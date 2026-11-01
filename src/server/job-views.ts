import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildForecastModel, estimateJobRemainingMs, type ForecastModel, type ForecastSample } from './forecast.js';
import type { JobRow } from './types.js';

/** Read-side job queries and the browser representation of jobs and the queue forecast. */
export function createJobViews(sqlite: DatabaseSync) {
  function jobById(id: string) { return sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined; }

  function jobIsCancelled(jobId: string) {
    return (sqlite.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined)?.status === 'cancelled';
  }

  function forecastModel(ownerId: number, running?: JobRow, now = Date.now()) {
    const samples = sqlite.prepare('SELECT source_bytes, source_duration_ms, processing_ms FROM conversion_samples WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50').all(ownerId) as ForecastSample[];
    return buildForecastModel(samples, running, now);
  }

  /** Positions in the single global FIFO queue, resolved with one query. */
  function queuePositions() {
    const rows = sqlite.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id").all() as Array<{ id: string }>;
    return new Map(rows.map((row, index) => [row.id, index + 1]));
  }

  function queuePosition(row: JobRow) {
    return Number((sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id <= ?))").get(row.created_at, row.created_at, row.id) as { count: number }).count);
  }

  function publicJob(row: JobRow, model: ForecastModel = forecastModel(row.owner_id, row.status === 'running' ? row : undefined), positions?: Map<string, number>) {
    const position = row.status !== 'queued' ? undefined : positions ? positions.get(row.id) : queuePosition(row);
    const remainingMs = row.status === 'running' ? estimateJobRemainingMs(row, model) : 0;
    return {
      id: row.id,
      status: row.status,
      phase: row.status === 'completed' ? 'completed' : row.phase,
      progress: row.progress,
      queuePosition: position,
      title: row.title,
      destination: row.destination,
      outputName: row.export_path ? basename(row.export_path) : undefined,
      error: row.error_message ? { code: row.error_code, message: row.error_message, retryable: Boolean(row.retryable) } : undefined,
      downloadReady: row.status === 'completed' && row.destination === 'download',
      mediaReady: row.status === 'completed' && Boolean(row.output_path && existsSync(row.output_path)),
      retryable: row.status === 'failed' && Boolean(row.retryable),
      retryOf: row.retry_of ?? undefined,
      sourceDurationMs: row.source_duration_ms || row.estimated_duration_ms,
      estimatedOutputBytes: row.estimated_output_bytes,
      estimatedRemainingSeconds: remainingMs ? Math.max(1, Math.round(remainingMs / 1000)) : undefined,
      estimatedFinishAt: remainingMs ? new Date(Date.now() + remainingMs).toISOString() : undefined,
      estimateConfidence: model.confidence,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  function queueSummary(ownerId: number) {
    const rows = sqlite.prepare("SELECT * FROM jobs WHERE owner_id = ? AND status IN ('running','queued') ORDER BY created_at, id").all(ownerId) as JobRow[];
    const now = Date.now();
    const running = rows.find((row) => row.status === 'running');
    const model = forecastModel(ownerId, running, now);
    const currentRemainingMs = running ? estimateJobRemainingMs(running, model, now) : 0;
    const queued = rows.filter((row) => row.status === 'queued');
    const queuedRemainingMs = queued.reduce((sum, row) => sum + estimateJobRemainingMs(row, model, now), 0);
    const remainingMs = currentRemainingMs + queuedRemainingMs;
    return {
      remainingJobs: rows.length,
      queuedJobs: queued.length,
      queuedSourceBytes: queued.reduce((sum, row) => sum + row.source_bytes, 0),
      estimatedQueuedSeconds: Math.max(0, Math.round(queuedRemainingMs / 1000)),
      estimatedRemainingSeconds: Math.max(0, Math.round(remainingMs / 1000)),
      estimatedFinishAt: rows.length ? new Date(now + remainingMs).toISOString() : undefined,
      currentJobId: running?.id,
      currentJobEstimatedRemainingSeconds: running ? Math.max(1, Math.round(currentRemainingMs / 1000)) : undefined,
      currentJobEstimatedFinishAt: running ? new Date(now + currentRemainingMs).toISOString() : undefined,
      confidence: model.confidence,
      forecastBasis: model.basis,
      forecastSampleCount: model.sampleCount
    };
  }

  /** One consistent jobs-overview snapshot for the list endpoint and the live stream. */
  function jobsSnapshot(ownerId: number) {
    const rows = sqlite.prepare('SELECT * FROM jobs WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 250').all(ownerId) as JobRow[];
    const running = rows.find((row) => row.status === 'running');
    const model = forecastModel(ownerId, running);
    const positions = rows.some((row) => row.status === 'queued') ? queuePositions() : new Map<string, number>();
    return { jobs: rows.map((row) => publicJob(row, model, positions)), queue: queueSummary(ownerId) };
  }

  return { jobById, jobIsCancelled, publicJob, jobsSnapshot };
}

export type JobViews = ReturnType<typeof createJobViews>;
