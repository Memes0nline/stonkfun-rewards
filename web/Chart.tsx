import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { DashboardReport } from '../src/web/view.js';
import { PeriodHero } from './Hero.js';
import {
  ATTRIBUTION_STATES, attributedChartDays, attributionState, attributionStateDetail, chartDays, chartTicks, customPeriod, dayNumber, daySegments, dayText, defaultPeriod,
  EMPTY_MESSAGE, HISTORY_FLOOR_TIME, noun, OTHER_COLOR, percentText, periodLabel, periodOptions, periodParams, SCAN_MORE_REASON, sortUsdRows, tickText, TOKEN_COLORS, tokenColor, tokenPalette, tokenRanking,
  tokenSymbol, trackedDays, usd, usdExact, verifiedHidden,
} from './model.js';
import type { DayBucket, Period, Segment, SortDirection, TokenPalette } from './model.js';
import { CopyButton } from './Sheet.js';

/** Chart height: the plot, its top margin and the day labels. The day tooltip is at most the plot's height. */
export const HEIGHT = 300;
const MARGIN = { left: 46, right: 12, top: 12, bottom: 26 };
/** The canvas's own pixel width, so bars, labels and the tooltip share one coordinate system at any screen size. */
function useWidth(ref: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => { const next = Math.round(entries[0]?.contentRect.width ?? 0); if (next > 0) setWidth(next); });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [ref]);
  return width;
}
export interface Geometry { width: number; firstDay: number; dayCount: number; slot: number; bar: number; x: (day: string) => number; plotHeight: number }
/** One slot per calendar day of the period, whether or not the day has receipts. */
export function geometry(width: number, period: Period): Geometry {
  const firstDay = dayNumber(period.start); const dayCount = period.days;
  const slot = (width - MARGIN.left - MARGIN.right) / dayCount;
  return { width, firstDay, dayCount, slot, bar: Math.max(2, Math.min(44, slot * 0.62)), plotHeight: HEIGHT - MARGIN.top - MARGIN.bottom,
    x: day => MARGIN.left + (dayNumber(day) - firstDay + 0.5) * slot };
}
/** Gridlines and compact left-scale labels at round steps, the last at the plot's top. Geometry only: the exact values are in
 * each chart's data table. */
function Scale({ ticks, width }: { ticks: readonly number[]; width: number }) {
  const scaleTop = ticks.at(-1)!; const plot = HEIGHT - MARGIN.top - MARGIN.bottom;
  return <>{ticks.map(value => { const y = MARGIN.top + (1 - value / scaleTop) * plot;
    return <g key={value} className="scale-tick"><line x1={MARGIN.left} x2={width - MARGIN.right} y1={y} y2={y}/><text x={MARGIN.left - 6} y={y + 3} textAnchor="end">
      {tickText(value)}</text></g>; })}</>;
}
/** Calendar-day labels under the plot: every day when there is room, otherwise every few days, so they never overlap. A label
 * opens its day when `onDay` is given; keyboard users open days from the columns themselves. */
function DayAxis({ g, onDay }: { g: Geometry; onDay?: (day: string) => void }) {
  const step = Math.max(1, Math.ceil(44 / g.slot));
  const days = Array.from({ length: g.dayCount }, (_, index) => index).filter(index => index % step === 0).map(index => dayText(g.firstDay + index));
  return <g className={`day-axis${onDay ? ' is-open' : ''}`} aria-hidden="true">{days.map(day => <text key={day} x={g.x(day)} y={HEIGHT - 8} textAnchor="middle"
    data-day={day} onClick={onDay ? () => { onDay(day); } : undefined}>{day.slice(5)}</text>)}</g>;
}

/** A token's color: a small square in tables and lists, a short line key in the tooltip. Identity is never color alone. */
export function TokenSwatch({ color, line = false }: { color: string; line?: boolean }) {
  return <i className={line ? 'token-key' : 'token-swatch'} style={{ background: color }} aria-hidden="true"/>;
}

/** One UTC day of the attributed series: its report total and receipts, the unpriced receipts that stay out of the bar, and one
 * row per segment with its color, ticker, share, USD, exact amount and a Copy CA button for the full mint, highest USD first
 * or, from the USD header, lowest first; Other follows the named tokens either way. A ticker lists that token's payouts on the
 * day. Other expands to its own tokens, in the same order, whose shares add up to Other's. */
