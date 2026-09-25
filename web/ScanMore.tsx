import { useEffect, useRef } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import { batchActionText, batchAt, batchStatusText, FLOOR_DAY, scanMoreBatches, scanMoreSummary } from './model.js';
import type { RescanPick } from './model.js';
import { Sheet } from './Sheet.js';

/** Scan more: one summary line and one list of 7-day batches from today back to the floor, newest first, each with its UTC dates,
 * its status and one action. Load reads every batch from the oldest loaded day back to its row, one after another (`onLoad` takes
 * how many); Check lists a loaded batch again and adds anything missed; a checked batch is greyed out, labelled Confirmed and not
 * clickable. `focus`, a time, highlights the row holding it, as when Coverage, the overview or a period opened the dialog. */
export function ScanMoreDialog({ report, focus, busy, onLoad, onCheck, onClose }: {
  report: DashboardReport; focus: number | null; busy: boolean; onLoad: (batches: number) => void; onCheck: (pick: RescanPick) => void; onClose: () => void;
}) {
  const batches = scanMoreBatches(report);
  const current = batchAt(batches, focus);
  const list = useRef<HTMLOListElement>(null);
  // The highlighted row is brought into view once, as the dialog opens.
  useEffect(() => { list.current?.querySelector('.highlight')?.scrollIntoView({ block: 'nearest' }); }, []);
  return <Sheet kind="modal" labelledBy="more-title" onClose={onClose}
    heading={<div><span className="eyebrow">LOAD AND CHECK HISTORY</span><h2 id="more-title">Scan more</h2></div>}>
    <div className="more">
      <p className="more-summary">{scanMoreSummary(report)}</p>
      <p className="muted">Batches of up to 7 days, UTC, newest first, back to {FLOOR_DAY}. Load reads every batch from the oldest loaded day back to the one you
        choose, one after another. Check lists a loaded batch again and adds anything missed. Payouts already saved are never counted twice.</p>
      <ol className="more-list" ref={list} aria-label="Batches">{batches.map(batch => {
        const highlighted = batch === current;
        return <li key={batch.startTime} className={`more-row ${batch.status}${highlighted ? ' highlight' : ''}`} aria-current={highlighted ? true : undefined}>
          <span className="more-dates">{batch.label}</span><span className="more-status">{batchStatusText(batch)}</span>
          {batch.status === 'checked'
            ? <button type="button" className="more-action" disabled aria-disabled="true" aria-label={`Confirmed, ${batch.label}`}>{batchActionText(batch)}</button>
            : <button type="button" className="more-action" disabled={busy} aria-label={`${batchActionText(batch)}, ${batch.label}`}
              onClick={() => { if (batch.status === 'not_loaded') onLoad(batch.back); else onCheck({ start: batch.first, end: batch.last }); }}>{batchActionText(batch)}</button>}
        </li>;
      })}</ol>
    </div>
    <div className="dialog-actions"><button type="button" onClick={onClose}>Close</button></div>
  </Sheet>;
}
