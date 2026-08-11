import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import argon2 from 'argon2';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bookMetadataFromFolderName, chapterTitlesFromFilenames, naturalSort, safeDownloadName } from '../domain/audiobook.js';
import { openDatabase } from './database.js';
import { buildForecastModel, estimateJobRemainingMs, type ForecastSample } from './forecast.js';
import { convertToM4b, inspectAudio, probeAudio, type AudioInspection, type EmbeddedMetadata } from './ffmpeg.js';
import { filesForInputBook, scanInputBooks } from './input-library.js';
import { createOutputWorkingPath, discardOutputWorkingPath, publishOutputWorkingPath } from './output-library.js';
import { createWorkQueue } from './work-queue.js';

const SESSION_HOURS = 8;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);
const COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(12).max(1024) });
const setupSchema = loginSchema.extend({ setupSecret: z.string().min(1).max(2048) });
const passwordResetSchema = z.object({ username: z.string().trim().min(1).max(100), setupSecret: z.string().min(1).max(2048), newPassword: z.string().min(12).max(1024) });
const startSchema = z.object({
  draftId: z.string().uuid(),
  title: z.string().trim().min(1).max(250),
  author: z.string().trim().max(250).optional().default(''),
  narrator: z.string().trim().max(250).optional().default(''),
  year: z.string().trim().regex(/^$|^\d{4}$/).optional().default(''),
  genre: z.string().trim().max(100).optional().default('Audiobook'),
  description: z.string().trim().max(4000).optional().default(''),
  bitrateKbps: z.union([z.literal(64), z.literal(96), z.literal(128)]).default(96),
  destination: z.enum(['output', 'download']).default('output'),
  chapters: z.array(z.object({ sourceId: z.string().uuid(), title: z.string().trim().min(1).max(500) })).min(1).max(500)
});
const inputDraftSchema = z.object({ folderId: z.string().min(1).max(2000) });
const batchStartSchema = z.object({
  items: z.array(z.object({
    folderId: z.string().min(1).max(2000),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    title: z.string().trim().min(1).max(250),
    author: z.string().trim().max(250).optional().default(''),
    narrator: z.string().trim().max(250).optional().default(''),
    year: z.string().trim().regex(/^$|^\d{4}$/).optional().default(''),
    genre: z.string().trim().max(100).optional().default('Audiobook'),
    description: z.string().trim().max(4000).optional().default(''),
    bitrateKbps: z.union([z.literal(64), z.literal(96), z.literal(128)]).default(96),
    destination: z.enum(['output', 'download']).default('output'),
    chapters: z.array(z.object({ filename: z.string().min(1).max(1000), title: z.string().trim().min(1).max(500) })).min(1).max(500)
  })).min(1).max(100)
});
type Session = { token_hash: string; account_id: number; csrf: string; expires_at: number; username: string; role: string };
type DraftSource = { id: string; draft_id: string; original_name: string; storage_path: string; duration_ms: number; size_bytes: number; modified_at: number; sort_order: number };
type StoredChapter = { sourceId: string; title: string };
type StoredMetadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string };
type JobPhase = 'queued' | 'reading_sources' | 'preparing_output' | 'encoding_audio' | 'validating_output' | 'completed';
type JobRow = { id: string; draft_id: string; owner_id: number; status: string; phase: JobPhase; progress: number; title: string; destination: 'output' | 'download'; bitrate_kbps: 64 | 96 | 128; metadata_json: string; chapters_json: string; output_path: string | null; export_path: string | null; error_code: string | null; error_message: string | null; source_fingerprint: string | null; source_bytes: number; source_duration_ms: number; estimated_duration_ms: number; estimated_output_bytes: number; retry_of: string | null; retryable: number; started_at: number | null; finished_at: number | null; archived_at: number | null; created_at: number; updated_at: number };