export function DayTooltip({ report, bucket, palette, selected = null, pinned = false, order = 'descending', onOrder, onToken, onDay, onClose }: {
  report: DashboardReport; bucket: DayBucket; palette: TokenPalette; selected?: string | null; pinned?: boolean;
  order?: SortDirection; onOrder?: (next: SortDirection) => void; onToken?: (key: string) => void; onDay?: () => void; onClose?: () => void;
}) {
  const split = daySegments(bucket, palette);
  const segments = sortUsdRows(split.segments, order); const others = sortUsdRows(split.others, order); const unpriced = split.unpriced;
  const next = order === 'descending' ? 'ascending' : 'descending';
  const [expanded, setExpanded] = useState(false);
  const row = (segment: Segment) => <li key={segment.key} className={selected === segment.key ? 'is-selected' : undefined}>
    <TokenSwatch color={segment.color} line/>
    {onToken ? <button type="button" className="ticker" onClick={() => { onToken(segment.key); }} aria-label={`${segment.symbol}: list its payouts on ${bucket.day}`}>{segment.symbol}</button>
      : <b>{segment.symbol}</b>}
    <span className="tooltip-share">{percentText(segment.tenths)}</span><span className="tooltip-usd">{usd(segment.usd)}</span>
    <span className="quantity">{segment.amount}</span>
    {segment.mintAddress ? <CopyButton value={segment.mintAddress} label={`${segment.symbol} contract address`} text="Copy CA"/> : <span className="muted tooltip-native">No mint address</span>}
  </li>;
  return <>
    <header><span className="tooltip-title"><b id={`day-tooltip-title-${bucket.day}`}>{bucket.day} UTC</b><span className="group-label">{report.attribution.label}</span></span>
      {onClose ? <button type="button" className="tooltip-close" onClick={onClose} aria-label="Close this day">×</button> : null}</header>
    <div className="tooltip-figure"><strong className="tooltip-total">{bucket.currentUsd === null ? 'No priced receipts' : usd(bucket.currentUsd)}</strong>
      {onDay ? <button type="button" className="tooltip-day link-button" onClick={onDay}>All {bucket.receipts.toLocaleString()} {noun(bucket.receipts, 'payout')} that day →</button> : null}</div>
    <span className="tooltip-sub">{bucket.receipts.toLocaleString()} {noun(bucket.receipts, 'receipt')}{unpriced.receipts
      ? ` · ${unpriced.receipts.toLocaleString()} unpriced ${noun(unpriced.receipts, 'receipt')} in ${unpriced.tokens.toLocaleString()} ${noun(unpriced.tokens, 'token')}, not in the bar` : ''}</span>
    {segments.length ? <div className="tooltip-sort"><span>Token · share</span>
      <button type="button" className="sort" aria-label={`USD, ${order === 'descending' ? 'highest' : 'lowest'} first. Sort ${next === 'descending' ? 'highest' : 'lowest'} first`}
        onClick={() => { onOrder?.(next); }}>USD <span aria-hidden="true">{order === 'descending' ? '▼' : '▲'}</span></button></div> : null}
    {segments.length ? <ul className="tooltip-tokens">{segments.map(segment => segment.other
      ? <li key="other" className={`tooltip-other${selected === 'other' ? ' is-selected' : ''}`}>
        <TokenSwatch color={segment.color} line/>
        <button type="button" className="other-toggle" aria-expanded={expanded} aria-controls={`other-tokens-${bucket.day}`}
          onClick={() => { setExpanded(value => !value); }}>Other · {segment.tokens.toLocaleString()} {noun(segment.tokens, 'token')} <span aria-hidden="true">{expanded ? '▾' : '▸'}</span></button>
        <span className="tooltip-share">{percentText(segment.tenths)}</span><span className="tooltip-usd">{usd(segment.usd)}</span>
        <span className="quantity">{segment.receipts.toLocaleString()} {noun(segment.receipts, 'receipt')}</span>
        {expanded ? <ul className="tooltip-others" id={`other-tokens-${bucket.day}`} aria-label="Tokens in Other">{others.map(row)}</ul> : null}
      </li> : row(segment))}</ul> : null}
    <span className="tooltip-hint">{pinned ? 'Pinned · Esc or a click outside closes it' : 'Click the day to pin it · a ticker lists its payouts that day'}</span>
  </>;
}
/** True on a phone-width viewport, where the day tooltip becomes a bottom sheet a tap pins. */
function useNarrow() {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const change = () => { setNarrow(list.matches); };
    change(); list.addEventListener('change', change);
    return () => { list.removeEventListener('change', change); };
  }, []);
  return narrow;
}
const ORDER_KEY = 'stonkfun:tooltip-usd-order:v1';
/** The tooltip's USD order, kept for the browser session so it holds from day to day, across tabs and reloads. */
function useTooltipOrder(): [SortDirection, (next: SortDirection) => void] {
  const [order, setOrder] = useState<SortDirection>(() => { try { return sessionStorage.getItem(ORDER_KEY) === 'ascending' ? 'ascending' : 'descending'; } catch { return 'descending'; } });
  return [order, next => { setOrder(next); try { sessionStorage.setItem(ORDER_KEY, next); } catch { /* optional session preference */ } }];
}
/** How long a hovered or focused day stays open after the pointer or focus leaves it, so it can move into the tooltip. */
export const TOOLTIP_GRACE_MS = 150;
const TOOLTIP_WIDTH = 300;
/** The space between the hovered day's bar and the tooltip's near edge. */
export const TOOLTIP_GAP = 8;
/** The tooltip right next to its day's bar, 8px from it: to the right, or to the left when the right would overflow the chart.
 * It may cover neighbouring days; column hover pauses while the pointer is in it or crosses the gap to it. Only when neither side
 * fits does it take the roomier side, at least 220px wide and inside the chart. It starts at the canvas's top, at most the plot's
 * height; `clampTop` then keeps it inside the viewport. */
