import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { buildFfmetadata, type AudiobookMetadata, type Chapter } from '../domain/audiobook.js';

type ProbeResult = { format?: { duration?: string; tags?: Record<string, string> }; chapters?: Array<{ tags?: { title?: string } }> };

function runJson(binary: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(JSON.parse(stdout) as ProbeResult) : reject(new Error(`ffprobe failed (${code}): ${stderr.slice(-800)}`)));
  });
}

export async function probeAudio(ffprobePath: string, path: string): Promise<number> {
  const result = await runJson(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path]);
  const seconds = Number(result.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Audio duration could not be read.');
  return Math.round(seconds * 1000);
}

export type ConversionInput = {
  ffmpegPath: string;
  ffprobePath: string;
  sources: Array<{ path: string; title: string; durationMs: number }>;
  metadata: AudiobookMetadata;
  bitrateKbps: 64 | 96 | 128;
  coverPath?: string;
  outputPath: string;
  onProgress?: (progress: number) => void;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
};

export async function convertToM4b(input: ConversionInput): Promise<void> {
  if (input.sources.length === 0) throw new Error('At least one audio source is required.');
  const output = resolve(input.outputPath);
  const metadataPath = resolve(dirname(output), `.${basename(output)}.ffmetadata`);
  const chapters: Chapter[] = input.sources.map((source) => ({ title: source.title, durationMs: source.durationMs }));
  await writeFile(metadataPath, buildFfmetadata(input.metadata, chapters), { encoding: 'utf8', mode: 0o600 });
  try {
  const inputArgs = input.sources.flatMap((source) => ['-i', resolve(source.path)]);
  const metadataIndex = input.sources.length;
  const coverIndex = metadataIndex + 1;
  const filters = input.sources.map((_source, index) => `[${index}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`).join(';');
  const concatInputs = input.sources.map((_source, index) => `[a${index}]`).join('');
  const args = [
    '-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats',
    ...inputArgs,
    '-f', 'ffmetadata', '-i', metadataPath,
    ...(input.coverPath ? ['-i', resolve(input.coverPath)] : []),
    '-filter_complex', `${filters};${concatInputs}concat=n=${input.sources.length}:v=0:a=1[audio]`,
    '-map', '[audio]', '-map_metadata', String(metadataIndex),
    ...(input.coverPath ? ['-map', `${coverIndex}:v:0`, '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'title=Cover'] : []),
    '-c:a', 'aac', '-b:a', `${input.bitrateKbps}k`, '-movflags', '+faststart', output
  ];
  const totalMs = input.sources.reduce((sum, source) => sum + source.durationMs, 0);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(input.ffmpegPath, args, { shell: false, windowsHide: true });
    input.onChild?.(child);
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('out_time_us=')) continue;
        const progress = Math.min(99, Math.max(0, Math.round((Number(line.slice(12)) / 1000 / totalMs) * 100)));
        if (Number.isFinite(progress)) input.onProgress?.(progress);
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(signal ? 'Conversion was cancelled.' : `FFmpeg failed (${code}): ${stderr}`)));
  });
  const result = await runJson(input.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist,album', '-show_chapters', '-of', 'json', output]);
  const duration = Number(result.format?.duration);
  const expectedDuration = totalMs / 1000;
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) throw new Error('Result duration validation failed.');
  if ((result.chapters?.length ?? 0) !== chapters.length) throw new Error('Result chapter-count validation failed.');
  const actualTitles = result.chapters?.map((chapter) => chapter.tags?.title ?? '') ?? [];
  if (actualTitles.some((title, index) => title !== chapters[index]?.title)) throw new Error('Result chapter-title validation failed.');
  if (result.format?.tags?.title !== input.metadata.title) throw new Error('Result metadata validation failed.');
  await readFile(output);
  } finally {
    await rm(metadataPath, { force: true });
  }
}
