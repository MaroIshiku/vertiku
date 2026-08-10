import { basename, extname } from 'node:path';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function naturalSort<T>(items: T[], name: (item: T) => string): T[] {
  return [...items].sort((left, right) => collator.compare(name(left), name(right)));
}

export function chapterTitleFromFilename(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/^[\s._-]*\d+[\s._-]*/u, '')
    .replace(/[._-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Untitled chapter';
}

function comparable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function bookMetadataFromFolderName(folderName: string): { title: string; author: string } {
  const cleaned = folderName.replace(/[_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const separator = cleaned.indexOf(' - ');
  if (separator <= 0 || separator >= cleaned.length - 3) return { title: cleaned || 'Untitled audiobook', author: '' };
  return { author: cleaned.slice(0, separator).trim(), title: cleaned.slice(separator + 3).trim() };
}

export function chapterTitlesFromFilenames(filenames: string[], bookTitle = ''): string[] {
  const parsed = filenames.map((filename, index) => {
    const stem = basename(filename, extname(filename));
    const match = stem.match(/^[\s._-]*(\d+)(?:[\s._-]+|$)/u);
    return {
      index,
      number: match ? Number.parseInt(match[1]!, 10) : undefined,
      title: chapterTitleFromFilename(filename)
    };
  });
  const counts = new Map<string, number>();
  for (const item of parsed) {
    const key = comparable(item.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const normalizedBookTitle = comparable(bookTitle);
  return parsed.map((item) => {
    const key = comparable(item.title);
    const repeated = (counts.get(key) ?? 0) > 1;
    const merelyRepeatsBookTitle = parsed.length > 1 && normalizedBookTitle.length > 0 && key === normalizedBookTitle;
    if (!repeated && !merelyRepeatsBookTitle) return item.title;
    return `Chapter ${item.number ?? item.index + 1}`;
  });
}

export function escapeFfmetadata(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([=;#])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

export type Chapter = { title: string; durationMs: number };
export type AudiobookMetadata = { title: string; author?: string; narrator?: string; year?: string; genre?: string; description?: string };

export function buildFfmetadata(metadata: AudiobookMetadata, chapters: Chapter[]): string {
  let cursor = 0;
  const lines = [
    ';FFMETADATA1',
    `title=${escapeFfmetadata(metadata.title)}`,
    `album=${escapeFfmetadata(metadata.title)}`,
    `artist=${escapeFfmetadata(metadata.author ?? '')}`,
    `album_artist=${escapeFfmetadata(metadata.author ?? '')}`,
    `composer=${escapeFfmetadata(metadata.narrator ?? '')}`,
    `date=${escapeFfmetadata(metadata.year ?? '')}`,
    `genre=${escapeFfmetadata(metadata.genre ?? 'Audiobook')}`,
    `comment=${escapeFfmetadata(metadata.description ?? '')}`
  ];
  for (const chapter of chapters) {
    const start = cursor;
    cursor += Math.max(1, Math.round(chapter.durationMs));
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${cursor}`, `title=${escapeFfmetadata(chapter.title)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function safeDownloadName(title: string): string {
  const safe = title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  return `${safe || 'audiobook'}.m4b`;
}