export function tooltipPlacement(g: Geometry, day: string) {
  const bar = { left: g.x(day) - g.bar / 2, right: g.x(day) + g.bar / 2 };
  const vertical = { top: 0, maxHeight: MARGIN.top + g.plotHeight };
  const right = bar.right + TOOLTIP_GAP; const left = bar.left - TOOLTIP_GAP - TOOLTIP_WIDTH;
  if (right + TOOLTIP_WIDTH <= g.width) return { side: 'right' as const, left: right, width: TOOLTIP_WIDTH, bar, ...vertical };
  if (left >= 0) return { side: 'left' as const, left, width: TOOLTIP_WIDTH, bar, ...vertical };
  const spaceRight = g.width - right; const spaceLeft = bar.left - TOOLTIP_GAP;
  const side = spaceRight >= spaceLeft ? 'right' as const : 'left' as const;
  const width = Math.max(220, Math.min(TOOLTIP_WIDTH, side === 'right' ? spaceRight : spaceLeft));
  return { side, left: side === 'right' ? Math.min(right, g.width - width) : Math.max(0, bar.left - TOOLTIP_GAP - width), width, bar, ...vertical };
}
/** Whether a pointer at `x` is on its way from the open day's bar to its tooltip: in the 8px gap, or beside the bar under or
 * above the tooltip, since the tooltip starts at the plot's top and a short bar's pointer reaches it on a diagonal. */
export function towardTooltip(place: ReturnType<typeof tooltipPlacement>, x: number) {
  return place.side === 'right' ? x > place.bar.right && x < place.left + place.width : x < place.bar.left && x > place.left;
}
/** The distance from a point to a box, both in viewport pixels: zero inside it. */
export const distanceTo = (box: { left: number; right: number; top: number; bottom: number }, x: number, y: number) =>
  Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
/** The tooltip's top within the canvas, moved only as far as keeps its `height` inside the viewport band `bandTop` to
 * `bandBottom`, given the canvas's own top in the viewport. When it cannot fit, its top edge stays visible. */
export function clampTop(top: number, height: number, canvasTop: number, bandTop: number, bandBottom: number) {
  return Math.max(bandTop - canvasTop, Math.min(top, bandBottom - height - canvasTop));
}
/** The viewport band a floating tooltip stays inside: below the sticky header, 8px from each edge. */
function viewportBand() {
  const header = document.querySelector('.topbar');
  const covered = header && getComputedStyle(header).position === 'sticky' ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  return { top: covered + 8, bottom: window.innerHeight - 8 };
}

/** Bar geometry for one day's segments: each from the baseline up in palette order, the last ending exactly at the day total,
 * with a 2px surface gap between neighbours. */
function stack(segments: Segment[], base: number, height: number) {
  const values = segments.map(segment => Number(segment.usd));
  const total = values.reduce((sum, value) => sum + value, 0);
  let below = 0;
  return segments.map((segment, index) => {
    const bottom = base - (total > 0 ? below / total * height : 0);
    below += values[index]!;
    const top = index === segments.length - 1 ? base - height : base - (total > 0 ? below / total * height : 0);
    const gap = index < segments.length - 1 ? 2 : 0;
    return { segment, y: top + Math.min(gap, Math.max(0, bottom - top - 1)), height: Math.max(1, bottom - top - gap), top, bottom };
  });
}

/** The attributed group's own daily series, each day's bar split by token: a separate SVG and scale, never stacked on or
 * summed with verified values. */
