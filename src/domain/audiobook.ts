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
