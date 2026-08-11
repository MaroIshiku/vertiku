import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bookMetadataFromFolderName, buildFfmetadata, chapterTitleFromFilename, chapterTitlesFromFilenames, naturalSort, safeDownloadName } from '../src/domain/audiobook.js';
import { convertToM4b, inspectAudio, probeAudio } from '../src/server/ffmpeg.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('audiobook chapter model', () => {
  it('sorts Part 2 before Part 10 without changing the original array', () => {
    const input = ['Part10.mp3', 'Part2.mp3', 'Part1.mp3'];
    expect(naturalSort(input, (name) => name)).toEqual(['Part1.mp3', 'Part2.mp3', 'Part10.mp3']);
    expect(input).toEqual(['Part10.mp3', 'Part2.mp3', 'Part1.mp3']);
  });

  it('derives readable titles and escapes FFmetadata control characters', () => {
    expect(chapterTitleFromFilename('003_the-last.chapter.mp3')).toBe('the last chapter');
    const metadata = buildFfmetadata({ title: 'Book=One;#', description: 'A long description without a duplicate comment tag.' }, [{ title: 'Part=1', durationMs: 1250 }, { title: 'Part 2', durationMs: 2500 }]);
    expect(metadata).toContain('title=Book\\=One\\;\\#');
    expect(metadata).toContain('description=A long description without a duplicate comment tag.');
    expect(metadata).not.toContain('\ncomment=');
    expect(metadata).toContain('START=1250\nEND=3750');
  });

  it('uses chapter numbers when every filename merely repeats the book title', () => {
    expect(chapterTitlesFromFilenames(['001 - Drood.mp3', '002 - Drood.mp3', '003 - Drood.mp3'], 'Drood')).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(chapterTitlesFromFilenames(['01 - Prologue.mp3', '02 - Arrival.mp3'], 'Example')).toEqual(['Prologue', 'Arrival']);
    expect(bookMetadataFromFolderName('Dan Simmons - Drood')).toEqual({ author: 'Dan Simmons', title: 'Drood' });
  });

  it('removes path and control characters from download names', () => {
    expect(safeDownloadName('../A: Book?')).toBe('..A Book.m4b');
  });
});

describe.runIf(spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0)('real FFmpeg adapter', () => {
  it('creates and validates exactly one chapter per input file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertiku-ffmpeg-')); directories.push(directory);
    const coverPath = join(directory, 'cover.jpg');
    expect(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-y', coverPath], { windowsHide: true }).status).toBe(0);
    const sources = [1, 2].map((number) => {
      const path = join(directory, `Part${number}.m4a`);
      const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${400 + number * 100}:duration=0.35`, ...(number === 1 ? ['-i', coverPath, '-map', '0:a:0', '-map', '1:v:0', '-metadata', 'album=Embedded book', '-metadata', 'artist=Embedded author', '-metadata', 'genre=Audiobook', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic'] : []), '-c:a', 'aac', '-y', path], { windowsHide: true });
      expect(created.status).toBe(0); return path;
    });
    const durations = await Promise.all(sources.map((path) => probeAudio('ffprobe', path)));
    expect(await inspectAudio('ffprobe', sources[0]!)).toMatchObject({ metadata: { title: 'Embedded book', author: 'Embedded author', genre: 'Audiobook' }, embeddedCover: true });
    const outputPath = join(directory, 'result.m4b');
    const phases: string[] = [];
    await convertToM4b({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', outputPath, bitrateKbps: 64, metadata: { title: 'Synthetic book', author: 'Vertiku Tests', description: 'Synthetic description' }, sources: sources.map((path, index) => ({ path, title: `Part ${index + 1}`, durationMs: durations[index]! })), embeddedCoverSourcePath: sources[0], onPhase: (phase) => phases.push(phase) });
    expect(phases).toEqual(['encoding_audio', 'validating_output']);
    expect(readFileSync(outputPath).byteLength).toBeGreaterThan(1000);
    const probed = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic', '-show_chapters', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true });
    expect(probed.status).toBe(0);
    const result = JSON.parse(probed.stdout) as { chapters: unknown[]; streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }>; format?: { tags?: Record<string, string> } };
    expect(result.chapters).toHaveLength(2);
    expect(result.streams).toContainEqual(expect.objectContaining({ codec_type: 'video', disposition: expect.objectContaining({ attached_pic: 1 }) }));
    expect(Object.fromEntries(Object.entries(result.format?.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]))).toMatchObject({ description: 'Synthetic description' });
    expect(Object.keys(result.format?.tags ?? {}).map((key) => key.toLowerCase())).not.toContain('comment');
    expect(existsSync(join(directory, '.result.m4b.ffmetadata'))).toBe(false);
  }, 30_000);

  it('streams hundreds of source files without opening the full book at once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertiku-ffmpeg-many-')); directories.push(directory);
    const basePath = join(directory, 'base.mp3');
    const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-y', basePath], { windowsHide: true });
    expect(created.status).toBe(0);
    const durationMs = await probeAudio('ffprobe', basePath);
    const sources = Array.from({ length: 238 }, (_value, index) => {
      const path = join(directory, `Part${String(index + 1).padStart(3, '0')}.mp3`);
      copyFileSync(basePath, path);
      return { path, title: `Chapter ${index + 1}`, durationMs };
    });
    const outputPath = join(directory, 'many-parts.m4b');
    await convertToM4b({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', outputPath, bitrateKbps: 64, metadata: { title: 'Many parts' }, sources });
    const probed = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_chapters', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true });
    expect(probed.status).toBe(0);
    const result = JSON.parse(probed.stdout) as { chapters: unknown[]; format?: { duration?: string } };
    expect(result.chapters).toHaveLength(238);
    expect(Number(result.format?.duration)).toBeGreaterThan(450);
  }, 120_000);
});
