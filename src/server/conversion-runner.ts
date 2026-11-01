import { mkdirSync, readdirSync, realpathSync, statfsSync, statSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';
import { safeDownloadName } from '../domain/audiobook.js';
import { JobFailure } from './errors.js';
import { convertToM4b, emptyEmbeddedMetadata, inspectAudio, type AudioInspection } from './ffmpeg.js';
import { estimateOutputBytes } from './forecast.js';
import type { JobViews } from './job-views.js';
import { createOutputWorkingPath, discardOutputWorkingPath, publishOutputWorkingPath } from './output-library.js';
import type { AppOptions, DraftSource, JobPhase, JobRow, StoragePaths, StoredChapter, StoredMetadata } from './types.js';

export function pathIsWithin(root: string, target: string) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

type RunnerDependencies = { sqlite: DatabaseSync; options: AppOptions; paths: StoragePaths; jobs: JobViews; log: FastifyBaseLogger };

/** Executes queued conversion jobs one at a time and owns the FFmpeg child processes. */
export function createConversionRunner({ sqlite, options, paths, jobs, log }: RunnerDependencies) {
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  let shuttingDown = false;

  async function inspectSource(path: string): Promise<AudioInspection> {
    const ffprobe = options.ffprobePath ?? 'ffprobe';
    if (options.inspect) return options.inspect(ffprobe, path);
    if (options.probe) return { durationMs: await options.probe(ffprobe, path), metadata: emptyEmbeddedMetadata(), embeddedCover: false };
    return inspectAudio(ffprobe, path);
  }

  function trustedExistingCover(path: string) {
    try {
      const actualPath = realpathSync(path);
      const trusted = [paths.inputDir, paths.uploadsDir].some((root) => {
        try { return pathIsWithin(realpathSync(root), actualPath); } catch { return false; }
      });
      return trusted && statSync(actualPath).isFile() ? actualPath : undefined;
    } catch { return undefined; }
  }

  /** Resolves a stored cover below the trusted roots, recovering the filesystem casing of covers recorded case-insensitively. */
  function availableCoverPath(storedPath: string | null) {
    if (!storedPath) return undefined;
    const direct = trustedExistingCover(storedPath);
    if (direct) return direct;
    if (![paths.inputDir, paths.uploadsDir].some((root) => pathIsWithin(root, storedPath))) return undefined;
    try {
      const expectedName = basename(storedPath).toLowerCase();
      const matchingEntry = readdirSync(dirname(storedPath), { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.toLowerCase() === expectedName);
      return matchingEntry ? trustedExistingCover(join(dirname(storedPath), matchingEntry.name)) : undefined;
    } catch { return undefined; }
  }

  async function cleanupUploadedDraft(draftId: string) {
    await rm(join(paths.uploadsDir, draftId), { recursive: true, force: true });
  }

  async function abandonCancelled(job: JobRow, workingPath: string | null) {
    if (workingPath) await discardOutputWorkingPath(workingPath);
    await cleanupUploadedDraft(job.draft_id);
  }

  const setPhase = (jobId: string, phase: JobPhase, progress: number) =>
    sqlite.prepare("UPDATE jobs SET phase = ?, progress = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(phase, progress, Date.now(), jobId);

  async function run(jobId: string) {
    const job = jobs.jobById(jobId);
    if (!job) return;
    const draft = sqlite.prepare('SELECT id, cover_path FROM drafts WHERE id = ?').get(job.draft_id) as { id: string; cover_path: string | null } | undefined;
    const rows = sqlite.prepare('SELECT * FROM draft_sources WHERE draft_id = ? ORDER BY sort_order').all(job.draft_id) as DraftSource[];
    let workingPath = job.output_path;
    try {
      if (!draft || rows.length === 0) throw new Error('The queued source draft is no longer available.');
      const chapters = JSON.parse(job.chapters_json) as StoredChapter[];
      const metadata = JSON.parse(job.metadata_json) as StoredMetadata;
      const rowById = new Map(rows.map((row) => [row.id, row]));
      if (chapters.length !== rows.length || chapters.some((chapter) => !rowById.has(chapter.sourceId))) throw new Error('The queued chapter set is no longer valid.');

      // Step 2: read source details. Batch jobs store only references, so their durations are measured here.
      let firstInspection: AudioInspection | undefined;
      for (const [index, row] of rows.entries()) {
        if (row.duration_ms > 0) {
          if (index === 0) {
            try { firstInspection = await inspectSource(row.storage_path); }
            catch { throw new JobFailure('SOURCE_INVALID', `Source audio could not be read: ${row.original_name}`, true); }
          }
          continue;
        }
        if (!existsSync(row.storage_path)) throw new JobFailure('SOURCE_MISSING', `Source file is no longer available: ${row.original_name}`, false);
        let inspection: AudioInspection;
        try { inspection = await inspectSource(row.storage_path); }
        catch { throw new JobFailure('SOURCE_INVALID', `Source audio could not be read: ${row.original_name}`, true); }
        if (index === 0) firstInspection = inspection;
        row.duration_ms = inspection.durationMs;
        sqlite.prepare('UPDATE draft_sources SET duration_ms = ? WHERE id = ?').run(inspection.durationMs, row.id);
        if (jobs.jobIsCancelled(job.id)) { await abandonCancelled(job, workingPath); return; }
      }

      // Step 3: resolve metadata (user overrides first, then embedded tags), working file, and capacity.
      setPhase(job.id, 'preparing_output', 8);
      const totalDurationMs = rows.reduce((sum, row) => sum + row.duration_ms, 0);
      const embedded = firstInspection?.metadata;
      const resolvedMetadata: StoredMetadata = {
        title: metadata.title || embedded?.title || job.title,
        author: metadata.author || embedded?.author || '',
        narrator: metadata.narrator || embedded?.narrator || '',
        year: metadata.year || embedded?.year || '',
        genre: metadata.genre || embedded?.genre || 'Audiobook',
        description: metadata.description || embedded?.description || ''
      };
      const outputEstimate = estimateOutputBytes(totalDurationMs, job.bitrate_kbps);
      sqlite.prepare('UPDATE jobs SET metadata_json = ?, source_duration_ms = ?, estimated_output_bytes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(resolvedMetadata), totalDurationMs, outputEstimate, Date.now(), job.id);
      workingPath = job.destination === 'output'
        ? await createOutputWorkingPath(paths.outputDir, job.id)
        : (job.output_path ?? join(paths.resultsDir, job.id, safeDownloadName(job.title)));
      mkdirSync(dirname(workingPath), { recursive: true });
      try {
        const storage = statfsSync(dirname(workingPath));
        if (Number(storage.bavail) * Number(storage.bsize) < outputEstimate * 1.1) throw new JobFailure('OUTPUT_STORAGE_LOW', 'The destination does not have enough free space for the estimated result.', true);
      } catch (error) { if (error instanceof JobFailure) throw error; }
      sqlite.prepare('UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?').run(workingPath, Date.now(), job.id);

      // A cancellation during inspection or preparation must not start a full encode that would only be discarded.
      if (jobs.jobIsCancelled(job.id)) { await abandonCancelled(job, workingPath); return; }

      // Step 4: encode.
      setPhase(job.id, 'encoding_audio', 10);
      const coverPath = availableCoverPath(draft.cover_path);
      if (draft.cover_path && !coverPath) log.warn({ jobId: job.id, jobRef: job.id.slice(0, 8) }, 'Optional audiobook cover was unavailable; continuing without it');
      await (options.convert ?? convertToM4b)({
        ffmpegPath: options.ffmpegPath ?? 'ffmpeg',
        ffprobePath: options.ffprobePath ?? 'ffprobe',
        outputPath: workingPath,
        coverPath,
        bitrateKbps: job.bitrate_kbps,
        metadata: resolvedMetadata,
        embeddedCoverSourcePath: !coverPath && firstInspection?.embeddedCover ? rows[0]?.storage_path : undefined,
        sources: chapters.map((chapter) => { const row = rowById.get(chapter.sourceId)!; return { path: row.storage_path, title: chapter.title, durationMs: row.duration_ms }; }),
        onProgress: (progress) => setPhase(job.id, 'encoding_audio', Math.min(94, Math.max(10, Math.round(10 + progress * 0.84)))),
        onPhase: (phase) => setPhase(job.id, phase, phase === 'validating_output' ? 96 : 10),
        onChild: (child) => children.set(job.id, child)
      });

      // Step 5: validate and publish.
      setPhase(job.id, 'validating_output', 96);
      if (jobs.jobIsCancelled(job.id)) { await abandonCancelled(job, workingPath); return; }
      const exportPath = job.destination === 'output' ? await publishOutputWorkingPath(workingPath, paths.outputDir, safeDownloadName(job.title)) : null;
      const finishedAt = Date.now();
      sqlite.prepare("UPDATE jobs SET status = 'completed', phase = 'completed', progress = 100, output_path = ?, export_path = ?, retryable = 0, finished_at = ?, updated_at = ? WHERE id = ?").run(exportPath ?? workingPath, exportPath, finishedAt, finishedAt, job.id);
      recordForecastSample(job.id, finishedAt);
      sqlite.prepare("UPDATE jobs SET retryable = 0 WHERE draft_id = ? AND status = 'failed'").run(job.draft_id);
      await cleanupUploadedDraft(job.draft_id);
    } catch (error) {
      await handleFailure(job, rows.length, workingPath, error);
    } finally {
      children.delete(job.id);
    }
  }

  function recordForecastSample(jobId: string, finishedAt: number) {
    const completed = sqlite.prepare('SELECT owner_id, source_bytes, source_duration_ms, started_at FROM jobs WHERE id = ?').get(jobId) as Pick<JobRow, 'owner_id' | 'source_bytes' | 'source_duration_ms' | 'started_at'>;
    if (completed.source_bytes > 0 && completed.source_duration_ms > 0 && completed.started_at) {
      sqlite.prepare('INSERT OR REPLACE INTO conversion_samples (id, owner_id, source_bytes, source_duration_ms, processing_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(jobId, completed.owner_id, completed.source_bytes, completed.source_duration_ms, Math.max(1, finishedAt - completed.started_at), finishedAt);
    }
  }

  async function handleFailure(job: JobRow, sourceCount: number, workingPath: string | null, error: unknown) {
    if (shuttingDown) {
      // The process is stopping: put the job back so it restarts first after the next start.
      sqlite.prepare("UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), job.id);
      return;
    }
    const cancelled = jobs.jobIsCancelled(job.id);
    if (workingPath) await discardOutputWorkingPath(workingPath);
    if (cancelled) {
      // Cancelled uploads are removed like cancelled queued uploads; failed uploads stay available for retry.
      await cleanupUploadedDraft(job.draft_id).catch((cleanupError: unknown) => log.warn({ err: cleanupError, jobId: job.id }, 'Cancelled upload cleanup could not be completed'));
      return;
    }
    const diagnostic = error instanceof Error ? error : new Error(String(error));
    const jobRef = job.id.slice(0, 8);
    const failedState = sqlite.prepare('SELECT phase, progress FROM jobs WHERE id = ?').get(job.id) as { phase: JobPhase; progress: number } | undefined;
    const validation = /validation/i.test(diagnostic.message);
    const failure = error instanceof JobFailure
      ? error
      : new JobFailure(
        validation ? 'VALIDATION_FAILED' : 'ENGINE_FAILED',
        validation
          ? `The converted file did not pass validation. Check the Vertiku container logs for reference ${jobRef}.`
          : `FFmpeg could not convert this audiobook. Check the Vertiku container logs for reference ${jobRef}.`,
        true
      );
    log.error({ err: diagnostic, jobId: job.id, jobRef, jobPhase: failedState?.phase ?? job.phase, jobProgress: failedState?.progress ?? job.progress, sourceCount, failureCode: failure.code }, 'Conversion job failed');
    const now = Date.now();
    sqlite.prepare("UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, retryable = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(failure.code, failure.message, failure.retryable ? 1 : 0, now, now, job.id);
  }

  function claim() {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const row = sqlite.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
      if (!row) { sqlite.exec('COMMIT'); return undefined; }
      const now = Date.now();
      const changed = sqlite.prepare("UPDATE jobs SET status = 'running', phase = 'reading_sources', progress = 2, error_code = NULL, error_message = NULL, retryable = 0, started_at = ?, finished_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, row.id);
      sqlite.exec('COMMIT');
      return changed.changes === 1 ? row.id : undefined;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }

  /** Jobs that were running when the process stopped are requeued at startup. */
  function requeueInterrupted() {
    sqlite.prepare("UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE status = 'running'").run(Date.now());
  }

  function stopChild(jobId: string) { children.get(jobId)?.kill('SIGTERM'); }

  function beginShutdown() {
    shuttingDown = true;
    for (const child of children.values()) child.kill('SIGTERM');
  }

  return { run, claim, requeueInterrupted, inspectSource, cleanupUploadedDraft, stopChild, beginShutdown };
}

export type ConversionRunner = ReturnType<typeof createConversionRunner>;
