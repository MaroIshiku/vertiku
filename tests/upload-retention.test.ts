import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { createUploadRetention } from '../src/server/upload-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1, 12);
const OLD = NOW - 8 * DAY;
const FRESH = NOW - DAY;

const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach((close) => close()); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof createUploadRetention>[0]['log'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vertiku-retention-')); directories.push(root);
  const uploadsDir = join(root, 'uploads'); mkdirSync(uploadsDir);
  const { sqlite } = openDatabase(join(root, 'vertiku.sqlite')); closers.push(() => sqlite.close());
  sqlite.prepare("INSERT INTO accounts (id, username, password_hash, role) VALUES (1, 'admin', 'synthetic-hash', 'admin')").run();

  function draft(createdAt: number, { upload = true }: { upload?: boolean } = {}) {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, 1, NULL, ?)').run(id, createdAt);
    const sourcePath = upload ? join(uploadsDir, id, `${randomUUID()}.mp3`) : join(root, 'input', 'Book', '01.mp3');
    sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, sort_order) VALUES (?, ?, ?, ?, 1000, 0)').run(randomUUID(), id, '01.mp3', sourcePath);
    if (upload) { mkdirSync(join(uploadsDir, id)); writeFileSync(sourcePath, 'synthetic upload'); }
    return id;
  }
  function job(draftId: string, status: string, updatedAt: number, { archived = false, retryable = status === 'failed' } = {}) {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO jobs (id, draft_id, owner_id, status, progress, title, retryable, archived_at, created_at, updated_at) VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, ?)')
      .run(id, draftId, status, 'Synthetic book', retryable ? 1 : 0, archived ? updatedAt : null, updatedAt, updatedAt);
    return id;
  }
  const retention = createUploadRetention({ sqlite, uploadsDir, retentionDays: 7, log: silentLog });
  const count = (sql: string, ...values: Array<string | number>) => Number((sqlite.prepare(sql).get(...values) as { count: number }).count);
  return { root, uploadsDir, sqlite, draft, job, retention, count };
}

describe('private upload retention', () => {
  it('removes drafts that never became a job after the retention period, including their upload copy', async () => {
    const { uploadsDir, draft, retention, count } = fixture();
    const oldUpload = draft(OLD); const freshUpload = draft(FRESH); const oldInputReference = draft(OLD, { upload: false });
    expect(await retention.sweep(NOW)).toMatchObject({ abandonedDrafts: 2 });
    expect(existsSync(join(uploadsDir, oldUpload))).toBe(false);
    expect(existsSync(join(uploadsDir, freshUpload))).toBe(true);
    expect(count('SELECT COUNT(*) AS count FROM drafts WHERE id IN (?, ?)', oldUpload, oldInputReference)).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM draft_sources WHERE draft_id IN (?, ?)', oldUpload, oldInputReference)).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM drafts WHERE id = ?', freshUpload)).toBe(1);
  });

  it('removes only upload copies that can no longer be retried and keeps the job history', async () => {
    const { uploadsDir, draft, job, retention, count, sqlite } = fixture();
    const archivedFailure = draft(OLD); const failedJob = job(archivedFailure, 'failed', OLD, { archived: true });
    const visibleFailure = draft(OLD); job(visibleFailure, 'failed', OLD);
    const waiting = draft(OLD); job(waiting, 'queued', OLD);
    const retriedAgain = draft(OLD); job(retriedAgain, 'failed', OLD, { archived: true }); job(retriedAgain, 'running', FRESH);
    const recentlyCleared = draft(OLD); job(recentlyCleared, 'failed', FRESH, { archived: true });

    expect(await retention.sweep(NOW)).toMatchObject({ abandonedDrafts: 0, expiredUploads: 1 });
    expect(existsSync(join(uploadsDir, archivedFailure))).toBe(false);
    for (const kept of [visibleFailure, waiting, retriedAgain, recentlyCleared]) expect(existsSync(join(uploadsDir, kept))).toBe(true);
    expect(sqlite.prepare('SELECT status, retryable FROM jobs WHERE id = ?').get(failedJob)).toMatchObject({ status: 'failed', retryable: 0 });
    expect(count('SELECT COUNT(*) AS count FROM drafts WHERE id = ?', archivedFailure)).toBe(1);
  });

  it('removes stale upload directories without a draft but never follows symlinks or touches foreign names', async () => {
    const { root, uploadsDir, retention } = fixture();
    const stale = join(uploadsDir, randomUUID()); const recent = join(uploadsDir, randomUUID()); const foreign = join(uploadsDir, 'keep-me');
    for (const directory of [stale, recent, foreign]) { mkdirSync(directory); writeFileSync(join(directory, 'part.mp3'), 'synthetic'); }
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'precious.m4b'), 'must survive');
    const link = join(uploadsDir, randomUUID()); symlinkSync(outside, link, 'dir');
    for (const directory of [stale, foreign]) utimesSync(directory, OLD / 1000, OLD / 1000);
    utimesSync(recent, FRESH / 1000, FRESH / 1000);

    expect(await retention.sweep(NOW)).toMatchObject({ orphanedDirectories: 1 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(outside, 'precious.m4b'))).toBe(true);
  });

  it('runs at startup with the configured retention period', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vertiku-retention-start-')); directories.push(root);
    const databasePath = join(root, 'vertiku.sqlite');
    const first = await buildApp({ databasePath, dataDir: root, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', uploadRetentionDays: 3 });
    await first.close();
    const { sqlite } = openDatabase(databasePath);
    sqlite.prepare("INSERT INTO accounts (id, username, password_hash, role) VALUES (1, 'admin', 'synthetic-hash', 'admin')").run();
    const expired = randomUUID(); const kept = randomUUID();
    sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, 1, NULL, ?)').run(expired, Date.now() - 4 * DAY);
    sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, 1, NULL, ?)').run(kept, Date.now() - 2 * DAY);
    sqlite.close();
    for (const id of [expired, kept]) mkdirSync(join(root, 'uploads', id));

    const restarted = await buildApp({ databasePath, dataDir: root, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', uploadRetentionDays: 3 });
    try {
      for (let attempt = 0; attempt < 100 && existsSync(join(root, 'uploads', expired)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(join(root, 'uploads', expired))).toBe(false);
      expect(existsSync(join(root, 'uploads', kept))).toBe(true);
    } finally { await restarted.close(); }
  });
});