function AttributedPlot({ report, period, palette, onDay }: { report: DashboardReport; period: Period; palette: TokenPalette; onDay: (day: string, token?: string) => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const width = useWidth(canvas);
  const g = geometry(width, period);
  const [active, setActiveState] = useState<{ day: string; pinned: boolean } | null>(null);
  // Timers and pointer handlers read the open day through this ref, so they never act on a stale render.
  const current = useRef(active);
  const setActive = (next: { day: string; pinned: boolean } | null) => { current.current = next; setActiveState(next); };
  // The token lit across the chart: a hovered segment or legend entry, or one chosen with the arrow keys.
  const [lit, setLit] = useState<string | null>(null);
  const pointer = useRef('mouse');
  const tooltip = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const [order, setOrder] = useTooltipOrder();
  const state = attributionState(report);
  const days = attributedChartDays(report, period);
  const priced = days?.filter(day => day.currentUsd !== null) ?? [];
  const ticks = chartTicks(Math.max(1, ...priced.map(day => Number(day.currentUsd)))); const scaleTop = ticks.at(-1)!;
  const buckets = new Map((report.attribution.dayTokens ?? []).map(bucket => [bucket.day, bucket]));
  const columns = new Set(days?.map(day => day.day) ?? []);
  const bucket = active ? buckets.get(active.day) : undefined;
  const segmentsOf = (day: string) => { const found = buckets.get(day); return found ? daySegments(found, palette).segments : []; };
  // The last pointer position over the plot: its x and the column under it (null over an empty day or outside).
  const point = useRef<{ x: number; day: string | null } | null>(null);
  // Whether the pointer is in the tooltip, where the days it covers never take over.
  const inTooltip = () => tooltip.current?.matches(':hover') ?? false;
  // The pointer's last distance to the open tooltip, so a pointer still closing in keeps the grace running.
  const reach = useRef<number | null>(null);
  // One grace timer. When it runs out the tooltip follows the pointer: to the column under it, or closed if there is none. A
  // pinned day stays until Escape, a click elsewhere or its own column again.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const settle = () => {
    timer.current = null;
    if (current.current?.pinned || inTooltip()) return;
    const day = point.current?.day ?? null;
    setActive(day === null ? null : { day, pinned: false });
  };
  const grace = (restart = true) => { if (!restart && timer.current !== null) return; cancel(); timer.current = setTimeout(settle, TOOLTIP_GRACE_MS); };
  const close = () => { cancel(); setActive(null); setLit(null); };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => { if (current.current?.pinned && !canvas.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  });
  // Hover follows the pointer over the plot (never on a phone, where a tap pins the day as a bottom sheet). A column opens at
  // once. Column hover pauses while the pointer is in the tooltip, and while it crosses from the bar to the tooltip: through the
  // gap, or beside the bar under the tooltip on the way up to it. There the grace decides, restarted only while the pointer
  // closes in: a pointer that keeps going reaches the tooltip, so a day it covers never takes over, and one that rests follows
  // the column under it. Anywhere else closes after the grace.
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse' || narrow) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const slot = dayText(g.firstDay + Math.floor((x - MARGIN.left) / g.slot));
    const day = x >= MARGIN.left && x < g.width - MARGIN.right && columns.has(slot) ? slot : null;
    point.current = { x, day };
    const box = tooltip.current?.getBoundingClientRect();
    const distance = box ? distanceTo(box, event.clientX, event.clientY) : null;
    const closer = distance !== null && reach.current !== null && distance < reach.current;
    reach.current = distance;
    const open = current.current;
    if (open?.pinned || inTooltip()) return;
    if (open && day === open.day) { cancel(); return; }
    if (open && towardTooltip(tooltipPlacement(g, open.day), x)) { grace(closer); return; }
    if (day !== null) { cancel(); setActive({ day, pinned: false }); return; }
    if (open) grace(false);
  };
  const out = () => { point.current = null; if (current.current && !current.current.pinned) grace(); };
  // A named token opens that day's payouts of it; Other and the day itself open the whole day.
  const open = (day: string, token: string | null = null) => { onDay(day, token && token !== 'other' ? token : undefined); };
  // A click or tap pins the day, lighting the segment it landed on. The same click again unpins it: a mouse keeps the hovered
  // day open, a tap closes it. A different segment of a pinned day only moves the light.
  const pin = (day: string, token: string | null) => {
    cancel();
    if (active?.pinned && active.day === day && (token === null || token === lit)) {
      setActive(pointer.current === 'touch' || narrow ? null : { day, pinned: false }); if (token === null) setLit(null);
      return;
    }
    setActive({ day, pinned: true }); setLit(token);
  };
  const keys = (day: string) => (event: ReactKeyboardEvent<SVGGElement>) => {
    const named = segmentsOf(day).filter(segment => !segment.other).map(segment => segment.key);
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(day, lit !== null && named.includes(lit) ? lit : null); }
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && named.length) {
      event.preventDefault();
      const at = lit === null ? -1 : named.indexOf(lit);
      setLit(event.key === 'ArrowUp' ? named[(at + 1) % named.length]! : named[at <= 0 ? named.length - 1 : at - 1]!);
    } else if (event.key === 'Escape') setLit(null);
  };
  const placement = bucket ? tooltipPlacement(g, bucket.day) : null;
  // The open tooltip's top, moved to stay inside the viewport as the page scrolls, the window resizes or the tooltip grows.
  const [top, setTop] = useState(0);
  const floating = placement !== null && !narrow;
  useLayoutEffect(() => {
    const node = tooltip.current;
    if (!floating || !node) return;
    const clamp = () => {
      const box = canvas.current?.getBoundingClientRect(); if (!box) return;
      const band = viewportBand();
      setTop(clampTop(0, node.offsetHeight, box.top, band.top, band.bottom));
    };
    clamp();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clamp);
    observer?.observe(node);
    window.addEventListener('scroll', clamp, { passive: true, capture: true }); window.addEventListener('resize', clamp);
    return () => { observer?.disconnect(); window.removeEventListener('scroll', clamp, { capture: true }); window.removeEventListener('resize', clamp); };
  }, [floating, bucket?.day]);
  const legend = palette.keys.filter(key => days?.some(day => segmentsOf(day.day).some(segment => segment.key === key)));
  const hasOther = days?.some(day => segmentsOf(day.day).some(segment => segment.other)) ?? false;
  const symbols = new Map((report.attribution.assets ?? []).map(asset => [`${asset.mint}:${asset.decimals}`, tokenSymbol(asset.symbol)]));
  const selectedSegment = bucket && lit !== null ? daySegments(bucket, palette).segments.find(segment => segment.key === lit) : undefined;
  return <div className="attributed-plot" role="group" aria-labelledby="attributed-chart-title">
    <div className="plot-heading"><span className="eyebrow group-label">{report.attribution.label}</span><h3 id="attributed-chart-title">Daily attributed receipts <span className="muted">/ USD by token · own scale</span></h3></div>
    {days === null ? <div className="chart-empty attributed-empty"><strong>{ATTRIBUTION_STATES[state === 'evaluated' ? 'not_evaluated' : state]}</strong><p>{attributionStateDetail(report)}</p></div>
      : priced.length === 0 ? <div className="chart-empty attributed-empty"><strong>{days.length ? 'No priced attributed receipts in this period.' : 'No attributed receipts in this period.'}</strong>
        {days.length ? <p>{days.length} UTC {noun(days.length, 'day')} with unpriced attributed receipts. {report.unpriced.explanation}</p> : null}</div>
        : <>
          <ul className="token-legend" aria-label="Token colors in this period">{legend.map(key => <li key={key} className={lit === key ? 'is-lit' : undefined}
            onMouseEnter={() => { setLit(key); }} onMouseLeave={() => { setLit(null); }}><TokenSwatch color={tokenColor(palette, key)}/>{symbols.get(key) ?? key}</li>)}
          {hasOther ? <li className={lit === 'other' ? 'is-lit' : undefined} onMouseEnter={() => { setLit('other'); }} onMouseLeave={() => { setLit(null); }}>
            <TokenSwatch color={OTHER_COLOR}/>Other</li> : null}
          <li className="legend-note">Unpriced receipts are not drawn</li></ul>
          <div className="plot-canvas" ref={canvas}>
          <svg className={`attributed-chart${lit !== null ? ' has-lit' : ''}`} width={g.width} height={HEIGHT} viewBox={`0 0 ${g.width} ${HEIGHT}`} role="group"
            aria-label="UTC daily attributed receipt values by token on their own scale. Each day opens its payouts, and the arrow keys choose a token in it; exact values are in the attributed chart data table."
            onPointerMove={move} onPointerLeave={out}>
            <Scale ticks={ticks} width={g.width}/>
            {days.map(day => {
              const x = g.x(day.day); const height = day.currentUsd === null ? 0 : Number(day.currentUsd) / scaleTop * g.plotHeight;
              const receipts = buckets.get(day.day)?.receipts ?? 0;
              const base = MARGIN.top + g.plotHeight;
              return <g key={day.day} className={`chart-day${active?.day === day.day ? ' is-active' : ''}`} tabIndex={0} role="button"
                aria-label={`${day.day} UTC · ${report.attribution.label}: ${day.currentUsd === null ? 'no priced receipts' : usd(day.currentUsd)}; ${receipts} ${noun(receipts, 'receipt')}; ${day.unpricedCount} unpriced ${noun(day.unpricedCount, 'asset')}. Open to list this day's payouts.`}
                aria-expanded={active?.day === day.day} aria-controls={active?.day === day.day ? 'day-tooltip' : undefined}
                onPointerDown={event => { pointer.current = event.pointerType; }}
                onFocus={() => { if (!narrow && !current.current?.pinned) { cancel(); setActive({ day: day.day, pinned: false }); } }}
                onBlur={event => { if (!tooltip.current?.contains(event.relatedTarget)) { if (!current.current?.pinned) grace(); setLit(null); } }}
                onClick={() => { pin(day.day, null); }} onKeyDown={keys(day.day)}>
                <rect className="day-hit" x={x - g.slot / 2} y={MARGIN.top} width={g.slot} height={g.plotHeight}/>
                {day.currentUsd === null ? <rect className="unpriced-bar" x={x - g.bar / 2} y={base - 1} width={g.bar} height={1}/>
                  : stack(segmentsOf(day.day), base, height).map(({ segment, y, height: size }) => <rect key={segment.key} data-token={segment.key}
                    className={`bar-segment${lit === null ? '' : lit === segment.key ? ' is-lit' : ' is-dim'}`} x={x - g.bar / 2} y={y} width={g.bar} height={size} fill={segment.color}
                    onMouseEnter={() => { if (!active?.pinned) setLit(segment.key); }} onMouseLeave={() => { if (!active?.pinned) setLit(null); }}
                    onClick={event => { event.stopPropagation(); pin(day.day, segment.key); }}/>)}
              </g>;
            })}
            <DayAxis g={g} onDay={day => { open(day); }}/>
          </svg>
          {bucket && active && placement ? <div id="day-tooltip" ref={tooltip} role="dialog" aria-labelledby={`day-tooltip-title-${bucket.day}`}
            className={`day-tooltip${narrow ? ' is-sheet' : ` is-${placement.side}`}${active.pinned ? ' is-pinned' : ''}`}
            style={narrow ? undefined : { left: `${placement.left}px`, top: `${top}px`, width: `${placement.width}px`, maxHeight: `${placement.maxHeight}px` }}
            onMouseEnter={cancel} onMouseLeave={() => { if (!current.current?.pinned) grace(); }}
            onBlur={event => { if (!canvas.current?.contains(event.relatedTarget) && !current.current?.pinned) grace(); }}>
            <DayTooltip key={bucket.day} report={report} bucket={bucket} palette={palette} selected={lit} pinned={active.pinned} order={order} onOrder={setOrder}
              onToken={key => { open(bucket.day, key); }} onDay={() => { open(bucket.day); }} {...narrow ? { onClose: close } : {}}/></div> : null}
          <span className="sr-only" role="status">{selectedSegment && !selectedSegment.other
            ? `${selectedSegment.symbol}: ${percentText(selectedSegment.tenths)}, ${usd(selectedSegment.usd)}. Enter lists its payouts on ${bucket?.day ?? ''}.` : ''}</span>
          </div>
        </>}
    {days?.length ? <details className="chart-data"><summary>View exact attributed chart data</summary><table><thead><tr><th>UTC day</th><th>Current USD</th><th>Unpriced assets</th><th>By token</th></tr></thead>
      <tbody>{days.map(day => <tr key={day.day}><td>{day.day}</td><td>{usdExact(day.currentUsd)}</td><td>{day.unpricedCount}</td>
        <td className="token-split">{segmentsOf(day.day).map(segment => `${segment.other ? `Other (${segment.tokens})` : segment.symbol} ${percentText(segment.tenths)} ${usdExact(segment.usd)}`).join(' · ') || '—'}</td></tr>)}</tbody></table></details> : null}
  </div>;
}

