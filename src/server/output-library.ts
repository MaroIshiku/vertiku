import { link, mkdir, rm, unlink } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export async function createOutputWorkingPath(outputRoot: string, jobId: string): Promise<string> {
  const root = resolve(outputRoot); await mkdir(root, { recursive: true });
  return join(root, `.vertiku-${jobId}.partial.m4b`);
}

export async function discardOutputWorkingPath(workingPath: string): Promise<void> {
  await rm(resolve(workingPath), { force: true });
}

export async function publishOutputWorkingPath(workingPath: string, outputRoot: string, requestedName: string): Promise<string> {
  const root = resolve(outputRoot); await mkdir(root, { recursive: true });
  const extension = extname(requestedName) || '.m4b'; const stem = basename(requestedName, extension);
  for (let index = 1; index <= 10_000; index += 1) {
    const name = index === 1 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
    const candidate = join(root, name);
    try { await link(resolve(workingPath), candidate); await unlink(resolve(workingPath)); return candidate; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  throw new Error('No available output filename could be allocated.');
}
