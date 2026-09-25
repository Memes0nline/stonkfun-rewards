import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import { TrustBadge } from './Attributed.js';
import {
  ATTRIBUTION_STATES, attributedCount, attributionState, attributionStateDetail, noun, periodCaption, periodPrices, periodSummary, priceTimeText, REASON_TEXT,
  reasonLabel, staleText, tokenSymbol, trustSourceRows, usd, utc,
} from './model.js';
import type { Period, PeriodSummary } from './model.js';

/** A small info glyph drawn in SVG; no icon font or image is fetched. */
export function InfoIcon() {
  return <svg className="info-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4.3M8 4.6v.2"/></svg>;
}

/** Opens while hovered; a click or tap keeps it open until another click, Escape, or a click elsewhere. */
export function Popover({ label, trigger, buttonLabel, buttonClass = 'chip', align = 'end', children }: {
  label: string; trigger: ReactNode; buttonLabel?: string; buttonClass?: string; align?: 'start' | 'end'; children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className={`popover-anchor ${align}`} ref={root} onMouseEnter={() => { setOpen(current => current ?? 'hover'); }}
    onMouseLeave={() => { setOpen(current => current === 'hover' ? null : current); }}>
    <button type="button" className={buttonClass} aria-label={buttonLabel} aria-expanded={open !== null} aria-controls={open ? id : undefined}
      onClick={() => { setOpen(current => current === 'pinned' ? null : 'pinned'); }}>{trigger}</button>
    {open ? <div className="popover" id={id} role="dialog" aria-label={label}>{children}</div> : null}
  </div>;
}

export type ChipId = 'verified' | 'unknown' | 'excluded' | 'unpriced';
const rows = (count: number) => `${count.toLocaleString()} ${noun(count, 'row')}`;
const firstFew = (assets: { symbol: string; amount: string }[]) => assets.length
  ? `${assets.slice(0, 5).map(asset => `${asset.symbol} ${asset.amount}`).join(' · ')}${assets.length > 5 ? ` · and ${(assets.length - 5).toLocaleString()} more` : ''}`
  : 'None';
/** The label each chip shows: the report's fixed group label, or the status name for excluded rows, which have no report group. */
export function chipLabel(report: DashboardReport, chip: ChipId) {
  return chip === 'verified' ? report.verifiedTotals.label : chip === 'unknown' ? report.unknownTotals.label
    : chip === 'unpriced' ? report.unpriced.label : 'Excluded';
}
export function chipValue(report: DashboardReport, chip: ChipId) {
  return chip === 'verified' ? rows(report.verifiedTotals.rows) : chip === 'unknown' ? rows(report.unknownTotals.rows)
    : chip === 'excluded' ? rows(report.counts.excluded)
      : `verified ${report.unpriced.verified.length.toLocaleString()} · attributed ${attributedCount(report, report.unpriced.attributed?.length ?? null)}`;
}

/** A chip's popover body: the report's fixed explanation where the group has one, and its exact counts. */
export function ChipDetails({ report, chip }: { report: DashboardReport; chip: ChipId }) {
  const figure = (term: string, value: ReactNode) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>;
  if (chip === 'verified') {
    const basis = report.confirmationBasisCounts;
    return <>
      <p>{report.verifiedTotals.explanation}</p>
      <dl className="popover-figures">
        {figure('Rows', report.verifiedTotals.rows.toLocaleString())}{figure('Signatures', report.verifiedTotals.signatures.toLocaleString())}
        {figure('Current value', usd(report.cumulative.currentUsd))}{figure('Last 7 days', usd(report.rolling168h.currentUsd))}
        {figure('Daily average', usd(report.rolling168h.dailyAverageUsd))}{figure('Unpriced assets', report.unpriced.verified.length.toLocaleString())}
      </dl>
      <p className="popover-foot">Exact feed {basis.official_feed.toLocaleString()} · same-slot {basis.same_slot_pattern.toLocaleString()} · verified historical authority {basis.verified_historical_authority.toLocaleString()}</p>
    </>;
  }
  if (chip === 'unknown') {
    const proven = report.unknownTotals.provenCredits;
    return <>
      <p>{report.unknownTotals.explanation}</p>
      <dl className="popover-figures">
        {figure('Rows', report.unknownTotals.rows.toLocaleString())}{figure('Signatures', report.unknownTotals.signatures.toLocaleString())}
        {figure('Proven credits', proven ? `${proven.credits.toLocaleString()} in ${proven.mints.toLocaleString()} ${noun(proven.mints, 'mint')} · token units only` : 'Not determinable: rows predate owner evidence')}
      </dl>
      <p className="popover-foot"><a href="#coverage">Unknown reasons and sample in Coverage →</a></p>
    </>;
  }
  if (chip === 'excluded') {
    return <>
      <dl className="popover-figures">
        {figure('Rows', report.counts.excluded.toLocaleString())}{figure('Signatures', report.uniqueSignatures.excluded.toLocaleString())}
      </dl>
      {report.excludedReasons === null ? <p>Reasons are listed only when the report carries every row.</p>
        : report.excludedReasons.length === 0 ? <p>No excluded rows.</p>
          : <ul className="reason-lines">{report.excludedReasons.map(item => <li key={item.reason}>
            <span><span className="reason-code">{reasonLabel(item.reason)}</span><b>{item.count.toLocaleString()}</b></span><p>{REASON_TEXT[item.reason]}</p></li>)}</ul>}
    </>;
  }
  return <>
    <p>{report.unpriced.explanation}</p>
    <dl className="popover-figures">
      {figure(`${report.verifiedTotals.label} assets`, report.unpriced.verified.length.toLocaleString())}
      {figure(`${report.attribution.label} assets`, attributedCount(report, report.unpriced.attributed?.length ?? null))}
    </dl>
    <p className="popover-foot">{report.verifiedTotals.label}: {firstFew(report.unpriced.verified)}</p>
    {report.unpriced.attributed ? <p className="popover-foot">{report.attribution.label}: {firstFew(report.unpriced.attributed)}</p> : null}
  </>;
}

/** The saved prices behind the period's figures: when they were taken, and each token priced from one the report flags stale,
 * which stays in the figures at that price. */
export function PeriodPrices({ report, period }: { report: DashboardReport; period: Period }) {
  const prices = periodPrices(report, period);
  if (!prices || prices.oldest === null || prices.newest === null) return null;
  return <div className="price-ages">
    <p><b>Saved prices</b> {prices.oldest === prices.newest ? priceTimeText(prices.oldest) : `${priceTimeText(prices.oldest)} → ${priceTimeText(prices.newest)}`}.
      {' '}Each token is valued at its most recent saved price; one taken more than 24 hours before the cutoff is marked stale.</p>
    {prices.stale.length ? <ul className="stale-list" aria-label="Stale prices in this period">{prices.stale.map(token => <li key={token.key}>
      <b>{tokenSymbol(token.symbol)}</b><span className="stale-label">{staleText(token)}</span><span className="muted">{token.priceAt ? priceTimeText(token.priceAt) : ''}</span></li>)}</ul>
      : <p className="muted">No stale prices in this period.</p>}
  </div>;
}

/** The attributed group's explanation, how the period figures are made with the report's own figures beside them for reference,
 * and the trust sources, behind the info button beside the period figure. */
export function AttributedDetails({ report, period }: { report: DashboardReport; period: Period }) {
  const attribution = report.attribution;
  const evaluated = attributionState(report) === 'evaluated';
  return <>
    <p>{attribution.explanation}</p>
    {evaluated ? <>
      <p>{`Period figures are sums of the report's UTC calendar-day buckets, added exactly, each day as the report rounds it; the daily average divides by the period's ${period.days.toLocaleString()} calendar ${noun(period.days, 'day')}. The first tracked day starts at tracking start, ${utc(report.trackingStart)}, and the last ends at the fixed cutoff, ${utc(report.cutoff)}.`}</p>
      <dl className="popover-figures">
        <div><dt>Report · rolling 168 hours</dt><dd>{usd(attribution.rolling168h?.currentUsd)}</dd></div>
        <div><dt>Its daily average · ÷ 7</dt><dd>{usd(attribution.rolling168h?.dailyAverageUsd)}</dd></div>
        <div><dt>Report · since tracking start</dt><dd>{usd(attribution.cumulative?.currentUsd)}</dd></div>
        <div><dt>Rows · all tracked days</dt><dd>{attributedCount(report, attribution.rows)}</dd></div>
        <div><dt>Priced tokens</dt><dd>{(attribution.cumulative?.pricedCount ?? 0).toLocaleString()} of {attributedCount(report, attribution.assets?.length ?? null)}</dd></div>
      </dl>
      <PeriodPrices report={report} period={period}/>
    </> : <p className="state-detail">{attributionStateDetail(report)}</p>}
    <div className="popover-badges">{trustSourceRows(report).map(item => <TrustBadge key={item.source} report={report} source={item.source} rows={item.rows} detailed/>)}</div>
    <p className="popover-foot">Current valuation at saved price timestamps. Prices may be stale; these are not historical payout-time values. Unpriced amounts are excluded.</p>
  </>;
}

/** The large figure for a period: its priced USD, or what the period holds instead. Never a zero standing in for no data. */
export const periodFigure = (summary: PeriodSummary) => summary.usd !== null ? usd(summary.usd)
  : summary.receipts > 0 ? 'No priced receipts' : 'No attributed receipts';

/** The attributed figures for the selected period: the one large USD figure under the report's own label, the period's exact
 * UTC range beneath it, and its payouts, tokens, daily average and unpriced receipts. The tier's state replaces them all
 * while it is not evaluated. */
export function PeriodHero({ report, period }: { report: DashboardReport; period: Period }) {
  const attribution = report.attribution;
  const state = attributionState(report);
  const summary = periodSummary(report, period);
  return <div className={`period-hero${summary ? '' : ' hero-unevaluated'}`}>
    <div className="hero-lead">
      <div className="hero-label"><span className="eyebrow group-label">{attribution.label}</span>
        <Popover label={attribution.label} buttonLabel={`About ${attribution.label}`} buttonClass="info-button" align="start" trigger={<InfoIcon/>}>
          <header className="popover-title group-label">{attribution.label}</header><AttributedDetails report={report} period={period}/>
        </Popover></div>
      <strong className="hero-figure">{summary ? periodFigure(summary) : ATTRIBUTION_STATES[state === 'evaluated' ? 'not_evaluated' : state]}</strong>
      {summary ? <><span className="period-caption">{periodCaption(period)}</span><span className="hero-note">Priced receipts only · UTC calendar days</span></>
        : <span className="hero-note state-detail">{attributionStateDetail(report)}</span>}
    </div>
    {summary ? <dl className="hero-figures">
      <div><dt>Payouts</dt><dd>{summary.receipts.toLocaleString()}</dd></div>
      <div><dt>Tokens</dt><dd>{summary.tokens.toLocaleString()}</dd></div>
      <div><dt>Daily average</dt><dd>{usd(summary.averageUsd)}</dd></div>
      <div><dt>{report.unpriced.label}</dt><dd>{summary.unpricedReceipts.toLocaleString()} {noun(summary.unpricedReceipts, 'receipt')}</dd></div>
    </dl> : null}
  </div>;
}