/** The period's reward tokens as horizontal bars, highest USD first or, from the USD header, lowest first: the top twelve in
 * their daily-chart colors and Other, or every token after "Show all". Each row gives the ticker, which opens the token's payouts
 * highest USD first, its bar, USD, share of the period's priced total and receipts, with Copy CA. Unpriced tokens follow the bars,
 * marked unpriced and never drawn. Bar lengths are relative only: the exact figures are printed beside them. */
export function TokenRanking({ report, period, palette, onToken = () => undefined, order: initialOrder = 'descending', all: initialAll = false }: {
  report: DashboardReport; period: Period; palette: TokenPalette; onToken?: (key: string) => void; order?: SortDirection; all?: boolean;
}) {
  const [order, setOrder] = useState<SortDirection>(initialOrder);
  const [all, setAll] = useState(initialAll);
  const ranking = tokenRanking(report, period, palette, all);
  if (!ranking) return null;
  const rows = sortUsdRows(ranking.rows, order);
  const largest = Math.max(0, ...rows.map(row => Number(row.usd)));
  const next = order === 'descending' ? 'ascending' : 'descending';
  const ticker = (key: string, symbol: string) => <button type="button" className="ticker" onClick={() => { onToken(key); }}
    aria-label={`${symbol}: list its payouts, highest USD first`}>{symbol}</button>;
  const copy = (mint: string | null, symbol: string) => mint ? <CopyButton value={mint} label={`${symbol} contract address`} text="Copy CA"/> : <span className="muted">No mint address</span>;
  return <div className="token-ranking" role="group" aria-labelledby="token-ranking-title">
    <div className="plot-heading"><span className="eyebrow group-label">{report.attribution.label}</span>
      <h3 id="token-ranking-title">Tokens you were paid in <span className="muted">/ {periodLabel(period)} · {period.start} → {period.end}</span></h3>
      <p>Ranked by USD at current prices. A payout does not name the launch it came from, so this ranks reward tokens, not launches.</p></div>
    {ranking.tokens === 0 ? <p className="ranking-empty muted">No attributed receipts in this period.</p> : <>
      <div className="table-scroll ranking-scroll"><table className="ranking-table">
        <thead><tr><th>Token</th><th className="ranking-bar-cell"><span className="sr-only">Bar</span></th>
          <th className="numeric" aria-sort={order}><button type="button" className="sort" onClick={() => { setOrder(next); }}
            aria-label={`USD, ${order === 'descending' ? 'highest' : 'lowest'} first. Sort ${next === 'descending' ? 'highest' : 'lowest'} first`}>
            USD <span aria-hidden="true">{order === 'descending' ? '▼' : '▲'}</span></button></th>
          <th className="numeric">Share</th><th className="numeric">Receipts</th><th><span className="sr-only">Contract address</span></th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key} className={row.other ? 'ranking-other' : undefined} data-token={row.key}>
          <td className="ranking-token"><TokenSwatch color={row.color}/>{row.other ? <span>Other · {row.tokens.toLocaleString()} {noun(row.tokens, 'token')}</span> : ticker(row.key, row.symbol)}</td>
          {/* Relative length only: the exact figure is printed beside it. */}
          <td className="ranking-bar-cell" aria-hidden="true"><span className="ranking-bar"><i style={{ width: `${largest > 0 ? Math.max(0.5, Number(row.usd) / largest * 100) : 0}%`, background: row.color }}/></span></td>
          <td className="numeric ranking-usd">{usd(row.usd)}</td><td className="numeric ranking-share">{percentText(row.tenths)}</td>
          <td className="numeric ranking-receipts">{row.receipts.toLocaleString()} {noun(row.receipts, 'receipt')}</td>
          <td className="ranking-copy">{row.other ? null : copy(row.mintAddress, row.symbol)}</td></tr>)}</tbody>
        {ranking.unpriced.length ? <tbody className="ranking-unpriced" aria-label="Unpriced tokens">{ranking.unpriced.map(token => <tr key={token.key} data-token={token.key}>
          <td className="ranking-token">{ticker(token.key, token.symbol)}</td><td className="ranking-bar-cell"/>
          <td className="numeric ranking-usd"><span className="badge unpriced">UNPRICED</span></td><td className="numeric ranking-share muted">—</td>
          <td className="numeric ranking-receipts">{token.receipts.toLocaleString()} {noun(token.receipts, 'receipt')}</td>
          <td className="ranking-copy">{copy(token.mintAddress, token.symbol)}</td></tr>)}</tbody> : null}
      </table></div>
      {ranking.foldable ? <button type="button" className="ranking-all link-button" aria-expanded={all} onClick={() => { setAll(value => !value); }}>
        {all ? `Show the top ${TOKEN_COLORS.length} and Other` : `Show all ${ranking.tokens.toLocaleString()} tokens`}</button> : null}
      <p className="ranking-foot">{ranking.total === null ? 'No priced tokens in this period' : `Shares of ${usd(ranking.total)}, the period's priced total`} · unpriced tokens are never valued or drawn · a ticker opens its payouts, highest USD first</p>
    </>}
  </div>;
}

