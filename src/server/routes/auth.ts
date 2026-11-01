import argon2 from 'argon2';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ARGON2_OPTIONS, copiedSecretMatches } from '../security.js';
import { SESSION_HOURS } from '../sessions.js';

const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(12).max(1024) });
const setupSchema = loginSchema.extend({ setupSecret: z.string().min(1).max(2048) });
const passwordResetSchema = z.object({ username: z.string().trim().min(1).max(100), setupSecret: z.string().min(1).max(2048), newPassword: z.string().min(12).max(1024) });

export function registerAuthRoutes({ app, sqlite, options, sessions }: AppContext) {
  // Compose-gated recovery succeeds at most once per process start.
  let passwordResetAvailable = options.passwordResetEnabled === true;
  const accountCount = () => Number((sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count);

  app.get('/api/setup/status', async () => ({ required: accountCount() === 0, passwordResetEnabled: passwordResetAvailable }));

  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    if (accountCount() > 0) return reply.code(409).send({ code: 'SETUP_CLOSED', message: 'Initial setup is already complete.', requestId: request.id });
    const input = setupSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Enter a username, a password of at least 12 characters, and the setup secret.', requestId: request.id });
    if (!options.setupSecret) return reply.code(503).send({ code: 'SETUP_SECRET_MISSING', message: 'The server administrator must configure ISHIKU_SETUP_SECRET.', requestId: request.id });
    if (!copiedSecretMatches(input.data.setupSecret, options.setupSecret) || copiedSecretMatches(input.data.password, options.setupSecret)) return reply.code(403).send({ code: 'SETUP_DENIED', message: 'Setup could not be authorized.', requestId: request.id });
    const passwordHash = await argon2.hash(input.data.password, ARGON2_OPTIONS);
    // Re-check inside one statement: concurrent setup requests may all pass the first check while hashing.
    const created = sqlite.prepare("INSERT INTO accounts (username, password_hash, role) SELECT ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM accounts)").run(input.data.username, passwordHash);
    if (Number(created.changes) !== 1) return reply.code(409).send({ code: 'SETUP_CLOSED', message: 'Initial setup is already complete.', requestId: request.id });
    sessions.audit('setup', Number(created.lastInsertRowid), 'success', request.id);
    return reply.code(201).send({ created: true });
  });

  app.post('/api/session', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const input = loginSchema.safeParse(request.body);
    const account = input.success ? sessions.accountByUsername(input.data.username) : undefined;
    const valid = input.success ? await sessions.verifyPassword(account, input.data.password) : false;
    if (!valid || !account) {
      sessions.audit('sign_in', account?.id ?? null, 'failure', request.id);
      return reply.code(401).send({ code: 'AUTH_INVALID', message: 'Invalid credentials.', requestId: request.id });
    }
    const { token, csrf } = sessions.createSession(account.id);
    reply.setCookie(sessions.cookieName, token, { ...sessions.cookieOptions, maxAge: SESSION_HOURS * 60 * 60 });
    sessions.audit('sign_in', account.id, 'success', request.id);
    return { csrf, user: { username: account.username, role: account.role } };
  });

  app.post('/api/password-reset', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = passwordResetSchema.safeParse(request.body);
    const account = input.success ? sessions.accountByUsername(input.data.username) : undefined;
    const secretValid = Boolean(input.success && options.setupSecret && copiedSecretMatches(input.data.setupSecret, options.setupSecret));
    const passwordReusesSetupSecret = Boolean(input.success && options.setupSecret && copiedSecretMatches(input.data.newPassword, options.setupSecret));
    const authorized = passwordResetAvailable && input.success && options.setupSecret && account && secretValid && !passwordReusesSetupSecret;
    if (!authorized || !input.success || !account) {
      // The browser always gets the same denial; the log records a non-secret reason.
      const reason = !passwordResetAvailable ? 'disabled' : !input.success ? 'invalid_payload' : !options.setupSecret ? 'missing_configured_secret' : !account ? 'unknown_account' : passwordReusesSetupSecret ? 'new_password_matches_secret' : 'secret_mismatch';
      request.log.warn({ reason }, 'Password recovery denied');
      sessions.audit('password_reset', account?.id ?? null, 'failure', request.id);
      return reply.code(403).send({ code: 'PASSWORD_RESET_DENIED', message: 'Password recovery could not be authorized.', requestId: request.id });
    }
    const passwordHash = await argon2.hash(input.data.newPassword, ARGON2_OPTIONS);
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, account.id);
      sqlite.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
      sessions.audit('password_reset', account.id, 'success', request.id);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    passwordResetAvailable = false;
    return reply.code(204).send();
  });

  app.get('/api/session', async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    return { csrf: session.csrf, user: { username: session.username, role: session.role } };
  });

  app.delete('/api/session', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    sessions.revokeSession(session.token_hash);
    reply.clearCookie(sessions.cookieName, sessions.cookieOptions);
    return reply.code(204).send();
  });
}
