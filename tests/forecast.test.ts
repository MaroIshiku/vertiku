import { describe, expect, it } from 'vitest';
import { buildForecastModel, estimateJobRemainingMs, type ForecastJob } from '../src/server/forecast.js';

const mib = 1024 ** 2;
const queued = (sourceBytes: number, sourceDurationMs = 0): ForecastJob => ({ status: 'queued', progress: 0, source_bytes: sourceBytes, source_duration_ms: sourceDurationMs, started_at: null });

describe('serial queue forecasting', () => {
  it('projects every queued byte from a sufficiently advanced active audiobook', () => {
    const now = Date.UTC(2026, 7, 10, 12);
    const remainingActiveMs = 120 * 60_000;
    const elapsed = remainingActiveMs * 56 / 44;
    const running: ForecastJob = { status: 'running', progress: 56, source_bytes: 594 * mib, source_duration_ms: 0, started_at: now - elapsed };
    const model = buildForecastModel([], running, now);
    const queuedEstimate = estimateJobRemainingMs(queued(2620 * mib), model, now);
    const total = estimateJobRemainingMs(running, model, now) + queuedEstimate;

    expect(model.basis).toBe('active_job_bytes');
    expect(queuedEstimate / 60_000).toBeCloseTo(1203, 0);
    expect(total / 60_000).toBeCloseTo(1323, 0);
  });

  it('does not compress forty same-sized queued books into a few minutes', () => {
    const now = Date.UTC(2026, 7, 10, 12);
    const elapsed = 4 * 60_000 * 30 / 70;
    const running: ForecastJob = { status: 'running', progress: 30, source_bytes: 600 * mib, source_duration_ms: 0, started_at: now - elapsed };
    const model = buildForecastModel([], running, now);
    const allQueued = Array.from({ length: 40 }, () => estimateJobRemainingMs(queued(600 * mib), model, now)).reduce((sum, value) => sum + value, 0);

    expect(allQueued / 60_000).toBeCloseTo(228.6, 1);
    expect((allQueued + estimateJobRemainingMs(running, model, now)) / 60_000).toBeGreaterThan(230);
  });

  it('uses a conservative percentile so one fast historical outlier cannot collapse the estimate', () => {
    const samples = [1, 1.2, 1.4, 0.01].map((processingMsPerByte) => ({ source_bytes: 1_000_000, source_duration_ms: 10_000, processing_ms: processingMsPerByte * 1_000_000 }));
    const model = buildForecastModel(samples, undefined);
    expect(model.basis).toBe('history_bytes');
    expect(model.processingMsPerByte).toBe(1.2);
    expect(estimateJobRemainingMs(queued(1_000_000), model)).toBeGreaterThanOrEqual(1_200_000);
  });

  it('gives every unknown queued book a conservative minimum while learning', () => {
    const model = buildForecastModel([], undefined);
    const total = Array.from({ length: 40 }, () => estimateJobRemainingMs(queued(0), model)).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(40 * 60_000);
  });
});
