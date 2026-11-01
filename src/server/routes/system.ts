import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import type { AppContext } from '../context.js';

const APP_VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'development'; }
  catch { return 'development'; }
})();

export function registerSystemRoutes({ app, sqlite, paths }: AppContext) {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    let database: 'ok' | 'failed' = 'ok'; let storage: 'ok' | 'failed' = 'ok';
    try { sqlite.prepare('SELECT 1').get(); } catch { database = 'failed'; }
    try { for (const directory of [paths.dataDir, paths.uploadsDir, paths.resultsDir]) accessSync(directory, fsConstants.R_OK | fsConstants.W_OK); } catch { storage = 'failed'; }
    if (database !== 'ok' || storage !== 'ok') return reply.code(503).send({ status: 'not-ready', database, storage });
    return { status: 'ready', database, storage, input: existsSync(paths.inputDir) ? 'mounted' : 'not-mounted', output: existsSync(paths.outputDir) ? 'mounted' : 'not-mounted' };
  });
  app.get('/api/manifest', async () => ({ id: 'vertiku', name: 'Vertiku', version: process.env.APP_VERSION || APP_VERSION, buildDate: process.env.BUILD_DATE ?? 'development', gitSha: process.env.GIT_SHA ?? 'development' }));
}
