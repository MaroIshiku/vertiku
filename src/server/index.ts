import { buildApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const app = await buildApp(config);
await app.listen({ host: config.host, port: config.port });

// On a container stop, close streams, stop FFmpeg, requeue the running job, and close SQLite cleanly.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'Shutting down Vertiku');
    const forceExit = setTimeout(() => process.exit(1), 20_000);
    forceExit.unref();
    app.close().then(() => process.exit(0), (error: unknown) => { app.log.error({ err: error }, 'Shutdown failed'); process.exit(1); });
  });
}
