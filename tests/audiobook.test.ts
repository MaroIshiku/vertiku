import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFfmetadata, chapterTitleFromFilename, naturalSort, safeDownloadName } from '../src/domain/audiobook.js';
import { convertToM4b, probeAudio } from '../src/server/ffmpeg.js';

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
    const metadata = buildFfmetadata({ title: 'Book=One;#' }, [{ title: 'Part=1', durationMs: 1250 }, { title: 'Part 2', durationMs: 2500 }]);
    expect(metadata).toContain('title=Book\\=One\\;\\#');
    expect(metadata).toContain('START=1250\nEND=3750');
  });

  it('removes path and control characters from download names', () => {
    expect(safeDownloadName('../A: Book?')).toBe('..A Book.m4b');
  });
});

describe.runIf(spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0)('real FFmpeg adapter', () => {
  it('creates and validates exactly one chapter per input file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vertiku-ffmpeg-')); directories.push(directory);
    const sources = [1, 2].map((number) => {
      const path = join(directory, `Part${number}.wav`);
      const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${400 + number * 100}:duration=0.35`, '-c:a', 'pcm_s16le', '-y', path], { windowsHide: true });
      expect(created.status).toBe(0); return path;
    });
    const durations = await Promise.all(sources.map((path) => probeAudio('ffprobe', path)));
    const outputPath = join(directory, 'result.m4b');
    await convertToM4b({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', outputPath, bitrateKbps: 64, metadata: { title: 'Synthetic book', author: 'Vertiku Tests' }, sources: sources.map((path, index) => ({ path, title: `Part ${index + 1}`, durationMs: durations[index]! })) });
    expect(readFileSync(outputPath).byteLength).toBeGreaterThan(1000);
    const probed = spawnSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true });
    expect(probed.status).toBe(0); expect((JSON.parse(probed.stdout) as { chapters: unknown[] }).chapters).toHaveLength(2);
    expect(existsSync(join(directory, '.result.m4b.ffmetadata'))).toBe(false);
  }, 30_000);
});
