import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { naturalSort } from '../domain/audiobook.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'folder.png'];

export type InputBook = { id: string; title: string; pathLabel: string; fileCount: number; files: string[]; coverPath?: string };

function safeEntries(directory: string) {
  try { return readdirSync(directory, { withFileTypes: true }); } catch { return []; }
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
      const cover = COVER_NAMES.find((name) => entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === name));
      books.push({ id, title: id === '.' ? basename(rootPath) : basename(directory), pathLabel: id === '.' ? basename(rootPath) : id, fileCount: audioFiles.length, files: audioFiles, coverPath: cover ? resolve(directory, cover) : undefined });
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) visit(resolve(directory, entry.name));
  };
  visit(rootPath);
  return naturalSort(books, (book) => book.pathLabel);
}

export function filesForInputBook(root: string, folderId: string) {
  const folder = resolveInputFolder(root, folderId); const entries = safeEntries(folder);
  const files = naturalSort(entries.filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => ({ name: entry.name, path: resolve(folder, entry.name) })), (file) => file.name);
  const coverName = COVER_NAMES.find((name) => entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === name));
  return { folder, files, coverPath: coverName ? resolve(folder, coverName) : undefined };
}
