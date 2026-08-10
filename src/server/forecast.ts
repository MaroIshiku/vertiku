export type ForecastJob = {
  status: string;
  progress: number;
  source_bytes: number;
  source_duration_ms: number;
  started_at: number | null;
};

export type ForecastSample = {
  source_bytes: number;
  source_duration_ms: number;
  processing_ms: number;
};

export type ForecastModel = {
  processingMsPerByte: number;
  processingToAudioRatio: number;
  sampleCount: number;
  confidence: 'learning' | 'measured';
  basis: 'active_job_bytes' | 'history_bytes' | 'conservative_size';
};

const MINIMUM_JOB_MS = 60_000;
const DEFAULT_PROCESSING_MS_PER_BYTE = 1 / (48 * 1024);
const DEFAULT_PROCESSING_TO_AUDIO_RATIO = 0.25;

function percentile(values: number[], fraction: number, fallback: number) {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (!usable.length) return fallback;
  return usable[Math.min(usable.length - 1, Math.ceil(usable.length * fraction) - 1)]!;
}

export function buildForecastModel(samples: ForecastSample[], running: ForecastJob | undefined, now = Date.now()): ForecastModel {
  const byteRates = samples.filter((sample) => sample.source_bytes > 0).map((sample) => sample.processing_ms / sample.source_bytes);
  const durationRatios = samples.filter((sample) => sample.source_duration_ms > 0).map((sample) => sample.processing_ms / sample.source_duration_ms);
  const historicalByteRate = percentile(byteRates, 0.75, DEFAULT_PROCESSING_MS_PER_BYTE);
  const historicalDurationRatio = percentile(durationRatios, 0.75, DEFAULT_PROCESSING_TO_AUDIO_RATIO);
  const reliableActive = running?.status === 'running' && running.progress >= 20 && running.started_at && running.source_bytes > 0
    ? Math.max(1, now - running.started_at) / (Math.min(99, running.progress) / 100) / running.source_bytes
    : undefined;

  if (reliableActive) {
    return {
      processingMsPerByte: samples.length ? Math.max(reliableActive, historicalByteRate) : reliableActive,
      processingToAudioRatio: historicalDurationRatio,
      sampleCount: samples.length,
      confidence: 'measured',
      basis: 'active_job_bytes'
    };
  }
  if (byteRates.length) {
    return { processingMsPerByte: historicalByteRate, processingToAudioRatio: historicalDurationRatio, sampleCount: samples.length, confidence: samples.length >= 3 ? 'measured' : 'learning', basis: 'history_bytes' };
  }
  return { processingMsPerByte: DEFAULT_PROCESSING_MS_PER_BYTE, processingToAudioRatio: historicalDurationRatio, sampleCount: samples.length, confidence: 'learning', basis: 'conservative_size' };
}

export function estimateJobRemainingMs(job: ForecastJob, model: ForecastModel, now = Date.now()) {
  if (!['queued', 'running'].includes(job.status)) return 0;
  if (job.status === 'running' && job.progress >= 10 && job.started_at) {
    const elapsed = Math.max(1, now - job.started_at);
    return Math.max(1_000, elapsed * (100 - Math.min(99, job.progress)) / Math.max(1, job.progress));
  }
  const byBytes = job.source_bytes > 0 ? job.source_bytes * model.processingMsPerByte : 0;
  const byExactDuration = job.source_duration_ms > 0 ? job.source_duration_ms * model.processingToAudioRatio : 0;
  return Math.max(MINIMUM_JOB_MS, byBytes, byExactDuration);
}
