import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { safeDownloadName } from '../../domain/audiobook.js';
import type { AppContext } from '../context.js';
import { JobFailure, UserFacingError, clientError } from '../errors.js';
import { estimateDurationFromBytes, estimateOutputBytes } from '../forecast.js';
import { filesForInputBook } from '../input-library.js';
import { createOutputWorkingPath, discardOutputWorkingPath } from '../output-library.js';
import { TERMINAL_STATUSES, type DraftSource, type JobRow, type StoredChapter, type StoredMetadata } from '../types.js';

const bitrate = z.union([z.literal(64), z.literal(96), z.literal(128)]).default(96);
const metadataFields = {
  title: z.string().trim().min(1).max(250),
  author: z.string().trim().max(250).optional().default(''),
  narrator: z.string().trim().max(250).optional().default(''),
  year: z.string().trim().regex(/^$|^\d{4}$/).optional().default(''),
  genre: z.string().trim().max(100).optional().default('Audiobook'),
  description: z.string().trim().max(4000).optional().default(''),
  bitrateKbps: bitrate,
  destination: z.enum(['output', 'download']).default('output')
};
const startSchema = z.object({
  draftId: z.string().uuid(),
  ...metadataFields,
  chapters: z.array(z.object({ sourceId: z.string().uuid(), title: z.string().trim().min(1).max(500) })).min(1).max(500)
});
const batchStartSchema = z.object({
  items: z.array(z.object({
    folderId: z.string().min(1).max(2000),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    ...metadataFields,
    chapters: z.array(z.object({ filename: z.string().min(1).max(1000), title: z.string().trim().min(1).max(500) })).min(1).max(500)
  })).min(1).max(100)
});

const sourceFingerprint = (entries: Array<{ name: string; size: number; modifiedAt: number }>) =>
  createHash('sha256').update(entries.map((entry) => `${entry.name}\0${entry.size}\0${entry.modifiedAt}`).join('\n')).digest('hex');

