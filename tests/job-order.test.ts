import { describe, expect, it } from 'vitest';
import { groupJobs } from '../src/client/job-order.js';

describe('job overview ordering', () => {
  it('groups failed, running, queued, completed, and cancelled jobs in that order', () => {
    const groups = groupJobs([
      { id: 'complete-old', status: 'completed', updatedAt: '2026-08-10T10:00:00.000Z' },
      { id: 'queue-second', status: 'queued', queuePosition: 2, createdAt: '2026-08-10T10:02:00.000Z' },
      { id: 'failed-old', status: 'failed', updatedAt: '2026-08-10T10:03:00.000Z' },
      { id: 'running', status: 'running', updatedAt: '2026-08-10T10:04:00.000Z' },
      { id: 'queue-first', status: 'queued', queuePosition: 1, createdAt: '2026-08-10T10:01:00.000Z' },
      { id: 'complete-new', status: 'completed', updatedAt: '2026-08-10T10:05:00.000Z' },
      { id: 'failed-new', status: 'failed', updatedAt: '2026-08-10T10:06:00.000Z' },
      { id: 'cancelled', status: 'cancelled', updatedAt: '2026-08-10T10:07:00.000Z' }
    ]);

    expect(groups.map((group) => group.id)).toEqual(['failed', 'running', 'queued', 'completed', 'cancelled']);
    expect(groups.find((group) => group.id === 'failed')?.jobs.map((job) => job.id)).toEqual(['failed-new', 'failed-old']);
    expect(groups.find((group) => group.id === 'queued')?.jobs.map((job) => job.id)).toEqual(['queue-first', 'queue-second']);
    expect(groups.find((group) => group.id === 'completed')?.jobs.map((job) => job.id)).toEqual(['complete-new', 'complete-old']);
  });
});
