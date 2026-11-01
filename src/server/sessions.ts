import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ARGON2_OPTIONS, hashToken, normalizedIdentifier } from './security.js';
import type { Session } from './types.js';

export const SESSION_HOURS = 8;

type AccountRecord = { id: number; username: string; password_hash: string; role: string };

export function createSessionStore(sqlite: DatabaseSync, cookieSecure: boolean) {
  const cookieName = cookieSecure ? '__Host-vertiku_session' : 'vertiku_session';
  // Clearing a __Host- cookie only works when the same Secure/Path attributes are repeated.
  const cookieOptions = { path: '/', httpOnly: true, secure: cookieSecure, sameSite: 'strict' as const };
  let dummyPasswordHash: Promise<string> | undefined;

  function accountByUsername(username: string) {
    const direct = sqlite.prepare('SELECT id, username, password_hash, role FROM accounts WHERE username = ? COLLATE NOCASE').get(username.trim()) as AccountRecord | undefined;
    if (direct) return direct;
    const normalized = normalizedIdentifier(username);
    return (sqlite.prepare('SELECT id, username, password_hash, role FROM accounts').all() as unknown as AccountRecord[]).find((account) => normalizedIdentifier(account.username) === normalized);
  }

  /** Unknown usernames still pay the Argon2 verification cost, so sign-in timing does not reveal which accounts exist. */
  async function verifyPassword(account: AccountRecord | undefined, password: string) {
    if (account) return argon2.verify(account.password_hash, password).catch(() => false);
    dummyPasswordHash ??= argon2.hash(randomBytes(32).toString('base64url'), ARGON2_OPTIONS);
    await argon2.verify(await dummyPasswordHash, password).catch(() => false);
    return false;
  }

  function audit(eventType: string, targetAccountId: number | null, outcome: 'success' | 'failure', requestId: string) {
    sqlite.prepare('INSERT INTO audit_events (id, event_type, target_account_id, outcome, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), eventType, targetAccountId, outcome, requestId, Date.now());
  }

  function createSession(accountId: number) {
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url'); const now = Date.now();
    sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    sqlite.prepare('INSERT INTO sessions (token_hash, account_id, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(hashToken(token), accountId, csrf, now, now, now + SESSION_HOURS * 60 * 60 * 1000);
    return { token, csrf };
  }

  function sessionFor(request: FastifyRequest): Session | undefined {
    const token = request.cookies[cookieName];
    if (!token) return undefined;
    const session = sqlite.prepare('SELECT s.token_hash, s.account_id, s.csrf, s.expires_at, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?').get(hashToken(token)) as Session | undefined;
    if (!session || session.expires_at <= Date.now()) {
      if (session) sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
      return undefined;
    }
    sqlite.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), session.token_hash);
    return session;
  }

  /** Sends 401/403 and returns undefined when the request has no valid session (or, for mutations, no valid CSRF proof). */
  function requireSession(request: FastifyRequest, reply: FastifyReply, requireCsrf = false): Session | undefined {
    const session = sessionFor(request);
    if (!session) { void reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Sign in to continue.', requestId: request.id }); return undefined; }
    if (requireCsrf && request.headers['x-csrf-token'] !== session.csrf) { void reply.code(403).send({ code: 'CSRF_INVALID', message: 'Request denied.', requestId: request.id }); return undefined; }
    return session;
  }

  function sessionIsActive(session: Session): boolean {
    const row = sqlite.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(session.token_hash) as { expires_at: number } | undefined;
    return Boolean(row && row.expires_at > Date.now());
  }

  function revokeSession(tokenHash: string) { sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); }

  return { cookieName, cookieOptions, accountByUsername, verifyPassword, audit, createSession, requireSession, sessionIsActive, revokeSession };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
