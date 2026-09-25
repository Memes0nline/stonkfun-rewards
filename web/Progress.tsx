import { useEffect, useRef } from 'react';
import type { DashboardJob } from '../src/web/service.js';
import { SCAN_PHASES, type ScanPhase } from '../src/scanner/progress.js';
import type { DashboardReport } from '../src/web/view.js';
import { batchTimeText, daysDoneText, doneText, duration, failureNotice, RATE_LIMITED_TEXT, rateLimited, FIRST_SCAN_NOTE, isFirstScan, progressAge, progressPercent,
  progressState, progressTitle, readingText, utc } from './model.js';

const labels: Record<ScanPhase, string> = {
  preparing: 'Preparing scan', registry: 'Loading StonkFun registry', metadata: 'Loading token metadata', planning: 'Planning days',
  history: 'Reading blockchain history', evidence: 'Saving distribution evidence',
  normalization: 'Normalizing transfers', authority: 'Reconciling payout authority', classification: 'Classifying rewards',
  pricing: 'Pricing supported assets', checkpoint: 'Saving scan checkpoint', report: 'Calculating dashboard totals', complete: 'Complete',
};
export const phaseLabel = (phase: ScanPhase | null) => phase ? labels[phase] : 'Saved job state';
/** The scan dialog for a first scan, a refresh or a Load earlier batch, titled by the wallet it scans or by the batch's days. Its
 * top line names the UTC span the job reads, and once it finishes the span done with its new payouts from `report`, the job
 * wallet's report when in view. A batch says how long one usually takes. */
