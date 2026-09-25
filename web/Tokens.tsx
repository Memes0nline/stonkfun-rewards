import { Fragment, useState } from 'react';
import type { DashboardReport, LaunchSources } from '../src/web/view.js';
import { TrustBadge, TrustNotes } from './Attributed.js';
import { TokenSwatch } from './Chart.js';
import {
  allLaunchesLabel, ATTRIBUTION_STATES, assetKey, attributionState, attributionStateDetail, avatarHue, EMPTY_MESSAGE, EMPTY_PALETTE, filterTokens, isAddress, launchesPage, noun,
  priceTimeText, short, sortTokens, SOURCES_EMPTY_WHY, SOURCES_LOADING, sourcesEmpty, sourcesHeading, sourcesSentence, staleText, stonkfunTokenLink, tokenColor, tokenSymbol,
  TRUST_SOURCE_ORDER, usd, utc, verifiedHidden,
} from './model.js';
import type { AttributedAsset, TokenPalette, TokenSort, TokenSortKey } from './model.js';
import { Address, CopyButton, Sheet } from './Sheet.js';

export function Avatar({ mint }: { mint: string }) {
  const hue = avatarHue(mint);
  return <svg className="avatar" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill={`hsl(${hue}, 30%, 17%)`}/><path d="M10 26V17L20 10L30 17V26L20 32Z" fill="none" stroke={`hsl(${hue}, 65%, 68%)`} strokeWidth="2"/><path d="M10 17L20 24L30 17M20 24V32" stroke={`hsl(${hue}, 65%, 68%)`} strokeWidth="2"/></svg>;
}
function TokenCell({ asset }: { asset: { mint: string; symbol: string; name: string } }) {
  return <div className="token-id"><Avatar mint={asset.mint}/><div><b>{tokenSymbol(asset.symbol)}</b><span>{asset.name}</span><a href={`https://solscan.io/token/${asset.mint}`} target="_blank" rel="noreferrer" title={asset.mint}>{short(asset.mint)} ↗</a></div></div>;
}

