import { useState } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import { ALL_CHECKED_TEXT, loadedDays, NONE_CONFIRMED_TEXT, rescanError, rescanSections, rescanSummary, rescanWeekLabel } from './model.js';
import type { RescanPick } from './model.js';
import { Sheet } from './Sheet.js';

/** Rescan dates: the calendar weeks of the loaded range (Monday to Sunday, UTC), newest first, in two sections. To check lists
 * each week with a day read once or partly not loaded, with how many; Already confirmed lists each week whose days are all
 * Checked, greyed out and not clickable. Check other dates, collapsed, takes any start and end day, at most seven. The exact
 * range shows before anything starts; Rescan starts a check job over it, whose progress opens in the scan dialog. */
export function RescanDialog({ report, initial, busy, onStart, onClose }: {
  report: DashboardReport; initial: RescanPick | null; busy: boolean; onStart: (pick: RescanPick) => void; onClose: () => void;
}) {
  const sections = rescanSections(report);
  const loaded = loadedDays(report);
  const first = initial ?? sections.toCheck[0] ?? null;
  const [start, setStart] = useState(first?.start ?? '');
  const [end, setEnd] = useState(first?.end ?? '');
  // A pick that is no week to check, as when every loaded day is checked, is made with the day fields, so they open.
  const [other, setOther] = useState(first !== null && !sections.toCheck.some(week => week.start === first.start && week.end === first.end));
  const chosen = start !== '' || end !== '';
  const error = chosen ? rescanError(report, start, end) : null;
  return <Sheet kind="modal" labelledBy="rescan-title" onClose={onClose}
    heading={<div><span className="eyebrow">CHECK LOADED DAYS AGAIN</span><h2 id="rescan-title">Rescan dates</h2></div>}>
    <div className="rescan">
      <p className="muted">Weeks run Monday to Sunday UTC, inside the loaded history, {loaded.first} → {loaded.last}.</p>
      <section className="rescan-section" aria-labelledby="rescan-to-check"><h3 id="rescan-to-check">To check</h3>
        {sections.toCheck.length ? <div className="rescan-weeks" role="group" aria-labelledby="rescan-to-check">
          {sections.toCheck.map(week => <button type="button" key={week.start} aria-pressed={week.start === start && week.end === end}
            onClick={() => { setStart(week.start); setEnd(week.end); }}>{rescanWeekLabel(week)}</button>)}</div>
          : <p className="rescan-empty">{ALL_CHECKED_TEXT}</p>}
      </section>
      <section className="rescan-section" aria-labelledby="rescan-confirmed"><h3 id="rescan-confirmed">Already confirmed</h3>
        {sections.confirmed.length ? <div className="rescan-weeks confirmed" role="group" aria-labelledby="rescan-confirmed">
          {sections.confirmed.map(week => <button type="button" key={week.start} disabled aria-disabled="true">{rescanWeekLabel(week)}</button>)}</div>
          : <p className="rescan-empty muted">{NONE_CONFIRMED_TEXT}</p>}
      </section>
      <details className="rescan-other" open={other} onToggle={event => { setOther(event.currentTarget.open); }}>
        <summary>Check other dates</summary>
        <p className="muted">Any loaded days, checked or not, up to 7 at a time.</p>
        <div className="rescan-days">
          <label><span>Start day (UTC)</span><input type="date" value={start} min={loaded.first} max={loaded.last} onChange={event => { setStart(event.target.value); }}/></label>
          <label><span>End day (UTC)</span><input type="date" value={end} min={loaded.first} max={loaded.last} onChange={event => { setEnd(event.target.value); }}/></label>
        </div>
      </details>
      {error ? <p className="rescan-error" role="alert">{error}</p> : chosen ? <p className="rescan-summary" role="status">{rescanSummary(start, end)}</p> : null}
    </div>
    <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!chosen || error !== null || busy} onClick={() => { onStart({ start, end }); }}>Rescan</button></div>
  </Sheet>;
}
