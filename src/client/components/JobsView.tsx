import { useEffect, useState } from 'react';
import { errorMessage, postJson, requestJson } from '../api.js';
import { finishTime, formatEstimate, formatSourceSize, plural } from '../format.js';
import { groupJobs } from '../job-order.js';
import { phaseLabel } from '../job-status.js';
import { isTerminal, type Job, type JobsSnapshot, type QueueSummary, type Session } from '../types.js';
import { EmptyState } from './fields.js';

const FALLBACK_REFRESH_MS = 10_000;

function QueueForecast({ queue }: { queue?: QueueSummary }) {
  if (!queue || queue.remainingJobs === 0) return null;
  const basis = queue.forecastBasis === 'active_job_bytes'
    ? "the active audiobook's measured processing rate"
    : queue.forecastBasis === 'history_bytes'
      ? `${queue.forecastSampleCount} persistent server measurement${queue.forecastSampleCount === 1 ? '' : 's'}`
      : 'a conservative source-size fallback while Vertiku learns this server';
  return <div className="queue-forecast" role="status">
    <p><strong>Full queue estimate</strong><span>{plural(queue.remainingJobs, 'audiobook')} remaining</span></p>
    <p>About {formatEstimate(queue.estimatedRemainingSeconds)} · all queued work should finish around {finishTime(queue.estimatedFinishAt)}</p>
    <small>Current audiobook plus about {formatEstimate(queue.estimatedQueuedSeconds)} for all {queue.queuedJobs} waiting book{queue.queuedJobs === 1 ? '' : 's'} ({formatSourceSize(queue.queuedSourceBytes)} source) · based on {basis}</small>
  </div>;
}

type JobsViewProps = { session: Session; initialJobs?: Job[]; onOpenJob: (job: Job) => void; onNewAudiobook: () => void };

/** Live jobs overview: server-sent events with a periodic fallback refresh. */
export function JobsView({ session, initialJobs, onOpenJob, onNewAudiobook }: JobsViewProps) {
  const [jobs, setJobs] = useState<Job[] | undefined>(initialJobs);
  const [queue, setQueue] = useState<QueueSummary>();
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const apply = (result: JobsSnapshot) => { if (!disposed) { setJobs(result.jobs); setQueue(result.queue); } };
    const refresh = () => void requestJson<JobsSnapshot>('/api/jobs').then(apply).catch(() => undefined);
    refresh();
    const events = new EventSource('/api/jobs/events');
    events.addEventListener('jobs', (event) => apply(JSON.parse((event as MessageEvent).data) as JobsSnapshot));
    const fallback = window.setInterval(refresh, FALLBACK_REFRESH_MS);
    return () => { disposed = true; events.close(); window.clearInterval(fallback); };
  }, [session]);

  const list = jobs ?? [];
  const retryableJobs = list.filter((job) => job.retryable).length;
  const stoppedJobs = list.filter((job) => job.status === 'failed' || job.status === 'cancelled').length;
  const queuedJobs = queue?.queuedJobs ?? 0;

  async function action(run: () => Promise<void>, fallback: string) {
    setNotice(''); setError('');
    try { await run(); } catch (reason) { setError(errorMessage(reason, fallback)); }
  }
  const retryFailed = () => action(async () => {
    const result = await postJson<{ accepted: number; skipped: number; jobs: Job[] }>('/api/jobs/retry-failed', session.csrf);
    if (result.jobs[0]) onOpenJob(result.jobs[0]);
    else setError('None of the failed jobs could be retried. Their source files may no longer be available.');
  }, 'The failed jobs could not be retried.');
  const cancelWaiting = () => action(async () => {
    if (!queuedJobs || !window.confirm(`Cancel all ${plural(queuedJobs, 'waiting audiobook')}? The running conversion will continue.`)) return;
    const result = await postJson<{ cancelled: number }>('/api/jobs/cancel-queued', session.csrf);
    setNotice(`${plural(result.cancelled, 'waiting audiobook')} cancelled.`);
  }, 'The waiting jobs could not be cancelled.');
  const clearStopped = () => action(async () => {
    if (!stoppedJobs || !window.confirm(`Clear ${plural(stoppedJobs, 'failed or cancelled job')} from this overview? Audiobooks and source files will not be deleted.`)) return;
    const result = await postJson<{ cleared: number }>('/api/jobs/clear-stopped', session.csrf);
    setJobs((current) => current?.filter((job) => job.status !== 'failed' && job.status !== 'cancelled'));
    setNotice(`${plural(result.cleared, 'job')} cleared from the overview.`);
  }, 'The jobs could not be cleared.');
  const clearJob = (job: Job) => action(async () => {
    if (!window.confirm(`Clear “${job.title}” from this overview? Its files will not be deleted.`)) return;
    await postJson<{ cleared: number }>(`/api/jobs/${job.id}/clear`, session.csrf);
    setJobs((current) => current?.filter((item) => item.id !== job.id));
    setNotice(`“${job.title}” cleared from the overview.`);
  }, 'The job could not be cleared.');

  return <section className="workspace-card psu-card">
    <div className="section-heading">
      <div>
        <p className="eyebrow">LIVE QUEUE</p>
        <h1>Your conversion jobs</h1>
        <p>Updates arrive automatically. Vertiku processes exactly one audiobook at a time.</p>
        <QueueForecast queue={queue} />
      </div>
      <div className="button-row">
        {retryableJobs > 0 && <button className="secondary" onClick={() => void retryFailed()}>Retry {retryableJobs} failed</button>}
        {stoppedJobs > 0 && <button className="secondary" onClick={() => void clearStopped()}>Clear failed &amp; cancelled ({stoppedJobs})</button>}
        {queuedJobs > 0 && <button className="secondary" onClick={() => void cancelWaiting()}>Cancel all waiting ({queuedJobs})</button>}
        <button className="primary" onClick={onNewAudiobook}>New audiobook</button>
      </div>
    </div>
    {notice && <p className="message success" role="status">{notice}</p>}
    {error && <p className="message error" role="alert">{error}</p>}
    {jobs === undefined
      ? <div className="empty-state"><p>Loading jobs…</p></div>
      : list.length === 0
        ? <EmptyState title="No jobs yet" heading="h2">Your audiobook conversions will appear here.</EmptyState>
        : <div className="job-groups">
          {groupJobs(list).map((group) => <section className="job-group" key={group.id} aria-labelledby={`job-group-${group.id}`}>
            <div className="job-group-heading"><h2 id={`job-group-${group.id}`}>{group.title}</h2><span>{group.jobs.length}</span></div>
            <div className="jobs-list">
              {group.jobs.map((job) => <div className="job-list-item" key={job.id}>
                <button className="job-list-open" onClick={() => onOpenJob(job)}>
                  <span>
                    <strong>{job.title}</strong>
                    <small>{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}{job.retryOf ? ' · Retry' : ''}{job.status === 'queued' && job.queuePosition ? ` · Position ${job.queuePosition}` : ''}</small>
                  </span>
                  <span className="job-list-state"><span className={`status-label ${job.status}`}>{phaseLabel(job)}</span><small>{job.progress}%</small></span>
                </button>
                {isTerminal(job) && <button className="job-list-clear" aria-label={`Clear ${job.title} from job history`} onClick={() => void clearJob(job)}>Clear entry</button>}
              </div>)}
            </div>
          </section>)}
        </div>}
  </section>;
}