export type SourceToken = LaunchSources['tokens'][number];
/** The likely-source launches, read once per report as the Tokens tab opens. A failure says whether it timed out. */
export interface SourcesState { status: 'idle' | 'loading' | 'ready' | 'failed'; data: LaunchSources | null; reason?: 'timeout' | 'error'; wallet?: string }
type Launch = SourceToken['likely'][number] | SourceToken['exact'][number];
/** A launch's symbol and name when known, or else its short address. */
function LaunchName({ launch }: { launch: { mint: string; symbol?: string | null | undefined; name?: string | null | undefined } }) {
  return launch.symbol || launch.name ? <>{launch.symbol ? <b>{tokenSymbol(launch.symbol)}</b> : null}{launch.name ? <span>{launch.name}</span> : null}</>
    : <b><abbr className="source-short" title={launch.mint}>{short(launch.mint)}</abbr></b>;
}
/** Copy CA and a launch's StonkFun page, plus Solscan where the row has room, after its short address unless its name already is. */
function LaunchActions({ mint, solscan, named = true }: { mint: string; solscan?: string | null; named?: boolean }) {
  const valid = isAddress(mint);
  return <span className="source-actions">
    {valid ? <>{named ? <abbr className="source-short" title={mint}>{short(mint)}</abbr> : null}<CopyButton value={mint} label={`${short(mint)} launch contract address`} text="Copy CA"/>
      <a href={stonkfunTokenLink(mint)} target="_blank" rel="noreferrer" title="This launch on StonkFun">StonkFun ↗</a></> : <code className="address">{mint}</code>}
    {valid && solscan ? <a href={solscan} target="_blank" rel="noreferrer">Solscan ↗</a> : null}
  </span>;
}
function LaunchRow({ launch }: { launch: Launch }) {
  return <li className="source-launch">
    <div className="source-name"><LaunchName launch={launch}/>
      {'held' in launch ? <span className={`source-state ${launch.held.holding ? 'holding' : 'sold'}`}>{launch.held.holding ? 'Holding now' : 'Held earlier, sold'}</span> : null}</div>
    <LaunchActions mint={launch.mint} solscan={launch.tokenLink} named={!!(launch.symbol || launch.name)}/>
    {'held' in launch ? <p className="source-held">{launch.held.holding ? `Holds ${launch.held.amount}` : 'None held now'}
      {launch.held.source === 'history' ? ` · last traded ${launch.held.lastSeen === null ? 'at an unknown time' : utc(launch.held.lastSeen)}` : ''}
      {launch.held.evidenceLink ? <> <a href={launch.held.evidenceLink} target="_blank" rel="noreferrer">Transaction ↗</a></> : null}</p>
      : <p className="source-held">Named by the official feed for {launch.receipts.toLocaleString()} confirmed {noun(launch.receipts, 'receipt')}</p>}
  </li>;
}
/** Every launch the retained summaries name for a token, 25 a page. */
export function AllLaunches({ symbol, token, initialPage = 0 }: { symbol: string; token: SourceToken; initialPage?: number }) {
  const [page, setPage] = useState(initialPage);
  const view = launchesPage(token.launches, page);
  return <div className="all-launches" role="group" aria-label={`All launches that pay in ${symbol}`}>
    <p className="sources-foot">From StonkFun's retained /rewards summaries{token.summaryRetrievedAt ? `, latest ${utc(Date.parse(token.summaryRetrievedAt) / 1000)}` : ''}. {view.first.toLocaleString()}–{view.last.toLocaleString()} of {token.launches.length.toLocaleString()}.</p>
    <ol className="source-list all-launch-list" start={view.first}>{view.items.map(launch => <li key={launch.mint} className="source-launch compact">
      <div className="source-name"><LaunchName launch={launch}/></div><LaunchActions mint={launch.mint} named={!!(launch.symbol || launch.name)}/></li>)}</ol>
    {view.pages > 1 ? <div className="launch-pager">
      <button type="button" disabled={view.page === 0} onClick={() => { setPage(view.page - 1); }}>← Previous 25</button>
      <span>Page {view.page + 1} of {view.pages}</span>
      <button type="button" disabled={view.page >= view.pages - 1} onClick={() => { setPage(view.page + 1); }}>Next 25 →</button></div> : null}
  </div>;
}
/** The launches a token may have come from, under its row: the heading, when the holdings are from, the fixed sentence, then any
 * launch the official feed names for the token's confirmed receipts, as exact, apart from the likely ones, and the full list. */
