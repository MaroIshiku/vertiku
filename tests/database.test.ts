import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/server/database.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('database upgrades', () => {
  it('adds recovery and forecast fields to a 0.2 database without losing accounts or jobs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertiku-database-')); directories.push(directory); const path = join(directory, 'vertiku.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE drafts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, cover_path TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE draft_sources (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, original_name TEXT NOT NULL, storage_path TEXT NOT NULL, duration_ms INTEGER NOT NULL, sort_order INTEGER NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, owner_id INTEGER NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'output', bitrate_kbps INTEGER NOT NULL DEFAULT 96, metadata_json TEXT NOT NULL DEFAULT '{}', chapters_json TEXT NOT NULL DEFAULT '[]', output_path TEXT, export_path TEXT, error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO accounts VALUES (1, 'admin', 'preserved-hash', 'admin');
      INSERT INTO drafts VALUES ('draft-1', 1, NULL, 1);
      INSERT INTO draft_sources VALUES ('source-1', 'draft-1', '01.mp3', '/input/01.mp3', 1000, 0);
      INSERT INTO jobs VALUES ('job-1', 'draft-1', 1, 'completed', 100, 'Preserved Book', 'output', 96, '{}', '[]', '/output/book.m4b', '/output/book.m4b', NULL, NULL, 1, 2);
    `);
    legacy.close();

    const upgraded = openDatabase(path);
    expect(upgraded.sqlite.prepare('SELECT username FROM accounts WHERE id = 1').get()).toEqual({ username: 'admin' });
    expect(upgraded.sqlite.prepare('SELECT title, status FROM jobs WHERE id = ?').get('job-1')).toEqual({ title: 'Preserved Book', status: 'completed' });
    const jobColumns = (upgraded.sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(jobColumns).toEqual(expect.arrayContaining(['phase', 'source_fingerprint', 'retry_of', 'retryable', 'started_at', 'finished_at', 'archived_at']));
    expect(upgraded.sqlite.prepare('SELECT phase FROM jobs WHERE id = ?').get('job-1')).toEqual({ phase: 'queued' });
    expect(upgraded.sqlite.prepare('SELECT archived_at FROM jobs WHERE id = ?').get('job-1')).toEqual({ archived_at: null });
    expect(upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'").get()).toEqual({ name: 'audit_events' });
    expect(upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversion_samples'").get()).toEqual({ name: 'conversion_samples' });
    upgraded.sqlite.prepare('UPDATE jobs SET source_bytes = ?, source_duration_ms = ?, started_at = ?, finished_at = ? WHERE id = ?').run(594 * 1024 ** 2, 10 * 60 * 60_000, 1_000, 121_000, 'job-1');
    upgraded.sqlite.close();

    const reopened = openDatabase(path);
    expect(reopened.sqlite.prepare('SELECT id, source_bytes, source_duration_ms, processing_ms FROM conversion_samples WHERE id = ?').get('job-1')).toEqual({ id: 'job-1', source_bytes: 594 * 1024 ** 2, source_duration_ms: 10 * 60 * 60_000, processing_ms: 120_000 });
    reopened.sqlite.prepare("INSERT INTO system_settings (key, value) VALUES ('eta_history_reset_at', '122000')").run();
    reopened.sqlite.prepare('DELETE FROM conversion_samples').run();
    reopened.sqlite.close();

    const afterReset = openDatabase(path);
    expect(afterReset.sqlite.prepare('SELECT COUNT(*) AS count FROM conversion_samples').get()).toEqual({ count: 0 });
    afterReset.sqlite.close();
  });
});
