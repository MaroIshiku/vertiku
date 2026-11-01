import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statfsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUDIO_EXTENSIONS, COVER_EXTENSIONS, bookMetadataFromFolderName, chapterTitlesFromFilenames, formatDuration, naturalSort, safeDownloadName } from '../../domain/audiobook.js';
import type { AppContext } from '../context.js';
import { MULTIPART_LIMIT_MESSAGES, UserFacingError, clientError, errorCode } from '../errors.js';
import { emptyEmbeddedMetadata, type AudioInspection } from '../ffmpeg.js';
import { filesForInputBook, scanInputBooks } from '../input-library.js';

const inputDraftSchema = z.object({ folderId: z.string().min(1).max(2000) });

type AnalyzedSource = { id: string; originalName: string; storagePath: string; inspection: AudioInspection; sizeBytes: number; modifiedAt: number };

// Browsers report no or a generic MIME type for some formats (for example Opus or FLAC); ffprobe is the authoritative check.
const acceptsAudioMime = (mimetype: string) => mimetype.startsWith('audio/') || mimetype === '' || mimetype === 'application/octet-stream';

export function registerDraftRoutes({ app, sqlite, paths, sessions, runner }: AppContext) {
  async function inspectNamedSource(request: FastifyRequest, path: string, displayName: string) {
    try { return await runner.inspectSource(path); }
    catch (error) {
      request.log.warn({ err: error }, 'Audio source could not be analyzed');
      throw new UserFacingError(`Audio could not be read: ${displayName}`);
    }
  }

  function insertDraft(draftId: string, ownerId: number, coverPath: string | undefined, sources: AnalyzedSource[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.prepare('INSERT INTO drafts (id, owner_id, cover_path, created_at) VALUES (?, ?, ?, ?)').run(draftId, ownerId, coverPath ?? null, Date.now());
      const insert = sqlite.prepare('INSERT INTO draft_sources (id, draft_id, original_name, storage_path, duration_ms, size_bytes, modified_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      sources.forEach((source, index) => insert.run(source.id, draftId, source.originalName, source.storagePath, source.inspection.durationMs, source.sizeBytes, source.modifiedAt, index));
      sqlite.exec('COMMIT');
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }

  const publicSources = (sources: AnalyzedSource[], titles: string[]) => sources.map((source, index) => ({
    id: source.id, filename: source.originalName, title: titles[index], durationMs: source.inspection.durationMs, duration: formatDuration(source.inspection.durationMs)
  }));

  app.post('/api/drafts', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const draftId = randomUUID(); const draftDir = join(paths.uploadsDir, draftId); mkdirSync(draftDir, { recursive: true });
    const uploaded: AnalyzedSource[] = [];
    let coverPath: string | undefined;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        const originalName = part.filename ?? 'unnamed'; const extension = extname(originalName).toLowerCase();
        if (part.fieldname === 'cover') {
          if (!COVER_EXTENSIONS.has(extension) || !part.mimetype.startsWith('image/')) throw new UserFacingError('Unsupported cover image.');
          coverPath = join(draftDir, `cover${extension}`);
          await pipeline(part.file, createWriteStream(coverPath, { mode: 0o600 }));
          continue;
        }
        if (part.fieldname !== 'files' || !AUDIO_EXTENSIONS.has(extension) || !acceptsAudioMime(part.mimetype)) throw new UserFacingError(`Unsupported audio file: ${originalName}`);
        const id = randomUUID(); const storagePath = join(draftDir, `${id}${extension}`);
        await pipeline(part.file, createWriteStream(storagePath, { mode: 0o600 }));
        const inspection = await inspectNamedSource(request, storagePath, originalName); const stat = statSync(storagePath);
        uploaded.push({ id, originalName, storagePath, inspection, sizeBytes: stat.size, modifiedAt: Math.trunc(stat.mtimeMs) });
      }
      if (uploaded.length === 0) throw new UserFacingError('Select at least one supported audio file.');
      const sorted = naturalSort(uploaded, (source) => source.originalName);
      insertDraft(draftId, session.account_id, coverPath, sorted);
      const titles = chapterTitlesFromFilenames(sorted.map((source) => source.originalName));
      const embedded = sorted[0]?.inspection.metadata ?? emptyEmbeddedMetadata();
      return reply.code(201).send({ id: draftId, cover: Boolean(coverPath || sorted[0]?.inspection.embeddedCover), suggestedMetadata: embedded, sources: publicSources(sorted, titles) });
    } catch (error) {
      await rm(draftDir, { recursive: true, force: true });
      const limit = MULTIPART_LIMIT_MESSAGES[errorCode(error) ?? ''];
      if (limit) return reply.code(limit.status).send({ code: limit.code, message: limit.message, requestId: request.id });
      return reply.code(400).send({ code: 'INVALID_FILE', message: clientError(request, error, 'The files could not be analyzed.'), requestId: request.id });
    }
  });

  app.get('/api/input-books', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply); if (!session) return reply;
    const completedQuery = sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status = 'completed' LIMIT 1");
    const activeQuery = sqlite.prepare("SELECT id FROM jobs WHERE owner_id = ? AND source_fingerprint = ? AND status IN ('queued','running') LIMIT 1");
    const books = scanInputBooks(paths.inputDir).map(({ coverPath: _coverPath, files, ...book }) => {
      const suggested = bookMetadataFromFolderName(book.title);
      const titles = chapterTitlesFromFilenames(files, suggested.title);
      const completed = completedQuery.get(session.account_id, book.fingerprint) as { id: string } | undefined;
      const active = activeQuery.get(session.account_id, book.fingerprint) as { id: string } | undefined;
      const issues = [...book.issues];
      if (completed) issues.push({ code: 'ALREADY_CONVERTED', severity: 'warning' as const, message: 'These exact source files were already converted successfully.' });
      if (active) issues.push({ code: 'ALREADY_QUEUED', severity: 'error' as const, message: 'These exact source files are already queued or running.' });
      if (existsSync(join(paths.outputDir, safeDownloadName(suggested.title)))) issues.push({ code: 'OUTPUT_NAME_COLLISION', severity: 'warning' as const, message: 'The default output filename already exists; Vertiku will allocate a numbered name.' });
      return { ...book, suggestedTitle: suggested.title, suggestedAuthor: suggested.author, issues, needsReview: issues.length > 0, alreadyConvertedJobId: completed?.id, chapters: files.map((filename, index) => ({ filename, title: titles[index]! })) };
    });
    let outputFreeBytes: number | undefined;
    try { const storage = statfsSync(paths.outputDir); outputFreeBytes = Number(storage.bavail) * Number(storage.bsize); } catch { /* Output mount readiness reports availability separately. */ }
    return { mounted: existsSync(paths.inputDir), rootLabel: '/input', outputFreeBytes, books };
  });

  app.post('/api/drafts/from-input', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const session = sessions.requireSession(request, reply, true); if (!session) return reply;
    const input = inputDraftSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ code: 'VALIDATION_FAILED', message: 'Choose a valid input folder.', requestId: request.id });
    try {
      const selected = filesForInputBook(paths.inputDir, input.data.folderId);
      if (!selected.files.length) return reply.code(404).send({ code: 'INPUT_BOOK_EMPTY', message: 'No supported audio files were found in this folder.', requestId: request.id });
      if (selected.files.length > 500) return reply.code(400).send({ code: 'INPUT_BOOK_TOO_LARGE', message: 'An input folder may contain at most 500 audio files.', requestId: request.id });
      const analyzed: AnalyzedSource[] = [];
      for (const file of selected.files) analyzed.push({ id: randomUUID(), originalName: file.name, storagePath: file.path, inspection: await inspectNamedSource(request, file.path, file.name), sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt });
      const draftId = randomUUID();
      insertDraft(draftId, session.account_id, selected.coverPath, analyzed);
      const suggested = bookMetadataFromFolderName(basename(selected.folder));
      const titles = chapterTitlesFromFilenames(analyzed.map((source) => source.originalName), suggested.title);
      const embedded = analyzed[0]?.inspection.metadata ?? emptyEmbeddedMetadata();
      return reply.code(201).send({ id: draftId, cover: Boolean(selected.coverPath || analyzed[0]?.inspection.embeddedCover), suggestedTitle: embedded.title || suggested.title, suggestedAuthor: embedded.author || suggested.author, suggestedMetadata: embedded, sourceFingerprint: selected.fingerprint, sourceBytes: selected.sourceBytes, sources: publicSources(analyzed, titles) });
    } catch (error) {
      return reply.code(400).send({ code: 'INPUT_BOOK_INVALID', message: clientError(request, error, 'The input folder could not be analyzed.'), requestId: request.id });
    }
  });
}