const INSERT_JOB = "INSERT INTO jobs (id, draft_id, owner_id, status, progress, title, destination, bitrate_kbps, metadata_json, chapters_json, output_path, source_fingerprint, source_bytes, source_duration_ms, estimated_duration_ms, estimated_output_bytes, retry_of, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function registerJobRoutes({ app, sqlite, paths, sessions, jobs, runner, events, workQueue }: AppContext) {
  const ownedJob = (id: string, ownerId: number) => sqlite.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND archived_at IS NULL').get(id, ownerId) as JobRow | undefined;
  const notFound = (requestId: string) => ({ code: 'JOB_NOT_FOUND', message: 'The job was not found.', requestId });

  app.post('/api/jobs/from-input/batch', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const input = batchStartSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Review every selected audiobook and chapter title.', requestId: request.id, fieldErrors: input.error.flatten().fieldErrors });
    if (new Set(input.data.items.map((item) => item.folderId)).size !== input.data.items.length) return reply.code(400).send({ code: 'BATCH_DUPLICATE_BOOK', message: 'Each input folder may appear only once in a batch.', requestId: request.id });
    try {
      // Validate every book against the current /input state before anything is stored.
      const prepared = input.data.items.map((item, batchIndex) => {
        const selected = filesForInputBook(paths.inputDir, item.folderId);
        if (!selected.files.length || selected.files.length > 500) throw new UserFacingError('Each selected folder must contain between 1 and 500 supported audio files.');
        if (item.fingerprint && item.fingerprint !== selected.fingerprint) throw new UserFacingError(`The source files changed in ${item.folderId}. Refresh the input library and review it again.`);
        if (sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status IN ('queued','running') LIMIT 1").get(session.account_id, selected.fingerprint)) throw new UserFacingError(`The audiobook in ${item.folderId} is already queued or running.`);
        const submitted = new Map(item.chapters.map((chapter) => [chapter.filename, chapter.title]));
        if (submitted.size !== selected.files.length || item.chapters.length !== selected.files.length || selected.files.some((file) => !submitted.has(file.name))) throw new UserFacingError(`The chapter files changed in ${item.folderId}. Refresh the input library and review it again.`);
        const draftId = randomUUID(); const jobId = randomUUID(); const now = Date.now() + batchIndex;
        const sources = selected.files.map((file, index) => ({ id: randomUUID(), originalName: file.name, storagePath: file.path, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, title: submitted.get(file.name)!, sortOrder: index }));
        // Batch jobs never invent descriptive metadata; embedded tags are applied while processing.
        const metadata: StoredMetadata = { title: '', author: '', narrator: '', year: '', genre: '', description: '' };
        const chapters: StoredChapter[] = sources.map((source) => ({ sourceId: source.id, title: source.title }));
        const outputPath = item.destination === 'output' ? join(paths.outputDir, `.vertiku-${jobId}.partial.m4b`) : join(paths.resultsDir, jobId, safeDownloadName(item.title));
        const estimatedDurationMs = estimateDurationFromBytes(selected.sourceBytes);
        return { item, selected, draftId, jobId, now, sources, metadata, chapters, outputPath, estimatedDurationMs, estimatedOutputBytes: estimateOutputBytes(estimatedDurationMs, item.bitrateKbps) };
      });
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const insertDraft = sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, ?, ?, ?)');
        const insertSource = sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, size_bytes, modified_at, sort_order) VALUES (?, ?, ?, ?, 0, ?, ?, ?)');
        const insertJob = sqlite.prepare(INSERT_JOB);
        for (const entry of prepared) {
          insertDraft.run(entry.draftId, session.account_id, entry.selected.coverPath ?? null, entry.now);
          for (const source of entry.sources) insertSource.run(source.id, entry.draftId, source.originalName, source.storagePath, source.sizeBytes, source.modifiedAt, source.sortOrder);
          insertJob.run(entry.jobId, entry.draftId, session.account_id, entry.item.title, entry.item.destination, entry.item.bitrateKbps, JSON.stringify(entry.metadata), JSON.stringify(entry.chapters), entry.outputPath, entry.selected.fingerprint, entry.selected.sourceBytes, 0, entry.estimatedDurationMs, entry.estimatedOutputBytes, null, entry.now, entry.now);
        }
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      workQueue.wake();
      const queued = prepared.map((entry) => jobs.publicJob(jobs.jobById(entry.jobId)!));
      return reply.code(202).send({ accepted: queued.length, jobs: queued });
    } catch (error) {
      return reply.code(400).send({ code: 'BATCH_INVALID', message: clientError(request, error, 'The batch could not be queued.'), requestId: request.id });
    }
  });

  app.post('/api/jobs', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const input = startSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Review the audiobook metadata and every chapter title.', requestId: request.id, fieldErrors: input.error.flatten().fieldErrors });
    const draft = sqlite.prepare('SELECT id, cover_path FROM drafts WHERE id = ? AND owner_id = ?').get(input.data.draftId, session.account_id) as { id: string; cover_path: string | null } | undefined;
    if (!draft) return reply.code(404).send({ code: 'DRAFT_NOT_FOUND', message: 'The upload draft was not found.', requestId: request.id });
    const rows = sqlite.prepare('SELECT * FROM draft_sources WHERE draft_id = ? ORDER BY sort_order').all(draft.id) as DraftSource[];
    const rowIds = new Set(rows.map((row) => row.id));
    if (input.data.chapters.some((chapter) => !rowIds.has(chapter.sourceId)) || new Set(input.data.chapters.map((chapter) => chapter.sourceId)).size !== rows.length) return reply.code(400).send({ code: 'CHAPTER_SET_INVALID', message: 'Each uploaded file must appear exactly once.', requestId: request.id });
    if (sqlite.prepare("SELECT id FROM jobs WHERE draft_id = ? AND status IN ('queued','running','completed')").get(draft.id)) return reply.code(409).send({ code: 'DRAFT_ALREADY_QUEUED', message: 'This draft already has a conversion job.', requestId: request.id });
    const jobId = randomUUID();
    const outputPath = input.data.destination === 'output' ? await createOutputWorkingPath(paths.outputDir, jobId) : join(paths.resultsDir, jobId, safeDownloadName(input.data.title));
    if (input.data.destination === 'download') mkdirSync(dirname(outputPath), { recursive: true });
    const { title, author, narrator, year, genre, description } = input.data;
    const metadata: StoredMetadata = { title, author, narrator, year, genre, description };
    const sourceBytes = rows.reduce((sum, row) => sum + row.size_bytes, 0);
    const sourceDurationMs = rows.reduce((sum, row) => sum + row.duration_ms, 0);
    const fingerprint = sourceFingerprint(rows.map((row) => ({ name: row.original_name, size: row.size_bytes, modifiedAt: row.modified_at })));
    const now = Date.now();
    sqlite.prepare(INSERT_JOB).run(jobId, draft.id, session.account_id, title, input.data.destination, input.data.bitrateKbps, JSON.stringify(metadata), JSON.stringify(input.data.chapters), outputPath, fingerprint, sourceBytes, sourceDurationMs, sourceDurationMs, estimateOutputBytes(sourceDurationMs, input.data.bitrateKbps), null, now, now);
    workQueue.wake();
    return reply.code(202).send(jobs.publicJob(jobs.jobById(jobId)!));
  });

  /** Queues a new attempt that reuses the failed job's retained sources and records its lineage. */
  async function retryFailedJob(row: JobRow, ownerId: number) {
    if (row.owner_id !== ownerId || row.status !== 'failed' || !row.retryable) throw new JobFailure('JOB_NOT_RETRYABLE', 'This failed job cannot be retried.', false);
    if (sqlite.prepare("SELECT id FROM jobs WHERE draft_id = ? AND status IN ('queued','running') LIMIT 1").get(row.draft_id)) throw new JobFailure('JOB_ALREADY_RETRIED', 'This audiobook already has a queued or running retry.', false);
    const sources = sqlite.prepare('SELECT * FROM draft_sources WHERE draft_id = ? ORDER BY sort_order').all(row.draft_id) as DraftSource[];
    if (!sources.length || sources.some((source) => !existsSync(source.storage_path))) throw new JobFailure('SOURCE_MISSING', 'The original source files are no longer available.', false);
    const current = sources.map((source) => {
      const stat = statSync(source.storage_path); const modifiedAt = Math.trunc(stat.mtimeMs);
      // Changed sources are measured again by the runner.
      if (stat.size !== source.size_bytes || modifiedAt !== source.modified_at) sqlite.prepare('UPDATE draft_sources SET duration_ms = 0, size_bytes = ?, modified_at = ? WHERE id = ?').run(stat.size, modifiedAt, source.id);
      return { name: source.original_name, size: stat.size, modifiedAt };
    });
    const sourceBytes = current.reduce((sum, entry) => sum + entry.size, 0);
    const jobId = randomUUID(); const now = Date.now();
    const outputPath = row.destination === 'output' ? await createOutputWorkingPath(paths.outputDir, jobId) : join(paths.resultsDir, jobId, safeDownloadName(row.title));
    if (row.destination === 'download') mkdirSync(dirname(outputPath), { recursive: true });
    const estimatedDurationMs = row.source_duration_ms || estimateDurationFromBytes(sourceBytes);
    sqlite.prepare(INSERT_JOB).run(jobId, row.draft_id, ownerId, row.title, row.destination, row.bitrate_kbps, row.metadata_json, row.chapters_json, outputPath, sourceFingerprint(current), sourceBytes, 0, estimatedDurationMs, estimateOutputBytes(estimatedDurationMs, row.bitrate_kbps), row.id, now, now);
    return jobs.jobById(jobId)!;
  }

  app.get('/api/jobs', async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    return jobs.jobsSnapshot(session.account_id);
  });

  app.get('/api/jobs/events', async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    let previous = '';
    return events.stream(request, reply, session, (write) => {
      const data = JSON.stringify(jobs.jobsSnapshot(session.account_id));
      if (data !== previous) { previous = data; write('jobs', data); }
    });
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    const row = ownedJob((request.params as { id: string }).id, session.account_id);
    return row ? jobs.publicJob(row) : reply.code(404).send(notFound(request.id));
  });

  app.get('/api/jobs/:id/events', async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    const { id } = request.params as { id: string };
    if (!sqlite.prepare('SELECT id FROM jobs WHERE id = ? AND owner_id = ?').get(id, session.account_id)) return reply.code(404).send(notFound(request.id));
    let previous = '';
    return events.stream(request, reply, session, (write) => {
      const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?').get(id, session.account_id) as JobRow | undefined;
      if (!row) return true;
      const data = JSON.stringify(jobs.publicJob(row));
      if (data !== previous) { previous = data; write('job', data); }
      return TERMINAL_STATUSES.includes(row.status);
    });
  });

  app.post('/api/jobs/cancel-queued', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    let queued: Array<{ id: string; draft_id: string; output_path: string | null }> = [];
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      queued = sqlite.prepare("SELECT id, draft_id, output_path FROM jobs WHERE owner_id = ? AND status = 'queued' ORDER BY created_at, id").all(session.account_id) as typeof queued;
      const now = Date.now();
      sqlite.prepare("UPDATE jobs SET status = 'cancelled', error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ? WHERE owner_id = ? AND status = 'queued'").run(now, now, session.account_id);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    for (const row of queued) {
      try { if (row.output_path) await discardOutputWorkingPath(row.output_path); await runner.cleanupUploadedDraft(row.draft_id); }
      catch (error) { request.log.warn({ err: error, jobId: row.id }, 'Cancelled queue cleanup could not be completed'); }
    }
    workQueue.wake();
    return reply.code(202).send({ cancelled: queued.length });
  });

  app.post('/api/jobs/clear-stopped', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const now = Date.now();
    const result = sqlite.prepare("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE owner_id = ? AND archived_at IS NULL AND status IN ('failed','cancelled')").run(now, now, session.account_id);
    return reply.send({ cleared: Number(result.changes) });
  });

  app.post('/api/jobs/:id/clear', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const { id } = request.params as { id: string }; const now = Date.now();
    const result = sqlite.prepare("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND archived_at IS NULL AND status IN ('completed','failed','cancelled')").run(now, now, id, session.account_id);
    if (Number(result.changes) === 0) return reply.code(409).send({ code: 'JOB_NOT_CLEARABLE', message: 'Only completed, failed, or cancelled jobs can be cleared.', requestId: request.id });
    return reply.send({ cleared: 1 });
  });

  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const { id } = request.params as { id: string };
    const row = sqlite.prepare("SELECT id, draft_id, status, output_path FROM jobs WHERE id = ? AND owner_id = ? AND status IN ('queued','running')").get(id, session.account_id) as { id: string; draft_id: string; status: string; output_path: string | null } | undefined;
    if (!row) return reply.code(409).send({ code: 'JOB_NOT_CANCELLABLE', message: 'This job cannot be cancelled.', requestId: request.id });
    const cancelledAt = Date.now();
    sqlite.prepare("UPDATE jobs SET status = 'cancelled', error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')").run(cancelledAt, cancelledAt, id);
    if (row.status === 'queued') {
      if (row.output_path) await discardOutputWorkingPath(row.output_path);
      await runner.cleanupUploadedDraft(row.draft_id);
    }
    runner.stopChild(id);
    workQueue.wake();
    return reply.code(202).send({ id, status: 'cancelled' });
  });

  app.post('/api/jobs/:id/retry', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const row = ownedJob((request.params as { id: string }).id, session.account_id);
    if (!row) return reply.code(404).send(notFound(request.id));
    try {
      const retried = await retryFailedJob(row, session.account_id);
      workQueue.wake();
      return reply.code(202).send(jobs.publicJob(retried));
    } catch (error) {
      const failure = error instanceof JobFailure ? error : new JobFailure('RETRY_FAILED', 'The failed job could not be retried.', false);
      return reply.code(409).send({ code: failure.code, message: failure.message, requestId: request.id });
    }
  });

  app.post('/api/jobs/retry-failed', async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const failed = sqlite.prepare("SELECT * FROM jobs WHERE owner_id = ? AND archived_at IS NULL AND status = 'failed' AND retryable = 1 ORDER BY created_at LIMIT 100").all(session.account_id) as JobRow[];
    const retried: JobRow[] = []; let skipped = 0;
    for (const row of failed) { try { retried.push(await retryFailedJob(row, session.account_id)); } catch { skipped += 1; } }
    workQueue.wake();
    return reply.code(202).send({ accepted: retried.length, skipped, jobs: retried.map((row) => jobs.publicJob(row)) });
  });

  app.get('/api/jobs/:id/download', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    const { id } = request.params as { id: string };
    const row = sqlite.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND status = 'completed' AND destination = 'download'").get(id, session.account_id) as JobRow | undefined;
    if (!row?.output_path || !existsSync(row.output_path)) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: 'The browser-download result is not available.', requestId: request.id });
    reply.header('Content-Type', 'audio/mp4');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName(row.title))}`);
    return reply.send(createReadStream(row.output_path));
  });

  app.get('/api/jobs/:id/media', { config: { rateLimit: { max: 300, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    const { id } = request.params as { id: string };
    const row = sqlite.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND status = 'completed'").get(id, session.account_id) as JobRow | undefined;
    if (!row?.output_path || !existsSync(row.output_path)) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: 'The validated audiobook is not available.', requestId: request.id });
    const size = statSync(row.output_path).size; const range = request.headers.range;
    const unsatisfiable = () => reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.header('Content-Type', 'audio/mp4').header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-store');
    if (!range) { reply.header('Content-Length', size); return reply.send(createReadStream(row.output_path)); }
    // Only a single byte range is supported: "bytes=start-", "bytes=start-end", or the suffix form "bytes=-length".
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return unsatisfiable();
    const suffix = !match[1] && match[2] ? Number(match[2]) : undefined;
    if (suffix === 0) return unsatisfiable();
    const start = suffix !== undefined ? Math.max(0, size - suffix) : Number(match[1]);
    const end = suffix !== undefined ? size - 1 : match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return unsatisfiable();
    const boundedEnd = Math.min(end, size - 1);
    reply.code(206).header('Content-Range', `bytes ${start}-${boundedEnd}/${size}`).header('Content-Length', boundedEnd - start + 1);
    return reply.send(createReadStream(row.output_path, { start, end: boundedEnd }));
  });
}
