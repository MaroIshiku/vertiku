import { lstatSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';

export const DEFAULT_UPLOAD_RETENTION_DAYS = 7;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Upload directories are named by server-generated UUIDs; anything else is never touched.
const DRAFT_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RetentionResult = { abandonedDrafts: number; expiredUploads: number; orphanedDirectories: number };

type RetentionDependencies = { sqlite: DatabaseSync; uploadsDir: string; retentionDays: number; log: FastifyBaseLogger };

/**
 * Bounds private upload storage (STOR-001). After the retention period it removes:
 * - drafts that never became a job (database rows and any upload copy),
 * - upload copies whose jobs are all finished and that no visible failed attempt can retry any more,
 * - upload directories without a draft, left behind by an interrupted upload.
 * Job history, forecast samples, browser-download results, /input, and /output are never touched.
 */
export function createUploadRetention({ sqlite, uploadsDir, retentionDays, log }: RetentionDependencies) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RetentionResult> | undefined;

  const directoryFor = (draftId: string) => DRAFT_DIRECTORY.test(draftId) ? join(uploadsDir, draftId) : undefined;

  function realDirectory(path: string) {
    try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() ? stat : undefined; }
    catch { return undefined; }
  }

  async function removeDirectory(path: string | undefined) {
    if (!path || !realDirectory(path)) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  }

  async function sweepOnce(now: number): Promise<RetentionResult> {
    const cutoff = now - retentionDays * DAY_MS;
    const result: RetentionResult = { abandonedDrafts: 0, expiredUploads: 0, orphanedDirectories: 0 };

    // 1. Drafts that never became a job. The delete re-checks for jobs so a draft queued meanwhile is kept.
    const abandoned = sqlite.prepare('SELECT id FROM drafts d WHERE d.created_at < ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.draft_id = d.id)').all(cutoff) as Array<{ id: string }>;
    const deleteDraft = sqlite.prepare('DELETE FROM drafts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE draft_id = ?)');
    for (const { id } of abandoned) {
      if (Number(deleteDraft.run(id, id).changes) !== 1) continue;
      result.abandonedDrafts += 1;
      await removeDirectory(directoryFor(id));
    }

    // 2. Upload copies nobody can use any more: no queued/running job, no failed attempt still visible for retry.
    const candidates = sqlite.prepare(`
      SELECT j.draft_id AS id FROM jobs j
      GROUP BY j.draft_id
      HAVING MAX(j.updated_at) < ?
        AND SUM(CASE WHEN j.status IN ('queued', 'running') THEN 1 ELSE 0 END) = 0
        AND SUM(CASE WHEN j.status = 'failed' AND j.archived_at IS NULL THEN 1 ELSE 0 END) = 0
    `).all(cutoff) as Array<{ id: string }>;
    for (const { id } of candidates) {
      if (!(await removeDirectory(directoryFor(id)))) continue;
      sqlite.prepare("UPDATE jobs SET retryable = 0 WHERE draft_id = ? AND status = 'failed'").run(id);
      result.expiredUploads += 1;
    }

    // 3. Directories without a draft row, for example from an upload interrupted by a restart.
    const knownDraft = sqlite.prepare('SELECT 1 FROM drafts WHERE id = ?');
    let entries: string[] = [];
    try { entries = readdirSync(uploadsDir); } catch { entries = []; }
    for (const name of entries) {
      const path = directoryFor(name);
      const stat = path ? realDirectory(path) : undefined;
      if (!path || !stat || stat.mtimeMs >= cutoff || knownDraft.get(name)) continue;
      await rm(path, { recursive: true, force: true });
      result.orphanedDirectories += 1;
    }

    if (result.abandonedDrafts || result.expiredUploads || result.orphanedDirectories) log.info({ ...result, retentionDays }, 'Expired private upload storage was removed');
    return result;
  }

  /** Runs one sweep; concurrent calls share the sweep that is already in progress. */
  function sweep(now = Date.now()) {
    running ??= sweepOnce(now).finally(() => { running = undefined; });
    return running;
  }

  let stopped = false;
  let initial: NodeJS.Immediate | undefined;
  const sweepSafely = () => { if (!stopped) sweep().catch((error: unknown) => log.error({ err: error }, 'Upload retention sweep failed')); };

  return {
    sweep,
    start() {
      initial = setImmediate(sweepSafely);
      timer = setInterval(sweepSafely, SWEEP_INTERVAL_MS); timer.unref();
    },
    async stop() {
      stopped = true;
      if (initial) clearImmediate(initial);
      if (timer) clearInterval(timer);
      await running?.catch(() => undefined);
    }
  };
}