export function SourceLaunches({ symbol, token, sources, retry = () => undefined, showAll: initialShowAll = false }: {
  symbol: string; token: SourceToken | undefined; sources: SourcesState; retry?: () => void; showAll?: boolean;
}) {
  const [showAll, setShowAll] = useState(initialShowAll);
  const { data } = sources;
  // A reload keeps what is on screen: launches already read show while newer ones load.
  const status = data && (sources.status === 'loading' || sources.status === 'idle') ? 'ready' : sources.status;
  return <section className="sources" aria-label={sourcesHeading(symbol)}>
    <h4>{sourcesHeading(symbol)}</h4>
    {status === 'ready' && data?.holdingsAt ? <p className="sources-asof">Holdings as of {utc(Date.parse(data.holdingsAt) / 1000)}
      {data.holdingsSource === 'history' ? ' · from retained transactions; Refresh rewards to check current holdings' : ''}</p> : null}
    <p className="sources-sentence">{sourcesSentence(symbol)}</p>
    {status === 'loading' || status === 'idle' ? <p className="muted" role="status">{SOURCES_LOADING}</p>
      : status === 'failed' ? <div className="sources-failed" role="status"><p>{sources.reason === 'timeout' ? 'Checking launches is taking longer than 15 seconds.' : 'Launches could not be checked.'} Saved evidence is unchanged.</p>
        <button type="button" onClick={retry}>Retry</button></div>
        : !token ? <p className="muted">Launch sources are unavailable from this saved data.</p> : <>
          {token.exact.length ? <div className="sources-exact"><h5>Named by the official feed · exact</h5>
            <ul className="source-list">{token.exact.map(launch => <LaunchRow key={launch.mint} launch={launch}/>)}</ul></div> : null}
          {token.likely.length === 0 ? <div className="sources-none"><p className="sources-empty">{sourcesEmpty(symbol)}</p><p className="sources-why">{SOURCES_EMPTY_WHY}</p></div>
            : <>{token.exact.length ? <h5>Likely · not named by the feed</h5> : null}
              <ul className="source-list">{token.likely.map(launch => <LaunchRow key={launch.mint} launch={launch}/>)}</ul></>}
          {!token.covered ? <p className="sources-foot">No retained StonkFun /rewards summary names {symbol} as the token a launch pays in.</p>
            : <><button type="button" className="all-launches-toggle" aria-expanded={showAll} onClick={() => { setShowAll(open => !open); }}>
              {showAll ? `Hide the launches that pay in ${symbol}` : allLaunchesLabel(token.launches.length, symbol)}</button>
              {showAll ? <AllLaunches symbol={symbol} token={token}/> : null}</>}
        </>}
  </section>;
}
/** The chevron that opens a token row's launches. */
function SourcesToggle({ symbol, open, controls, onToggle }: { symbol: string; open: boolean; controls: string; onToggle: () => void }) {
  return <button type="button" className="chevron" aria-expanded={open} aria-controls={controls} aria-label={sourcesHeading(symbol)}
    onClick={event => { event.stopPropagation(); onToggle(); }}><span aria-hidden="true">{open ? '▾' : '▸'}</span></button>;
}
/** A row's expansion id: letters, digits and hyphens only. */
const sourcesId = (key: string) => `sources-${key.replace(/[^A-Za-z0-9]/g, '-')}`;

interface PricedFigure { priceAt: string | null; priceStale: boolean | null; priceAgeSeconds: number | null }
/** The saved price behind a USD cell, for its title. */
const priceTitle = (price: PricedFigure, none: string) => price.priceAt ? `Saved price: ${priceTimeText(price.priceAt)}${price.priceStale ? ` · ${staleText(price)}` : ''}` : none;
/** "stale · <age>" under a priced figure whose saved price the report flags stale. */
export function StaleLabel({ price }: { price: PricedFigure }) {
  const text = staleText(price);
  return text ? <span className="stale-label" title={price.priceAt ? `Saved price taken ${priceTimeText(price.priceAt)}, more than 24 hours before the cutoff` : undefined}>{text}</span> : null;
}

/** Verified receipts only. Each row opens the launches the official feed names for it, and the likely ones. */
export function TokenTable({ report, sources = { status: 'idle', data: null }, expanded = new Set<string>(), toggle = () => undefined, retry }: {
  report: DashboardReport; sources?: SourcesState; expanded?: ReadonlySet<string>; toggle?: (key: string) => void; retry?: () => void;
}) {
  return <section className="panel token-panel" aria-labelledby="token-title"><div className="panel-heading"><div><span className="eyebrow">CONFIRMED RECEIPTS ONLY</span><h2 id="token-title">Reward tokens <span className="count-label">{report.assets.length}</span></h2></div><span className="muted">MINT-VERIFIED IDENTITY</span></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Reward token table, scroll horizontally on narrow screens"><table className="verified-table"><thead><tr><th>Token / mint</th><th>Exact quantity</th><th>Current USD</th><th>7D amount / USD</th><th>Receipts</th><th>Last reward · UTC</th><th>Status / evidence</th></tr></thead><tbody>{report.assets.map(asset => {
      const key = `${asset.mint}:${asset.decimals}`; const open = expanded.has(`verified:${key}`); const id = sourcesId(`verified-${key}`);
      return <Fragment key={key}><tr className={open ? 'is-expanded' : undefined}><td><div className="token-cell"><SourcesToggle symbol={tokenSymbol(asset.symbol)} open={open} controls={id} onToggle={() => { toggle(`verified:${key}`); }}/><TokenCell asset={asset}/></div></td><td className="quantity">{asset.amount}</td><td title={priceTitle(asset, 'No verified USD price')}>{asset.currentUsd === null ? <span className="yellow-text">Unpriced</span> : usd(asset.currentUsd)}</td><td>{asset.sevenDayAmount}<span className="cell-sub">{usd(asset.sevenDayUsd)}</span></td><td>{asset.receipts}</td><td>{utc(asset.lastRewardTime).replace(' UTC', '')}</td><td><span className={`badge ${asset.currentUsd === null ? 'unpriced' : 'priced'}`}>{asset.currentUsd === null ? 'UNPRICED' : 'PRICED'}</span><StaleLabel price={asset}/>{asset.evidenceLink ? <a className="cell-sub" href={asset.evidenceLink} target="_blank" rel="noreferrer">Evidence ↗</a> : null}</td></tr>
        {open ? <tr className="sources-row" id={id}><td colSpan={7}><SourceLaunches symbol={tokenSymbol(asset.symbol)} sources={sources}
          token={sources.data?.tokens.find(item => item.key === key)} {...retry ? { retry } : {}}/></td></tr> : null}</Fragment>;
    })}</tbody></table></div>
    {report.assets.length === 0 ? <div className="table-empty"><span aria-hidden="true">◇</span><strong>No confirmed reward tokens</strong><p>{EMPTY_MESSAGE}</p></div> : null}
    <div className="panel-foot">Exact token quantities retained · mint-derived avatars · unknown candidates never enter this table</div>
  </section>;
}

