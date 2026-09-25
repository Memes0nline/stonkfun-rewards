import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import { TrustBadge } from './Attributed.js';
import { TokenSwatch } from './Chart.js';
import {
  ATTRIBUTION_STATES, assetKey, attributionState, attributionStateDetail, dayFilterBanner, DEFAULT_RECEIPT_SORT, EMPTY_PALETTE, filterReceipts, noun, PAGE_SIZE,
  receiptSortText, secondsText, short, sortReceipts, tokenColor, tokenSymbol, TRUST_SOURCE_ORDER, usd, usdExact, utc, WITNESS_RELATIONS,
} from './model.js';
import type { Receipt, ReceiptFilters, ReceiptSort, ReceiptSortKey, TokenPalette } from './model.js';
import { Address, Sheet } from './Sheet.js';

const txTime = (time: number, link: string | null) => link ? <a href={link} target="_blank" rel="noreferrer">{utc(time)} ↗</a> : utc(time);
/** One attributed receipt's full evidence. Every address is printed in full with its own copy button, never abbreviated. */
export function EvidenceModal({ report, receipt, onClose }: { report: DashboardReport; receipt: Receipt; onClose: () => void }) {
  const evidence = receipt.attribution;
  const native = evidence?.lane === 'native_sol';
  const field = (term: string, value: ReactNode) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>;
  return <Sheet kind="modal" labelledBy="evidence-title" onClose={onClose}
    heading={<div><span className="eyebrow group-label">{report.attribution.label} · receipt evidence</span>
      <h2 id="evidence-title">{tokenSymbol(receipt.symbol)} <span className="quantity">{receipt.amount ?? 'Unknown amount'}</span></h2>
      <span className="muted">{receipt.time === null ? 'Unknown time' : utc(receipt.time)}</span>
      <div className="evidence-badges">{evidence?.trustSources.map(source => <TrustBadge key={source} report={report} source={source}/>)}
        {evidence?.creditedMintAlsoRetainedLaunch ? <span className="badge dual-role">DUAL-ROLE MINT</span> : null}</div></div>}>
    <dl className="sheet-figures">
      {field('Amount', receipt.amount ?? 'Unknown amount')}{field('Current USD', receipt.currentUsd === null ? 'Unpriced' : usdExact(receipt.currentUsd))}
      {field('Lane', native ? 'Native SOL' : 'Token transfer')}{field('Model', evidence?.modelVersion ?? 'Unavailable')}
    </dl>
    <section className="sheet-section evidence-addresses"><h3>Addresses · in full</h3>
      <dl className="address-fields">
        {field('Signature', receipt.signature ? <Address value={receipt.signature} label="signature" link={receipt.evidenceLink}/> : 'Unavailable')}
        {field('Mint', receipt.mintAddress ? <Address value={receipt.mintAddress} label="mint address" link={`https://solscan.io/token/${receipt.mintAddress}`}/> : 'Native SOL · no mint address')}
        {field('Source owner', evidence?.sourceOwner ? <Address value={evidence.sourceOwner} label="source owner" link={`https://solscan.io/account/${evidence.sourceOwner}`}/> : 'Unavailable')}
        {field(native ? 'Source system account' : 'Source ATA', evidence?.sourceAta ? <Address value={evidence.sourceAta} label={native ? 'source system account' : 'source ATA'} link={`https://solscan.io/account/${evidence.sourceAta}`}/> : 'Unavailable')}
      </dl></section>
    {evidence ? <><section className="sheet-section"><h3>Trust sources</h3><div className="sheet-badges">
      {TRUST_SOURCE_ORDER.filter(source => evidence.trustSources.includes(source)).map(source => <div key={source} className="trust-line">
        <TrustBadge report={report} source={source} detailed/>{source === evidence.primaryTrustSource ? <span className="muted">Primary trust source</span> : null}</div>)}</div></section>
    <dl className="sheet-figures evidence-figures">
      {field('Feed witnesses', evidence.witnessCount > 0 && evidence.firstWitnessTime !== null && evidence.lastWitnessTime !== null
        ? <>{evidence.witnessCount.toLocaleString()} official {noun(evidence.witnessCount, 'distribution')}<br/>first {txTime(evidence.firstWitnessTime, evidence.firstWitnessLink)}<br/>last {txTime(evidence.lastWitnessTime, evidence.lastWitnessLink)}</> : 'None')}
      {field('Nearest witness', evidence.secondsToNearestWitness !== null && evidence.witnessRelation !== null
        ? `${secondsText(evidence.secondsToNearestWitness)} ${WITNESS_RELATIONS[evidence.witnessRelation]}` : '—')}
      {field('Nearest snapshot', evidence.secondsToNearestSnapshot !== null && evidence.snapshotRetrievedAt !== null
        ? `Published authority snapshot ${utc(Date.parse(evidence.snapshotRetrievedAt) / 1000)} taken after this payout · ${secondsText(evidence.secondsToNearestSnapshot)} away` : '—')}
      {field('Batch', `${evidence.batch.outerTransfersFromSource.toLocaleString()} outer ${noun(evidence.batch.outerTransfersFromSource, 'transfer')} from source · ${evidence.batch.transfersFromSource.toLocaleString()} ${noun(evidence.batch.transfersFromSource, 'transfer')} from source · ${evidence.batch.distinctRecipientOwners.toLocaleString()} recipient ${noun(evidence.batch.distinctRecipientOwners, 'owner')}`)}
      {field('Dual-role mint', evidence.creditedMintAlsoRetainedLaunch ? 'Yes · credited mint is also a retained launch mint' : 'No')}
    </dl></> : <p className="sheet-foot">Attribution evidence is unavailable for this receipt.</p>}
    <p className="sheet-foot">Addresses appear in full because look-alike senders can share their first and last characters. Compare every character. The USD figure is this amount at the saved current price, not a payout-time value, and it is never added to verified totals.</p>
  </Sheet>;
}

