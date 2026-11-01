import { useEffect, useState } from 'react';
import { errorMessage, postJson } from '../api.js';
import { finishTime, formatEstimate } from '../format.js';
import { JOB_STAGES, errorTitle, phaseLabel, statusDescription } from '../job-status.js';
import { isTerminal, type Job, type Session } from '../types.js';

export function JobActivity({ job }: { job: Job }) {
  if (job.status === 'completed') return <div className="job-activity completed" aria-hidden="true">✓</div>;
  if (job.status === 'failed' || job.status === 'cancelled') return <div className="job-activity failed" aria-hidden="true">!</div>;
  return <div className={`job-activity ${job.status}`} aria-hidden="true"><span className="signal-bars"><i /><i /><i /><i /><i /></span><span className="signal-node" /></div>;
}

/** Five persistent stages; completed, current, pending, and stopped are conveyed by text and symbols, not color alone. */
function JobChecklist({ job }: { job: Job }) {
  const completed = job.status === 'completed';
  const currentIndex = completed ? JOB_STAGES.length : Math.max(0, JOB_STAGES.findIndex((stage) => stage.phase === (job.phase ?? 'queued')));
  return <section className="job-checklist" aria-labelledby="job-checklist-title">
    <div className="job-checklist-heading">
      <div><p className="eyebrow">PROCESS CHECKLIST</p><h2 id="job-checklist-title">Five steps to a validated audiobook</h2></div>
      <span>{Math.min(currentIndex, JOB_STAGES.length)} of {JOB_STAGES.length} complete</span>
    </div>
    <ol>
      {JOB_STAGES.map((stage, index) => {
        const done = completed || index < currentIndex;
        const current = !completed && index === currentIndex;
        const stopped = current && (job.status === 'failed' || job.status === 'cancelled');
        const state = stopped ? job.status === 'failed' ? 'Stopped here' : 'Cancelled here' : job.status === 'queued' ? 'Waiting to start' : 'In progress';
        return <li key={stage.phase} className={done ? 'done' : stopped ? 'stopped' : current ? 'current' : 'pending'} aria-current={current ? 'step' : undefined}>
          <span className="stage-marker" aria-hidden="true">{done ? '✓' : stopped ? '!' : index + 1}</span>
          <div><strong>{stage.title}</strong><small>{stage.detail}</small>{current && <span className="stage-state">{state}</span>}</div>
        </li>;
      })}
    </ol>
  </section>;
}

type JobProgressProps = { job: Job; session: Session; onChange: (job: Job) => void; onShowJobs: () => void };

export function JobProgress({ job, session, onChange, onShowJobs }: JobProgressProps) {
  const [actionError, setActionError] = useState(''); const [actionBusy, setActionBusy] = useState(false);
  const terminal = isTerminal(job);

  useEffect(() => {
    if (terminal) return;
    const events = new EventSource(`/api/jobs/${job.id}/events`);
    events.addEventListener('job', (event) => onChange(JSON.parse((event as MessageEvent).data) as Job));
    return () => events.close();
  }, [job.id, terminal, onChange]);

  async function act(action: () => Promise<void>, fallback: string) {
    setActionBusy(true); setActionError('');
    try { await action(); } catch (reason) { setActionError(errorMessage(reason, fallback)); } finally { setActionBusy(false); }
  }
  const cancel = () => act(async () => { onChange({ ...job, ...await postJson<Job>(`/api/jobs/${job.id}/cancel`, session.csrf) }); }, 'The job could not be cancelled.');
  const retry = () => act(async () => { onChange(await postJson<Job>(`/api/jobs/${job.id}/retry`, session.csrf)); }, 'The job could not be retried.');

  return <section className="workspace-card job-card">
    <div className="job-summary" aria-live="polite">
      <JobActivity job={job} />
      <p className="eyebrow">CONVERSION JOB</p>
      <h1>{job.title || 'Your audiobook'}</h1>
      <p className="job-phase">{phaseLabel(job)}</p>
      <p className="job-status">{statusDescription(job)}</p>
      {job.status === 'running' && job.estimatedRemainingSeconds !== undefined && <p className="job-eta">
        <strong>This audiobook:</strong> about {formatEstimate(job.estimatedRemainingSeconds)} remaining · expected around {finishTime(job.estimatedFinishAt)}{' '}
        <small>({job.estimateConfidence === 'measured' ? 'based on this server' : 'early estimate'})</small>
      </p>}
      <progress max="100" value={job.progress} aria-label="Conversion progress" />
      <strong>{job.progress}%</strong>
    </div>
    <JobChecklist job={job} />
    {job.error && <p className="message error" role="alert"><strong>{errorTitle(job.error.code)}</strong><br />{job.error.message}</p>}
    {job.mediaReady && <div className="result-player">
      <h2>Listen to the validated result</h2>
      <audio controls preload="metadata" src={`/api/jobs/${job.id}/media`}>Your browser cannot play this M4B file.</audio>
    </div>}
    {actionError && <p className="message error" role="alert">{actionError}</p>}
    <div className="button-row centered">
      <button className="secondary" onClick={onShowJobs}>All jobs</button>
      {!terminal && <button className="secondary" disabled={actionBusy} onClick={() => void cancel()}>Cancel</button>}
      {job.retryable && <button className="secondary" disabled={actionBusy} onClick={() => void retry()}>Retry this audiobook</button>}
      {job.downloadReady && <a className="button primary" href={`/api/jobs/${job.id}/download`}>Download M4B</a>}
    </div>
  </section>;
}