/** One attributed token: its full mint, figures, trust sources with the report's wording, and its receipts newest first. */
export function TokenDrawer({ report, asset, onClose, onReceipt, palette = EMPTY_PALETTE }: {
  report: DashboardReport; asset: AttributedAsset; onClose: () => void; onReceipt?: (id: string) => void; palette?: TokenPalette;
}) {
  const key = assetKey(asset);
  const detail = report.attribution.tokenDetails?.find(item => item.key === key);
  const receipts = new Map((report.attribution.receipts ?? []).map(receipt => [receipt.id, receipt]));
  const listed = (detail?.receiptIds ?? []).flatMap(id => receipts.get(id) ?? []);
  const figure = (term: string, value: string) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>;
  return <Sheet kind="drawer" labelledBy="token-drawer-title" onClose={onClose}
    heading={<><Avatar mint={asset.mint}/><div><span className="eyebrow group-label">{report.attribution.label}</span><h2 id="token-drawer-title">{tokenSymbol(asset.symbol)}</h2>
      <span className="muted">{palette.keys.length ? <TokenSwatch color={tokenColor(palette, key)}/> : null}{asset.name}
        {palette.keys.length && !palette.colors.has(key) ? ' · Other in the chart' : ''}</span></div></>}>
    <section className="sheet-section"><h3>Mint address</h3>
      {detail?.mintAddress ? <Address value={detail.mintAddress} label="mint address" link={detail.tokenLink}/> : <p className="muted">Native SOL · no mint address</p>}</section>
    <dl className="sheet-figures">
      {figure('Quantity', asset.amount)}{figure('Current USD', asset.currentUsd === null ? 'Unpriced' : usd(asset.currentUsd))}
      {figure('Receipts', asset.receipts.toLocaleString())}{figure('First receipt', detail?.firstReceiptTime ? utc(detail.firstReceiptTime) : 'Unavailable')}
      {figure('Last receipt', utc(asset.lastRewardTime))}{figure('Saved price', asset.priceAt ? `${priceTimeText(asset.priceAt)}${asset.priceStale ? ` · ${staleText(asset)}` : ''}` : 'No valid USD price')}
    </dl>
    <section className="sheet-section"><h3>Trust sources</h3>
      {asset.trustSources === null ? <p className="muted">Unavailable: the report does not carry every attributed row.</p>
        : <div className="sheet-badges">{TRUST_SOURCE_ORDER.filter(source => asset.trustSources?.includes(source)).map(source => <TrustBadge key={source} report={report} source={source} detailed/>)}</div>}</section>
    <section className="sheet-section"><h3>Receipts <span className="muted">· newest first</span></h3>
      <ol className="receipt-list">{listed.map(receipt => {
        const owner = receipt.attribution?.sourceOwner ?? null;
        return <li key={receipt.id}>
          {onReceipt ? <button type="button" className="link-button" onClick={() => { onReceipt(receipt.id); }}>{receipt.time === null ? 'Unknown time' : utc(receipt.time)}</button>
            : <span>{receipt.time === null ? 'Unknown time' : utc(receipt.time)}</span>}
          <span className="quantity">{receipt.amount ?? 'Unknown amount'}</span>
          <span className={receipt.currentUsd === null ? 'yellow-text' : ''}>{receipt.currentUsd === null ? 'Unpriced' : usd(receipt.currentUsd)}</span>
          {owner ? <abbr className="sender" title={owner}>{short(owner)}</abbr> : <span className="muted">Unavailable</span>}
          {receipt.evidenceLink ? <a href={receipt.evidenceLink} target="_blank" rel="noreferrer">Evidence ↗</a> : <span className="muted">No link</span>}
        </li>;
      })}</ol>
      {listed.length < asset.receipts ? <p className="muted">{listed.length.toLocaleString()} of {asset.receipts.toLocaleString()} {noun(asset.receipts, 'receipt')} listed; the rest are older than the listed window or outside a truncated report.</p> : null}
    </section>
    <p className="sheet-foot">Sender identities are abbreviated here; hover for the full address, and the receipt's evidence carries every address in full. Current value at saved prices, never added to verified totals.</p>
  </Sheet>;
}

