import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filesForInputBook, resolveInputFolder, scanInputBooks } from '../src/server/input-library.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('mounted input library', () => {
  it('treats every audio-containing folder as a separate naturally sorted audiobook', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertiku-input-')); directories.push(root);
    const first = join(root, 'Author', 'Book 2'); const second = join(root, 'Author', 'Book 10'); mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true });
    writeFileSync(join(first, 'Part10.mp3'), 'synthetic'); writeFileSync(join(first, 'Part2.mp3'), 'synthetic'); writeFileSync(join(first, 'cover.jpg'), 'synthetic'); writeFileSync(join(second, 'Chapter 1.flac'), 'synthetic');
    expect(scanInputBooks(root)).toMatchObject([
      { id: 'Author/Book 2', title: 'Book 2', fileCount: 2 },
      { id: 'Author/Book 10', title: 'Book 10', fileCount: 1 }
    ]);
    expect(filesForInputBook(root, 'Author/Book 2').files.map((file) => file.name)).toEqual(['Part2.mp3', 'Part10.mp3']);
    expect(filesForInputBook(root, 'Author/Book 2').coverPath).toBe(join(first, 'cover.jpg'));
  });

  it('rejects traversal outside the configured input root', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertiku-input-')); directories.push(root);
    expect(() => resolveInputFolder(root, '../outside')).toThrow(/escapes/);
  });
});
