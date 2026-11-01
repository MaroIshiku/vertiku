export type User = { username: string; role: string };
export type Session = { csrf: string; user: User };

export type Source = { id: string; filename: string; title: string; durationMs: number; duration: string };
export type EmbeddedMetadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string };
export type Draft = { id: string; cover: boolean; suggestedTitle?: string; suggestedAuthor?: string; suggestedMetadata?: EmbeddedMetadata; sources: Source[] };

export type Bitrate = 64 | 96 | 128;
export type Destination = 'output' | 'download';
export type Metadata = { title: string; author: string; narrator: string; year: string; genre: string; description: string; bitrateKbps: Bitrate; destination: Destination };
export const defaultMetadata = (): Metadata => ({ title: '', author: '', narrator: '', year: '', genre: 'Audiobook', description: '', bitrateKbps: 96, destination: 'output' });

export type JobPhase = 'queued' | 'reading_sources' | 'preparing_output' | 'encoding_audio' | 'validating_output' | 'completed';
export type Job = {
  id: string; status: string; phase?: JobPhase; progress: number; queuePosition?: number; title: string;
  destination?: Destination; outputName?: string; downloadReady?: boolean; mediaReady?: boolean; retryable?: boolean; retryOf?: string;
  sourceDurationMs?: number; estimatedOutputBytes?: number; estimatedRemainingSeconds?: number; estimatedFinishAt?: string; estimateConfidence?: 'learning' | 'measured';
  error?: { code: string; message: string; retryable?: boolean }; createdAt?: string; updatedAt?: string;
};
export type QueueSummary = {
  remainingJobs: number; queuedJobs: number; queuedSourceBytes: number; estimatedQueuedSeconds: number; estimatedRemainingSeconds: number; estimatedFinishAt?: string;
  currentJobId?: string; currentJobEstimatedRemainingSeconds?: number; currentJobEstimatedFinishAt?: string;
  confidence: 'learning' | 'measured'; forecastBasis: 'active_job_bytes' | 'history_bytes' | 'conservative_size'; forecastSampleCount: number;
};
export type JobsSnapshot = { jobs: Job[]; queue: QueueSummary };

export type InputChapter = { filename: string; title: string };
export type PreflightIssue = { code: string; severity: 'warning' | 'error'; message: string };
export type InputBook = { id: string; title: string; pathLabel: string; fileCount: number; sourceBytes: number; fingerprint: string; suggestedTitle: string; suggestedAuthor: string; issues: PreflightIssue[]; needsReview: boolean; alreadyConvertedJobId?: string; chapters: InputChapter[] };
export type BatchItem = { book: InputBook; metadata: Metadata; chapters: InputChapter[] };

export const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (job: Job) => TERMINAL_STATUSES.includes(job.status);
