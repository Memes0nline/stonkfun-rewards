import { useEffect, useRef, useState } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import type { DashboardJob } from '../src/web/service.js';
import { ChipDetails, chipLabel, chipValue, InfoIcon } from './Hero.js';
import type { ChipId } from './Hero.js';
import { activityText, budgetRows, duration, failureNotice, jobKindText, jobStateText, lastSyncText, modeText, providerText, RATE_LIMITED_TEXT, rateLimited,
  runTimeText, short, utc, walletStatusText, workingText } from './model.js';
import type { Health } from './model.js';
import { phaseLabel } from './Progress.js';

const COUNTS: readonly ChipId[] = ['verified', 'unknown', 'excluded', 'unpriced'];

/** Everything the header status control opens onto: where the data comes from, the provider, the saved sync and cutoff, the
 * scan and what it spent, and one row per report group with the report's own explanation. Nothing here follows the period. */
export function StatusDetails({ report, health, job, now, openProgress, openWallet, wallet }: {
  report: DashboardReport | null; health: Health | null; job: DashboardJob | null; now: number; wallet: string;
  openProgress: () => void; openWallet: (wallet: string) => void;
}) {
  const figure = (term: string, value: string) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>;
  const running = job?.runningLocally ?? false;
  const elapsed = job && (running || job.progress.finishedAt !== null) ? duration((job.progress.finishedAt ?? now) - job.progress.startedAt) : null;
  const others = (health?.activeWallets ?? []).filter(active => active !== wallet);
  const failed = job ? failureNotice(job) : null;
  return <>
    <section className="status-section" aria-label="Data source">
      <dl className="status-figures">
        {figure('Mode', modeText(health))}
        {report?.synthetic ? figure('Data', 'Synthetic fixture · deterministic test data · no real rewards') : null}
        {figure('Provider', providerText(health))}
        {report ? figure('Last sync', lastSyncText(report)) : null}
        {report ? figure('Fixed cutoff', utc(report.cutoff)) : null}
      </dl>
    </section>
    <section className="status-section" aria-label="Scan">
      <h3>Scan</h3>
      {job ? <>
        <p className="status-job"><span className={`working-indicator ${running ? 'is-working' : ''}`}>{jobStateText(job)}</span>
          {elapsed ? <span className="strip-time">{elapsed}</span> : null}
          <span className="muted">{phaseLabel(job.progress.phase)} · {activityText(job.progress, now)}</span></p>
        {failed ? <p className="status-failure" role="alert">{failed.message} {failed.saved}</p> : rateLimited(job) ? <p className="status-failure">{RATE_LIMITED_TEXT}</p> : null}
        <button type="button" className="status-link" onClick={openProgress}>View scan progress →</button>
        <dl className="status-figures" aria-label="Last job">
          {figure('Job', jobKindText(job))}
          {figure('Elapsed', running && elapsed ? elapsed : job.elapsedSeconds !== null ? runTimeText(job.elapsedSeconds) : elapsed ?? 'Unavailable')}
          {figure('Requests', `Helius ${job.requests.helius.toLocaleString()} · StonkFun ${job.requests.stonkfun.toLocaleString()}`)}
        </dl>
        <dl className="status-figures budgets" aria-label="Provider requests in the last job">
          {budgetRows(job).map(row => figure(row.label, `${row.used.toLocaleString()} of ${row.limit.toLocaleString()}`))}
        </dl>
      </> : <p className="muted">No scan saved for this wallet.</p>}
      {others.map(active => <button type="button" className="status-link" key={active} onClick={() => { openWallet(active); }}>Scan running · {short(active)} · view progress →</button>)}
    </section>
    {report ? <section className="status-section" aria-label="Rows by group">
      <h3>Rows</h3>
      {COUNTS.map(chip => <details key={chip} className="status-count">
        <summary><span className="chip-label group-label">{chipLabel(report, chip)}</span><b>{chipValue(report, chip)}</b><InfoIcon/></summary>
        <div className="status-count-body"><ChipDetails report={report} chip={chip}/></div>
      </details>)}
    </section> : null}
  </>;
}

/** The header's single status control: the short address of the wallet in view, its status and the last refresh inline, opening
 * the status panel. A wallet with no saved coverage reads Not scanned yet, with no last refresh; a running job reads WORKING with
 * the day it is reading. */
export function StatusMenu({ scanned = true, ...props }: Parameters<typeof StatusDetails>[0] & { scanned?: boolean }) {
  const { report, health, job, wallet } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const loadedFrom = report?.wallet === job?.wallet ? report?.history.loadedFrom ?? null : null;
  const state = job?.runningLocally ? workingText(job, loadedFrom) : wallet ? walletStatusText(job, scanned) : jobStateText(job);
  const refreshed = report ? lastSyncText(report) : 'Never';
  const lastRefresh = !wallet || scanned;
  return <div className="status-menu" ref={root}>
    <button type="button" className="status-button" aria-expanded={open} aria-controls={open ? 'status-panel' : undefined}
      aria-label={`${wallet ? `Wallet ${short(wallet)}. ` : ''}Status: ${state}${report?.synthetic ? ', synthetic fixture' : ''}${health?.offline ? ', offline viewing' : ''}${lastRefresh ? `. Last refresh ${refreshed}` : ''}`}
      onClick={() => { setOpen(current => !current); }}>
      {wallet ? <span className="status-wallet" title={wallet}>{short(wallet)}</span> : null}
      <span className={`working-indicator ${job?.runningLocally ? 'is-working' : ''}`}>{state}</span>
      {report?.synthetic ? <span className="status-tag warning">SYNTHETIC</span> : null}
      {health?.offline ? <span className="status-tag">OFFLINE</span> : null}
      {lastRefresh ? <span className="status-refresh"><span className="muted">Last refresh</span> {refreshed}</span> : null}
      <span className="status-caret" aria-hidden="true">▾</span>
    </button>
    {open ? <div id="status-panel" className="status-panel" role="dialog" aria-label="Status">
      <StatusDetails {...props} openProgress={() => { setOpen(false); props.openProgress(); }} openWallet={active => { setOpen(false); props.openWallet(active); }}/>
    </div> : null}
  </div>;
}