export function Progress({ job, now, report = null, close, action, onRetry = () => undefined, onKey = () => undefined }: {
  job: DashboardJob; now: number; report?: DashboardReport | null; close: () => void; action: (kind: 'resume' | 'cancel') => void;
  /** Resumes the stopped job, or starts its kind again when it cannot resume. */ onRetry?: () => void; /** Opens the key form. */ onKey?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); const node = dialog.current; return () => { node?.close(); }; }, []);
  const active = job.runningLocally && job.status === 'running';
  const state = progressState(job, now);
  const percent = progressPercent(job.progress.phaseProgress);
  const age = progressAge(job.progress.lastActivityAt, now, job.progress.finishedAt);
  const elapsed = active || job.progress.finishedAt !== null ? duration((job.progress.finishedAt ?? now) - job.progress.startedAt) : 'unavailable';
  const earlier = job.kind === 'earlier' && job.batch ? job.batch : null;
  // A stopped job's classified failure replaces the older generic warnings; a rate limit while running is a banner, not a failure.
  const failed = failureNotice(job);
  // The title names the wallet and the kind of job; its state is in the indicator, the state line and the notices beneath.
  const title = progressTitle(job);
  const shown = report?.wallet === job.wallet ? report : null;
  const loadedFrom = shown?.history.loadedFrom ?? null;
  const range = job.status === 'complete' && !active ? doneText(job, shown) : readingText(job, loadedFrom);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby="progress-title">
    <div className="panel-heading"><div><span className="eyebrow">SCAN JOURNEY / SAVED EVIDENCE</span><h2 id="progress-title">{title}</h2>
      {range ? <p className="progress-range">{range}</p> : null}</div><button onClick={close} aria-label="Dismiss progress">×</button></div>
    <div className="progress-hero">
      <div className="progress-time"><span className={`working-indicator ${active ? 'is-working' : ''}`}>{active ? 'WORKING' : job.status.toUpperCase()}</span><strong>{active ? 'Scanning for' : 'Duration'} {elapsed}</strong></div>
      <h3>{phaseLabel(job.progress.phase)}</h3><p role="status" aria-live="polite">{state}</p>
      <p className="progress-days">{daysDoneText(job, loadedFrom)}</p>
      <div className="progress-meta">{job.progress.finishedAt !== null ? `Finished ${utc(job.progress.finishedAt / 1000)}` : `Last backend activity ${age}`}</div>
      <p className="progress-requests">Requests so far: Helius {job.requests.helius.toLocaleString()} · StonkFun {job.requests.stonkfun.toLocaleString()}</p>
      {isFirstScan(job) ? <p className="progress-first">{FIRST_SCAN_NOTE}</p> : null}
      {earlier ? <p className="progress-first progress-batch-time">{batchTimeText(shown?.history)}</p> : null}
    </div>
    {rateLimited(job) ? <p className="progress-note rate-limit" role="status">{RATE_LIMITED_TEXT}</p> : null}
    {failed ? <div className="failure-notice" role="alert"><p><b>{failed.message}</b></p><p>{failed.saved}</p>
      <div className="failure-actions">{failed.reenterKey ? <button type="button" onClick={onKey}>Re-enter API key</button> : null}
        <button type="button" className="primary" onClick={onRetry}>Retry</button></div></div> : null}
    <div className="phase-bar" role="img" aria-label={`${job.progress.completedPhases.length} scan phases completed; ${phaseLabel(job.progress.phase)} ${active ? 'active' : job.status}`}>
      {SCAN_PHASES.map(phase => <span key={phase} className={`${job.progress.completedPhases.includes(phase) ? 'done' : ''} ${active && job.progress.phase === phase ? 'active' : ''}`}/>)}
    </div>
    <div className="progress-detail">
      <div className="progress-work"><span className="eyebrow">CURRENT WORK</span><strong>{job.progress.action}</strong>
        {percent !== null && job.progress.phaseProgress ? <div><div className="progress-meter"><span style={{ width: `${percent}%` }}/></div><small>{job.progress.phaseProgress.completed} / {job.progress.phaseProgress.total} {job.progress.phaseProgress.unit}</small></div>
          : active ? <small>Phase progress is indeterminate until a real total is known.</small> : null}
        {job.progress.phase === 'history' && active ? <small>Total page count is unknown; pages are saved as they arrive.</small> : null}
      </div>
      <ol className="phase-path" aria-label="Chronological scan stages">{SCAN_PHASES.map(phase => <li key={phase} className={job.progress.completedPhases.includes(phase) ? 'done' : active && job.progress.phase === phase ? 'active' : 'upcoming'}><span aria-hidden="true">{job.progress.completedPhases.includes(phase) ? '✓' : active && job.progress.phase === phase ? '◉' : '○'}</span>{labels[phase]}</li>)}</ol>
    </div>
    <p className="progress-pipeline-note">History pages also save evidence, normalize transfers, reconcile authority and classify candidates. The later phases check work still queued.</p>
    <div className="usage-panel"><span className="eyebrow">PROVIDER REQUEST USAGE · NOT SCAN COMPLETION</span><div><span>StonkFun {job.used.stonkfun} / {job.limits.stonkfun}</span><span>Helius {job.used.helius} / {job.limits.helius}</span><span>Saved pages {job.used.pages}</span></div></div>
    {job.status === 'complete' && !job.failure && !failed ? <p className="progress-note">Saved coverage and report totals are ready. Review the dashboard for confirmed, unknown and unpriced evidence.</p> : null}
    {job.cancelled ? <p className="progress-note warning">Cancelled. Acknowledged pages and evidence remain saved. {job.canResume ? 'Resume is available within this job’s limits.' : 'Resume is unavailable under the current job limits or server state.'}</p> : null}
    {job.failure && !failed ? <p className="progress-note warning" role="alert">{job.failure}. Saved pages and evidence remain available. {job.canResume ? 'Resume continues within the job limits.' : 'Resume is unavailable under the current job limits or server state.'}</p> : null}
    {job.resumeBlocked ? <p className="progress-note warning">Saved budget or deadline exhausted. A new check fills remaining gaps; Resume cannot reset limits.</p> : null}
    {job.stage === 'interrupted_or_external' ? <p className="progress-note warning">Interrupted or running in another process. Resume becomes available after its existing lease expires.</p> : null}
    {job.status === 'paused' && !job.cancelled && !job.failure && !failed ? <p className="progress-note warning">Scan paused after an interruption. Saved work is retained. {job.canResume ? 'Resume continues within job limits.' : 'Resume is unavailable under the current job limits or server state.'}</p> : null}
    <div className="dialog-actions"><button onClick={close}>DISMISS</button>{job.canResume && !failed ? <button className="primary" onClick={() => action('resume')}>RESUME</button> : null}{active ? <button className="danger" onClick={() => action('cancel')}>CANCEL SCAN</button> : null}</div>
  </dialog>;
}