/** The verified group's own daily series, beneath the attributed one. Omitted entirely while verified has no rows. */
function VerifiedPlot({ report, period }: { report: DashboardReport; period: Period }) {
  const canvas = useRef<HTMLDivElement>(null);
  const width = useWidth(canvas);
  const g = geometry(width, period);
  const [cumulative, setCumulative] = useState(false);
  const days = chartDays(report, period);
  const priced = days.filter(day => day.currentUsd !== null);
  const ticks = chartTicks(Math.max(1, ...priced.map(day => Number(day.currentUsd)))); const scaleTop = ticks.at(-1)!;
  let sum = 0;
  const points = days.map(day => { sum += Number(day.currentUsd ?? 0); return { x: g.x(day.day), sum }; });
  const total = Math.max(1, sum);
  return <div className="verified-plot" role="group" aria-labelledby="verified-chart-title">
    <div className="plot-heading"><span className="eyebrow group-label">{report.verifiedTotals.label}</span><h3 id="verified-chart-title">Daily verified receipts <span className="muted">/ USD · own scale</span></h3><p>{report.verifiedTotals.explanation}</p></div>
    <div className="chart-legend"><span><i className="dot cyan"/>Confirmed, priced receipts</span><label><input type="checkbox" checked={cumulative} onChange={event => { setCumulative(event.target.checked); }}/> <i className="dot magenta"/>Cumulative (right scale)</label></div>
    {priced.length === 0 ? <div className="chart-empty"><div className="empty-bars" aria-hidden="true">◇</div><strong>{EMPTY_MESSAGE}</strong><p>{report.counts.unknown_candidate.toLocaleString()} unknown candidates remain separate from reward totals.</p></div> :
      <><div className="plot-canvas" ref={canvas}><svg className="reward-chart" width={g.width} height={HEIGHT} viewBox={`0 0 ${g.width} ${HEIGHT}`} role="img" aria-label="UTC daily confirmed reward values. Exact values are available in the chart data table.">
        <Scale ticks={ticks} width={g.width}/>
        {days.map(day => {
          const x = g.x(day.day); const height = day.currentUsd === null ? 0 : Number(day.currentUsd) / scaleTop * g.plotHeight;
          return <g key={day.day}><rect x={x - g.bar / 2} y={MARGIN.top + g.plotHeight - height} width={g.bar} height={Math.max(1, height)} className={day.currentUsd === null ? 'unpriced-bar' : 'reward-bar'}><title>{`${day.day} UTC: ${usd(day.currentUsd)}; ${day.unpricedCount} unpriced assets`}</title></rect></g>;
        })}
        <DayAxis g={g}/>
        {cumulative ? <><polyline className="cumulative-line" points={points.map(point => `${point.x},${MARGIN.top + g.plotHeight - point.sum / total * g.plotHeight}`).join(' ')}/><text x={g.width - MARGIN.right} y={MARGIN.top + 3} textAnchor="end">{sum.toLocaleString('en-US', { notation: 'compact' })}</text></> : null}
      </svg></div><details className="chart-data"><summary>View exact chart data</summary><table><thead><tr><th>UTC day</th><th>Current USD</th><th>Unpriced assets</th></tr></thead><tbody>{days.map(day => <tr key={day.day}><td>{day.day}</td><td>{usdExact(day.currentUsd)}</td><td>{day.unpricedCount}</td></tr>)}</tbody></table></details></>}
  </div>;
}

