import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOutputWorkingPath, publishOutputWorkingPath } from '../src/server/output-library.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('mounted output folder', () => {
  it('publishes without copying bytes, overwriting, or leaving the working artifact behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vertiku-output-')); directories.push(root);
    const output = join(root, 'output'); const firstWorking = await createOutputWorkingPath(output, 'one'); const secondWorking = await createOutputWorkingPath(output, 'two');
    writeFileSync(firstWorking, 'validated synthetic artifact'); writeFileSync(secondWorking, 'validated synthetic artifact');
    const first = await publishOutputWorkingPath(firstWorking, output, 'Synthetic Book.m4b'); const second = await publishOutputWorkingPath(secondWorking, output, 'Synthetic Book.m4b');
    expect(basename(first)).toBe('Synthetic Book.m4b'); expect(basename(second)).toBe('Synthetic Book (2).m4b');
    expect(readFileSync(first, 'utf8')).toBe('validated synthetic artifact'); expect(readFileSync(second, 'utf8')).toBe('validated synthetic artifact');
    expect(existsSync(firstWorking)).toBe(false); expect(existsSync(secondWorking)).toBe(false);
  });
});
