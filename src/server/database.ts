import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', { id: integer('id').primaryKey(), username: text('username').notNull().unique(), passwordHash: text('password_hash').notNull(), role: text('role').notNull().default('user') });
export const sessions = sqliteTable('sessions', { tokenHash: text('token_hash').primaryKey(), accountId: integer('account_id').notNull(), csrf: text('csrf').notNull(), createdAt: integer('created_at').notNull(), lastSeenAt: integer('last_seen_at').notNull(), expiresAt: integer('expires_at').notNull() });
export const drafts = sqliteTable('drafts', { id: text('id').primaryKey(), ownerId: integer('owner_id').notNull(), coverPath: text('cover_path'), createdAt: integer('created_at').notNull() });
export const draftSources = sqliteTable('draft_sources', { id: text('id').primaryKey(), draftId: text('draft_id').notNull(), originalName: text('original_name').notNull(), storagePath: text('storage_path').notNull(), durationMs: integer('duration_ms').notNull(), sortOrder: integer('sort_order').notNull() });
export const jobs = sqliteTable('jobs', { id: text('id').primaryKey(), draftId: text('draft_id').notNull(), ownerId: integer('owner_id').notNull(), status: text('status').notNull(), progress: integer('progress').notNull(), title: text('title').notNull(), destination: text('destination').notNull().default('output'), bitrateKbps: integer('bitrate_kbps').notNull().default(96), metadataJson: text('metadata_json').notNull().default('{}'), chaptersJson: text('chapters_json').notNull().default('[]'), outputPath: text('output_path'), exportPath: text('export_path'), errorCode: text('error_code'), errorMessage: text('error_message'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull() });

export function openDatabase(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, cover_path TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_sources (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, original_name TEXT NOT NULL, storage_path TEXT NOT NULL, duration_ms INTEGER NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT, owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'output', bitrate_kbps INTEGER NOT NULL DEFAULT 96, metadata_json TEXT NOT NULL DEFAULT '{}', chapters_json TEXT NOT NULL DEFAULT '[]', output_path TEXT, export_path TEXT, error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_draft_sources_draft ON draft_sources(draft_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id, created_at DESC);
  `);
  const jobColumns = new Set((sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!jobColumns.has('destination')) sqlite.exec("ALTER TABLE jobs ADD COLUMN destination TEXT NOT NULL DEFAULT 'output'");
  if (!jobColumns.has('export_path')) sqlite.exec('ALTER TABLE jobs ADD COLUMN export_path TEXT');
  if (!jobColumns.has('bitrate_kbps')) sqlite.exec('ALTER TABLE jobs ADD COLUMN bitrate_kbps INTEGER NOT NULL DEFAULT 96');
  if (!jobColumns.has('metadata_json')) sqlite.exec("ALTER TABLE jobs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  if (!jobColumns.has('chapters_json')) sqlite.exec("ALTER TABLE jobs ADD COLUMN chapters_json TEXT NOT NULL DEFAULT '[]'");
  return { sqlite, db: drizzle({ client: sqlite }) };
}
