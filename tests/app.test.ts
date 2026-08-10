import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

async function testApp(setupSecret = 'synthetic-setup-secret-value', cookieSecure = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'vertiku-test-')); directories.push(dataDir);
  const app = await buildApp({ databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, cookieSecure, setupSecret }); apps.push(app); return app;
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
    expect((await app.inject('/api/setup/status')).json()).toEqual({ required: true });
  });

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
    const releases: Array<() => void> = []; let active = 0; let maximumActive = 0;
    const app = await buildApp({
      databasePath: join(dataDir, 'vertiku.sqlite'), dataDir, inputDir, outputDir, cookieSecure: false, setupSecret: 'synthetic-setup-secret-value', maxConcurrentJobs: 8,
      probe: async () => 1_000,
      convert: async (input) => { active += 1; maximumActive = Math.max(maximumActive, active); await new Promise<void>((resolve) => releases.push(resolve)); writeFileSync(input.outputPath, 'validated batch audiobook'); active -= 1; }
    }); apps.push(app);
    const credentials = { username: 'admin', password: 'synthetic-password-123', setupSecret: 'synthetic-setup-secret-value' };
    await app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { username: credentials.username, password: credentials.password } });
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`; const csrf = login.json().csrf as string;
    const library = (await app.inject({ method: 'GET', url: '/api/input-books', headers: { cookie } })).json().books as Array<{ id: string; suggestedTitle: string; suggestedAuthor: string; chapters: Array<{ filename: string; title: string }> }>;
    expect(library[0]).toMatchObject({ suggestedTitle: 'Drood', suggestedAuthor: 'Dan Simmons', chapters: [{ title: 'Chapter 1' }, { title: 'Chapter 2' }] });
    const items = library.map((book) => ({ folderId: book.id, title: book.suggestedTitle, author: book.suggestedAuthor, destination: 'output', bitrateKbps: 96, chapters: book.chapters }));
    expect((await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie }, payload: { items } })).statusCode).toBe(403);
    const stale = structuredClone(items); stale[0]!.chapters = stale[0]!.chapters.slice(1);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie, 'x-csrf-token': csrf }, payload: { items: stale } })).statusCode).toBe(400);
    expect(((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as unknown[])).toHaveLength(0);
    const queued = await app.inject({ method: 'POST', url: '/api/jobs/from-input/batch', headers: { cookie, 'x-csrf-token': csrf }, payload: { items } });
    expect(queued.statusCode).toBe(202); expect(queued.json().accepted).toBe(2);
    await waitFor(() => releases.length === 1); expect(maximumActive).toBe(1); releases[0]!();
    await waitFor(() => releases.length === 2); expect(maximumActive).toBe(1); releases[1]!();
    await waitFor(async () => ((await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ status: string }>).every((job) => job.status === 'completed'));
    expect(existsSync(join(inputDir, 'Dan Simmons - Drood', '001 - Drood.mp3'))).toBe(true);
    expect(readdirSync(join(dataDir, 'uploads'))).toHaveLength(0);
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
    const history = (await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).json().jobs as Array<{ status: string }>;
    expect(history.every((job) => job.status === 'completed')).toBe(true);
    expect(readdirSync(outputDir).some((name) => name.includes('.partial.'))).toBe(false);
    expect(existsSync(join(dataDir, 'results')) && readdirSync(join(dataDir, 'results')).length).toBe(0);
  });
});