const COLUMNS: { key: TokenSortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'symbol', label: 'Token' }, { key: 'quantity', label: 'Quantity', numeric: true }, { key: 'usd', label: 'USD', numeric: true },
  { key: 'receipts', label: 'Receipts', numeric: true }, { key: 'last', label: 'Last receipt · UTC' }, { key: null, label: 'Trust' }, { key: null, label: 'Price' },
];
/** Attributed tokens: searchable, sortable, one drawer per token, each row expanding to its likely source launches. Deliberately
 * no total row; verified tokens keep their own table below. */
export function TokensTab({ report, selected, open, close, onReceipt, palette = EMPTY_PALETTE, launchSources = { status: 'idle', data: null }, loadSources = () => undefined }: {
  report: DashboardReport; selected?: string | undefined; open: (key: string) => void; close: () => void; onReceipt?: (id: string) => void; palette?: TokenPalette;
  launchSources?: SourcesState; loadSources?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TokenSort>({ key: 'usd', direction: 'descending' });
  // Expanded rows, by group and token key.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The page reads the launches as soon as this tab opens, so a row opens on them at once. Opening a row reads them only when
  // nothing is loaded or loading.
  const expand = (id: string) => {
    if (!expanded.has(id) && (launchSources.status === 'failed' || launchSources.status === 'idle')) loadSources();
    setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const attribution = report.attribution;
  const state = attributionState(report);
  const assets = attribution.assets ?? [];
  const rows = sortTokens(filterTokens(assets, query), sort);
  const active = state === 'evaluated' ? assets.find(asset => assetKey(asset) === selected) : undefined;
  const sources = TRUST_SOURCE_ORDER.filter(source => assets.some(asset => asset.trustSources?.includes(source)));
  const toggle = (key: TokenSortKey) => { setSort(current => current.key === key ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    : { key, direction: key === 'symbol' ? 'ascending' : 'descending' }); };
  return <>
    <section className="panel token-panel attributed-panel" aria-labelledby="attributed-token-title">
      <div className="panel-heading"><div><span className="eyebrow group-label">{attribution.label}</span><h2 id="attributed-token-title">Attributed tokens {state === 'evaluated' ? <span className="count-label">{assets.length}</span> : null}</h2></div>
        {state === 'evaluated' ? <label className="search-box"><span className="sr-only">Search tokens</span><input type="search" placeholder="Search symbol, name or mint" value={query} spellCheck={false} autoComplete="off" onChange={event => { setQuery(event.target.value); }}/></label> : null}</div>
      <p className="panel-note">{attribution.explanation}</p>
      {state !== 'evaluated' ? <div className="state-box"><strong>{ATTRIBUTION_STATES[state]}</strong><p>{attributionStateDetail(report)}</p></div> : <>
        <div className="table-scroll tall" tabIndex={0} role="region" aria-label="Attributed token table"><table className="token-table">
          <thead><tr>{COLUMNS.map(column => <th key={column.label} className={column.numeric ? 'numeric' : undefined}
            aria-sort={column.key === null ? undefined : sort.key === column.key ? sort.direction : 'none'}>
            {column.key === null ? column.label : <button type="button" className="sort" onClick={() => { toggle(column.key!); }}>{column.label}
              <span aria-hidden="true">{sort.key === column.key ? sort.direction === 'ascending' ? ' ▲' : ' ▼' : ' ↕'}</span></button>}</th>)}</tr></thead>
          <tbody>{rows.map(asset => {
            const key = assetKey(asset); const expandedRow = expanded.has(`attributed:${key}`); const id = sourcesId(`attributed-${key}`);
            return <Fragment key={key}><tr className={[key === selected ? 'is-selected' : '', expandedRow ? 'is-expanded' : ''].filter(Boolean).join(' ') || undefined} onClick={() => { open(key); }}>
              <td><div className="token-cell"><SourcesToggle symbol={tokenSymbol(asset.symbol)} open={expandedRow} controls={id} onToggle={() => { expand(`attributed:${key}`); }}/>
                <button type="button" className="row-open" onClick={event => { event.stopPropagation(); open(key); }} aria-label={`${tokenSymbol(asset.symbol)} ${asset.name}: open token detail`}>
                <Avatar mint={asset.mint}/><span className="token-name"><b><TokenSwatch color={tokenColor(palette, key)}/>{tokenSymbol(asset.symbol)}</b><span>{asset.name}</span></span></button></div></td>
              <td className="quantity numeric">{asset.amount}</td>
              <td className="numeric" title={priceTitle(asset, 'No valid USD price')}>{asset.currentUsd === null ? <span className="yellow-text">Unpriced</span> : usd(asset.currentUsd)}</td>
              <td className="numeric">{asset.receipts.toLocaleString()}</td>
              <td>{utc(asset.lastRewardTime).replace(' UTC', '')}</td>
              <td><div className="trust-cell">{asset.trustSources === null ? <span className="muted">Unavailable</span> : asset.trustSources.map(source => <TrustBadge key={source} report={report} source={source}/>)}</div></td>
              <td><span className={`badge ${asset.currentUsd === null ? 'unpriced' : 'attributed'}`}>{asset.currentUsd === null ? 'UNPRICED' : 'PRICED'}</span><StaleLabel price={asset}/></td>
            </tr>
            {expandedRow ? <tr className="sources-row" id={id}><td colSpan={COLUMNS.length}><SourceLaunches symbol={tokenSymbol(asset.symbol)} sources={launchSources} retry={loadSources}
              token={launchSources.data?.tokens.find(item => item.key === key)}/></td></tr> : null}</Fragment>;
          })}</tbody></table></div>
        {rows.length === 0 ? <div className="table-empty"><span aria-hidden="true">◇</span><strong>{assets.length ? 'No token matches this search' : 'No attributed tokens'}</strong>
          <p>{assets.length ? 'Search matches symbol, name or mint.' : 'No attributed receipts in the tracked window.'}</p></div> : null}
        <TrustNotes report={report} sources={sources}/>
      </>}
      <div className="panel-foot">{state === 'evaluated' ? `${rows.length.toLocaleString()} of ${assets.length.toLocaleString()} tokens · ` : ''}Exact token quantities · priced separately from verified receipts · no row adds the two groups</div>
    </section>
    {verifiedHidden(report) ? null : <TokenTable report={report} sources={launchSources} expanded={expanded} toggle={expand} retry={loadSources}/>}
    {active ? <TokenDrawer report={report} asset={active} onClose={close} palette={palette} {...onReceipt ? { onReceipt } : {}}/> : null}
  </>;
}