/** The period control: each fixed period, disabled with its reason until tracked history covers it; ALL; and a custom range of
 * two UTC days inside tracked history. A valid choice goes straight to the hash; an invalid range shows why and changes nothing.
 * A period that earlier history would enable opens Scan more on the batch holding its first day, when `onMore` is given. */
export function PeriodControl({ report, period, onPeriod, onMore = null }: {
  report: DashboardReport; period: Period; onPeriod: (params: Record<string, string>) => void; onMore?: ((focus: number) => void) | null;
}) {
  const tracked = trackedDays(report);
  const [draft, setDraft] = useState({ from: period.start, to: period.end });
  const [error, setError] = useState<string | null>(null);
  // The draft follows the applied period, however it changed: here, through Back, or through an edited link.
  const applied = `${period.id}|${period.start}|${period.end}`;
  const [seen, setSeen] = useState(applied);
  if (seen !== applied) { setSeen(applied); setDraft({ from: period.start, to: period.end }); setError(null); }
  const edit = (next: { from: string; to: string }) => {
    setDraft(next);
    const custom = customPeriod(report, next.from, next.to);
    setError(custom.error);
    if (custom.period) onPeriod(periodParams(custom.period));
  };
  return <div className="period-control">
    <div className="segments period-segments" role="group" aria-label="Period">
      {periodOptions(report).map(option => {
        // A period that earlier history would enable is not disabled when it can open Scan more: that is what it does.
        const more = option.reason === SCAN_MORE_REASON && onMore ? onMore : null;
        return <span key={option.id} className="period-option">
          <button type="button" className={more ? 'needs-more' : undefined} aria-pressed={period.id === option.id} aria-disabled={option.reason && !more ? true : undefined}
            aria-describedby={option.reason ? `period-reason-${option.id}` : undefined} onClick={() => {
              if (!option.reason) onPeriod({ period: option.id });
              else if (more) more(Math.max(HISTORY_FLOOR_TIME, dayNumber(option.period.start) * 86400));
            }}>{option.label}</button>
          {option.reason ? <span className="period-tip" role="tooltip" id={`period-reason-${option.id}`}>{option.reason}</span> : null}
        </span>;
      })}
      <span className="period-option"><button type="button" aria-pressed={period.id === 'custom'} onClick={() => { edit({ from: period.start, to: period.end }); }}>CUSTOM</button></span>
    </div>
    {period.id === 'custom' || error ? <div className="custom-range" role="group" aria-label="Custom UTC range">
      <label><span>From · UTC</span><input type="date" min={tracked.first} max={tracked.last} value={draft.from} aria-invalid={error ? true : undefined}
        onChange={event => { edit({ ...draft, from: event.target.value }); }}/></label>
      <label><span>To · UTC</span><input type="date" min={tracked.first} max={tracked.last} value={draft.to} aria-invalid={error ? true : undefined}
        onChange={event => { edit({ ...draft, to: event.target.value }); }}/></label>
      {error ? <p className="range-error" role="alert">{error}</p> : <p className="range-hint">Tracked history {tracked.first} → {tracked.last}</p>}
    </div> : null}
  </div>;
}

