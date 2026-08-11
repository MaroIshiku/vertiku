import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', { id: integer('id').primaryKey(), username: text('username').notNull().unique(), passwordHash: text('password_hash').notNull(), role: text('role').notNull().default('user') });
export const sessions = sqliteTable('sessions', { tokenHash: text('token_hash').primaryKey(), accountId: integer('account_id').notNull(), csrf: text('csrf').notNull(), createdAt: integer('created_at').notNull(), lastSeenAt: integer('last_seen_at').notNull(), expiresAt: integer('expires_at').notNull() });
export const drafts = sqliteTable('drafts', { id: text('id').primaryKey(), ownerId: integer('owner_id').notNull(), coverPath: text('cover_path'), createdAt: integer('created_at').notNull() });
export const draftSources = sqliteTable('draft_sources', { id: text('id').primaryKey(), draftId: text('draft_id').notNull(), originalName: text('original_name').notNull(), storagePath: text('storage_path').notNull(), durationMs: integer('duration_ms').notNull(), sizeBytes: integer('size_bytes').notNull().default(0), modifiedAt: integer('modified_at').notNull().default(0), sortOrder: integer('sort_order').notNull() });
export const jobs = sqliteTable('jobs', { id: text('id').primaryKey(), draftId: text('draft_id').notNull(), ownerId: integer('owner_id').notNull(), status: text('status').notNull(), phase: text('phase').notNull().default('queued'), progress: integer('progress').notNull(), title: text('title').notNull(), destination: text('destination').notNull().default('output'), bitrateKbps: integer('bitrate_kbps').notNull().default(96), metadataJson: text('metadata_json').notNull().default('{}'), chaptersJson: text('chapters_json').notNull().default('[]'), outputPath: text('output_path'), exportPath: text('export_path'), errorCode: text('error_code'), errorMessage: text('error_message'), sourceFingerprint: text('source_fingerprint'), sourceBytes: integer('source_bytes').notNull().default(0), sourceDurationMs: integer('source_duration_ms').notNull().default(0), estimatedDurationMs: integer('estimated_duration_ms').notNull().default(0), estimatedOutputBytes: integer('estimated_output_bytes').notNull().default(0), retryOf: text('retry_of'), retryable: integer('retryable').notNull().default(0), startedAt: integer('started_at'), finishedAt: integer('finished_at'), archivedAt: integer('archived_at'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull() });
export const conversionSamples = sqliteTable('conversion_samples', { id: text('id').primaryKey(), ownerId: integer('owner_id').notNull(), sourceBytes: integer('source_bytes').notNull(), sourceDurationMs: integer('source_duration_ms').notNull(), processingMs: integer('processing_ms').notNull(), createdAt: integer('created_at').notNull() });

export function openDatabase(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, cover_path TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_sources (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, original_name TEXT NOT NULL, storage_path TEXT NOT NULL, duration_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, modified_at INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT, owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, status TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'output', bitrate_kbps INTEGER NOT NULL DEFAULT 96, metadata_json TEXT NOT NULL DEFAULT '{}', chapters_json TEXT NOT NULL DEFAULT '[]', output_path TEXT, export_path TEXT, error_code TEXT, error_message TEXT, source_fingerprint TEXT, source_bytes INTEGER NOT NULL DEFAULT 0, source_duration_ms INTEGER NOT NULL DEFAULT 0, estimated_duration_ms INTEGER NOT NULL DEFAULT 0, estimated_output_bytes INTEGER NOT NULL DEFAULT 0, retry_of TEXT, retryable INTEGER NOT NULL DEFAULT 0, started_at INTEGER, finished_at INTEGER, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, target_account_id INTEGER, outcome TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversion_samples (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, source_bytes INTEGER NOT NULL, source_duration_ms INTEGER NOT NULL, processing_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_draft_sources_draft ON draft_sources(draft_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversion_samples_owner ON conversion_samples(owner_id, created_at DESC);
  `);
  const jobColumns = new Set((sqlite.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!jobColumns.has('destination')) sqlite.exec("ALTER TABLE jobs ADD COLUMN destination TEXT NOT NULL DEFAULT 'output'");
  if (!jobColumns.has('export_path')) sqlite.exec('ALTER TABLE jobs ADD COLUMN export_path TEXT');
  if (!jobColumns.has('bitrate_kbps')) sqlite.exec('ALTER TABLE jobs ADD COLUMN bitrate_kbps INTEGER NOT NULL DEFAULT 96');
  if (!jobColumns.has('metadata_json')) sqlite.exec("ALTER TABLE jobs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  if (!jobColumns.has('chapters_json')) sqlite.exec("ALTER TABLE jobs ADD COLUMN chapters_json TEXT NOT NULL DEFAULT '[]'");
  if (!jobColumns.has('phase')) sqlite.exec("ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'");
  const sourceColumns = new Set((sqlite.prepare('PRAGMA table_info(draft_sources)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!sourceColumns.has('size_bytes')) sqlite.exec('ALTER TABLE draft_sources ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0');
  if (!sourceColumns.has('modified_at')) sqlite.exec('ALTER TABLE draft_sources ADD COLUMN modified_at INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('source_fingerprint')) sqlite.exec('ALTER TABLE jobs ADD COLUMN source_fingerprint TEXT');
  if (!jobColumns.has('source_bytes')) sqlite.exec('ALTER TABLE jobs ADD COLUMN source_bytes INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('source_duration_ms')) sqlite.exec('ALTER TABLE jobs ADD COLUMN source_duration_ms INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('estimated_duration_ms')) sqlite.exec('ALTER TABLE jobs ADD COLUMN estimated_duration_ms INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('estimated_output_bytes')) sqlite.exec('ALTER TABLE jobs ADD COLUMN estimated_output_bytes INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('retry_of')) sqlite.exec('ALTER TABLE jobs ADD COLUMN retry_of TEXT');
  if (!jobColumns.has('retryable')) sqlite.exec('ALTER TABLE jobs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0');
  if (!jobColumns.has('started_at')) sqlite.exec('ALTER TABLE jobs ADD COLUMN started_at INTEGER');
  if (!jobColumns.has('finished_at')) sqlite.exec('ALTER TABLE jobs ADD COLUMN finished_at INTEGER');
  if (!jobColumns.has('archived_at')) sqlite.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(owner_id, source_fingerprint, status); CREATE INDEX IF NOT EXISTS idx_jobs_retry ON jobs(owner_id, retry_of, status); CREATE INDEX IF NOT EXISTS idx_jobs_visible ON jobs(owner_id, archived_at, status, created_at DESC);');
  sqlite.exec(`
    INSERT OR IGNORE INTO conversion_samples (id, owner_id, source_bytes, source_duration_ms, processing_ms, created_at)
    SELECT id, owner_id, source_bytes, source_duration_ms, MAX(1, finished_at - started_at), finished_at
    FROM jobs
    WHERE status = 'completed' AND source_bytes > 0 AND source_duration_ms > 0 AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND finished_at > COALESCE((SELECT CAST(value AS INTEGER) FROM system_settings WHERE key = 'eta_history_reset_at'), 0);
  `);
  return { sqlite, db: drizzle({ client: sqlite }) };
}