export type AppOptions = {
  databasePath: string;
  cookieSecure: boolean;
  setupSecret?: string;
  dataDir?: string;
  inputDir?: string;
  outputDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxUploadBytes?: number;
  maxConcurrentJobs?: number;
  passwordResetEnabled?: boolean;
  etaHistoryResetToken?: string;
  convert?: typeof convertToM4b;
  probe?: typeof probeAudio;
  inspect?: typeof inspectAudio;
  staticRoot?: string;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const secretMatches = (actual: string, expected: string) => {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
const normalizedIdentifier = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
const copiedSecretCandidates = (value: string) => {
  const trimmed = value.trim();
  const candidates = new Set([trimmed, trimmed.normalize('NFKC')]);
  const first = trimmed.at(0); const last = trimmed.at(-1);
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    const unquoted = trimmed.slice(1, -1);
    candidates.add(unquoted); candidates.add(unquoted.normalize('NFKC'));
  }
  return [...candidates];
};
const copiedSecretMatches = (actual: string, expected: string) => copiedSecretCandidates(actual).some((candidate) => copiedSecretCandidates(expected).some((configured) => secretMatches(candidate, configured)));
const formatDuration = (milliseconds: number) => {
  const total = Math.round(milliseconds / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const estimateDurationFromBytes = (bytes: number) => Math.max(1_000, Math.round((bytes * 8 / 96_000) * 1000));
const estimateOutputBytes = (durationMs: number, bitrateKbps: number) => Math.ceil((durationMs / 1000) * bitrateKbps * 1000 / 8 * 1.02);
const emptyEmbeddedMetadata = (): EmbeddedMetadata => ({ title: '', author: '', narrator: '', year: '', genre: '', description: '' });

class JobFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) { super(message); }
}

export async function buildApp(options: AppOptions) {
  const dataDir = resolve(options.dataDir ?? dirname(options.databasePath));
  const uploadsDir = join(dataDir, 'uploads');
  const resultsDir = join(dataDir, 'results');
  const inputDir = resolve(options.inputDir ?? '/input');
  const outputDir = resolve(options.outputDir ?? '/output');
  mkdirSync(dirname(options.databasePath), { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'body.password', 'body.newPassword', 'body.setupSecret'] }, trustProxy: false, bodyLimit: 10 * 1024 * 1024 });
  const { sqlite } = openDatabase(options.databasePath);
  type AccountRecord = { id: number; username: string; password_hash: string; role: string };
  const accountByUsername = (username: string) => {
    const direct = sqlite.prepare('SELECT id, username, password_hash, role FROM accounts WHERE username = ? COLLATE NOCASE').get(username.trim()) as AccountRecord | undefined;
    if (direct) return direct;
    const normalized = normalizedIdentifier(username);
    return (sqlite.prepare('SELECT id, username, password_hash, role FROM accounts').all() as unknown as AccountRecord[]).find((account) => normalizedIdentifier(account.username) === normalized);
  };
  if (options.etaHistoryResetToken) {
    const resetTokenHash = hashToken(options.etaHistoryResetToken);
    const previous = sqlite.prepare("SELECT value FROM system_settings WHERE key = 'eta_history_reset_token_hash'").get() as { value: string } | undefined;
    if (previous?.value !== resetTokenHash) {
      const resetAt = Date.now();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.prepare('DELETE FROM conversion_samples').run();
        sqlite.prepare("INSERT INTO system_settings (key, value) VALUES ('eta_history_reset_token_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(resetTokenHash);
        sqlite.prepare("INSERT INTO system_settings (key, value) VALUES ('eta_history_reset_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(resetAt));
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  }
  const cookieName = options.cookieSecure ? '__Host-vertiku_session' : 'vertiku_session';
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  let shuttingDown = false;
  let passwordResetAvailable = options.passwordResetEnabled === true;
  await app.register(cookie);
  await app.register(helmet, {
    hsts: options.cookieSecure,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: options.cookieSecure ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 501, fileSize: options.maxUploadBytes ?? 10 * 1024 ** 3, fields: 20, parts: 530 } });

  async function inspectSource(path: string): Promise<AudioInspection> {
    if (options.inspect) return options.inspect(options.ffprobePath ?? 'ffprobe', path);
    if (options.probe) return { durationMs: await options.probe(options.ffprobePath ?? 'ffprobe', path), metadata: emptyEmbeddedMetadata(), embeddedCover: false };
    return inspectAudio(options.ffprobePath ?? 'ffprobe', path);
  }

  function audit(eventType: string, targetAccountId: number | null, outcome: 'success' | 'failure', requestId: string) {
    sqlite.prepare('INSERT INTO audit_events (id, event_type, target_account_id, outcome, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), eventType, targetAccountId, outcome, requestId, Date.now());
  }

  function sessionFor(request: FastifyRequest): Session | undefined {
    const token = request.cookies[cookieName];
    if (!token) return undefined;
    const session = sqlite.prepare(`SELECT s.token_hash, s.account_id, s.csrf, s.expires_at, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).get(hashToken(token)) as Session | undefined;
    if (!session || session.expires_at <= Date.now()) {
      if (session) sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
      return undefined;
    }
    sqlite.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), session.token_hash);
    return session;
  }

  function requireSession(request: FastifyRequest, reply: FastifyReply, requireCsrf = false): Session | undefined {
    const session = sessionFor(request);
    if (!session) { void reply.code(401).send({ code: 'AUTH_REQUIRED', message: 'Sign in to continue.', requestId: request.id }); return undefined; }
    if (requireCsrf && request.headers['x-csrf-token'] !== session.csrf) { void reply.code(403).send({ code: 'CSRF_INVALID', message: 'Request denied.', requestId: request.id }); return undefined; }
    return session;
  }

  function forecastModel(ownerId: number, running?: JobRow, now = Date.now()) {
    const samples = sqlite.prepare('SELECT source_bytes, source_duration_ms, processing_ms FROM conversion_samples WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50').all(ownerId) as ForecastSample[];
    return buildForecastModel(samples, running, now);
  }

  function pathIsWithin(root: string, target: string) {
    const relativePath = relative(resolve(root), resolve(target));
    return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  }

  function trustedExistingCover(path: string) {
    try {
      const actualPath = realpathSync(path);
      const trusted = [inputDir, uploadsDir].some((root) => {
        try { return pathIsWithin(realpathSync(root), actualPath); } catch { return false; }
      });
      return trusted && statSync(actualPath).isFile() ? actualPath : undefined;
    } catch { return undefined; }
  }

  function availableCoverPath(storedPath: string | null) {
    if (!storedPath) return undefined;
    const direct = trustedExistingCover(storedPath);
    if (direct) return direct;
    if (![inputDir, uploadsDir].some((root) => pathIsWithin(root, storedPath))) return undefined;
    try {
      const expectedName = basename(storedPath).toLowerCase();
      const matchingEntry = readdirSync(dirname(storedPath), { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.toLowerCase() === expectedName);
      return matchingEntry ? trustedExistingCover(join(dirname(storedPath), matchingEntry.name)) : undefined;
    } catch { return undefined; }
  }

  function estimatedRemainingMs(row: JobRow, model: ReturnType<typeof buildForecastModel>, now = Date.now()) {
    return estimateJobRemainingMs(row, model, now);
  }

  function publicJob(row: JobRow, model = forecastModel(row.owner_id, row.status === 'running' ? row : undefined)) {
    const position = row.status === 'queued' ? Number((sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id <= ?))").get(row.created_at, row.created_at, row.id) as { count: number }).count) : undefined;
    const phase = row.status === 'completed' ? 'completed' : row.phase;
    const remainingMs = row.status === 'running' ? estimatedRemainingMs(row, model) : 0;
    return { id: row.id, status: row.status, phase, progress: row.progress, queuePosition: position, title: row.title, destination: row.destination, outputName: row.export_path ? basename(row.export_path) : undefined, error: row.error_message ? { code: row.error_code, message: row.error_message, retryable: Boolean(row.retryable) } : undefined, downloadReady: row.status === 'completed' && row.destination === 'download', mediaReady: row.status === 'completed' && Boolean(row.output_path && existsSync(row.output_path)), retryable: row.status === 'failed' && Boolean(row.retryable), retryOf: row.retry_of ?? undefined, sourceDurationMs: row.source_duration_ms || row.estimated_duration_ms, estimatedOutputBytes: row.estimated_output_bytes, estimatedRemainingSeconds: remainingMs ? Math.max(1, Math.round(remainingMs / 1000)) : undefined, estimatedFinishAt: remainingMs ? new Date(Date.now() + remainingMs).toISOString() : undefined, estimateConfidence: model.confidence, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }

  function queueSummary(ownerId: number) {
    const rows = sqlite.prepare("SELECT * FROM jobs WHERE owner_id = ? AND status IN ('running','queued') ORDER BY created_at, id").all(ownerId) as JobRow[];
    const now = Date.now();
    const running = rows.find((row) => row.status === 'running');
    const model = forecastModel(ownerId, running, now);
    const currentRemainingMs = running ? estimatedRemainingMs(running, model, now) : 0;
    const queued = rows.filter((row) => row.status === 'queued');
    const queuedRemainingMs = queued.reduce((sum, row) => sum + estimatedRemainingMs(row, model, now), 0);
    const remainingMs = currentRemainingMs + queuedRemainingMs;
    return { remainingJobs: rows.length, queuedJobs: queued.length, queuedSourceBytes: queued.reduce((sum, row) => sum + row.source_bytes, 0), estimatedQueuedSeconds: Math.max(0, Math.round(queuedRemainingMs / 1000)), estimatedRemainingSeconds: Math.max(0, Math.round(remainingMs / 1000)), estimatedFinishAt: rows.length ? new Date(now + remainingMs).toISOString() : undefined, currentJobId: running?.id, currentJobEstimatedRemainingSeconds: running ? Math.max(1, Math.round(currentRemainingMs / 1000)) : undefined, currentJobEstimatedFinishAt: running ? new Date(now + currentRemainingMs).toISOString() : undefined, confidence: model.confidence, forecastBasis: model.basis, forecastSampleCount: model.sampleCount };
  }

  async function cleanupUploadedDraft(draftId: string) {
    await rm(join(uploadsDir, draftId), { recursive: true, force: true });
  }

  function sessionIsActive(session: Session): boolean {
    const row = sqlite.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(session.token_hash) as { expires_at: number } | undefined;
    return Boolean(row && row.expires_at > Date.now());
  }

  async function runQueuedJob(jobId: string) {
    const job = sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
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
        if ((sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined)?.status === 'cancelled') {
          if (workingPath) await discardOutputWorkingPath(workingPath);
          await cleanupUploadedDraft(job.draft_id);
          return;
        }
      }
      sqlite.prepare("UPDATE jobs SET phase = 'preparing_output', progress = 8, updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), job.id);
      const totalDurationMs = rows.reduce((sum, row) => sum + row.duration_ms, 0);
      const resolvedMetadata: StoredMetadata = {
        title: metadata.title || firstInspection?.metadata.title || job.title,
        author: metadata.author || firstInspection?.metadata.author || '',
        narrator: metadata.narrator || firstInspection?.metadata.narrator || '',
        year: metadata.year || firstInspection?.metadata.year || '',
        genre: metadata.genre || firstInspection?.metadata.genre || 'Audiobook',
        description: metadata.description || firstInspection?.metadata.description || ''
      };
      const outputEstimate = estimateOutputBytes(totalDurationMs, job.bitrate_kbps);
      sqlite.prepare('UPDATE jobs SET metadata_json = ?, source_duration_ms = ?, estimated_output_bytes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(resolvedMetadata), totalDurationMs, outputEstimate, Date.now(), job.id);
      workingPath = job.destination === 'output'
        ? await createOutputWorkingPath(outputDir, job.id)
        : (job.output_path ?? join(resultsDir, job.id, safeDownloadName(job.title)));
      mkdirSync(dirname(workingPath), { recursive: true });
      try {
        const storage = statfsSync(dirname(workingPath));
        const available = Number(storage.bavail) * Number(storage.bsize);
        if (available < outputEstimate * 1.1) throw new JobFailure('OUTPUT_STORAGE_LOW', 'The destination does not have enough free space for the estimated result.', true);
      } catch (error) { if (error instanceof JobFailure) throw error; }
      sqlite.prepare('UPDATE jobs SET output_path = ?, updated_at = ? WHERE id = ?').run(workingPath, Date.now(), job.id);
      sqlite.prepare("UPDATE jobs SET phase = 'encoding_audio', progress = 10, updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), job.id);
      const coverPath = availableCoverPath(draft.cover_path);
      if (draft.cover_path && !coverPath) app.log.warn({ jobId: job.id, jobRef: job.id.slice(0, 8) }, 'Optional audiobook cover was unavailable; continuing without it');
      await (options.convert ?? convertToM4b)({
        ffmpegPath: options.ffmpegPath ?? 'ffmpeg', ffprobePath: options.ffprobePath ?? 'ffprobe', outputPath: workingPath, coverPath, bitrateKbps: job.bitrate_kbps,
        metadata: resolvedMetadata,
        embeddedCoverSourcePath: !coverPath && firstInspection?.embeddedCover ? rows[0]?.storage_path : undefined,
        sources: chapters.map((chapter) => { const row = rowById.get(chapter.sourceId)!; return { path: row.storage_path, title: chapter.title, durationMs: row.duration_ms }; }),
        onProgress: (progress) => sqlite.prepare("UPDATE jobs SET phase = 'encoding_audio', progress = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(Math.min(94, Math.max(10, Math.round(10 + progress * 0.84))), Date.now(), job.id),
        onPhase: (phase) => sqlite.prepare("UPDATE jobs SET phase = ?, progress = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(phase, phase === 'validating_output' ? 96 : 10, Date.now(), job.id),
        onChild: (child) => children.set(job.id, child)
      });
      sqlite.prepare("UPDATE jobs SET phase = 'validating_output', progress = 96, updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), job.id);
      const status = (sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined)?.status;
      if (status === 'cancelled') {
        if (workingPath) await discardOutputWorkingPath(workingPath);
        await cleanupUploadedDraft(job.draft_id);
        return;
      }
      const exportPath = job.destination === 'output' ? await publishOutputWorkingPath(workingPath, outputDir, safeDownloadName(job.title)) : null;
      const storedPath = exportPath ?? workingPath;
      const finishedAt = Date.now();
      sqlite.prepare("UPDATE jobs SET status = 'completed', phase = 'completed', progress = 100, output_path = ?, export_path = ?, retryable = 0, finished_at = ?, updated_at = ? WHERE id = ?").run(storedPath, exportPath, finishedAt, finishedAt, job.id);
      const completed = sqlite.prepare('SELECT owner_id, source_bytes, source_duration_ms, started_at FROM jobs WHERE id = ?').get(job.id) as Pick<JobRow, 'owner_id' | 'source_bytes' | 'source_duration_ms' | 'started_at'>;
      if (completed.source_bytes > 0 && completed.source_duration_ms > 0 && completed.started_at) {
        sqlite.prepare('INSERT OR REPLACE INTO conversion_samples (id, owner_id, source_bytes, source_duration_ms, processing_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(job.id, completed.owner_id, completed.source_bytes, completed.source_duration_ms, Math.max(1, finishedAt - completed.started_at), finishedAt);
      }
      sqlite.prepare("UPDATE jobs SET retryable = 0 WHERE draft_id = ? AND status = 'failed'").run(job.draft_id);
      await cleanupUploadedDraft(job.draft_id);
    } catch (error) {
      if (shuttingDown) {
        sqlite.prepare("UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), job.id);
        return;
      }
      const cancelled = (sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined)?.status === 'cancelled';
      if (workingPath) await discardOutputWorkingPath(workingPath);
      if (!cancelled) {
        const diagnostic = error instanceof Error ? error : new Error(String(error));
        const jobRef = job.id.slice(0, 8);
        const failedState = sqlite.prepare('SELECT phase, progress FROM jobs WHERE id = ?').get(job.id) as { phase: JobPhase; progress: number } | undefined;
        const failure = error instanceof JobFailure
          ? error
          : new JobFailure(
            /validation/i.test(diagnostic.message) ? 'VALIDATION_FAILED' : 'ENGINE_FAILED',
            /validation/i.test(diagnostic.message)
              ? `The converted file did not pass validation. Check the Vertiku container logs for reference ${jobRef}.`
              : `FFmpeg could not convert this audiobook. Check the Vertiku container logs for reference ${jobRef}.`,
            true
          );
        app.log.error({ err: diagnostic, jobId: job.id, jobRef, jobPhase: failedState?.phase ?? job.phase, jobProgress: failedState?.progress ?? job.progress, sourceCount: rows.length, failureCode: failure.code }, 'Conversion job failed');
        sqlite.prepare("UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, retryable = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(failure.code, failure.message, failure.retryable ? 1 : 0, Date.now(), Date.now(), job.id);
      }
    } finally {
      children.delete(job.id);
    }
  }

  function claimQueuedJob() {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const row = sqlite.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
      if (!row) { sqlite.exec('COMMIT'); return undefined; }
      const changed = sqlite.prepare("UPDATE jobs SET status = 'running', phase = 'reading_sources', progress = 2, error_code = NULL, error_message = NULL, retryable = 0, started_at = ?, finished_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), Date.now(), row.id);
      sqlite.exec('COMMIT');
      return changed.changes === 1 ? row.id : undefined;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }

  sqlite.prepare("UPDATE jobs SET status = 'queued', phase = 'queued', progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE status = 'running'").run(Date.now());
  const workQueue = createWorkQueue({ concurrency: 1, claim: claimQueuedJob, run: runQueuedJob });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ code: 'UPLOAD_TOO_LARGE', message: 'One of the selected files exceeds the configured upload limit.', requestId: request.id });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests. Try again later.', requestId: request.id });
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Vertiku could not complete the request.', requestId: request.id });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    try { sqlite.prepare('SELECT 1').get(); return { status: 'ready', database: 'ok', storage: 'ok', input: existsSync(inputDir) ? 'mounted' : 'not-mounted', output: existsSync(outputDir) ? 'mounted' : 'not-mounted' }; } catch { return reply.code(503).send({ status: 'not-ready' }); }
  });
  app.get('/api/manifest', async () => ({ id: 'vertiku', name: 'Vertiku', version: process.env.APP_VERSION ?? '0.5.2', buildDate: process.env.BUILD_DATE ?? 'development', gitSha: process.env.GIT_SHA ?? 'development' }));
  app.get('/api/setup/status', async () => ({ required: Number((sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count) === 0, passwordResetEnabled: passwordResetAvailable }));

  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    if ((sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count > 0) return reply.code(409).send({ code: 'SETUP_CLOSED', message: 'Initial setup is already complete.', requestId: request.id });
    const input = setupSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Enter a username, a password of at least 12 characters, and the setup secret.', requestId: request.id });
    if (!options.setupSecret) return reply.code(503).send({ code: 'SETUP_SECRET_MISSING', message: 'The server administrator must configure ISHIKU_SETUP_SECRET.', requestId: request.id });
    if (!copiedSecretMatches(input.data.setupSecret, options.setupSecret) || copiedSecretMatches(input.data.password, options.setupSecret)) return reply.code(403).send({ code: 'SETUP_DENIED', message: 'Setup could not be authorized.', requestId: request.id });
    const passwordHash = await argon2.hash(input.data.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    sqlite.prepare("INSERT INTO accounts (username, password_hash, role) VALUES (?, ?, 'admin')").run(input.data.username, passwordHash);
    return reply.code(201).send({ created: true });
  });

  app.post('/api/session', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const input = loginSchema.safeParse(request.body);
    const account = input.success ? accountByUsername(input.data.username) : undefined;
    const valid = account && input.success ? await argon2.verify(account.password_hash, input.data.password) : false;
    if (!valid || !account) { audit('sign_in', account?.id ?? null, 'failure', request.id); return reply.code(401).send({ code: 'AUTH_INVALID', message: 'Invalid credentials.', requestId: request.id }); }
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url'); const now = Date.now();
    sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    sqlite.prepare('INSERT INTO sessions (token_hash, account_id, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(hashToken(token), account.id, csrf, now, now, now + SESSION_HOURS * 60 * 60 * 1000);
    reply.setCookie(cookieName, token, { path: '/', httpOnly: true, secure: options.cookieSecure, sameSite: 'strict', maxAge: SESSION_HOURS * 60 * 60 });
    audit('sign_in', account.id, 'success', request.id);
    return { csrf, user: { username: account.username, role: account.role } };
  });
  app.post('/api/password-reset', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = passwordResetSchema.safeParse(request.body);
    const account = input.success ? accountByUsername(input.data.username) : undefined;
    const secretValid = Boolean(input.success && options.setupSecret && copiedSecretMatches(input.data.setupSecret, options.setupSecret));
    const passwordReusesSetupSecret = Boolean(input.success && options.setupSecret && copiedSecretMatches(input.data.newPassword, options.setupSecret));
    const authorized = passwordResetAvailable && input.success && options.setupSecret && account && secretValid && !passwordReusesSetupSecret;
    if (!authorized || !input.success || !account) {
      const reason = !passwordResetAvailable ? 'disabled' : !input.success ? 'invalid_payload' : !options.setupSecret ? 'missing_configured_secret' : !account ? 'unknown_account' : passwordReusesSetupSecret ? 'new_password_matches_secret' : 'secret_mismatch';
      request.log.warn({ reason }, 'Password recovery denied');
      audit('password_reset', account?.id ?? null, 'failure', request.id);
      return reply.code(403).send({ code: 'PASSWORD_RESET_DENIED', message: 'Password recovery could not be authorized.', requestId: request.id });
    }
    const passwordHash = await argon2.hash(input.data.newPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, account.id);
      sqlite.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
      audit('password_reset', account.id, 'success', request.id);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    passwordResetAvailable = false;
    return reply.code(204).send();
  });
  app.get('/api/session', async (request, reply) => { const session = requireSession(request, reply); return session ? { csrf: session.csrf, user: { username: session.username, role: session.role } } : reply; });
  app.delete('/api/session', async (request, reply) => { const session = requireSession(request, reply, true); if (!session) return reply; sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash); reply.clearCookie(cookieName, { path: '/' }); return reply.code(204).send(); });

  app.post('/api/drafts', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const draftId = randomUUID(); const draftDir = join(uploadsDir, draftId); mkdirSync(draftDir, { recursive: true });
    const uploaded: Array<{ id: string; originalName: string; storagePath: string; inspection: AudioInspection; sizeBytes: number; modifiedAt: number }> = [];
    let coverPath: string | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        const originalName = part.filename ?? 'unnamed'; const extension = extname(originalName).toLowerCase();
        if (part.fieldname === 'cover') {
          if (!COVER_EXTENSIONS.has(extension) || !part.mimetype.startsWith('image/')) throw new Error('Unsupported cover image.');
          coverPath = join(draftDir, `cover${extension}`); await pipeline(part.file, createWriteStream(coverPath, { mode: 0o600 }));
          continue;
        }
        if (part.fieldname !== 'files' || !AUDIO_EXTENSIONS.has(extension) || !part.mimetype.startsWith('audio/')) throw new Error(`Unsupported audio file: ${originalName}`);
        const id = randomUUID(); const storagePath = join(draftDir, `${id}${extension}`); await pipeline(part.file, createWriteStream(storagePath, { mode: 0o600 }));
        const inspection = await inspectSource(storagePath); const stat = statSync(storagePath);
        uploaded.push({ id, originalName, storagePath, inspection, sizeBytes: stat.size, modifiedAt: Math.trunc(stat.mtimeMs) });
      }
      if (uploaded.length === 0) throw new Error('Select at least one supported audio file.');
      const sorted = naturalSort(uploaded, (source) => source.originalName);
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, ?, ?, ?)').run(draftId, session.account_id, coverPath ?? null, Date.now());
        const insert = sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, size_bytes, modified_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        sorted.forEach((source, index) => insert.run(source.id, draftId, source.originalName, source.storagePath, source.inspection.durationMs, source.sizeBytes, source.modifiedAt, index));
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      const titles = chapterTitlesFromFilenames(sorted.map((source) => source.originalName));
      const embedded = sorted[0]?.inspection.metadata ?? emptyEmbeddedMetadata();
      return reply.code(201).send({ id: draftId, cover: Boolean(coverPath || sorted[0]?.inspection.embeddedCover), suggestedMetadata: embedded, sources: sorted.map((source, index) => ({ id: source.id, filename: source.originalName, title: titles[index], durationMs: source.inspection.durationMs, duration: formatDuration(source.inspection.durationMs) })) });
    } catch (error) {
      await rm(draftDir, { recursive: true, force: true });
      return reply.code(400).send({ code: 'INVALID_FILE', message: error instanceof Error ? error.message : 'The files could not be analyzed.', requestId: request.id });
    }
  });

  app.get('/api/input-books', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = requireSession(request, reply); if (!session) return reply;
    const books = scanInputBooks(inputDir).map(({ coverPath: _coverPath, files, ...book }) => {
      const suggested = bookMetadataFromFolderName(book.title);
      const titles = chapterTitlesFromFilenames(files, suggested.title);
      const completed = sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status = 'completed' LIMIT 1").get(session.account_id, book.fingerprint) as { id: string } | undefined;
      const active = sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status IN ('queued','running') LIMIT 1").get(session.account_id, book.fingerprint) as { id: string } | undefined;
      const issues = [...book.issues];
      if (completed) issues.push({ code: 'ALREADY_CONVERTED', severity: 'warning' as const, message: 'These exact source files were already converted successfully.' });
      if (active) issues.push({ code: 'ALREADY_QUEUED', severity: 'error' as const, message: 'These exact source files are already queued or running.' });
      if (existsSync(join(outputDir, safeDownloadName(suggested.title)))) issues.push({ code: 'OUTPUT_NAME_COLLISION', severity: 'warning' as const, message: 'The default output filename already exists; Vertiku will allocate a numbered name.' });
      return { ...book, suggestedTitle: suggested.title, suggestedAuthor: suggested.author, issues, needsReview: issues.length > 0, alreadyConvertedJobId: completed?.id, chapters: files.map((filename, index) => ({ filename, title: titles[index]! })) };
    });
    let outputFreeBytes: number | undefined;
    try { const storage = statfsSync(outputDir); outputFreeBytes = Number(storage.bavail) * Number(storage.bsize); } catch { /* Output mount readiness reports availability separately. */ }
    return { mounted: existsSync(inputDir), rootLabel: '/input', outputFreeBytes, books };
  });

  app.post('/api/drafts/from-input', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const input = inputDraftSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Choose a valid input folder.', requestId: request.id });
    try {
      const selected = filesForInputBook(inputDir, input.data.folderId);
      if (!selected.files.length) return reply.code(404).send({ code: 'INPUT_BOOK_EMPTY', message: 'No supported audio files were found in this folder.', requestId: request.id });
      if (selected.files.length > 500) return reply.code(400).send({ code: 'INPUT_BOOK_TOO_LARGE', message: 'An input folder may contain at most 500 audio files.', requestId: request.id });
      const analyzed: Array<{ id: string; originalName: string; storagePath: string; inspection: AudioInspection; sizeBytes: number; modifiedAt: number }> = [];
      for (const file of selected.files) analyzed.push({ id: randomUUID(), originalName: file.name, storagePath: file.path, inspection: await inspectSource(file.path), sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt });
      const draftId = randomUUID(); sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, ?, ?, ?)').run(draftId, session.account_id, selected.coverPath ?? null, Date.now());
        const insert = sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, size_bytes, modified_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        analyzed.forEach((source, index) => insert.run(source.id, draftId, source.originalName, source.storagePath, source.inspection.durationMs, source.sizeBytes, source.modifiedAt, index)); sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      const suggested = bookMetadataFromFolderName(basename(selected.folder));
      const titles = chapterTitlesFromFilenames(analyzed.map((source) => source.originalName), suggested.title);
      const embedded = analyzed[0]?.inspection.metadata ?? emptyEmbeddedMetadata();
      return reply.code(201).send({ id: draftId, cover: Boolean(selected.coverPath || analyzed[0]?.inspection.embeddedCover), suggestedTitle: embedded.title || suggested.title, suggestedAuthor: embedded.author || suggested.author, suggestedMetadata: embedded, sourceFingerprint: selected.fingerprint, sourceBytes: selected.sourceBytes, sources: analyzed.map((source, index) => ({ id: source.id, filename: source.originalName, title: titles[index], durationMs: source.inspection.durationMs, duration: formatDuration(source.inspection.durationMs) })) });
    } catch (error) { return reply.code(400).send({ code: 'INPUT_BOOK_INVALID', message: error instanceof Error ? error.message : 'The input folder could not be analyzed.', requestId: request.id }); }
  });

  app.post('/api/jobs/from-input/batch', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const input = batchStartSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Review every selected audiobook and chapter title.', requestId: request.id, fieldErrors: input.error.flatten().fieldErrors });
    if (new Set(input.data.items.map((item) => item.folderId)).size !== input.data.items.length) return reply.code(400).send({ code: 'BATCH_DUPLICATE_BOOK', message: 'Each input folder may appear only once in a batch.', requestId: request.id });
    try {
      const prepared = input.data.items.map((item, batchIndex) => {
        const selected = filesForInputBook(inputDir, item.folderId);
        if (!selected.files.length || selected.files.length > 500) throw new Error('Each selected folder must contain between 1 and 500 supported audio files.');
        if (item.fingerprint && item.fingerprint !== selected.fingerprint) throw new Error(`The source files changed in ${item.folderId}. Refresh the input library and review it again.`);
        if (sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status IN ('queued','running') LIMIT 1").get(session.account_id, selected.fingerprint)) throw new Error(`The audiobook in ${item.folderId} is already queued or running.`);
        const submitted = new Map(item.chapters.map((chapter) => [chapter.filename, chapter.title]));
        if (submitted.size !== selected.files.length || item.chapters.length !== selected.files.length || selected.files.some((file) => !submitted.has(file.name))) throw new Error(`The chapter files changed in ${item.folderId}. Refresh the input library and review it again.`);
        const draftId = randomUUID(); const jobId = randomUUID(); const now = Date.now() + batchIndex;
        const sources = selected.files.map((file, index) => ({ id: randomUUID(), originalName: file.name, storagePath: file.path, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, title: submitted.get(file.name)!, sortOrder: index }));
        const metadata: StoredMetadata = { title: '', author: '', narrator: '', year: '', genre: '', description: '' };
        const chapters: StoredChapter[] = sources.map((source) => ({ sourceId: source.id, title: source.title }));
        const outputPath = item.destination === 'output' ? join(outputDir, `.vertiku-${jobId}.partial.m4b`) : join(resultsDir, jobId, safeDownloadName(item.title));
        const estimatedDurationMs = estimateDurationFromBytes(selected.sourceBytes);
        return { item, selected, draftId, jobId, now, sources, metadata, chapters, outputPath, estimatedDurationMs, estimatedOutputBytes: estimateOutputBytes(estimatedDurationMs, item.bitrateKbps) };
      });
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const insertDraft = sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, ?, ?, ?)');
        const insertSource = sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, size_bytes, modified_at, sort_order) VALUES (?, ?, ?, ?, 0, ?, ?, ?)');
        const insertJob = sqlite.prepare("INSERT INTO jobs (id, draft_id, owner_id, status, progress, title, destination, bitrate_kbps, metadata_json, chapters_json, output_path, source_fingerprint, source_bytes, estimated_duration_ms, estimated_output_bytes, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const entry of prepared) {
          insertDraft.run(entry.draftId, session.account_id, entry.selected.coverPath ?? null, entry.now);
          for (const source of entry.sources) insertSource.run(source.id, entry.draftId, source.originalName, source.storagePath, source.sizeBytes, source.modifiedAt, source.sortOrder);
          insertJob.run(entry.jobId, entry.draftId, session.account_id, entry.item.title, entry.item.destination, entry.item.bitrateKbps, JSON.stringify(entry.metadata), JSON.stringify(entry.chapters), entry.outputPath, entry.selected.fingerprint, entry.selected.sourceBytes, entry.estimatedDurationMs, entry.estimatedOutputBytes, entry.now, entry.now);
        }
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      workQueue.wake();
      const jobs = prepared.map((entry) => publicJob(sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(entry.jobId) as JobRow));
      return reply.code(202).send({ accepted: jobs.length, jobs });
    } catch (error) { return reply.code(400).send({ code: 'BATCH_INVALID', message: error instanceof Error ? error.message : 'The batch could not be queued.', requestId: request.id }); }
  });

  app.post('/api/jobs', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const input = startSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Review the audiobook metadata and every chapter title.', requestId: request.id, fieldErrors: input.error.flatten().fieldErrors });
    const draft = sqlite.prepare('SELECT id, cover_path FROM drafts WHERE id = ? AND owner_id = ?').get(input.data.draftId, session.account_id) as { id: string; cover_path: string | null } | undefined;
    if (!draft) return reply.code(404).send({ code: 'DRAFT_NOT_FOUND', message: 'The upload draft was not found.', requestId: request.id });
    const rows = sqlite.prepare('SELECT * FROM draft_sources WHERE draft_id = ?').all(draft.id) as DraftSource[];
    const rowById = new Map(rows.map((row) => [row.id, row]));
    if (input.data.chapters.some((chapter) => !rowById.has(chapter.sourceId)) || new Set(input.data.chapters.map((chapter) => chapter.sourceId)).size !== rows.length) return reply.code(400).send({ code: 'CHAPTER_SET_INVALID', message: 'Each uploaded file must appear exactly once.', requestId: request.id });
    const existing = sqlite.prepare("SELECT id FROM jobs WHERE draft_id = ? AND status IN ('queued','running','completed')").get(draft.id);
    if (existing) return reply.code(409).send({ code: 'DRAFT_ALREADY_QUEUED', message: 'This draft already has a conversion job.', requestId: request.id });
    const jobId = randomUUID();
    const resultDir = join(resultsDir, jobId);
    const outputPath = input.data.destination === 'output' ? await createOutputWorkingPath(outputDir, jobId) : join(resultDir, safeDownloadName(input.data.title));
    if (input.data.destination === 'download') mkdirSync(resultDir, { recursive: true });
    const metadata: StoredMetadata = { title: input.data.title, author: input.data.author, narrator: input.data.narrator, year: input.data.year, genre: input.data.genre, description: input.data.description };
    const sourceBytes = rows.reduce((sum, row) => sum + row.size_bytes, 0);
    const sourceDurationMs = rows.reduce((sum, row) => sum + row.duration_ms, 0);
    const sourceFingerprint = createHash('sha256').update(rows.sort((left, right) => left.sort_order - right.sort_order).map((row) => `${row.original_name}\0${row.size_bytes}\0${row.modified_at}`).join('\n')).digest('hex');
    const now = Date.now();
    sqlite.prepare("INSERT INTO jobs (id, draft_id, owner_id, status, progress, title, destination, bitrate_kbps, metadata_json, chapters_json, output_path, source_fingerprint, source_bytes, source_duration_ms, estimated_duration_ms, estimated_output_bytes, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, draft.id, session.account_id, input.data.title, input.data.destination, input.data.bitrateKbps, JSON.stringify(metadata), JSON.stringify(input.data.chapters), outputPath, sourceFingerprint, sourceBytes, sourceDurationMs, sourceDurationMs, estimateOutputBytes(sourceDurationMs, input.data.bitrateKbps), now, now);
    workQueue.wake();
    const queued = sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
    return reply.code(202).send(publicJob(queued));
  });

  async function retryFailedJob(row: JobRow, ownerId: number) {
    if (row.owner_id !== ownerId || row.status !== 'failed' || !row.retryable) throw new JobFailure('JOB_NOT_RETRYABLE', 'This failed job cannot be retried.', false);
    if (sqlite.prepare("SELECT id FROM jobs WHERE draft_id = ? AND status IN ('queued','running') LIMIT 1").get(row.draft_id)) throw new JobFailure('JOB_ALREADY_RETRIED', 'This audiobook already has a queued or running retry.', false);
    const sources = sqlite.prepare('SELECT * FROM draft_sources WHERE draft_id = ? ORDER BY sort_order').all(row.draft_id) as DraftSource[];
    if (!sources.length || sources.some((source) => !existsSync(source.storage_path))) throw new JobFailure('SOURCE_MISSING', 'The original source files are no longer available.', false);
    let sourceBytes = 0;
    for (const source of sources) {
      const stat = statSync(source.storage_path);
      sourceBytes += stat.size;
      if (stat.size !== source.size_bytes || Math.trunc(stat.mtimeMs) !== source.modified_at) sqlite.prepare('UPDATE draft_sources SET duration_ms = 0, size_bytes = ?, modified_at = ? WHERE id = ?').run(stat.size, Math.trunc(stat.mtimeMs), source.id);
    }
    const sourceFingerprint = createHash('sha256').update(sources.map((source) => { const stat = statSync(source.storage_path); return `${source.original_name}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`; }).join('\n')).digest('hex');
    const jobId = randomUUID(); const now = Date.now();
    const outputPath = row.destination === 'output' ? await createOutputWorkingPath(outputDir, jobId) : join(resultsDir, jobId, safeDownloadName(row.title));
    if (row.destination === 'download') mkdirSync(dirname(outputPath), { recursive: true });
    const estimatedDurationMs = row.source_duration_ms || estimateDurationFromBytes(sourceBytes);
    sqlite.prepare("INSERT INTO jobs (id, draft_id, owner_id, status, progress, title, destination, bitrate_kbps, metadata_json, chapters_json, output_path, source_fingerprint, source_bytes, source_duration_ms, estimated_duration_ms, estimated_output_bytes, retry_of, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, row.draft_id, ownerId, row.title, row.destination, row.bitrate_kbps, row.metadata_json, row.chapters_json, outputPath, sourceFingerprint, sourceBytes, 0, estimatedDurationMs, estimateOutputBytes(estimatedDurationMs, row.bitrate_kbps), row.id, now, now);
    return sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
  }

  app.get('/api/jobs', async (request, reply) => { const session = requireSession(request, reply); if (!session) return reply; const rows = sqlite.prepare('SELECT * FROM jobs WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 250').all(session.account_id) as JobRow[]; const running = rows.find((row) => row.status === 'running'); const model = forecastModel(session.account_id, running); return { jobs: rows.map((row) => publicJob(row, model)), queue: queueSummary(session.account_id) }; });
  app.get('/api/jobs/events', async (request, reply) => {
    const session = requireSession(request, reply); if (!session) return reply;
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    let previous = '';
    const send = () => { if (!sessionIsActive(session)) { clearInterval(timer); reply.raw.end(); return; } const rows = sqlite.prepare('SELECT * FROM jobs WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 250').all(session.account_id) as JobRow[]; const running = rows.find((row) => row.status === 'running'); const model = forecastModel(session.account_id, running); const data = JSON.stringify({ jobs: rows.map((row) => publicJob(row, model)), queue: queueSummary(session.account_id) }); if (data !== previous) { previous = data; reply.raw.write(`event: jobs\ndata: ${data}\n\n`); } };
    const timer = setInterval(send, 750); send(); request.raw.on('close', () => clearInterval(timer)); return reply;
  });
  app.get('/api/jobs/:id', async (request, reply) => { const session = requireSession(request, reply); if (!session) return reply; const { id } = request.params as { id: string }; const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND archived_at IS NULL').get(id, session.account_id) as JobRow | undefined; return row ? publicJob(row) : reply.code(404).send({ code: 'JOB_NOT_FOUND', message: 'The job was not found.', requestId: request.id }); });
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const session = requireSession(request, reply); if (!session) return reply;
    const { id } = request.params as { id: string }; const exists = sqlite.prepare('SELECT id FROM jobs WHERE id = ? AND owner_id = ?').get(id, session.account_id); if (!exists) return reply.code(404).send({ code: 'JOB_NOT_FOUND', message: 'The job was not found.', requestId: request.id });
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const send = () => { if (!sessionIsActive(session)) { clearInterval(timer); reply.raw.end(); return; } const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?').get(id, session.account_id) as JobRow | undefined; if (!row) return; reply.raw.write(`event: job\ndata: ${JSON.stringify(publicJob(row))}\n\n`); if (['completed', 'failed', 'cancelled'].includes(row.status)) { clearInterval(timer); reply.raw.end(); } };
    const timer = setInterval(send, 750); send(); request.raw.on('close', () => clearInterval(timer)); return reply;
  });
  app.post('/api/jobs/cancel-queued', async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    sqlite.exec('BEGIN IMMEDIATE');
    let queued: Array<{ id: string; draft_id: string; output_path: string | null }> = [];
    try {
      queued = sqlite.prepare("SELECT id, draft_id, output_path FROM jobs WHERE owner_id = ? AND status = 'queued' ORDER BY created_at, id").all(session.account_id) as typeof queued;
      sqlite.prepare("UPDATE jobs SET status = 'cancelled', error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ? WHERE owner_id = ? AND status = 'queued'").run(Date.now(), Date.now(), session.account_id);
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    for (const row of queued) {
      try { if (row.output_path) await discardOutputWorkingPath(row.output_path); await cleanupUploadedDraft(row.draft_id); }
      catch (error) { request.log.warn({ err: error, jobId: row.id }, 'Cancelled queue cleanup could not be completed'); }
    }
    workQueue.wake();
    return reply.code(202).send({ cancelled: queued.length });
  });
  app.post('/api/jobs/clear-stopped', async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const now = Date.now();
    const result = sqlite.prepare("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE owner_id = ? AND archived_at IS NULL AND status IN ('failed','cancelled')").run(now, now, session.account_id);
    return reply.send({ cleared: Number(result.changes) });
  });
  app.post('/api/jobs/:id/clear', async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const { id } = request.params as { id: string }; const now = Date.now();
    const result = sqlite.prepare("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND archived_at IS NULL AND status IN ('completed','failed','cancelled')").run(now, now, id, session.account_id);
    if (Number(result.changes) === 0) return reply.code(409).send({ code: 'JOB_NOT_CLEARABLE', message: 'Only completed, failed, or cancelled jobs can be cleared.', requestId: request.id });
    return reply.send({ cleared: 1 });
  });
  app.post('/api/jobs/:id/cancel', async (request, reply) => { const session = requireSession(request, reply, true); if (!session) return reply; const { id } = request.params as { id: string }; const row = sqlite.prepare("SELECT id, draft_id, status, output_path FROM jobs WHERE id = ? AND owner_id = ? AND status IN ('queued','running')").get(id, session.account_id) as { id: string; draft_id: string; status: string; output_path: string | null } | undefined; if (!row) return reply.code(409).send({ code: 'JOB_NOT_CANCELLABLE', message: 'This job cannot be cancelled.', requestId: request.id }); sqlite.prepare("UPDATE jobs SET status = 'cancelled', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id); if (row.status === 'queued') { if (row.output_path) await discardOutputWorkingPath(row.output_path); await cleanupUploadedDraft(row.draft_id); } children.get(id)?.kill('SIGTERM'); workQueue.wake(); return reply.code(202).send({ id, status: 'cancelled' }); });
  app.post('/api/jobs/:id/retry', async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const { id } = request.params as { id: string }; const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND archived_at IS NULL').get(id, session.account_id) as JobRow | undefined;
    if (!row) return reply.code(404).send({ code: 'JOB_NOT_FOUND', message: 'The job was not found.', requestId: request.id });
    try { const retried = await retryFailedJob(row, session.account_id); workQueue.wake(); return reply.code(202).send(publicJob(retried)); }
    catch (error) { const failure = error instanceof JobFailure ? error : new JobFailure('RETRY_FAILED', 'The failed job could not be retried.', false); return reply.code(409).send({ code: failure.code, message: failure.message, requestId: request.id }); }
  });
  app.post('/api/jobs/retry-failed', async (request, reply) => {
    const session = requireSession(request, reply, true); if (!session) return reply;
    const failed = sqlite.prepare("SELECT * FROM jobs WHERE owner_id = ? AND archived_at IS NULL AND status = 'failed' AND retryable = 1 ORDER BY created_at LIMIT 100").all(session.account_id) as JobRow[];
    const retried: JobRow[] = []; let skipped = 0;
    for (const row of failed) { try { retried.push(await retryFailedJob(row, session.account_id)); } catch { skipped += 1; } }
    workQueue.wake(); return reply.code(202).send({ accepted: retried.length, skipped, jobs: retried.map((row) => publicJob(row)) });
  });
  app.get('/api/jobs/:id/download', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (request, reply) => { const session = requireSession(request, reply); if (!session) return reply; const { id } = request.params as { id: string }; const row = sqlite.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND status = 'completed' AND destination = 'download'").get(id, session.account_id) as JobRow | undefined; if (!row?.output_path || !existsSync(row.output_path)) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: 'The browser-download result is not available.', requestId: request.id }); reply.header('Content-Type', 'audio/mp4'); reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName(row.title))}`); return reply.send(createReadStream(row.output_path)); });
  app.get('/api/jobs/:id/media', { config: { rateLimit: { max: 300, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = requireSession(request, reply); if (!session) return reply;
    const { id } = request.params as { id: string }; const row = sqlite.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ? AND status = 'completed'").get(id, session.account_id) as JobRow | undefined;
    if (!row?.output_path || !existsSync(row.output_path)) return reply.code(404).send({ code: 'ARTIFACT_NOT_FOUND', message: 'The validated audiobook is not available.', requestId: request.id });
    const size = statSync(row.output_path).size; const range = request.headers.range;
    reply.header('Content-Type', 'audio/mp4').header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-store');
    if (!range) { reply.header('Content-Length', size); return reply.send(createReadStream(row.output_path)); }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    const suffix = !match[1] && match[2] ? Number(match[2]) : undefined;
    const start = suffix ? Math.max(0, size - suffix) : Number(match[1]);
    const end = suffix ? size - 1 : match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    const boundedEnd = Math.min(end, size - 1);
    reply.code(206).header('Content-Range', `bytes ${start}-${boundedEnd}/${size}`).header('Content-Length', boundedEnd - start + 1);
    return reply.send(createReadStream(row.output_path, { start, end: boundedEnd }));
  });

  const staticRoot = resolve(options.staticRoot ?? 'dist/client');
  if (existsSync(join(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
  } else app.get('/', async () => ({ name: 'Vertiku', message: 'Build the client with npm run build.' }));
  workQueue.wake();
  app.addHook('onClose', async () => { shuttingDown = true; for (const child of children.values()) child.kill('SIGTERM'); await workQueue.stop(); sqlite.close(); });
  return app;
}
