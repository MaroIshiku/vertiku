import type { convertToM4b, inspectAudio, probeAudio } from './ffmpeg.js';

export type AppOptions = {
  databasePath: string;
  cookieSecure: boolean;
  setupSecret?: string;
  dataDir?: string;
  inputDir?: string;
  outputDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxUploadBytes?: number;
  maxConcurrentJobs?: number;
  passwordResetEnabled?: boolean;
  etaHistoryResetToken?: string;
  convert?: typeof convertToM4b;
  probe?: typeof probeAudio;
  inspect?: typeof inspectAudio;
  staticRoot?: string;
};

export type StoragePaths = { dataDir: string; uploadsDir: string; resultsDir: string; inputDir: string; outputDir: string };

export type Session = { token_hash: string; account_id: number; csrf: string; expires_at: number; username: string; role: string };
export type DraftSource = { id: string; draft_id: string; original_name: string; storage_path: string; duration_ms: number; size_bytes: number; modified_at: number; sort_order: number };
export type StoredChapter = { sourceId: string; title: string };
export type StoredMetadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string };
export type JobPhase = 'queued' | 'reading_sources' | 'preparing_output' | 'encoding_audio' | 'validating_output' | 'completed';
export type JobRow = {
  id: string; draft_id: string; owner_id: number; status: string; phase: JobPhase; progress: number; title: string;
  destination: 'output' | 'download'; bitrate_kbps: 64 | 96 | 128; metadata_json: string; chapters_json: string;
  output_path: string | null; export_path: string | null; error_code: string | null; error_message: string | null;
  source_fingerprint: string | null; source_bytes: number; source_duration_ms: number; estimated_duration_ms: number; estimated_output_bytes: number;
  retry_of: string | null; retryable: number; started_at: number | null; finished_at: number | null; archived_at: number | null; created_at: number; updated_at: number;
};

export const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled'];