/** Individual attributed receipts, filtered by day, token, trust source and price, newest first or sorted by the Date or USD
 * header. The whole filtered set is sorted before the first page is cut. Each opens its evidence. */
export function PayoutsTab({ report, filters, setFilters, openReceipt, palette = EMPTY_PALETTE, sort = DEFAULT_RECEIPT_SORT, setSort = () => undefined }: {
  report: DashboardReport; filters: ReceiptFilters; setFilters: (next: ReceiptFilters) => void; openReceipt: (id: string) => void; palette?: TokenPalette;
  sort?: ReceiptSort; setSort?: (next: ReceiptSort) => void;
}) {
  const key = JSON.stringify([filters, sort]);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [filterKey, setFilterKey] = useState(key);
  // A new filter or sort starts again at the first page.
  if (key !== filterKey) { setFilterKey(key); setShown(PAGE_SIZE); }
  const state = attributionState(report);
  const attribution = report.attribution;
  const all = attribution.receipts ?? [];
  const rows = sortReceipts(filterReceipts(all, filters), sort);
  // The same header again flips its direction; the other header starts newest or highest first.
  const header = (column: ReceiptSortKey, label: string, numeric = false) => <th className={numeric ? 'numeric' : undefined} aria-sort={sort.key === column ? sort.direction : 'none'}>
    <button type="button" className="sort" onClick={() => { setSort({ key: column, direction: sort.key === column && sort.direction === 'descending' ? 'ascending' : 'descending' }); }}>{label}
      <span aria-hidden="true">{sort.key === column ? sort.direction === 'ascending' ? ' ▲' : ' ▼' : ' ↕'}</span></button></th>;
  const days = [...new Set([...all.flatMap(receipt => receipt.day ?? []), ...filters.day ? [filters.day] : []])].sort().reverse();
  const tokens = [...attribution.assets ?? []].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.mint.localeCompare(b.mint));
  const change = (name: keyof ReceiptFilters, value: string) => { setFilters({ ...filters, [name]: value || undefined }); };
  const active = Object.values(filters).some(Boolean);
  // A day opened from the chart is named above the list with its count, which is the chart tooltip's count for that day.
  const banner = dayFilterBanner(report, filters);
  const select = (name: keyof ReceiptFilters, label: string, options: { value: string; label: string }[]) => <label className="filter"><span>{label}</span>
    <select value={filters[name] ?? ''} onChange={event => { change(name, event.target.value); }}><option value="">All</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  return <section className="panel payouts-panel attributed-panel" aria-labelledby="payouts-title">
    <div className="panel-heading"><div><span className="eyebrow group-label">{attribution.label}</span><h2 id="payouts-title">Payouts {state === 'evaluated'
      ? <span className="count-label" title={active ? `${rows.length.toLocaleString()} of ${all.length.toLocaleString()} receipts match these filters` : undefined}>
        {(active ? rows.length : all.length).toLocaleString()}</span> : null}</h2></div>
      {state === 'evaluated' ? <span className="muted">{receiptSortText(sort)} · EACH OPENS ITS EVIDENCE</span> : null}</div>
    {state !== 'evaluated' ? <div className="state-box"><strong>{ATTRIBUTION_STATES[state]}</strong><p>{attributionStateDetail(report)}</p></div> : <>
      {banner ? <div className="day-banner"><p>{banner.token ? <TokenSwatch color={tokenColor(palette, banner.token)}/> : null}<b>{banner.text}</b>
        {banner.partial ? <span className="muted"> · the list holds only the newest receipts</span> : null}</p>
        {/* The banner names the day and, from a chart segment, its token; Clear lifts both. */}
        <button type="button" onClick={() => { setFilters({ ...filters, day: undefined, ...banner.token ? { token: undefined } : {} }); }}
          aria-label={banner.token ? `Clear the ${banner.day} ${banner.symbol ?? ''} filter` : `Clear the ${banner.day} day filter`}>Clear ×</button></div> : null}
      <div className="filters" role="group" aria-label="Payout filters">
        {select('day', 'Day · UTC', days.map(day => ({ value: day, label: day })))}
        {select('token', 'Token', tokens.map(asset => ({ value: assetKey(asset), label: `${tokenSymbol(asset.symbol)} · ${short(asset.mint)}` })))}
        {select('trust', 'Trust source', TRUST_SOURCE_ORDER.map(source => ({ value: source, label: attribution.trustSources[source].label })))}
        {select('price', 'Price', [{ value: 'priced', label: 'Priced' }, { value: 'unpriced', label: 'Unpriced' }])}
        <button type="button" className="clear-filters" disabled={!active} onClick={() => { setFilters({}); }}>Clear filters</button>
      </div>
      <p className="list-status" role="status">{rows.length ? `Showing 1–${Math.min(shown, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} ${noun(rows.length, 'receipt')}` : 'No receipts match these filters.'}
        {active ? ` · filtered from ${all.length.toLocaleString()}` : ''}{attribution.receiptsComplete === false ? ` · the list holds the newest ${all.length.toLocaleString()} of ${(attribution.rows ?? 0).toLocaleString()} attributed rows` : ''}</p>
      {rows.length ? <div className="table-scroll tall" tabIndex={0} role="region" aria-label="Attributed receipts"><table className="receipt-table">
        <thead><tr>{header('date', 'Date · UTC')}<th>Token</th><th className="numeric">Amount</th>{header('usd', 'USD', true)}<th>Sender</th><th>Trust</th></tr></thead>
        <tbody>{rows.slice(0, shown).map(receipt => {
          const owner = receipt.attribution?.sourceOwner ?? null;
          return <tr key={receipt.id} onClick={() => { openReceipt(receipt.id); }}>
            <td><button type="button" className="row-open" onClick={event => { event.stopPropagation(); openReceipt(receipt.id); }}
              aria-label={`${receipt.time === null ? 'Unknown time' : utc(receipt.time)} ${tokenSymbol(receipt.symbol)} ${receipt.amount ?? ''}: open evidence`}>{receipt.time === null ? 'Unknown time' : utc(receipt.time)}</button></td>
            <td><b><TokenSwatch color={tokenColor(palette, receipt.asset)}/>{tokenSymbol(receipt.symbol)}</b>{receipt.attribution?.creditedMintAlsoRetainedLaunch ? <span className="badge dual-role">DUAL-ROLE</span> : null}</td>
            <td className="quantity numeric">{receipt.amount ?? 'Unknown amount'}</td>
            <td className="numeric">{receipt.currentUsd === null ? <span className="yellow-text">Unpriced</span> : usd(receipt.currentUsd)}</td>
            <td>{owner ? <abbr className="sender" title={owner}>{short(owner)}</abbr> : <span className="muted">Unavailable</span>}</td>
            <td><div className="trust-cell">{receipt.attribution?.trustSources.map(source => <TrustBadge key={source} report={report} source={source}/>)}</div></td>
          </tr>;
        })}</tbody></table></div>
        : <div className="table-empty"><span aria-hidden="true">◇</span><strong>No receipts match these filters</strong>
          {active ? <button type="button" onClick={() => { setFilters({}); }}>Clear filters</button> : <p>No attributed receipts in the tracked window.</p>}</div>}
      {rows.length > shown ? <div className="list-more"><button type="button" onClick={() => { setShown(count => count + PAGE_SIZE); }}>Show {Math.min(PAGE_SIZE, rows.length - shown).toLocaleString()} more</button></div> : null}
    </>}
    <div className="panel-foot">Attributed receipts only: unknown, excluded and verified rows never enter this list · USD at saved current prices · senders abbreviated here, in full in each receipt's evidence</div>
  </section>;
}
