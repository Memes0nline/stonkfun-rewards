import type { DashboardReport } from '../src/web/view.js';
import { EARLIER_BATCH_DAYS } from '../src/scanner/ranges.js';
import { attributedCount, attributionState, coverageTarget, DAY_STATE_TEXT, dayStates, FLOOR_DAY, historyStatus, isAddress, noun, REASON_TEXT, reasonLabel, short, utc, weekOf } from './model.js';
import type { RescanPick } from './model.js';
import { EarlierButton } from './Refresh.js';
import { Address } from './Sheet.js';

const mintCell = (mint: string | null) => isAddress(mint) ? <Address value={mint} label="mint address" link={`https://solscan.io/token/${mint}`}/>
  : <span className="muted">{mint === null ? 'Unresolved mint' : mint}</span>;

/** Retrieval and classification: counts by status, ranges and gaps, each loaded day as Checked or Read once, unknown reasons in
 * plain words, the bounded samples. A day read once offers Rescan to double-check, which opens Rescan dates on its week. */
export function Coverage({ report, reclassify, canReclassify, onEarlier = () => undefined, canEarlier = false, onRescan = () => undefined, canRescan = false }: {
  report: DashboardReport; reclassify: () => void; canReclassify: boolean; onEarlier?: () => void; canEarlier?: boolean;
  onRescan?: (pick: RescanPick) => void; canRescan?: boolean;
}) {
  // One block per status, each under the report's own group label where the report has one; nothing here is added up.
  // An unevaluated attributed tier reads as its state alone, never as a count.
  const evaluated = attributionState(report) === 'evaluated';
  const statuses = [
    { label: report.verifiedTotals.label, rows: report.counts.confirmed, signatures: report.uniqueSignatures.confirmed, tone: '' },
    { label: report.attribution.label, rows: evaluated ? report.attribution.rows : null, signatures: evaluated ? report.attribution.signatures : null, tone: 'violet-text' },
    { label: 'Excluded', rows: report.counts.excluded, signatures: report.uniqueSignatures.excluded, tone: '' },
    { label: report.unknownTotals.label, rows: report.counts.unknown_candidate, signatures: report.uniqueSignatures.unknown_candidate, tone: 'yellow-text' },
  ];
  // Gaps lie inside the target, the loaded range; coverage before it is listed but never missing.
  const target = coverageTarget(report);
  const ranges = [...report.coverage.completed.map(range => ({ ...range, gap: false })), ...report.coverage.gaps.map(range => ({ ...range, gap: true }))]
    .sort((a, b) => b.startTime - a.startTime);
  // The days from the floor to the oldest loaded day wait for Load earlier: listed last, oldest, and never as a gap.
  const notLoaded = report.history.notLoadedYet;
  const earlier = historyStatus(report).earlier;
  const days = dayStates(report);
  const checkedDays = days.filter(item => item.state === 'checked').length;
  const readOnce = days.filter(item => item.state === 'read_once').length;
  return <>
    <div className="coverage-grid">
      <section className="panel" aria-labelledby="coverage-title">
        <div className="panel-heading"><div><span className="eyebrow">RETRIEVAL / CLASSIFICATION</span><h2 id="coverage-title">Coverage & confidence</h2></div><span className="badge unpriced">PARTIAL CLASSIFICATION</span></div>
        <div className="coverage-body">
          <dl className="status-counts">{statuses.map(status => <div key={status.label}><dt className="group-label">{status.label}</dt>
            <dd>{status.rows === null ? <b className={status.tone}>{attributedCount(report, null)}</b>
              : <><b className={status.tone}>{status.rows.toLocaleString()}</b> {noun(status.rows, 'row')}<span>{(status.signatures ?? 0).toLocaleString()} {noun(status.signatures, 'signature')}</span></>}</dd></div>)}</dl>
          <p className="muted">{report.uniqueSignatures.all.toLocaleString()} signatures retained across all statuses. One signature can carry several rows or statuses, so these counts are never summed.</p>
          <p className="warning">Complete retrieval does not establish complete reward attribution: a count of zero does not prove that no rewards were paid.</p>
          <div className="ranges"><h3>Retrieval ranges <span className="muted">· {report.coverage.completed.length.toLocaleString()} complete · {report.coverage.gaps.length.toLocaleString()} {noun(report.coverage.gaps.length, 'gap')} · newest first</span></h3>
            <p className="muted range-target">Target {utc(target.startTime)} → {utc(target.endTime)}</p>
            <ol className="range-list">{ranges.map(range => <li key={`${range.gap ? 'gap' : 'complete'}-${range.startTime}`} className={range.gap ? 'warning' : undefined}>
              <span>{range.gap ? 'GAP' : 'COMPLETE'}</span>{utc(range.startTime)} → {utc(range.endTime)}</li>)}</ol>
            {ranges.length === 0 ? <p className="muted">No retrieval range saved yet.</p> : null}
            {notLoaded ? <div className="not-loaded"><p><span>NOT LOADED YET</span>{utc(notLoaded.startTime)} → {utc(notLoaded.endTime)} · {notLoaded.days.toLocaleString()} {noun(notLoaded.days, 'day')}</p>
              <p className="muted">Not scanned yet, so not a gap. Each batch loads {EARLIER_BATCH_DAYS} more days back to {FLOOR_DAY}.</p>
              {earlier ? <EarlierButton earlier={earlier} disabled={!canEarlier} onEarlier={onEarlier}/> : null}</div> : null}</div>
          <div className="day-states"><h3>Loaded days <span className="muted">· {checkedDays.toLocaleString()} checked · {readOnce.toLocaleString()} read once · newest first</span></h3>
            <p className="muted">Checked: the day was read in full and its transactions matched a second list from Helius. Read once: loaded before that check existed.</p>
            <ol className="day-list">{days.map(item => <li key={item.day} className={item.state}><span className="day-date">{item.day}</span>
              <span className="day-state">{DAY_STATE_TEXT[item.state]}</span>
              {item.state === 'read_once' ? <button type="button" className="rescan-day" disabled={!canRescan} onClick={() => { onRescan(weekOf(report, item.day)); }}>Rescan to double-check</button> : null}</li>)}</ol></div>
          <div className="pending"><span>Pending local classification: <b>{report.pendingClassification.walletSignatures.toLocaleString()}</b> wallet / <b>{report.pendingClassification.networkSignatures.toLocaleString()}</b> network signatures</span>
            <button type="button" disabled={!canReclassify} onClick={reclassify}>RECLASSIFY LOCALLY</button></div>
        </div>
      </section>
      <section className="panel" aria-labelledby="reasons-title">
        <div className="panel-heading"><div><span className="eyebrow">UNRESOLVED EVIDENCE</span><h2 id="reasons-title">Why rows stay unknown</h2></div></div>
        <ul className="reason-list">{report.unknownReasons.map(item => <li key={item.reason}><div><span className="reason-code">{reasonLabel(item.reason)}</span><p>{REASON_TEXT[item.reason]}</p></div><b>{item.count.toLocaleString()}</b></li>)}</ul>
        {report.unknownReasons.length === 0 ? <p className="muted padded">No saved unknown reasons.</p> : null}
        <div className="panel-foot">Top reasons by row count · reasons can overlap within one classification record · {report.unknownTotals.explanation}</div>
      </section>
    </div>
    {report.unknownCandidates.length ? <details className="panel unknown-panel"><summary>UNKNOWN CANDIDATE SAMPLE <span className="muted">/ {report.unknownCandidates.length} of {report.counts.unknown_candidate.toLocaleString()} classification records · excluded from reward totals</span></summary>
      <div className="table-scroll"><table className="sample-table"><thead><tr><th>Mint · full address</th><th>Observed · UTC</th><th>Unresolved evidence</th><th>Status / evidence</th></tr></thead><tbody>{report.unknownCandidates.map((candidate, index) => <tr key={index}>
        <td>{mintCell(candidate.mint)}</td><td>{candidate.time === null ? 'Unknown time' : utc(candidate.time)}</td>
        <td><ul className="sample-reasons">{candidate.reasons.map(reason => <li key={reason} title={REASON_TEXT[reason]}>{reasonLabel(reason)}</li>)}</ul></td>
        <td><span className="badge unpriced">UNKNOWN</span>{candidate.evidenceLink ? <a className="cell-sub" href={candidate.evidenceLink} target="_blank" rel="noreferrer">Evidence ↗</a> : null}</td></tr>)}</tbody></table></div>
      <div className="panel-foot">Bounded sample from the report's first 500 detail records. Aggregate counts include every retained classification.</div></details> : null}
    <details className="panel unknown-panel"><summary>CONFIRMATION EVIDENCE <span className="muted">/ {report.confirmationBasisCounts.official_feed} exact feed · {report.confirmationBasisCounts.same_slot_pattern} same-slot · {report.confirmationBasisCounts.verified_historical_authority} verified historical authority</span></summary>
      <div className="table-scroll"><table className="sample-table"><thead><tr><th>Mint · full address</th><th>Observed · UTC</th><th>Confirmation basis</th><th>Transaction</th></tr></thead><tbody>{report.confirmedEvidence.map((item, index) => <tr key={index}>
        <td>{mintCell(item.mint)}</td><td>{item.time === null ? 'Unknown time' : utc(item.time)}</td>
        <td>{item.basis?.replaceAll('_', ' ') ?? 'Unresolved'}{item.authority ? <span className="cell-sub">Model {item.authority.modelVersion} · epoch {item.authority.epochId}<br/>Observed window {utc(item.authority.validAfter)} to {utc(item.authority.validBefore)}<br/>Witnesses {item.authority.witnesses.map((witness, i) => <a key={witness} href={`https://solscan.io/tx/${witness}`} target="_blank" rel="noreferrer" title={witness}>{i ? ', ' : ''}{short(witness)} ↗</a>)}</span> : null}</td>
        <td>{item.evidenceLink ? <a href={item.evidenceLink} target="_blank" rel="noreferrer">Evidence ↗</a> : 'Unavailable'}</td></tr>)}</tbody></table></div>
      {report.confirmedEvidence.length === 0 ? <p className="muted padded">No confirmed receipt in the report's first 500 detail records.</p> : null}
      <div className="panel-foot">Confirmation basis counts include all retained rows. The evidence sample is bounded by the report detail limit.</div></details>
  </>;
}
