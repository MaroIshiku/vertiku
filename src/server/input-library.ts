import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { naturalSort } from '../domain/audiobook.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'folder.png'];

export type PreflightIssue = { code: string; severity: 'warning' | 'error'; message: string };
export type InputBook = { id: string; title: string; pathLabel: string; fileCount: number; files: string[]; sourceBytes: number; fingerprint: string; issues: PreflightIssue[]; coverPath?: string };

function safeEntries(directory: string) {
  try { return readdirSync(directory, { withFileTypes: true }); } catch { return []; }
}

function coverPathFromEntries(directory: string, entries: ReturnType<typeof safeEntries>) {
  for (const expectedName of COVER_NAMES) {
    const entry = entries.find((candidate) => candidate.isFile() && candidate.name.toLowerCase() === expectedName);
    if (entry) return resolve(directory, entry.name);
  }
  return undefined;
}

export function resolveInputFolder(root: string, folderId: string): string {
  if (folderId.length > 2000 || folderId.includes('\0')) throw new Error('Invalid input folder.');
  const rootPath = resolve(root); const target = resolve(rootPath, folderId === '.' ? '' : folderId);
  const relativePath = relative(rootPath, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) throw new Error('Input folder escapes the configured root.');
  let current = rootPath;
  for (const segment of relativePath.split(sep).filter(Boolean)) { current = resolve(current, segment); const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Input folder may not contain symlink traversal.'); }
  return target;
}

export function scanInputBooks(root: string): InputBook[] {
  const rootPath = resolve(root);
  if (!existsSync(rootPath) || !lstatSync(rootPath).isDirectory() || lstatSync(rootPath).isSymbolicLink()) return [];
  const books: InputBook[] = [];
  const visit = (directory: string) => {
    const entries = safeEntries(directory);
    const audioFiles = naturalSort(entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => entry.name), (name) => name);
    if (audioFiles.length) {
      const id = relative(rootPath, directory).replaceAll('\\', '/') || '.';
      const coverPath = coverPathFromEntries(directory, entries);
      const stats = audioFiles.flatMap((name) => {
        try { return [{ name, stat: statSync(resolve(directory, name)) }]; } catch { return []; }
      });
      if (stats.length !== audioFiles.length) {
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) visit(resolve(directory, entry.name));
        return;
      }
      const fingerprint = createHash('sha256').update(stats.map(({ name, stat }) => `${name}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`).join('\n')).digest('hex');
      const numbers = audioFiles.map((name) => Number(name.match(/^(?:\D*?)(\d{1,6})(?:\D|$)/)?.[1])).filter(Number.isFinite).sort((left, right) => left - right);
      const numberSpan = numbers.length >= 2 ? numbers.at(-1)! - numbers[0]! + 1 : 0;
      const missingNumbers = numberSpan > 0 && numberSpan <= 5_000 ? Array.from({ length: numberSpan }, (_value, index) => numbers[0]! + index).filter((number) => !numbers.includes(number)) : [];
      const issues: PreflightIssue[] = [];
      if (missingNumbers.length) issues.push({ code: 'CHAPTER_SEQUENCE_GAP', severity: 'warning', message: `Numbered filenames skip ${missingNumbers.slice(0, 5).join(', ')}${missingNumbers.length > 5 ? '…' : ''}.` });
      if (numberSpan > 5_000) issues.push({ code: 'CHAPTER_SEQUENCE_RANGE', severity: 'warning', message: 'Chapter numbers span an unusually large range.' });
      if (stats.some(({ stat }) => stat.size < 4096)) issues.push({ code: 'SUSPICIOUSLY_SMALL_SOURCE', severity: 'warning', message: 'At least one audio file is unusually small and may be incomplete.' });
      books.push({ id, title: id === '.' ? basename(rootPath) : basename(directory), pathLabel: id === '.' ? basename(rootPath) : id, fileCount: audioFiles.length, files: audioFiles, sourceBytes: stats.reduce((sum, { stat }) => sum + stat.size, 0), fingerprint, issues, coverPath });
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) visit(resolve(directory, entry.name));
  };
  visit(rootPath);
  return naturalSort(books, (book) => book.pathLabel);
}

export function filesForInputBook(root: string, folderId: string) {
  const folder = resolveInputFolder(root, folderId); const entries = safeEntries(folder);
  const files = naturalSort(entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => { const path = resolve(folder, entry.name); const stat = statSync(path); return { name: entry.name, path, sizeBytes: stat.size, modifiedAt: Math.trunc(stat.mtimeMs) }; }), (file) => file.name);
  const fingerprint = createHash('sha256').update(files.map((file) => `${file.name}\0${file.sizeBytes}\0${file.modifiedAt}`).join('\n')).digest('hex');
  return { folder, files, sourceBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), fingerprint, coverPath: coverPathFromEntries(folder, entries) };
}
