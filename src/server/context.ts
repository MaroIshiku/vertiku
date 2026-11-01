import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { ConversionRunner } from './conversion-runner.js';
import type { EventStreams } from './event-stream.js';
import type { JobViews } from './job-views.js';
import type { SessionStore } from './sessions.js';
import type { AppOptions, StoragePaths } from './types.js';
import type { createWorkQueue } from './work-queue.js';

/** Everything a route module needs; built once per application instance in buildApp. */
export type AppContext = {
  app: FastifyInstance;
  sqlite: DatabaseSync;
  options: AppOptions;
  paths: StoragePaths;
  sessions: SessionStore;
  jobs: JobViews;
  runner: ConversionRunner;
  events: EventStreams;
  workQueue: ReturnType<typeof createWorkQueue>;
};
