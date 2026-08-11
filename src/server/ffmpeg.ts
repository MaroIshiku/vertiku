import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { buildFfmetadata, type AudiobookMetadata, type Chapter } from '../domain/audiobook.js';

type ProbeResult = {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string> }>;
  chapters?: Array<{ tags?: { title?: string } }>;
};

export type EmbeddedMetadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string };
export type AudioInspection = { durationMs: number; metadata: EmbeddedMetadata; embeddedCover: boolean };

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

export async function inspectAudio(ffprobePath: string, path: string): Promise<AudioInspection> {
  const result = await runJson(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', path]);
  const seconds = Number(result.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Audio duration could not be read.');
  const tags = Object.fromEntries(Object.entries(result.format?.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value.trim()]));
  const first = (...keys: string[]) => keys.map((key) => tags[key]).find(Boolean) ?? '';
  const rawYear = first('date', 'year');
  return {
    durationMs: Math.round(seconds * 1000),
    metadata: {
      title: first('album', 'title'),
      author: first('album_artist', 'albumartist', 'artist', 'author'),
      narrator: first('narrator', 'performer', 'composer'),
      year: rawYear.match(/\b\d{4}\b/)?.[0] ?? '',
      genre: first('genre'),
      description: first('description', 'comment')
    },
    embeddedCover: Boolean(result.streams?.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1))
  };
}

export async function probeAudio(ffprobePath: string, path: string): Promise<number> {
  return (await inspectAudio(ffprobePath, path)).durationMs;
}

export type ConversionInput = {
  ffmpegPath: string;
  ffprobePath: string;
  sources: Array<{ path: string; title: string; durationMs: number }>;
  metadata: AudiobookMetadata;
  bitrateKbps: 64 | 96 | 128;
  coverPath?: string;
  embeddedCoverSourcePath?: string;
  outputPath: string;
  onProgress?: (progress: number) => void;
  onPhase?: (phase: 'encoding_audio' | 'validating_output') => void;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
};

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

function processResult(child: ChildProcessWithoutNullStreams): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

function appendDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-64 * 1024);
}

function waitForDrain(encoder: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      encoder.stdin.off('drain', onDrain);
      encoder.stdin.off('error', onError);
      encoder.stdin.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolvePromise(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('FFmpeg output encoder closed its audio input unexpectedly.')); };
    encoder.stdin.once('drain', onDrain);
    encoder.stdin.once('error', onError);
    encoder.stdin.once('close', onClose);
  });
}

async function forwardDecodedAudio(decoder: ChildProcessWithoutNullStreams, encoder: ChildProcessWithoutNullStreams): Promise<void> {
  for await (const chunk of decoder.stdout) {
    if (encoder.stdin.destroyed) throw new Error('FFmpeg output encoder closed its audio input unexpectedly.');
    if (encoder.stdin.write(chunk)) continue;
    await waitForDrain(encoder);
  }
}

