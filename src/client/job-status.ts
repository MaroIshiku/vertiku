import type { Job, JobPhase } from './types.js';

export function phaseLabel(job: Job) {
  if (job.status === 'queued') return job.queuePosition ? `Queue position ${job.queuePosition}` : 'Queued';
  if (job.status === 'running') {
    if (job.phase === 'reading_sources') return 'Reading source details';
    if (job.phase === 'preparing_output') return 'Preparing the M4B output';
    if (job.phase === 'validating_output') return 'Validating and publishing the M4B';
    return 'Encoding chapter audio';
  }
  if (job.status === 'completed') return 'Completed';
  if (job.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

export function statusDescription(job: Job) {
  switch (job.status) {
    case 'completed': return job.destination === 'output' ? `Saved to /output/${job.outputName ?? 'audiobook.m4b'}.` : 'Your validated browser download is ready.';
    case 'failed': return 'The conversion could not be completed. The remaining queue continued normally.';
    case 'cancelled': return 'The conversion was cancelled.';
    case 'queued': return 'Vertiku keeps your place safely and starts this book after every earlier book is complete.';
    default: return job.destination === 'output' ? 'Vertiku is working directly inside /output without creating a second result copy.' : 'Vertiku is preparing your private browser download.';
  }
}

export function errorTitle(code: string) {
  if (code === 'ENGINE_FAILED') return 'Conversion failed';
  if (code === 'VALIDATION_FAILED') return 'Validation failed';
  return code.replaceAll('_', ' ');
}

export const JOB_STAGES: Array<{ phase: JobPhase; title: string; detail: string }> = [
  { phase: 'queued', title: 'Queued safely', detail: 'Store the job and source references before processing.' },
  { phase: 'reading_sources', title: 'Reading source details', detail: 'Read duration, embedded tags, chapters, and cover information.' },
  { phase: 'preparing_output', title: 'Preparing output', detail: 'Resolve metadata, filename, storage capacity, and the working file.' },
  { phase: 'encoding_audio', title: 'Encoding chapter audio', detail: 'Create the AAC audio stream and chapter timeline.' },
  { phase: 'validating_output', title: 'Validating and publishing', detail: 'Verify duration, chapter titles, and metadata before publishing.' }
];
