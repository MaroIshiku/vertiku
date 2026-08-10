export type JobOrderRecord = {
  id: string;
  status: string;
  queuePosition?: number;
  createdAt?: string;
  updatedAt?: string;
};

export const JOB_OVERVIEW_GROUPS = [
  { id: 'failed', title: 'Failed', statuses: ['failed'] },
  { id: 'running', title: 'Running now', statuses: ['running'] },
  { id: 'queued', title: 'Waiting in queue', statuses: ['queued', 'pending'] },
  { id: 'completed', title: 'Completed', statuses: ['completed'] },
  { id: 'cancelled', title: 'Cancelled', statuses: ['cancelled'] }
] as const;

function timestamp(value?: string) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupJobs<T extends JobOrderRecord>(jobs: T[]) {
  return JOB_OVERVIEW_GROUPS.map((group) => {
    const items = jobs.filter((job) => (group.statuses as readonly string[]).includes(job.status));
    items.sort((left, right) => {
      if (group.id === 'queued') {
        const position = (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER);
        if (position !== 0) return position;
        return timestamp(left.createdAt) - timestamp(right.createdAt);
      }
      return timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt);
    });
    return { ...group, jobs: items };
  }).filter((group) => group.jobs.length > 0);
}
