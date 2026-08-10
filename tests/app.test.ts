import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

async function testApp(setupSecret = 'synthetic-setup-secret-value', cookieSecure = false, passwordResetEnabled = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-test-')); directories.push(dataDir);
  const app = await buildApp({ databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, cookieSecure, setupSecret, passwordResetEnabled }); apps.push(app); return app;
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the queue state.');
}

describe('platform and identity endpoints', () => {
  it('reports liveness, readiness, and first-run state', async () => {
    const app = await testApp();
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/health/ready')).json()).toMatchObject({ status: 'ready', database: 'ok', storage: 'ok' });
    expect((await app.inject('/api/setup/status')).json()).toEqual({ required: true, passwordResetEnabled: false });
  }, 10_000);

  it('only upgrades browser assets to HTTPS when secure-cookie mode is enabled', async () => {
    const httpApp = await testApp();
    const httpCsp = (await httpApp.inject('/')).headers['content-security-policy'];
    expect(httpCsp).not.toContain('upgrade-insecure-requests');

    const httpsApp = await testApp('synthetic-setup-secret-value', true);
    const httpsCsp = (await httpsApp.inject('/')).headers['content-security-policy'];
    expect(httpsCsp).toContain('upgrade-insecure-requests');
  });

  it('closes setup after creating the administrator and issues a revocable CSRF session', async () => {
    const app = await testApp();
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: credentials })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: credentials })).statusCode).toBe(409);
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    expect(login.statusCode).toBe(200); expect(login.json().csrf).toMatch(/^[A-Za-z0-9_-]+$/);
    const cookie = login.cookies[0]?.name && `${login.cookies[0].name}=${login.cookies[0].value}`;
    const denied = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } }); expect(denied.statusCode).toBe(403);
    const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie, 'x-csrf-token': login.json().csrf } }); expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    const app = await testApp();
    await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/session', payload: { username: 'unknown', password: 'synthetic-password' } });
    const wrong = await app.inject({ method: 'POST', url: '/api/session', payload: { username: 'admin', password: 'different-password' } });
    expect(unknown.statusCode).toBe(401); expect(wrong.statusCode).toBe(401); expect(unknown.json().message).toBe('Invalid credentials.'); expect(wrong.json().message).toBe('Invalid credentials.');
  });

  it('allows independent devices to sign in concurrently and treats username casing consistently', async () => {
    const app = await testApp();
    await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'Admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' } });
    const first = await app.inject({ method: 'POST', url: '/api/session', headers: { 'user-agent': 'synthetic-phone' }, remoteAddress: '192.0.2.10', payload: { username: 'admin', password: 'synthetic-password-123' } });
    const second = await app.inject({ method: 'POST', url: '/api/session', headers: { 'user-agent': 'synthetic-desktop' }, remoteAddress: '198.51.100.20', payload: { username: 'ADMIN', password: 'synthetic-password-123' } });
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    for (const login of [first, second]) {
      const sessionCookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
      expect((await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: sessionCookie } })).statusCode).toBe(200);
    }
  });

  it('performs one Compose-gated password reset without deleting the account and revokes every session', async () => {
    const app = await testApp('synthetic-setup-secret-value', false, true);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const oldLogin = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const oldCookie = `${oldLogin.cookies[0]!.name}=${oldLogin.cookies[0]!.value}`;
    expect((await app.inject('/api/setup/status')).json()).toMatchObject({ required: false, passwordResetEnabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/password-reset', payload: { username: 'admin', setupSecret: 'wrong-secret', newPassword: 'replacement-password-123' } })).statusCode).toBe(403);
    const reset = await app.inject({ method: 'POST', url: '/api/password-reset', payload: { username: 'ADMIN', setupSecret: credentials.setupSecret, newPassword: 'replacement-password-123' } });
    expect(reset.statusCode).toBe(204);
    expect((await app.inject('/api/setup/status')).json()).toMatchObject({ required: false, passwordResetEnabled: false });
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: oldCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/session', payload: { username: 'admin', password: credentials.password } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/session', payload: { username: 'admin', password: 'replacement-password-123' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/password-reset', payload: { username: 'admin', setupSecret: credentials.setupSecret, newPassword: 'another-password-123' } })).statusCode).toBe(403);
  });

  it('accepts copied setup-secret whitespace during recovery without exposing the denial reason', async () => {
    const app = await testApp('synthetic-setup-secret-value', false, true);
    await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' } });
    const reset = await app.inject({ method: 'POST', url: '/api/password-reset', payload: { username: 'admin', setupSecret: '  synthetic-setup-secret-value  ', newPassword: 'replacement-password-123' } });
    expect(reset.statusCode).toBe(204);
  });

  it('clears persistent ETA measurements once per changed Compose reset token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-eta-reset-')); directories.push(dataDir);
    const databasePath = join(dataDir, 'vertiku.sqlite');
    const first = await buildApp({ databasePath, dataDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value' });
    await first.close();
    let database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO conversion_samples VALUES (?, ?, ?, ?, ?, ?)').run('sample-1', 1, 1000, 1000, 1000, 1000);
    database.close();

    const reset = await buildApp({ databasePath, dataDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', etaHistoryResetToken: 'new-hardware-2026' });
    await reset.close();
    database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversion_samples').get()).toEqual({ count: 0 });
    database.prepare('INSERT INTO conversion_samples VALUES (?, ?, ?, ?, ?, ?)').run('sample-2', 1, 1000, 1000, 1000, 2000);
    database.close();

    const sameToken = await buildApp({ databasePath, dataDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', etaHistoryResetToken: 'new-hardware-2026' });
    await sameToken.close();
    database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM conversion_samples').get()).toEqual({ count: 1 });
    database.close();
  });

  it('rate-limits repeated filesystem-backed readiness checks', async () => {
    const app = await testApp();
    for (let request = 0; request < 60; request += 1) {
      expect((await app.inject('/health/ready')).statusCode).toBe(200);
    }
    const limited = await app.inject('/health/ready');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('persistent conversion queue', () => {
  it('reviews an entire input batch and always analyzes and converts one book at a time', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-batch-')); directories.push(dataDir);
    const inputDir = join(dataDir, 'input'); const outputDir = join(dataDir, 'output');
    mkdirSync(join(inputDir, 'Dan Simmons - Drood'), { recursive: true }); mkdirSync(join(inputDir, 'Second Author - Second Book'), { recursive: true });
    writeFileSync(join(inputDir, 'Dan Simmons - Drood', '001 - Drood.mp3'), 'synthetic'); writeFileSync(join(inputDir, 'Dan Simmons - Drood', '002 - Drood.mp3'), 'synthetic');
    writeFileSync(join(inputDir, 'Second Author - Second Book', '01 - Opening.mp3'), 'synthetic');
    const releases: Array<() => void> = []; const convertedMetadata: Array<{ title: string; author?: string }> = []; let active = 0; let maximumActive = 0;
    const app = await buildApp({
      databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, inputDir, outputDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', maxConcurrentJobs: 8,
      inspect: async (_binary, path) => ({ durationMs: 1_000, metadata: path.includes('Drood') ? { title: 'Embedded Drood', author: 'Embedded Author', narrator: '', year: '', genre: '', description: '' } : { title: '', author: '', narrator: '', year: '', genre: '', description: '' }, embeddedCover: false }),
      convert: async (input) => { convertedMetadata.push(input.metadata); active += 1; maximumActive = Math.max(maximumActive, active); input.onPhase?.('encoding_audio'); await new Promise<void>((resolve) => releases.push(resolve)); input.onPhase?.('validating_output'); writeFileSync(input.outputPath, 'validated batch audiobook'); active -= 1; }
    }); apps.push(app);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`; const csrf = login.json().csrf as string;
    const library = (await app.inject({ method: 'GET', url: '/api/input-books', headers: { cookie } })).json().books as Array<{ id: string; fingerprint: string; suggestedTitle: string; suggestedAuthor: string; chapters: Array<{ filename: string; title: string }> }>;
    expect(library[0]).toMatchObject({ suggestedTitle: 'Drood', suggestedAuthor: 'Dan Simmons', chapters: [{ title: 'Chapter 1' }, { title: 'Chapter 2' }] });
    const items = library.map((book) => ({ folderId: book.id, fingerprint: book.fingerprint, title: book.id, destination: 'output', bitrateKbps: 96, chapters: book.chapters }));
    expect((await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie }, payload: { items } })).statusCode).toBe(403);
    const stale = structuredClone(items); stale[0]!.chapters = stale[0]!.chapters.slice(1);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie, 'x-csrf-token': csrf }, payload: { items: stale } })).statusCode).toBe(400);
    expect(((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as unknown[])).toHaveLength(0);
    const queued = await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie, 'x-csrf-token': csrf }, payload: { items } });
    expect(queued.statusCode).toBe(202); expect(queued.json().accepted).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().queue).toMatchObject({ remainingJobs: 2, confidence: 'learning' });
    await waitFor(() => releases.length === 1); expect(maximumActive).toBe(1);
    const liveQueue = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json() as { jobs: Array<{ id: string; status: string; phase: string; estimatedRemainingSeconds?: number; estimatedFinishAt?: string }>; queue: { remainingJobs: number; queuedJobs: number; estimatedRemainingSeconds: number; estimatedFinishAt?: string; currentJobId?: string; currentJobEstimatedRemainingSeconds?: number } };
    const running = liveQueue.jobs.find((job) => job.status === 'running')!;
    expect(running).toMatchObject({ phase: 'encoding_audio' });
    expect(running.estimatedRemainingSeconds).toBeGreaterThan(0); expect(running.estimatedFinishAt).toBeTruthy();
    expect(liveQueue.queue).toMatchObject({ remainingJobs: 2, queuedJobs: 1, currentJobId: running.id });
    expect(liveQueue.queue.estimatedRemainingSeconds).toBeGreaterThan(liveQueue.queue.currentJobEstimatedRemainingSeconds ?? 0); expect(liveQueue.queue.estimatedFinishAt).toBeTruthy();
    releases[0]!();
    await waitFor(() => releases.length === 2); expect(maximumActive).toBe(1); releases[1]!();
    await waitFor(async () => ((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ status: string }>).every((job) => job.status === 'completed'));
    expect(((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ phase: string }>).every((job) => job.phase === 'completed')).toBe(true);
    expect(existsSync(join(inputDir, 'Dan Simmons - Drood', '001 - Drood.mp3'))).toBe(true);
    expect(readdirSync(join(dataDir, 'uploads'))).toHaveLength(0);
    expect(convertedMetadata).toContainEqual(expect.objectContaining({ title: 'Embedded Drood', author: 'Embedded Author' }));
    const rescanned = (await app.inject({ method: 'GET', url: '/api/input-books', headers: { cookie } })).json().books as Array<{ id: string; issues: Array<{ code: string }> }>;
    expect(rescanned.find((book) => book.id === 'Dan Simmons - Drood')?.issues).toContainEqual(expect.objectContaining({ code: 'ALREADY_CONVERTED' }));
  });

  it('queues FIFO with bounded concurrency and publishes output without a data result copy', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-queue-')); directories.push(dataDir);
    const inputDir = join(dataDir, 'input'); const outputDir = join(dataDir, 'output');
    mkdirSync(join(inputDir, 'Book One'), { recursive: true }); mkdirSync(join(inputDir, 'Book Two'), { recursive: true });
    writeFileSync(join(inputDir, 'Book One', '01.mp3'), 'synthetic'); writeFileSync(join(inputDir, 'Book Two', '01.mp3'), 'synthetic');
    const releases: Array<() => void> = [];
    let active = 0; let maximumActive = 0;
    const app = await buildApp({
      databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, inputDir, outputDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', maxConcurrentJobs: 1,
      probe: async () => 1_000,
      convert: async (input) => {
        active += 1; maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        writeFileSync(input.outputPath, 'validated synthetic audiobook');
        active -= 1;
      }
    });
    apps.push(app);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`; const csrf = login.json().csrf as string;
    const headers = { cookie, 'x-csrf-token': csrf };
    const enqueue = async (folderId: string, title: string) => {
      const draft = (await app.inject({ method: 'POST', url: '/api/drafts/from-input', headers, payload: { folderId } })).json();
      return app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { draftId: draft.id, title, destination: 'output', bitrateKbps: 96, chapters: draft.sources.map((source: { id: string; title: string }) => ({ sourceId: source.id, title: source.title })) } });
    };
    await enqueue('Book One', 'Book One'); await waitFor(() => releases.length === 1);
    const second = await enqueue('Book Two', 'Book Two');
    expect(second.statusCode).toBe(202); expect(second.json()).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(maximumActive).toBe(1);
    releases[0]!(); await waitFor(() => releases.length === 2); releases[1]!();
    await waitFor(async () => ((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ status: string }>).every((job) => job.status === 'completed'));
    const history = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ id: string; status: string; mediaReady: boolean }>;
    expect(history.every((job) => job.status === 'completed')).toBe(true);
    expect(history.every((job) => job.mediaReady)).toBe(true);
    expect((await app.inject(`/api/jobs/${history[0]!.id}/media`)).statusCode).toBe(401);
    const media = await app.inject({ method: 'GET', url: `/api/jobs/${history[0]!.id}/media`, headers: { cookie, range: 'bytes=0-3' } });
    expect(media.statusCode).toBe(206); expect(media.headers['content-range']).toMatch(/^bytes 0-3\//); expect(media.rawPayload.toString()).toBe('vali');
    expect(readdirSync(outputDir).some((name) => name.includes('.partial.'))).toBe(false);
    expect(existsSync(join(dataDir, 'results')) && readdirSync(join(dataDir, 'results')).length).toBe(0);
  });

  it('cancels every waiting job atomically without interrupting the active conversion', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-cancel-waiting-')); directories.push(dataDir);
    const inputDir = join(dataDir, 'input'); const outputDir = join(dataDir, 'output');
    for (const book of ['Active Book', 'Waiting Book']) {
      mkdirSync(join(inputDir, book), { recursive: true });
      writeFileSync(join(inputDir, book, '01.mp3'), `synthetic ${book}`);
    }
    const releases: Array<() => void> = [];
    const app = await buildApp({
      databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, inputDir, outputDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value',
      probe: async () => 1_000,
      convert: async (input) => { await new Promise<void>((resolve) => releases.push(resolve)); writeFileSync(input.outputPath, 'validated active audiobook'); }
    }); apps.push(app);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`; const csrf = login.json().csrf as string; const headers = { cookie, 'x-csrf-token': csrf };
    const enqueue = async (folderId: string) => {
      const draft = (await app.inject({ method: 'POST', url: '/api/drafts/from-input', headers, payload: { folderId } })).json();
      return app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { draftId: draft.id, title: folderId, destination: 'output', bitrateKbps: 96, chapters: draft.sources.map((source: { id: string; title: string }) => ({ sourceId: source.id, title: source.title })) } });
    };
    const active = await enqueue('Active Book'); await waitFor(() => releases.length === 1);
    const waiting = await enqueue('Waiting Book');

    expect((await app.inject({ method: 'POST', url: '/api/jobs/cancel-queued', headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/cancel-queued', headers, payload: {} })).json()).toEqual({ cancelled: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/jobs/cancel-queued', headers, payload: {} })).json()).toEqual({ cancelled: 0 });
    let history = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ id: string; status: string }>;
    expect(history.find((job) => job.id === active.json().id)?.status).toBe('running');
    expect(history.find((job) => job.id === waiting.json().id)?.status).toBe('cancelled');

    releases[0]!();
    await waitFor(async () => ((await app.inject({ method: 'GET', url: `/api/jobs/${active.json().id}`, headers: { cookie } })).json().status === 'completed'));
    history = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ id: string; status: string }>;
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ id: active.json().id, status: 'completed' }), expect.objectContaining({ id: waiting.json().id, status: 'cancelled' })]));
    expect(releases).toHaveLength(1);
  });

  it('retains failed sources, preserves the failed attempt, and retries only through an authorized mutation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-retry-')); directories.push(dataDir);
    const inputDir = join(dataDir, 'input'); const outputDir = join(dataDir, 'output'); mkdirSync(join(inputDir, 'Retry Book'), { recursive: true });
    writeFileSync(join(inputDir, 'Retry Book', '01.mp3'), 'synthetic retry source');
    let attempts = 0;
    const app = await buildApp({
      databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, inputDir, outputDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value',
      probe: async () => 1_000,
      convert: async (input) => { attempts += 1; if (attempts === 1) throw new Error('Synthetic encoder interruption.'); writeFileSync(input.outputPath, 'validated retry result'); }
    }); apps.push(app);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`; const csrf = login.json().csrf as string; const headers = { cookie, 'x-csrf-token': csrf };
    const draft = (await app.inject({ method: 'POST', url: '/api/drafts/from-input', headers, payload: { folderId: 'Retry Book' } })).json();
    const queued = await app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { draftId: draft.id, title: 'Retry Book', chapters: draft.sources.map((source: { id: string; title: string }) => ({ sourceId: source.id, title: source.title })) } });
    await waitFor(async () => ((await app.inject({ method: 'GET', url: `/api/jobs/${queued.json().id}`, headers: { cookie } })).json().status === 'failed'));
    const failed = (await app.inject({ method: 'GET', url: `/api/jobs/${queued.json().id}`, headers: { cookie } })).json();
    expect(failed).toMatchObject({ status: 'failed', retryable: true, error: { code: 'ENGINE_FAILED', retryable: true } });
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${failed.id}/retry`, headers: { cookie }, payload: {} })).statusCode).toBe(403);
    const retry = await app.inject({ method: 'POST', url: `/api/jobs/${failed.id}/retry`, headers, payload: {} });
    expect(retry.statusCode).toBe(202); expect(retry.json()).toMatchObject({ status: 'queued', retryOf: failed.id });
    await waitFor(async () => ((await app.inject({ method: 'GET', url: `/api/jobs/${retry.json().id}`, headers: { cookie } })).json().status === 'completed'));
    const history = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ id: string; status: string }>;
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ id: failed.id, status: 'failed' }), expect.objectContaining({ id: retry.json().id, status: 'completed' })]));
  });
});
