import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const setupSecretSchema = z.string().min(32).refine(
  (secret) => !/^replace-with-/i.test(secret),
  'Replace the published setup-secret placeholder with a unique value.'
);

const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  VERTIKU_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  VERTIKU_DATA_DIR: z.string().default(resolve('data')),
  VERTIKU_INPUT_DIR: z.string().default('/input'),
  VERTIKU_OUTPUT_DIR: z.string().default('/output'),
  VERTIKU_DATABASE_URL: z.string().optional(),
  ISHIKU_SETUP_SECRET: setupSecretSchema.optional(),
  VERTIKU_SETUP_SECRET: setupSecretSchema.optional(),
  VERTIKU_SETUP_SECRET_FILE: z.string().optional(),
  VERTIKU_MAX_UPLOAD_GIB: z.coerce.number().positive().max(100).default(10),
  VERTIKU_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(8).default(1),
  VERTIKU_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe')
});

export function loadConfig(environment = process.env) {
  const value = schema.parse(environment);
  const setupSecret = value.VERTIKU_SETUP_SECRET_FILE
    ? setupSecretSchema.parse(readFileSync(value.VERTIKU_SETUP_SECRET_FILE, 'utf8').trim())
    : value.ISHIKU_SETUP_SECRET ?? value.VERTIKU_SETUP_SECRET;
  const databaseUrl = value.VERTIKU_DATABASE_URL?.replace(/^sqlite:\/\//, '');
  return {
    host: value.HOST,
    port: value.VERTIKU_PORT,
    dataDir: resolve(value.VERTIKU_DATA_DIR),
    inputDir: resolve(value.VERTIKU_INPUT_DIR),
    outputDir: resolve(value.VERTIKU_OUTPUT_DIR),
    databasePath: resolve(databaseUrl ?? `${value.VERTIKU_DATA_DIR}/vertiku.sqlite`),
    setupSecret,
    cookieSecure: value.VERTIKU_COOKIE_SECURE === 'true',
    maxUploadBytes: value.VERTIKU_MAX_UPLOAD_GIB * 1024 ** 3,
    maxConcurrentJobs: value.VERTIKU_MAX_CONCURRENT_JOBS,
    ffmpegPath: value.FFMPEG_PATH,
    ffprobePath: value.FFPROBE_PATH
  };
}
