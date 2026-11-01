import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { AppContext } from './context.js';
import { createConversionRunner } from './conversion-runner.js';
import { openDatabase } from './database.js';
import { createEventStreams } from './event-stream.js';
import { createJobViews } from './job-views.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerSystemRoutes } from './routes/system.js';
import { hashToken } from './security.js';
import { createSessionStore } from './sessions.js';
import type { AppOptions, StoragePaths } from './types.js';
import { createWorkQueue } from './work-queue.js';

export type { AppOptions } from './types.js';

/** Clears durable forecast samples exactly once whenever the Compose reset token changes (for example after a hardware move). */
function applyEtaHistoryReset(sqlite: AppContext['sqlite'], token: string | undefined) {
  if (!token) return;
  const resetTokenHash = hashToken(token);
  const previous = sqlite.prepare("SELECT value FROM system_settings WHERE key = 'eta_history_reset_token_hash'").get() as { value: string } | undefined;
  if (previous?.value === resetTokenHash) return;
  const upsert = sqlite.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.prepare('DELETE FROM conversion_samples').run();
    upsert.run('eta_history_reset_token_hash', resetTokenHash);
    upsert.run('eta_history_reset_at', String(Date.now()));
    sqlite.exec('COMMIT');
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

export async function buildApp(options: AppOptions) {
  const dataDir = resolve(options.dataDir ?? dirname(options.databasePath));
  const paths: StoragePaths = {
    dataDir,
    uploadsDir: join(dataDir, 'uploads'),
    resultsDir: join(dataDir, 'results'),
    inputDir: resolve(options.inputDir ?? '/input'),
    outputDir: resolve(options.outputDir ?? '/output')
  };
  for (const directory of [dirname(options.databasePath), paths.uploadsDir, paths.resultsDir]) mkdirSync(directory, { recursive: true });

  const app = Fastify({ logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'body.password', 'body.newPassword', 'body.setupSecret'] }, trustProxy: false, bodyLimit: 10 * 1024 * 1024 });
  const { sqlite } = openDatabase(options.databasePath);
  applyEtaHistoryReset(sqlite, options.etaHistoryResetToken);

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
        upgradeInsecureRequests: options.cookieSecure ? [] : null
      }
    }
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 501, fileSize: options.maxUploadBytes ?? 10 * 1024 ** 3, fields: 20, parts: 530 } });

  const sessions = createSessionStore(sqlite, options.cookieSecure);
  const jobs = createJobViews(sqlite);
  const runner = createConversionRunner({ sqlite, options, paths, jobs, log: app.log });
  runner.requeueInterrupted();
  // Vertiku is intentionally serial: exactly one audiobook is converted at a time.
  const workQueue = createWorkQueue({ concurrency: 1, claim: runner.claim, run: runner.run });
  const events = createEventStreams(sessions.sessionIsActive);
  const context: AppContext = { app, sqlite, options, paths, sessions, jobs, runner, events, workQueue };

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ code: 'UPLOAD_TOO_LARGE', message: 'One of the selected files exceeds the configured upload limit.', requestId: request.id });
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests. Try again later.', requestId: request.id });
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Vertiku could not complete the request.', requestId: request.id });
  });

  registerSystemRoutes(context);
  registerAuthRoutes(context);
  registerDraftRoutes(context);
  registerJobRoutes(context);

  const staticRoot = resolve(options.staticRoot ?? 'dist/client');
  if (existsSync(join(staticRoot, 'index.html'))) await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
  else app.get('/', async () => ({ name: 'Vertiku', message: 'Build the client with npm run build.' }));

  workQueue.wake();
  app.addHook('preClose', async () => { events.closeAll(); });
  app.addHook('onClose', async () => {
    runner.beginShutdown();
    await workQueue.stop();
    sqlite.close();
  });
  return app;
}