export async function convertToM4b(input: ConversionInput): Promise<void> {
  if (input.sources.length === 0) throw new Error('At least one audio source is required.');
  const output = resolve(input.outputPath);
  const metadataPath = resolve(dirname(output), `.${basename(output)}.ffmetadata`);
  const chapters: Chapter[] = input.sources.map((source) => ({ title: source.title, durationMs: source.durationMs }));
  await writeFile(metadataPath, buildFfmetadata(input.metadata, chapters), { encoding: 'utf8', mode: 0o600 });
  try {
    const coverSourcePath = input.coverPath ?? input.embeddedCoverSourcePath;
    const encoderArgs = [
      '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
      '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-f', 'ffmetadata', '-i', metadataPath,
      ...(coverSourcePath ? ['-i', resolve(coverSourcePath)] : []),
      '-map', '0:a:0', '-map_metadata', '1', '-map_chapters', '1',
      ...(coverSourcePath
        ? ['-map', '2:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'title=Cover']
        : []),
      '-c:a', 'aac', '-b:a', `${input.bitrateKbps}k`, '-movflags', '+faststart', output
    ];
    const totalMs = input.sources.reduce((sum, source) => sum + source.durationMs, 0);
    input.onPhase?.('encoding_audio');
    const encoder = spawn(input.ffmpegPath, encoderArgs, { shell: false, windowsHide: true });
    input.onChild?.(encoder);
    let encoderStderr = '';
    let activeDecoder: ChildProcessWithoutNullStreams | undefined;
    encoder.stdout.setEncoding('utf8'); encoder.stderr.setEncoding('utf8');
    encoder.stdin.on('error', () => { /* The encoder result below carries the actionable diagnostic. */ });
    encoder.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('out_time_us=')) continue;
        const progress = Math.min(99, Math.max(0, Math.round((Number(line.slice(12)) / 1000 / totalMs) * 100)));
        if (Number.isFinite(progress)) input.onProgress?.(progress);
      }
    });
    encoder.stderr.on('data', (chunk: string) => { encoderStderr = appendDiagnostic(encoderStderr, chunk); });
    const encoderResult = processResult(encoder);
    encoder.once('close', () => activeDecoder?.kill('SIGTERM'));

    try {
      for (const [index, source] of input.sources.entries()) {
        const decoderArgs = [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', resolve(source.path),
          '-map', '0:a:0', '-vn', '-f', 'f32le', '-c:a', 'pcm_f32le', '-ar', '44100', '-ac', '2', 'pipe:1'
        ];
        const decoder = spawn(input.ffmpegPath, decoderArgs, { shell: false, windowsHide: true });
        activeDecoder = decoder;
        let decoderStderr = '';
        decoder.stderr.setEncoding('utf8');
        decoder.stderr.on('data', (chunk: string) => { decoderStderr = appendDiagnostic(decoderStderr, chunk); });
        const decoderResult = processResult(decoder);
        try {
          await forwardDecodedAudio(decoder, encoder);
          const { code, signal, error } = await decoderResult;
          if (error) throw new Error(`FFmpeg source decoder could not start at part ${index + 1}/${input.sources.length}: ${error.message}`, { cause: error });
          if (code !== 0) {
            throw new Error(signal
              ? `FFmpeg source decoder was terminated at part ${index + 1}/${input.sources.length} (${signal}).`
              : `FFmpeg source decoder failed at part ${index + 1}/${input.sources.length} (code ${code}): ${decoderStderr}`);
          }
        } catch (error) {
          decoder.kill('SIGTERM');
          throw error;
        } finally {
          activeDecoder = undefined;
        }
      }
      encoder.stdin.end();
      const { code, signal, error } = await encoderResult;
      if (error) throw new Error(`FFmpeg output encoder could not start: ${error.message}`, { cause: error });
      if (code !== 0) {
        throw new Error(signal
          ? 'Conversion was cancelled.'
          : `FFmpeg output encoder failed (code ${code}): ${encoderStderr}`);
      }
    } catch (error) {
      activeDecoder?.kill('SIGTERM');
      if (!encoder.killed) encoder.kill('SIGTERM');
      const encoderOutcome = await encoderResult;
      if (encoderOutcome.error) throw new Error(`FFmpeg output encoder could not start: ${encoderOutcome.error.message}`, { cause: encoderOutcome.error });
      if (error instanceof Error && /EPIPE|premature close/i.test(error.message) && encoderStderr) {
        throw new Error(`FFmpeg output encoder failed: ${encoderStderr}`, { cause: error });
      }
      throw error;
    }

    input.onPhase?.('validating_output');
    const result = await runJson(input.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist,album', '-show_chapters', '-of', 'json', output]);
    const duration = Number(result.format?.duration);
    const expectedDuration = totalMs / 1000;
    if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) throw new Error(`Result duration validation failed (expected ${expectedDuration.toFixed(3)} seconds, got ${Number.isFinite(duration) ? duration.toFixed(3) : 'an unreadable duration'}).`);
    if ((result.chapters?.length ?? 0) !== chapters.length) throw new Error('Result chapter-count validation failed.');
    const actualTitles = result.chapters?.map((chapter) => chapter.tags?.title ?? '') ?? [];
    if (actualTitles.some((title, index) => title !== chapters[index]?.title)) throw new Error('Result chapter-title validation failed.');
    if (result.format?.tags?.title !== input.metadata.title) throw new Error('Result metadata validation failed.');
  } finally {
    await rm(metadataPath, { force: true });
  }
}