/** One panel for the selected period: the attributed figures and the period control lead, the attributed chart and the period's
 * token ranking follow, and verified comes last on its own scale, left out while it has no rows. The two groups are never stacked
 * or summed. */
export function Chart({ report, period = defaultPeriod(report), notice = null, palette, onPeriod = () => undefined, onDay = () => undefined, onTokenPayouts = () => undefined,
  onMore = null }: {
  report: DashboardReport; period?: Period; notice?: string | null; palette?: TokenPalette; onPeriod?: (params: Record<string, string>) => void;
  onDay?: (day: string, token?: string) => void; onTokenPayouts?: (token: string) => void; onMore?: ((focus: number) => void) | null;
}) {
  const colors = palette ?? tokenPalette(report, period);
  return <section className="panel chart-panel period-panel" aria-label="Reward summary">
    <div className="period-head"><PeriodHero report={report} period={period}/><PeriodControl report={report} period={period} onPeriod={onPeriod} onMore={onMore}/></div>
    {notice ? <p className="period-notice" role="status">{notice}</p> : null}
    <AttributedPlot report={report} period={period} palette={colors} onDay={onDay}/>
    <TokenRanking report={report} period={period} palette={colors} onToken={onTokenPayouts}/>
    {verifiedHidden(report) ? null : <VerifiedPlot report={report} period={period}/>}
    <div className="panel-foot">UTC calendar days · the first tracked day starts at tracking start and the last ends at the fixed cutoff · a day without a bar does not prove no payout · hover a day for its tokens, click or tap to pin it · a ticker opens its payouts that day</div>
  </section>;
}
