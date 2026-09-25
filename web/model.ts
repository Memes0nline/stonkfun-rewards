import type { DashboardReport } from '../src/web/view.js';
import type { DashboardJob } from '../src/web/service.js';
import type { ScanProgress } from '../src/scanner/progress.js';
import { EARLIER_BATCH_DAYS, earlierBatch, FIRST_SCAN_DAYS, firstScanStart, HISTORY_FLOOR, mergeRanges, RANGE_OVERLAP_SECONDS } from '../src/scanner/ranges.js';
export const EMPTY_MESSAGE = 'No confirmed priced rewards yet.';
export const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
export const noun = (count: number | null, word: string) => count === 1 ? word : `${word}s`;
export const utc = (value: number) => new Date(value * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
// USD strings have already been rounded by the exact-decimal report builder. Do not coerce quantities to Number.
const thousands = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A USD figure as the dashboard shows it: two decimals, rounded half up from the exact string, with thousands separators, and
 * "<$0.01" for a positive value under one cent. The evidence modal and the exact chart data tables keep full precision
 * through `usdExact`. */
export function usd(value: string | null | undefined) {
  if (value === null || value === undefined) return 'Unavailable';
  if (!DECIMAL.test(value)) return usdExact(value);
  const { coefficient, scale } = parseDecimal(value);
  const unit = 10n ** BigInt(Math.max(0, scale - 2));
  if (coefficient > 0n && coefficient < unit) return '<$0.01';
  const cents = scale <= 2 ? coefficient * 10n ** BigInt(2 - scale) : (coefficient * 2n + unit) / (2n * unit);
  const [whole, fraction] = decimalText(cents, 2).split('.');
  return `$${thousands(whole!)}.${fraction!}`;
}
/** A USD figure at the report's full precision, trailing zeros dropped past the cents, with thousands separators. */
export function usdExact(value: string | null | undefined) {
  if (value === null || value === undefined) return 'Unavailable';
  const [whole, fraction] = value.split('.');
  return `$${thousands(whole!)}${fraction ? `.${fraction.replace(/0+$/, '').padEnd(2, '0')}` : '.00'}`;
}
export type AttributionState = 'evaluated' | 'not_evaluated' | 'rechecking';
/** The only values the dashboard shows for an unevaluated attributed tier. Never 0. */
export const ATTRIBUTION_STATES = { not_evaluated: 'Not evaluated', rechecking: 'Rechecking' } as const;
export function attributionState(report: DashboardReport): AttributionState {
  if (report.attribution.evaluated) return 'evaluated';
  return report.attribution.recheckPending > 0 ? 'rechecking' : 'not_evaluated';
}
export function attributionStateDetail(report: DashboardReport) {
  const pending = report.attribution.recheckPending;
  return attributionState(report) === 'rechecking'
    ? `${pending.toLocaleString()} ${pending === 1 ? 'row awaits' : 'rows await'} an attribution recheck after new trust evidence. A running scan or local reclassification completes it.`
    : 'Saved rows predate classifier v3 or await an attribution recheck. Reclassify locally to evaluate the attributed tier.';
}
/** Attributed counts and USD: a state label instead of a number whenever the tier was not evaluated. */
export function attributedCount(report: DashboardReport, value: number | null) {
  const state = attributionState(report);
  if (state !== 'evaluated') return ATTRIBUTION_STATES[state];
  return value === null ? ATTRIBUTION_STATES.not_evaluated : value.toLocaleString();
}
export function attributedUsd(report: DashboardReport, value: string | null | undefined) {
  const state = attributionState(report);
  return state === 'evaluated' ? usd(value) : ATTRIBUTION_STATES[state];
}
export type TrustSource = keyof DashboardReport['attribution']['trustSources'];
export const TRUST_SOURCE_ORDER: readonly TrustSource[] = ['feed_witnessed_identity', 'published_withdraw_authority'];
/** Attributed rows carrying each trust source; a row with both sources appears under both. */
export function trustSourceRows(report: DashboardReport) {
  const counts = report.attribution.basisCounts;
  if (!counts) return [];
  const rows: Record<TrustSource, number> = { feed_witnessed_identity: counts.feed_witnessed_identity,
    published_withdraw_authority: counts.published_withdraw_authority + counts.withBothTrustSources };
  return TRUST_SOURCE_ORDER.filter(source => rows[source] > 0).map(source => ({ source, rows: rows[source] }));
}
const DECIMAL = /^\d+(?:\.\d+)?$/;
function parseDecimal(value: string) {
  if (!DECIMAL.test(value)) throw new Error('invalid_decimal');
  const [whole = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
function decimalText(coefficient: bigint, scale: number) {
  if (scale === 0) return coefficient.toString();
  const text = coefficient.toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}
/** Exact sum of two nonnegative decimal strings, such as the report's rounded USD figures. Never floating point. */
export function addDecimal(a: string, b: string) {
  const x = parseDecimal(a); const y = parseDecimal(b); const scale = Math.max(x.scale, y.scale);
  return decimalText(x.coefficient * 10n ** BigInt(scale - x.scale) + y.coefficient * 10n ** BigInt(scale - y.scale), scale);
}
/** A nonnegative decimal divided by a whole number of days, rounded half up to six places as the report rounds its average. */
export function divideDecimal(value: string, divisor: number, places = 6) {
  if (!Number.isSafeInteger(divisor) || divisor <= 0) throw new Error('invalid_divisor');
  const x = parseDecimal(value);
  const numerator = x.coefficient * 10n ** BigInt(places); const denominator = 10n ** BigInt(x.scale) * BigInt(divisor);
  return decimalText((numerator * 2n + denominator) / (2n * denominator), places);
}
/** A Unix time's UTC calendar day, YYYY-MM-DD. */
export const utcDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
/** Days since the Unix epoch of a YYYY-MM-DD UTC day, and back. */
export const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
export const dayText = (value: number) => new Date(value * 86_400_000).toISOString().slice(0, 10);
/** Whether a string names a real calendar day as YYYY-MM-DD. */
export const isCalendarDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayNumber(value)) && dayText(dayNumber(value)) === value;
/** The history floor as a time, as a day, and as the header's short date. */
export const HISTORY_FLOOR_TIME = HISTORY_FLOOR;
export const FLOOR_DAY = utcDay(HISTORY_FLOOR);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const floorDate = new Date(HISTORY_FLOOR * 1000);
export const FLOOR_SHORT = `${MONTHS[floorDate.getUTCMonth()]!} ${floorDate.getUTCDate()}`;
export const FIRST_SCAN_NOTE = `The first scan covers the last ${FIRST_SCAN_DAYS} days. Older history loads afterwards in ${EARLIER_BATCH_DAYS}-day batches.`;
export type LoadedHistory = DashboardReport['history'];
/** Whole or part days of `range` inside the saved coverage: the days an interrupted Load earlier batch already holds. */
function savedDaysIn(range: { startTime: number; endTime: number }, completed: readonly { startTime: number; endTime: number }[]) {
  const seconds = completed.reduce((sum, item) => sum + Math.max(0, Math.min(item.endTime, range.endTime) - Math.max(item.startTime, range.startTime)), 0);
  return Math.min(Math.ceil((range.endTime - range.startTime) / 86400), Math.ceil(seconds / 86400));
}
/** What the header and Scan more say about loaded history: the loaded range from its oldest day, or the full history at the floor.
 * The days left, and a batch an interruption left partly saved, are in Scan more. */
export function historyStatus(report: Pick<DashboardReport, 'history'>) {
  const { history } = report;
  return { loaded: history.earlierRemaining ? `Loaded ${history.oldestLoadedDay} → today` : `Full history since ${FLOOR_DAY}` };
}
/** A UTC span as the scan text prints it: its first day through the day of its last second, or, under a day, both times to
 * the minute. Callers add UTC where the line needs it. */
export function spanText(span: { startTime: number; endTime: number }) {
  const minute = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return span.endTime - span.startTime < 86400 ? `${minute(span.startTime)} → ${minute(span.endTime)}`
    : `${utcDay(span.startTime)} → ${utcDay(span.endTime - 1)}`;
}
type SpanJob = Pick<DashboardJob, 'ranges' | 'batch'> & Partial<Pick<DashboardJob, 'kind'>>;
/** The time a job reads that no earlier scan saved: its planned ranges joined where they meet, each without the minute it
 * rereads inside saved coverage. A piece starting at its batch's start, or at the oldest loaded day (`loadedFrom`), rereads
 * nothing; with neither known, nothing is taken off. A rescan reads its chosen days whole. */
export function newSpans(job: SpanJob, loadedFrom: number | null) {
  if (job.kind === 'check') return mergeRanges(job.ranges.map(range => ({ startTime: range.startTime, endTime: range.endTime })));
  const start = job.batch?.startTime ?? loadedFrom;
  return mergeRanges(job.ranges.map(range => ({ startTime: range.startTime, endTime: range.endTime })))
    .map(piece => start === null || piece.startTime <= start ? piece : { startTime: Math.min(piece.endTime, piece.startTime + RANGE_OVERLAP_SECONDS), endTime: piece.endTime })
    .filter(piece => piece.endTime > piece.startTime);
}
/** The one span a job's text names: from its first new second to its last; its planned ranges when nothing is new, as when a
 * refresh at the same cutoff only rereads its last minute. Null for a job with no planned range. */
export function jobSpan(job: SpanJob, loadedFrom: number | null) {
  const pieces = newSpans(job, loadedFrom);
  const source = pieces.length ? pieces : job.ranges;
  return source.length ? { startTime: Math.min(...source.map(item => item.startTime)), endTime: Math.max(...source.map(item => item.endTime)) } : null;
}
/** The idle Check latest data button's second line: from the earliest gap in the loaded range, or else the last cutoff, to now. */
export const refreshRangeText = (report: Pick<DashboardReport, 'cutoff' | 'coverage'>) =>
  `Checks ${utc(Math.min(report.cutoff, ...report.coverage.gaps.map(gap => gap.startTime)))} → now`;
/** The idle Scan wallet button's second line: the first scan's first day, seven days before now unless the floor clips it, to
 * today. No day count: the first scan's seven days reach into an eighth calendar day. */
export const firstScanRangeText = (nowSeconds: number) => `Scans ${utcDay(firstScanStart(Math.floor(nowSeconds)))} → today`;
/** The running primary button's second line: the span its job reads. */
export function runningRangeText(job: SpanJob, loadedFrom: number | null) {
  const span = jobSpan(job, loadedFrom);
  return span ? `Scanning ${spanText(span)}` : null;
}
/** The day a running job is on: its earliest day not saved yet, which the history phase reads in order. Null when it is not
 * running here or every day is saved. */
export function currentDay(job: SpanJob & Pick<DashboardJob, 'runningLocally'>, loadedFrom: number | null) {
  if (!job.runningLocally) return null;
  // A day whose check still disagreed stays pending but is done for this run.
  const next = [...job.ranges].sort((a, b) => a.startTime - b.startTime).find(range => range.status !== 'complete' && !range.check);
  return next ? utcDay(Math.max(next.startTime, jobSpan(job, loadedFrom)?.startTime ?? next.startTime)) : null;
}
/** The header status chip: WORKING with the day being read while the job runs here, otherwise its state. */
export function workingText(job: DashboardJob | null, loadedFrom: number | null) {
  const day = job ? currentDay(job, loadedFrom) : null;
  return day ? `WORKING · ${day}` : jobStateText(job);
}
/** The scan dialog's top line while the job has not finished. */
export function readingText(job: SpanJob, loadedFrom: number | null) {
  const span = jobSpan(job, loadedFrom);
  return span ? `Reading ${spanText(span)} UTC` : null;
}
/** The day being read, if any, and the days saved of those planned. */
export function daysDoneText(job: SpanJob & Pick<DashboardJob, 'runningLocally' | 'savedDays'>, loadedFrom: number | null) {
  const day = currentDay(job, loadedFrom);
  const done = `${job.savedDays.completed.toLocaleString()} of ${job.savedDays.planned.toLocaleString()} ${noun(job.savedDays.planned, 'day')} done`;
  return day ? `Now reading ${day} · ${done}` : done;
}
/** Attributed payouts inside the time a finished job read new, from a report read after it finished; null until that report is
 * in view, or while the tier is not evaluated. A whole UTC day counts from its day bucket, which covers every receipt; a part
 * day counts the listed receipts inside it. Verified receipts are never added to attributed ones. */
export function newPayouts(job: SpanJob & Pick<DashboardJob, 'wallet' | 'cutoff' | 'kind'>, report: DashboardReport | null) {
  if (!report || report.wallet !== job.wallet || attributionState(report) !== 'evaluated') return null;
  const current = job.kind === 'earlier' ? job.batch !== null && report.history.loadedFrom <= job.batch.startTime : report.cutoff >= job.cutoff;
  if (!current) return null;
  const buckets = new Map((report.attribution.dayTokens ?? []).map(bucket => [bucket.day, bucket.receipts]));
  const receipts = report.attribution.receipts ?? [];
  let count = 0;
  for (const piece of newSpans(job, report.history.loadedFrom)) {
    for (let day = Math.floor(piece.startTime / 86400); day * 86400 < piece.endTime; day++) {
      const from = Math.max(piece.startTime, day * 86400); const to = Math.min(piece.endTime, (day + 1) * 86400);
      count += from === day * 86400 && to === (day + 1) * 86400 ? buckets.get(dayText(day)) ?? 0
        : receipts.filter(receipt => receipt.time !== null && receipt.time >= from && receipt.time < to).length;
    }
  }
  return count;
}
/** The scan dialog's top line once the job has finished, with its new payouts once the report after it is in view. A rescan
 * says what its checks found instead. */
export function doneText(job: SpanJob & Pick<DashboardJob, 'wallet' | 'cutoff' | 'kind'> & Partial<Pick<DashboardJob, 'check' | 'checkResult'>>, report: DashboardReport | null) {
  if (job.kind === 'check') return rescanDoneText(job);
  const span = jobSpan(job, report?.wallet === job.wallet ? report.history.loadedFrom : null);
  if (!span) return null;
  const count = newPayouts(job, report);
  return `Done: ${spanText(span)}${count === null ? '' : ` · ${count.toLocaleString()} new ${noun(count, 'payout')}`}`;
}
export type HistoryStatus = ReturnType<typeof historyStatus>;
/** A run time as "45 s", "2 min 10 s" or "1 h 5 min". */
export function runTimeText(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) return `${Math.floor(whole / 60)} min${whole % 60 ? ` ${whole % 60} s` : ''}`;
  return `${Math.floor(whole / 3600)} h${Math.floor(whole % 3600 / 60) ? ` ${Math.floor(whole % 3600 / 60)} min` : ''}`;
}
/** A batch's UTC days, its first through the day of its last second, with its day count. */
export function batchLabel(batch: { startTime: number; endTime: number }) {
  const days = Math.ceil((batch.endTime - batch.startTime) / 86400);
  return `Loading ${utcDay(batch.startTime)} → ${utcDay(batch.endTime - 1)} (${days} ${noun(days, 'day')})`;
}
/** How long a Load earlier batch usually takes: the last completed batch's days and run time, or a plain estimate before any. */
export const batchTimeText = (history: LoadedHistory | null | undefined) => history?.lastBatch?.kind === 'earlier'
  ? `Last batch: ${history.lastBatch.days} ${noun(history.lastBatch.days, 'day')} in ${runTimeText(history.lastBatch.elapsedSeconds)}` : 'Usually a few minutes.';
/** The period control's reason for a period that loading earlier history would make available; the period then opens Scan more. */
export const SCAN_MORE_REASON = 'Scan more to enable';
/** A job planning the whole first-scan range, seven days before its cutoff or from the floor, in one run: a new wallet's first scan. */
export function isFirstScan(job: Pick<DashboardJob, 'cutoff' | 'ranges'>) {
  const ranges = [...job.ranges].sort((a, b) => a.startTime - b.startTime);
  return ranges.length > 0 && ranges[0]!.startTime === firstScanStart(job.cutoff) && ranges.at(-1)!.endTime === job.cutoff
    && ranges.every((range, index) => index === 0 || range.startTime === ranges[index - 1]!.endTime);
}
/** The range the Coverage tab measures: the loaded range, from the oldest loaded day to the fixed cutoff. Days before it are not
 * loaded yet, and nothing before the floor is a gap. */
export const coverageTarget = (report: Pick<DashboardReport, 'cutoff' | 'trackingStart'>) => ({ startTime: Math.max(HISTORY_FLOOR, report.trackingStart), endTime: report.cutoff });
/** The UTC calendar days a report tracks: tracking start's day through the day of the last second before the fixed cutoff.
 * The first can begin mid-day and the last ends at the cutoff. */
export function trackedDays(report: DashboardReport) {
  const first = utcDay(report.trackingStart); const last = utcDay(Math.max(report.trackingStart, report.cutoff - 1));
  return { first, last, count: dayNumber(last) - dayNumber(first) + 1 };
}
export const FIXED_PERIODS = [{ id: '7d', label: '7D', days: 7 }, { id: '14d', label: '14D', days: 14 }, { id: '30d', label: '30D', days: 30 },
  { id: '60d', label: '60D', days: 60 }, { id: '90d', label: '90D', days: 90 }] as const;
export type PeriodId = typeof FIXED_PERIODS[number]['id'] | 'all' | 'custom';
/** Whole UTC calendar days, `start` through `end` inclusive. */
export interface Period { id: PeriodId; start: string; end: string; days: number }
const span = (id: PeriodId, start: string, end: string): Period => ({ id, start, end, days: dayNumber(end) - dayNumber(start) + 1 });
export interface PeriodOption { id: PeriodId; label: string; period: Period; reason: string | null }
/** The fixed periods end on the cutoff's UTC day. Each is offered once tracked history covers all its days, and until then
 * carries the reason it is disabled: Scan more when the days back to the floor would cover it, otherwise the days it needs.
 * ALL, from the first tracked day, always is. */
export function periodOptions(report: DashboardReport): PeriodOption[] {
  const tracked = trackedDays(report);
  const reachable = report.history.earlierRemaining ? dayNumber(tracked.last) - dayNumber(FLOOR_DAY) + 1 : tracked.count;
  return [...FIXED_PERIODS.map(item => ({ id: item.id, label: item.label, period: span(item.id, dayText(dayNumber(tracked.last) - item.days + 1), tracked.last),
    reason: item.days <= tracked.count ? null : item.days <= reachable ? SCAN_MORE_REASON : `needs ${item.days} days of tracked history` })),
  { id: 'all', label: 'ALL', period: span('all', tracked.first, tracked.last), reason: null }];
}
/** A custom range names two real UTC days inside tracked history, the first on or before the second. */
export function customPeriod(report: DashboardReport, from: string, to: string): { period: Period; error: null } | { period: null; error: string } {
  const tracked = trackedDays(report);
  if (!isCalendarDay(from) || !isCalendarDay(to)) return { period: null, error: 'Enter both days as real UTC dates.' };
  if (from > to) return { period: null, error: 'The start must be on or before the end.' };
  if (from < tracked.first || to > tracked.last) return { period: null, error: `Choose days within tracked history, ${tracked.first} → ${tracked.last}.` };
  return { period: span('custom', from, to), error: null };
}
export const periodLabel = (period: Period) => period.id === 'custom' ? 'Custom' : period.id === 'all' ? 'ALL' : period.id.toUpperCase();
/** 7D while tracked history covers it, otherwise ALL. */
export function defaultPeriod(report: DashboardReport) {
  const options = periodOptions(report);
  return (options[0]!.reason === null ? options[0]! : options.at(-1)!).period;
}
/** The period the hash names when tracked history allows it; otherwise the default, with why the request was set aside. */
export function resolvePeriod(report: DashboardReport, params: Readonly<Record<string, string>>): { period: Period; notice: string | null } {
  const fallback = defaultPeriod(report);
  if (!params.period) return { period: fallback, notice: null };
  if (params.period === 'custom') {
    const custom = customPeriod(report, params.from ?? '', params.to ?? '');
    return custom.period ? { period: custom.period, notice: null } : { period: fallback, notice: `Custom range set aside: ${custom.error} Showing ${periodLabel(fallback)}.` };
  }
  const option = periodOptions(report).find(item => item.id === params.period);
  if (option && option.reason === null) return { period: option.period, notice: null };
  const reason = option?.reason === SCAN_MORE_REASON ? 'needs earlier history; Scan more to enable it' : option?.reason ?? 'is not available';
  return { period: fallback, notice: `${option?.label ?? 'That period'} ${reason}; showing ${periodLabel(fallback)}.` };
}
/** A period's hash parameters: its id, and for a custom range its first and last day. */
export const periodParams = (period: Period): Record<string, string> => period.id === 'custom' ? { period: 'custom', from: period.start, to: period.end } : { period: period.id };
/** The exact UTC date range under the period figure. */
export const periodCaption = (period: Period) => `${period.start} → ${period.end} · ${period.days.toLocaleString()} ${noun(period.days, 'day')}`;
const inPeriod = <T extends { day: string }>(days: readonly T[], period: Period) => days.filter(day => day.day >= period.start && day.day <= period.end);
/** The attributed figures for a period: exact decimal sums of the report's UTC day buckets inside it. Unpriced receipts are never
 * valued; they are counted apart. The daily average divides by every calendar day of the period, active or not. Null, never zero,
 * while the tier is not evaluated. */
export function periodSummary(report: DashboardReport, period: Period) {
  const buckets = attributionState(report) === 'evaluated' ? report.attribution.dayTokens : null;
  if (!buckets) return null;
  const inside = inPeriod(buckets, period);
  const priced = inside.flatMap(bucket => bucket.currentUsd === null ? [] : [bucket.currentUsd]);
  const usd = priced.length ? priced.reduce(addDecimal) : null;
  const unpriced = inside.flatMap(bucket => bucket.tokens.filter(token => token.currentUsd === null));
  return { usd, averageUsd: usd === null ? null : divideDecimal(usd, period.days), receipts: inside.reduce((sum, bucket) => sum + bucket.receipts, 0),
    tokens: new Set(inside.flatMap(bucket => bucket.tokens.map(token => token.key))).size,
    unpricedReceipts: unpriced.reduce((sum, token) => sum + token.receipts, 0), unpricedTokens: new Set(unpriced.map(token => token.key)).size,
    activeDays: inside.length };
}
export type PeriodSummary = NonNullable<ReturnType<typeof periodSummary>>;
/** How long before the cutoff a saved price was taken: whole hours under two days, then days to one place. */
export const ageText = (seconds: number) => seconds < 172_800 ? `${Math.floor(seconds / 3600).toLocaleString()} h` : `${(seconds / 86400).toFixed(1)} d`;
/** "stale · <age>" for a price the report flags stale, otherwise null. */
export const staleText = (price: { priceStale: boolean | null; priceAgeSeconds: number | null }) =>
  price.priceStale ? `stale · ${price.priceAgeSeconds === null ? 'unknown age' : ageText(price.priceAgeSeconds)}` : null;
/** A saved price's time as the dashboard prints times. */
export const priceTimeText = (priceAt: string) => utc(Date.parse(priceAt) / 1000);
/** The saved prices behind a period's figures: the oldest and newest price times among its priced tokens, and each token whose
 * price the report flags stale, oldest price first. Null while the tier is not evaluated. */
export function periodPrices(report: DashboardReport, period: Period) {
  if (attributionState(report) !== 'evaluated') return null;
  const tokens = new Map<string, DayBucket['tokens'][number]>();
  for (const bucket of inPeriod(report.attribution.dayTokens ?? [], period)) for (const token of bucket.tokens) if (token.priceAt !== null) tokens.set(token.key, token);
  const times = [...tokens.values()].map(token => token.priceAt!).sort();
  const stale = [...tokens.values()].filter(token => token.priceStale === true)
    .sort((a, b) => (b.priceAgeSeconds ?? Infinity) - (a.priceAgeSeconds ?? Infinity) || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
  return { oldest: times[0] ?? null, newest: times.at(-1) ?? null, stale };
}
export function chartDays(report: DashboardReport, period: Period) { return inPeriod(report.utcDays, period); }
/** A daily chart's left scale: round steps from zero, each 1, 2, 2.5, 4 or 5 times a power of ten, the smallest step that reaches
 * `maximum` in at most `steps` of them, so a $1,500 day gives 0, 400, 800, 1.2K, 1.6K. The last tick is the scale's full height.
 * Geometry only: the exact values are in each chart's data table. */
export function chartTicks(maximum: number, steps = 4) {
  if (!(maximum > 0) || !Number.isFinite(maximum)) return [0, 1];
  const raw = maximum / steps;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 4, 5, 10].map(multiple => multiple * magnitude).find(value => value >= raw * (1 - 1e-9))!;
  const count = Math.max(1, Math.ceil(maximum / step - 1e-9));
  return Array.from({ length: count + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}
/** A scale label: compact, such as 400, 1.2K or 0.25. */
export const tickText = (value: number) => value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
/** The verified group is left out, chart and token table, while it has no rows and no token to list; any verified row, priced or
 * not, shows it, because token units are never shown as zero. */
export const verifiedHidden = (report: DashboardReport) => report.counts.confirmed === 0 && report.assets.length === 0;
/** The attributed group's own daily buckets in a period; null (never an empty zero series) until the tier is evaluated. */
export function attributedChartDays(report: DashboardReport, period: Period) {
  const days = report.attribution.utcDays;
  return attributionState(report) === 'evaluated' && days !== null ? inPeriod(days, period) : null;
}
/** The dashboard's tabs, in order. The hash carries the active tab and its filters, so refresh and links keep them. */
export const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'tokens', label: 'Tokens' }, { id: 'payouts', label: 'Payouts' },
  { id: 'trust', label: 'Trust' }, { id: 'coverage', label: 'Coverage' }] as const;
export type TabId = typeof TABS[number]['id'];
export interface Route { tab: TabId; params: Record<string, string> }
// Only these parameters survive parsing, and only with well-formed values.
const ROUTE_PARAMS: Record<string, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/, token: /^[A-Za-z0-9-]{1,64}:\d{1,3}$/, trust: /^(feed_witnessed_identity|published_withdraw_authority)$/,
  price: /^(priced|unpriced)$/, period: /^(7d|14d|30d|60d|90d|all|custom)$/, from: /^\d{4}-\d{2}-\d{2}$/, to: /^\d{4}-\d{2}-\d{2}$/,
  sort: /^(date|usd)-(asc|desc)$/,
};
/** The overview's period parameters, the only ones it keeps. */
export const PERIOD_PARAMS = ['period', 'from', 'to'] as const;
/** `#tab` or `#tab?key=value&…`. An empty or unknown hash reads as the overview; unknown or malformed parameters are dropped. */
export function parseRoute(hash: string): Route {
  const text = hash.replace(/^#/, '');
  const split = text.indexOf('?');
  const path = split < 0 ? text : text.slice(0, split);
  const tab = TABS.find(item => item.id === path)?.id ?? 'overview';
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(split < 0 ? '' : text.slice(split + 1))) {
    if (ROUTE_PARAMS[key]?.test(value)) params[key] = value;
  }
  return { tab, params };
}
export function routeHash(route: Route) {
  const query = new URLSearchParams(Object.entries(route.params).filter(([key, value]) => ROUTE_PARAMS[key]?.test(value))).toString();
  return `#${route.tab}${query ? `?${query}` : ''}`;
}
/** One plain line for every reason code the projection accepts. Dashboard wording for a code, never a report group label. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  missing_official_distribution: 'No official StonkFun distribution record names this transaction.',
  missing_transaction: 'An official record names a transaction that is not retained here.',
  failed_transaction: 'The transaction failed on chain, so nothing was paid.',
  conflicting_feed_rows: 'Official distribution records disagree about this transaction.',
  feed_provenance_unresolved: 'The retrieval behind the official record could not be confirmed.',
  conflicting_transaction_evidence: 'Retained copies of this transaction disagree.',
  conflicting_identity_evidence: 'Retained observations of this credit disagree.',
  missing_transfer_observation: 'A credit seen in one retained copy is missing from another.',
  no_supported_transfers: 'The transaction has no token transfer the scanner supports.',
  unresolved_normalization: 'Some token activity in the transaction could not be normalized.',
  uninterpreted_activity: 'The transaction runs instructions the scanner does not interpret.',
  unexplained_native_movement: 'SOL moved in a way the payout structure does not explain.',
  mint_mismatch: 'The official record names a different token than the transfer.',
  amount_mismatch: 'The official record\'s amount does not match the transfer.',
  feed_fee_semantics_unresolved: 'A token transfer fee leaves the official amount\'s meaning unresolved.',
  unproven_net_credit: 'The recipient\'s net credit could not be proven from balances.',
  ambiguous_attribution: 'Senders and recipients overlap, or one token arrives from several origins.',
  recipient_participation: 'The recipient signed the transaction.',
  unsupported_authority_pattern: 'The transfer authority did not sign in a supported way.',
  conflicting_evidence_quarantined: 'Conflicting evidence holds this transaction in quarantine.',
  self_or_outgoing_transfer: 'The wallet sent these tokens itself, or they stayed in one account.',
  wallet_participation: 'The wallet signed the transaction, so it took part rather than only receiving.',
  recipient_ownership_unresolved: 'The receiving account could not be shown to belong to this wallet.',
  positive_credit_unproven: 'A positive net credit to the wallet could not be proven.',
  reward_quote_unverified: 'The credited token has no retained StonkFun reward-quote record.',
  timestamp_missing: 'The transaction has no block time.',
  payout_origin_unverified: 'No confirmation basis established who paid this credit.',
  ordering_unavailable: 'Same-slot confirmation needs transaction ordering the provider did not supply.',
  no_supported_credit: 'No supported credit to the wallet, as recorded before the current classifier.',
  authority_recheck_pending: 'Waiting for a recheck after new authority evidence.',
  support_recheck_pending: 'Waiting for a recheck after its supporting evidence changed.',
  attribution_recheck_pending: 'Waiting for an attribution recheck after new trust evidence.',
  distributor_credit_unreconciled: 'The credit is not exact, or a transferred token is not a registered reward quote.',
  distributor_trust_unestablished: 'The sender is neither a feed-witnessed distributor nor the published withdraw authority.',
  distributor_source_not_ata: 'The tokens did not leave the sender\'s own derived token account.',
  distributor_signer_shape_unsupported: 'The sender did not sign alone, apart from a separate fee payer.',
  wallet_in_account_keys: 'The wallet\'s own address appears among the transaction\'s accounts.',
  distributor_identity_conflicted: 'An official record contradicts this sender, or one of its witnesses is contested.',
  distributor_attribution_revoked: 'A local revocation covers this sender at the credit\'s time.',
  published_authority_rotation_ambiguous: 'Published snapshots around this credit name different authorities.',
  published_authority_snapshot_pending: 'No published snapshot taken after this credit exists yet.',
  distributor_native_source_unsupported: 'The SOL did not come from the sender\'s own system account.',
  native_credit_from_distributor_unproven: 'A trusted distributor sent SOL, but not every native-SOL check passed.',
  no_token_credit_to_wallet: 'No token moved into or out of this wallet in the transaction.',
  zero_value_token_credit: 'The transaction only created an empty token account for the wallet.',
  credit_without_supported_transfer_instruction: 'Tokens arrived without a supported transfer, chiefly minted supply.',
};
export const reasonLabel = (reason: string) => reason.replaceAll('_', ' ');
export const lastSyncText = (report: DashboardReport) => report.lastSync ? utc(Date.parse(report.lastSync) / 1000) : 'Not completed';
/** The local server's own state, from /api/v1/health. */
export interface Health { providerConfigured: boolean; configurationChecked: boolean; offline: boolean; activeWallets: string[] }
/** The header status control's state word: the job's status, WORKING while it runs here, or NO SCAN. */
export const jobStateText = (job: DashboardJob | null) => job ? (job.runningLocally ? 'WORKING' : job.status.toUpperCase()) : 'NO SCAN';
export const modeText = (health: Health | null) => health?.offline ? 'Offline viewing · saved data only · scans disabled' : 'Local · read only';
export const providerText = (health: Health | null) => `${health?.providerConfigured ? 'Configured' : 'Not configured'}${health?.configurationChecked ? '' : ' · checked only when scanning'}`;
/** Requests the job made against each of its limits. */
export const budgetRows = (job: DashboardJob) => [
  { label: 'StonkFun requests', used: job.used.stonkfun, limit: job.limits.stonkfun },
  { label: 'Helius requests', used: job.used.helius, limit: job.limits.helius },
  { label: 'History pages', used: job.used.pages, limit: job.limits.pages },
];
/** Exact order of two nonnegative decimal strings. Quantities and USD never pass through Number to be compared. */
export function compareDecimal(a: string, b: string) {
  const [aWhole = '0', aFraction = ''] = a.split('.'); const [bWhole = '0', bFraction = ''] = b.split('.');
  const left = aWhole.replace(/^0+(?=\d)/, ''); const right = bWhole.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left !== right) return left < right ? -1 : 1;
  const places = Math.max(aFraction.length, bFraction.length);
  const x = aFraction.padEnd(places, '0'); const y = bFraction.padEnd(places, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}
/** Highest USD first; unpriced (null) after every priced value, in either direction. */
export const byUsd = (a: string | null, b: string | null) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : compareDecimal(b, a);
export const assetKey = (asset: { mint: string; decimals: number }) => `${asset.mint}:${asset.decimals}`;
export const tokenSymbol = (symbol: string | null) => symbol === null ? '$TOKEN' : symbol.startsWith('$') ? symbol : `$${symbol}`;
export type DayBucket = NonNullable<DashboardReport['attribution']['dayTokens']>[number];
/** Twelve categorical token colors in a fixed order, validated as one set for this dark chart surface (#0b131b): every slot in
 * the OKLCH lightness band 0.48–0.67 with chroma of at least 0.10 and 3:1 contrast, and every adjacent pair at least 8 apart
 * under protanopia and deuteranopia and 15 apart under normal vision (OKLab ΔE ×100). The first eight are the validated dark
 * set; slots nine to twelve (cyan, brown, fuchsia, olive) extend it with the same checks. A thirteenth token is never a new
 * hue: it joins Other. */
export const TOKEN_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767',
  '#08a4bd', '#945701', '#a519cb', '#838503'] as const;
export const OTHER_COLOR = '#6b7885';
export interface TokenPalette { keys: readonly string[]; colors: ReadonlyMap<string, string> }
export const EMPTY_PALETTE: TokenPalette = { keys: [], colors: new Map() };
/** The period's twelve tokens with the highest priced USD, highest first, each with its color; every other token is Other.
 * The same period always gives the same colors, on every tab. */
export function tokenPalette(report: DashboardReport, period: Period): TokenPalette {
  const buckets = attributionState(report) === 'evaluated' ? inPeriod(report.attribution.dayTokens ?? [], period) : [];
  const totals = new Map<string, { usd: string; symbol: string }>();
  for (const token of buckets.flatMap(bucket => bucket.tokens)) {
    if (token.currentUsd === null) continue;
    const prior = totals.get(token.key);
    totals.set(token.key, { usd: prior ? addDecimal(prior.usd, token.currentUsd) : token.currentUsd, symbol: token.symbol });
  }
  const keys = [...totals].sort(([a, x], [b, y]) => compareDecimal(y.usd, x.usd) || x.symbol.localeCompare(y.symbol) || a.localeCompare(b))
    .slice(0, TOKEN_COLORS.length).map(([key]) => key);
  return { keys, colors: new Map(keys.map((key, index) => [key, TOKEN_COLORS[index]!])) };
}
export const tokenColor = (palette: TokenPalette, key: string) => palette.colors.get(key) ?? OTHER_COLOR;
export interface Segment {
  key: string; symbol: string; color: string; usd: string; amount: string | null; receipts: number; tokens: number; other: boolean; tenths: number;
  /** The token's full mint for Copy CA; null for Other and for the native-SOL sentinel, which is not an address. */
  mintAddress: string | null;
}
/** One day's priced USD split by token: the palette's tokens in palette order from the baseline, then one Other segment for
 * every other priced token, whose value is the day total less the named segments so the stack ends exactly at the day's
 * total. `tenths` are shares of the stack in tenths of a percent, rounded by largest remainder so they sum to exactly 1000.
 * `others` lists Other's tokens, highest USD first, their shares apportioned the same way to sum exactly to Other's.
 * Unpriced receipts are not drawn; they are counted apart. */
export function daySegments(bucket: DayBucket, palette: TokenPalette) {
  const priced = bucket.tokens.filter(token => token.currentUsd !== null);
  const named = palette.keys.flatMap(key => priced.filter(token => token.key === key));
  const rest = priced.filter(token => !palette.colors.has(token.key))
    .sort((a, b) => compareDecimal(b.currentUsd!, a.currentUsd!) || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
  const part = (token: DayBucket['tokens'][number], color: string): Omit<Segment, 'tenths'> => ({ key: token.key, symbol: tokenSymbol(token.symbol), color,
    usd: token.currentUsd!, amount: token.amount, receipts: token.receipts, tokens: 1, other: false, mintAddress: isAddress(token.mintAddress) ? token.mintAddress : null });
  const parts = named.map(token => part(token, tokenColor(palette, token.key)));
  if (rest.length) {
    const namedSum = parts.reduce((sum, item) => addDecimal(sum, item.usd), '0');
    const remainder = bucket.currentUsd !== null ? subtractDecimal(bucket.currentUsd, namedSum) : null;
    parts.push({ key: 'other', symbol: 'Other', color: OTHER_COLOR, usd: remainder ?? rest.reduce((sum, token) => addDecimal(sum, token.currentUsd!), '0'),
      amount: null, receipts: rest.reduce((sum, token) => sum + token.receipts, 0), tokens: rest.length, other: true, mintAddress: null });
  }
  const segments = withTenths(parts, 1000);
  const otherTenths = segments.find(segment => segment.other)?.tenths ?? 0;
  const unpriced = bucket.tokens.filter(token => token.currentUsd === null);
  return { segments, others: withTenths(rest.map(token => part(token, OTHER_COLOR)), otherTenths),
    unpriced: { receipts: unpriced.reduce((sum, token) => sum + token.receipts, 0), tokens: unpriced.length } };
}
/** Largest-remainder apportionment of `units` tenths of a percent over the parts' USD, so they sum to exactly `units`. */
function withTenths(parts: Omit<Segment, 'tenths'>[], units: number): Segment[] {
  const scale = Math.max(0, ...parts.map(part => parseDecimal(part.usd).scale));
  const values = parts.map(part => { const { coefficient, scale: own } = parseDecimal(part.usd); return coefficient * 10n ** BigInt(scale - own); });
  const total = values.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return parts.map(part => ({ ...part, tenths: 0 }));
  const whole = BigInt(units);
  const floors = values.map(value => value * whole / total);
  const remainders = values.map((value, index) => ({ index, remainder: value * whole - floors[index]! * total }));
  let missing = whole - floors.reduce((sum, value) => sum + value, 0n);
  for (const { index } of [...remainders].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))) {
    if (missing <= 0n) break;
    floors[index]!++; missing--;
  }
  return parts.map((part, index) => ({ ...part, tenths: Number(floors[index]!) }));
}
export const percentText = (tenths: number) => `${(tenths / 10).toFixed(1)}%`;
/** An unpriced token in a period: listed apart with its receipts, never ranked, valued or drawn. */
export interface UnpricedToken { key: string; symbol: string; receipts: number; mintAddress: string | null }
/** A period's reward tokens ranked by priced USD, from the report's own day buckets: a token's USD is the exact sum of its day
 * values in the period, and its receipts are counted the same way. Priced tokens rank highest first, equal USD by symbol and
 * then key, the order that assigns the palette, so each keeps its daily-chart color. By default the top twelve are listed and
 * every other priced token folds into one Other row; `all` lists every priced token, those past the twelfth in Other's gray.
 * Shares are tenths of a percent of the listed rows' USD, the period's priced total, apportioned by largest remainder to sum to
 * exactly 1000. Unpriced tokens are listed apart, most receipts first. A payout never names its launch, so this ranks reward
 * tokens, not launches. Null while the tier is not evaluated. */
export function tokenRanking(report: DashboardReport, period: Period, palette: TokenPalette, all = false) {
  if (attributionState(report) !== 'evaluated' || !report.attribution.dayTokens) return null;
  const totals = new Map<string, { key: string; symbol: string; usd: string | null; receipts: number; mintAddress: string | null }>();
  for (const token of inPeriod(report.attribution.dayTokens, period).flatMap(bucket => bucket.tokens)) {
    const prior = totals.get(token.key);
    const usd = token.currentUsd === null ? prior?.usd ?? null : prior?.usd ? addDecimal(prior.usd, token.currentUsd) : token.currentUsd;
    totals.set(token.key, { key: token.key, symbol: token.symbol, usd, receipts: (prior?.receipts ?? 0) + token.receipts,
      mintAddress: isAddress(token.mintAddress) ? token.mintAddress : null });
  }
  const priced = [...totals.values()].flatMap(item => item.usd === null ? [] : [{ ...item, usd: item.usd }])
    .sort((a, b) => compareDecimal(b.usd, a.usd) || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
  const shown = all ? priced : priced.slice(0, TOKEN_COLORS.length);
  const rest = priced.slice(shown.length);
  const parts: Omit<Segment, 'tenths'>[] = shown.map(item => ({ key: item.key, symbol: tokenSymbol(item.symbol), color: tokenColor(palette, item.key), usd: item.usd,
    amount: null, receipts: item.receipts, tokens: 1, other: false, mintAddress: item.mintAddress }));
  if (rest.length) parts.push({ key: 'other', symbol: 'Other', color: OTHER_COLOR, usd: rest.reduce((sum, item) => addDecimal(sum, item.usd), '0'), amount: null,
    receipts: rest.reduce((sum, item) => sum + item.receipts, 0), tokens: rest.length, other: true, mintAddress: null });
  const unpriced: UnpricedToken[] = [...totals.values()].filter(item => item.usd === null)
    .sort((a, b) => b.receipts - a.receipts || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key))
    .map(item => ({ key: item.key, symbol: tokenSymbol(item.symbol), receipts: item.receipts, mintAddress: item.mintAddress }));
  return { rows: withTenths(parts, 1000), unpriced, total: priced.length ? priced.reduce((sum, item) => addDecimal(sum, item.usd), '0') : null,
    tokens: totals.size, foldable: priced.length > TOKEN_COLORS.length };
}
export type TokenRanking = NonNullable<ReturnType<typeof tokenRanking>>;
export type SortDirection = 'ascending' | 'descending';
/** The tooltip's token rows by exact USD, highest first when descending. Other, a remainder rather than a token, follows the
 * named tokens, and unpriced tokens follow everything, in either direction. Equal USD falls back to symbol, then key. */
export function sortUsdRows<T extends { key: string; symbol: string; usd: string | null; other?: boolean }>(rows: readonly T[], direction: SortDirection) {
  const sign = direction === 'ascending' ? 1 : -1;
  const group = (row: T) => row.usd === null ? 2 : row.other ? 1 : 0;
  return [...rows].sort((a, b) => group(a) - group(b) || (a.usd !== null && b.usd !== null ? sign * compareDecimal(a.usd, b.usd) : 0)
    || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
}
/** a − b for nonnegative decimals, or null when b exceeds a. Never floating point. */
export function subtractDecimal(a: string, b: string) {
  const x = parseDecimal(a); const y = parseDecimal(b); const scale = Math.max(x.scale, y.scale);
  const difference = x.coefficient * 10n ** BigInt(scale - x.scale) - y.coefficient * 10n ** BigInt(scale - y.scale);
  return difference < 0n ? null : decimalText(difference, scale);
}
export type AttributedAsset = NonNullable<DashboardReport['attribution']['assets']>[number];
export type TokenSortKey = 'symbol' | 'quantity' | 'usd' | 'receipts' | 'last';
export interface TokenSort { key: TokenSortKey; direction: 'ascending' | 'descending' }
/** Exact ordering for the token table. Unpriced tokens follow every priced one in either USD direction. */
export function sortTokens(assets: readonly AttributedAsset[], sort: TokenSort) {
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const order = (a: AttributedAsset, b: AttributedAsset) => {
    if (sort.key === 'usd') return a.currentUsd === null || b.currentUsd === null ? byUsd(a.currentUsd, b.currentUsd) : sign * compareDecimal(a.currentUsd, b.currentUsd);
    if (sort.key === 'quantity') return sign * compareDecimal(a.amount, b.amount);
    if (sort.key === 'receipts') return sign * (a.receipts - b.receipts);
    if (sort.key === 'last') return sign * (a.lastRewardTime - b.lastRewardTime);
    return sign * a.symbol.localeCompare(b.symbol);
  };
  return [...assets].sort((a, b) => order(a, b) || a.symbol.localeCompare(b.symbol) || assetKey(a).localeCompare(assetKey(b)));
}
/** Case-insensitive match on symbol, name or mint. */
export function filterTokens(assets: readonly AttributedAsset[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? assets.filter(asset => [asset.symbol, asset.name, asset.mint].some(value => value.toLowerCase().includes(needle))) : [...assets];
}
/** Copies through the asynchronous clipboard API. There is no fallback that reads or writes other clipboard content. */
export async function copyText(value: string): Promise<'copied' | 'failed'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return 'failed';
    await navigator.clipboard.writeText(value);
    return 'copied';
  } catch { return 'failed'; }
}
export const isAddress = (value: string | null): value is string => value !== null && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
/** The expansion under a token row: its fixed heading and the sentence that leads it. */
export const sourcesHeading = (symbol: string) => `Launches you hold that pay in ${symbol}`;
export const sourcesSentence = (symbol: string) => `The payout itself does not name its launch. These are launches this wallet holds, or held earlier, whose rewards are paid in ${symbol}.`;
export { stonkfunTokenLink } from '../src/web/links.js';
/** How long the launches may load before the expansion offers Retry; a later answer still shows. */
export const SOURCES_TIMEOUT_MS = 15_000;
export const SOURCES_LOADING = 'Checking launches you hold…';
export const sourcesEmpty = (symbol: string) => `No launch you hold was found that pays in ${symbol}.`;
export const SOURCES_EMPTY_WHY = 'This can happen when a launch was held and sold before tracking started, or when the paying launch is not in StonkFun\'s summaries.';
export const allLaunchesLabel = (count: number, symbol: string) => count === 1 ? `Show the one launch that pays in ${symbol}` : `Show all ${count.toLocaleString()} launches that pay in ${symbol}`;
/** Launches per page of the full list. */
export const LAUNCHES_PAGE = 25;
/** One page of a list, clamped to the pages there are, with its 1-based first and last positions. */
export function launchesPage<T>(items: readonly T[], page: number) {
  const pages = Math.max(1, Math.ceil(items.length / LAUNCHES_PAGE));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const start = current * LAUNCHES_PAGE;
  return { page: current, pages, items: items.slice(start, start + LAUNCHES_PAGE), first: items.length ? start + 1 : 0, last: Math.min(items.length, start + LAUNCHES_PAGE) };
}
export type Receipt = NonNullable<DashboardReport['attribution']['receipts']>[number];
export interface ReceiptFilters { day?: string | undefined; token?: string | undefined; trust?: string | undefined; price?: string | undefined }
export type ReceiptSortKey = 'date' | 'usd';
export interface ReceiptSort { key: ReceiptSortKey; direction: SortDirection }
/** Payouts open newest first; the hash leaves that default out. */
export const DEFAULT_RECEIPT_SORT: ReceiptSort = { key: 'date', direction: 'descending' };
/** A Payouts sort as its hash value, such as usd-asc; null for the default. */
export const receiptSortParam = (sort: ReceiptSort) => sort.key === DEFAULT_RECEIPT_SORT.key && sort.direction === DEFAULT_RECEIPT_SORT.direction
  ? null : `${sort.key}-${sort.direction === 'ascending' ? 'asc' : 'desc'}`;
/** The sort a hash value names, or the default for none. */
export function parseReceiptSort(value: string | undefined): ReceiptSort {
  const match = /^(date|usd)-(asc|desc)$/.exec(value ?? '');
  return match ? { key: match[1] as ReceiptSortKey, direction: match[2] === 'asc' ? 'ascending' : 'descending' } : DEFAULT_RECEIPT_SORT;
}
/** The Payouts caption for a sort. */
export const receiptSortText = (sort: ReceiptSort) => sort.key === 'date' ? (sort.direction === 'descending' ? 'NEWEST FIRST' : 'OLDEST FIRST')
  : `${sort.direction === 'descending' ? 'HIGHEST' : 'LOWEST'} USD FIRST · UNPRICED LAST`;
/** Payouts in the chosen order, over every filtered receipt before any page is cut. By date, an unknown time comes last; by
 * USD, exact decimal order with unpriced receipts last, in either direction. Equal USD falls back to newest first; equal times
 * keep the report's order. */
export function sortReceipts(receipts: readonly Receipt[], sort: ReceiptSort) {
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const time = (a: Receipt, b: Receipt, direction: number) => a.time === null || b.time === null ? (a.time === null ? 1 : 0) - (b.time === null ? 1 : 0) : direction * (a.time - b.time);
  return [...receipts].sort((a, b) => sort.key === 'date' ? time(a, b, sign)
    : (a.currentUsd === null || b.currentUsd === null ? byUsd(a.currentUsd, b.currentUsd) : sign * compareDecimal(a.currentUsd, b.currentUsd)) || time(a, b, -1));
}
/** The Payouts filters, all optional and combined with AND. The report's order is kept: newest first. */
export function filterReceipts(receipts: readonly Receipt[], filters: ReceiptFilters) {
  return receipts.filter(receipt => (!filters.day || receipt.day === filters.day) && (!filters.token || receipt.asset === filters.token)
    && (!filters.trust || (receipt.attribution?.trustSources as readonly string[] | undefined)?.includes(filters.trust) === true)
    && (!filters.price || (filters.price === 'priced') === (receipt.currentUsd !== null)));
}
/** The Payouts banner for a day filter: the listed receipts matching every filter, and the report's own receipt count for
 * that day, which the chart tooltip shows. They differ only when the list holds just the newest receipts, and then the banner
 * says so. Null while the tier is not evaluated, so a day filter never reads as 0 payouts. */
export function dayFilterBanner(report: DashboardReport, filters: ReceiptFilters) {
  if (!filters.day || attributionState(report) !== 'evaluated') return null;
  const listed = filterReceipts(report.attribution.receipts ?? [], filters).length;
  const bucket = report.attribution.dayTokens?.find(item => item.day === filters.day);
  // With a token, the report's own count of that token's receipts on the day, which the chart segment's tooltip shows.
  const token = filters.token ? bucket?.tokens.find(item => item.key === filters.token) : undefined;
  const reportReceipts = filters.token ? token?.receipts ?? 0 : bucket?.receipts ?? 0;
  const partial = !filters.trust && !filters.price && listed < reportReceipts;
  const count = partial ? `${listed.toLocaleString()} of ${reportReceipts.toLocaleString()}` : listed.toLocaleString();
  const symbol = filters.token ? tokenSymbol(token?.symbol ?? report.attribution.assets?.find(asset => assetKey(asset) === filters.token)?.symbol ?? null) : null;
  return { day: filters.day, token: filters.token ?? null, symbol, listed, reportReceipts, partial,
    text: `Showing ${filters.day}${symbol ? ` · ${symbol}` : ''} · ${count} ${noun(partial ? reportReceipts : listed, 'payout')}` };
}
export const PAGE_SIZE = 50;
export function secondsText(value: number) {
  const hours = value / 3600;
  const approximate = value < 60 ? '' : value < 3600 ? ` (${Math.round(value / 60)} min)` : hours < 48 ? ` (${hours.toFixed(1)} h)` : ` (${(hours / 24).toFixed(1)} d)`;
  return `${value.toLocaleString('en-US')} s${approximate}`;
}
export const WITNESS_RELATIONS = { before_first_witness: 'before the first witness', within_witness_span: 'within the witness span',
  after_last_witness: 'after the last witness' } as const;
export function avatarHue(mint: string) { return [...mint].reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 360, 0); }
export function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function progressAge(lastActivityAt: number, now: number, finishedAt: number | null) {
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - lastActivityAt) / 1000));
  return seconds < 2 ? 'just now' : `${seconds}s ago`;
}
/** A job's latest activity: "finished <UTC time>" once it has finished, otherwise how long ago the backend last reported. */
export const activityText = (progress: { lastActivityAt: number; finishedAt: number | null }, now: number) => progress.finishedAt !== null
  ? `finished ${utc(progress.finishedAt / 1000)}` : `last activity ${progressAge(progress.lastActivityAt, now, null)}`;
export function progressPercent(progress: ScanProgress['progress'] | null) {
  return progress && progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : null;
}
/** Shown while a running job waits out a Helius rate limit: temporary, and the scan keeps going. */
export const RATE_LIMITED_TEXT = 'Helius is limiting requests, slowing down.';
export const rateLimited = (job: Pick<DashboardJob, 'runningLocally' | 'progress'>) => job.runningLocally
  && job.progress.waiting?.provider === 'helius' && job.progress.waiting.reason === 'rate_limit';
type FailureFields = Pick<DashboardJob, 'failureClass' | 'failureMessage' | 'failureDetail' | 'savedDays' | 'runningLocally'>;
/** One plain sentence for each failure class a stopped job carries; `other` is the raw message. */
export function failureText(job: FailureFields) {
  switch (job.failureClass) {
    case 'key_rejected': return 'Helius rejected your API key. Check the key and try again.';
    case 'helius_quota': return `Helius refused the request${job.failureDetail ? `: ${job.failureDetail.replace(/[.\s]+$/, '')}` : ''}. A free plan may have used its monthly credits. Check usage in your Helius dashboard.`;
    case 'helius_rate_limited': return 'Helius was limiting requests when the scan stopped. Wait a minute and try again.';
    case 'stonkfun_unreachable': return 'StonkFun\'s API did not respond. Try again in a few minutes.';
    case 'network': return 'No connection. Check your internet and try again.';
    case 'other': return job.failureDetail ?? job.failureMessage ?? 'The scan stopped on an unrecognized error.';
    default: return null;
  }
}
/** A stopped job's failure: its message, the days it saved, and whether the key should be entered again. Null while the job
 * runs (a rate limit there is a banner, not a failure) or when nothing failed. */
export function failureNotice(job: FailureFields) {
  const message = job.runningLocally ? null : failureText(job);
  return message === null ? null : { message, saved: `Completed days are saved: ${job.savedDays.completed} of ${job.savedDays.planned}.`,
    reenterKey: job.failureClass === 'key_rejected' };
}
/** Why a wallet address cannot be loaded, checked in the page before any request; null for a well-formed address. */
export function walletInputError(value: string) {
  const text = value.trim();
  if (!text) return 'Enter a public Solana wallet address.';
  if (/[^1-9A-HJ-NP-Za-km-z]/.test(text)) return 'That is not a Solana address: addresses use letters and digits, without 0, O, I or l.';
  if (text.length < 32 || text.length > 44) return `That is not a Solana address: addresses are 32 to 44 characters, and this has ${text.length}.`;
  return null;
}
/** Whether the wallet in view has saved coverage: a report holding a completed day or a finished sync. A wallet the server does not
 * track, or whose first scan has not saved a day yet, has none, and the page offers Scan wallet instead of Check latest data. */
export const hasSavedCoverage = (report: Pick<DashboardReport, 'coverage' | 'lastSync'> | null) => report !== null
  && (report.coverage.completed.length > 0 || report.lastSync !== null);
/** The primary button's action for the wallet in view. */
export const primaryLabel = (scanned: boolean) => scanned ? 'Check latest data' : 'Scan wallet';
export const NOT_SCANNED = 'Not scanned yet';
/** The header status for the wallet in view: WORKING while its job runs here, Not scanned yet without saved coverage, and
 * otherwise its last job's state. */
export const walletStatusText = (job: DashboardJob | null, scanned: boolean) => scanned || job?.runningLocally ? jobStateText(job) : NOT_SCANNED;
/** The panel every tab shows for a wallet with no saved coverage. */
export const unscannedTitle = (wallet: string) => `${short(wallet)} has not been scanned yet.`;
export const UNSCANNED_NOTE = `The first scan covers the last ${FIRST_SCAN_DAYS} days and takes a few minutes. Older history loads afterwards in ${EARLIER_BATCH_DAYS}-day batches.`;
/** Why the primary button waits while another wallet's job runs: the page starts one job at a time. */
export const runningElsewhereText = (wallet: string) => `A scan is running for ${short(wallet)}`;
/** The wallet whose job runs on this server while another is in view, or null. With no wallet in view nothing waits. */
export const runningElsewhere = (health: Pick<Health, 'activeWallets'> | null, wallet: string) => wallet
  ? health?.activeWallets.find(active => active !== wallet) ?? null : null;
/** The scan dialog's title, naming the wallet: a Load earlier batch by its days, a first scan by its range, otherwise a refresh. */
export function progressTitle(job: Pick<DashboardJob, 'wallet' | 'kind' | 'batch' | 'cutoff' | 'ranges'> & Partial<Pick<DashboardJob, 'check'>>) {
  if (job.kind === 'earlier' && job.batch) return batchLabel(job.batch);
  if (job.kind === 'check' && job.check) return `Rescanning ${utcDay(job.check.startTime)} → ${utcDay(job.check.endTime - 1)}`;
  return job.batch?.kind === 'first' || isFirstScan(job) ? `Scanning ${short(job.wallet)}: last ${FIRST_SCAN_DAYS} days` : `Refreshing ${short(job.wallet)}`;
}
/** The job's kind as the status panel names it. */
export const jobKindText = (job: Pick<DashboardJob, 'kind' | 'batch'> & Partial<Pick<DashboardJob, 'check'>>) => job.batch?.kind === 'first' ? 'First scan'
  : job.kind === 'check' ? `Rescan${job.check ? ` · ${utcDay(job.check.startTime)} → ${utcDay(job.check.endTime - 1)}` : ''}`
  : job.kind === 'earlier' ? `Load earlier${job.batch ? ` · ${utcDay(job.batch.startTime)} → ${utcDay(job.batch.endTime - 1)}` : ''}` : 'Refresh';
/** Whether the loaded range holds no StonkFun payout at all, verified or attributed, once the attributed tier is evaluated. */
export const noPayouts = (report: DashboardReport) => attributionState(report) === 'evaluated' && (report.attribution.rows ?? 0) === 0 && report.counts.confirmed === 0;
/** The overview's empty state for a loaded range with no payouts, and whether Scan more can look further back. */
export function emptyHistoryText(history: LoadedHistory) {
  return history.earlierRemaining
    ? { title: `No StonkFun payouts found between ${history.oldestLoadedDay} and today.`, detail: `Days before ${history.oldestLoadedDay} are not loaded yet. Scan more to check them.`, earlier: true }
    : { title: `No StonkFun payouts found since ${FLOOR_DAY}.`, detail: 'Every day since then is loaded. Rows the scanner could not attribute are counted apart in Coverage.', earlier: false };
}
export function progressState(job: DashboardJob, now: number) {
  // The failure itself, its saved days and Retry are in the notice beneath; this line only says the job stopped.
  if (failureNotice(job)) return 'Stopped. What happened and what to do next are below.';
  if (rateLimited(job)) return RATE_LIMITED_TEXT;
  if (job.failure) return job.failure;
  if (job.status === 'complete') return 'Completed. Saved report is ready.';
  if (job.cancelled) return 'Cancelled. Acknowledged work is saved.';
  if (job.status === 'exhausted') return 'Stopped at the saved budget or deadline.';
  if (!job.runningLocally) return job.status === 'running' ? 'No local worker activity is visible.' : 'Paused. Acknowledged work is saved.';
  if (job.progress.awaitingProvider && now - job.progress.lastActivityAt >= 4000)
    return 'Waiting for provider response — scan still active.';
  return job.progress.action;
}

/** The loaded range as UTC days: the oldest loaded day through the day of the last second before the cutoff. */
export function loadedDays(report: Pick<DashboardReport, 'cutoff' | 'trackingStart'>) {
  const target = coverageTarget(report);
  return { first: utcDay(target.startTime), last: utcDay(Math.max(target.startTime, target.endTime - 1)) };
}
/** A check's days: whole UTC days, first through last. */
export interface RescanPick { start: string; end: string }
/** A finished rescan's line: the attributed payouts it found in transactions not saved before, and those already saved in its
 * days. Verified payouts are named apart when there are any, never added in. A rescan whose every day agreed says the range is
 * now checked. Null until its checks are done. */
export function rescanDoneText(job: Partial<Pick<DashboardJob, 'check' | 'checkResult'>>) {
  if (!job.check || !job.checkResult) return null;
  const { newPayouts, alreadySaved, newVerified, unconfirmedDays, days, checkedDays } = job.checkResult;
  return [`Rescanned ${utcDay(job.check.startTime)} → ${utcDay(job.check.endTime - 1)}: ${newPayouts.toLocaleString()} new ${noun(newPayouts, 'payout')} found, ${alreadySaved.toLocaleString()} already saved.`,
    newVerified > 0 ? `${newVerified.toLocaleString()} new verified ${noun(newVerified, 'payout')}.` : '',
    unconfirmedDays > 0 ? `Helius listed ${unconfirmedDays} ${noun(unconfirmedDays, 'day')} differently from its full read; rescan ${unconfirmedDays === 1 ? 'it' : 'them'} again later.` : '',
    days > 0 && checkedDays === days ? RANGE_CHECKED_TEXT : '']
    .filter(Boolean).join(' ');
}
export const RANGE_CHECKED_TEXT = 'Every day in this range is now checked.';
/** The loaded days not checked yet: read once, or partly not loaded. */
export const daysToCheck = (report: Pick<DashboardReport, 'cutoff' | 'trackingStart' | 'coverage'>) =>
  dayStates(report).filter(item => item.state !== 'checked').length;
export const ALL_CAUGHT_UP_TEXT = 'All caught up';
/** One row of Scan more: a batch of at most seven days. A batch not loaded is exactly the span Load earlier reads, counting back in
 * 7-day steps from the oldest loaded time and stopping at the floor; `back` is how many batches Load reads to reach it, 1 for the
 * next. Loaded days are split on the same 7-day steps from the oldest loaded day, as whole UTC days, since a check reads whole
 * days: their span is those days clipped to the loaded range, and `toCheck` counts the days read once or partly not loaded. */
export interface MoreBatch {
  startTime: number; endTime: number; first: string; last: string; days: number; label: string;
  status: 'not_loaded' | 'loaded' | 'checked'; toCheck: number; back: number; saved: number;
}
/** A batch edge as a row prints it: a day at midnight (the day before, for an end), otherwise its day and UTC minute. */
const edgeText = (seconds: number, end: boolean) => seconds % 86400 === 0 ? utcDay(end ? seconds - 1 : seconds)
  : new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
/** A batch's UTC dates, with the minute wherever an edge falls inside a day, so two rows never seem to share a day. */
export const batchDates = (span: { startTime: number; endTime: number }) => `${edgeText(span.startTime, false)} → ${edgeText(span.endTime, true)}`;
/** Every Scan more row from today back to the floor, newest first, none overlapping and none before the floor. */
export function scanMoreBatches(report: Pick<DashboardReport, 'cutoff' | 'trackingStart' | 'coverage' | 'history'>): MoreBatch[] {
  const loadedFrom = coverageTarget(report).startTime;
  const states = new Map(dayStates(report).map(item => [item.day, item.state]));
  const { first, last } = loadedDays(report);
  const loaded: MoreBatch[] = [];
  for (let day = dayNumber(first); day <= dayNumber(last); day += EARLIER_BATCH_DAYS) {
    const end = Math.min(day + EARLIER_BATCH_DAYS - 1, dayNumber(last));
    const days = Array.from({ length: end - day + 1 }, (_, index) => dayText(day + index));
    const toCheck = days.filter(item => states.get(item) !== 'checked').length;
    const span = { startTime: Math.max(loadedFrom, day * 86400), endTime: Math.min(report.cutoff, (end + 1) * 86400) };
    loaded.push({ ...span, first: dayText(day), last: dayText(end), days: days.length, label: batchDates(span), status: toCheck > 0 ? 'loaded' : 'checked', toCheck, back: 0, saved: 0 });
  }
  const earlier: MoreBatch[] = [];
  for (let batch = earlierBatch(loadedFrom); batch; batch = earlierBatch(batch.startTime)) {
    earlier.push({ ...batch, first: utcDay(batch.startTime), last: utcDay(batch.endTime - 1), days: Math.ceil((batch.endTime - batch.startTime) / 86400), label: batchDates(batch),
      status: 'not_loaded', toCheck: 0, back: earlier.length + 1, saved: savedDaysIn(batch, report.coverage.completed) });
  }
  return [...loaded.reverse(), ...earlier];
}
/** The row holding a time, which Scan more highlights when another place opened it. */
export const batchAt = (batches: readonly MoreBatch[], time: number | null) => time === null ? null
  : batches.find(batch => batch.startTime <= time && time < batch.endTime) ?? null;
/** A row's status: not loaded (with the days an interrupted batch saved), loaded, or checked. */
export const batchStatusText = (batch: MoreBatch) => batch.status === 'checked' ? 'Checked' : batch.status === 'loaded' ? 'Loaded'
  : batch.saved > 0 ? `Not loaded · ${batch.saved} of ${batch.days} ${noun(batch.days, 'day')} saved` : 'Not loaded';
/** A row's one action: Load, Check with its days still to check, or Confirmed, which is not clickable. */
export const batchActionText = (batch: MoreBatch) => batch.status === 'not_loaded' ? 'Load'
  : batch.status === 'loaded' ? `Check · ${batch.toCheck.toLocaleString()} ${noun(batch.toCheck, 'day')}` : 'Confirmed';
/** Scan more's Load reads several batches one after another; the scan dialog names the one running. */
export const sequenceText = (sequence: { index: number; total: number }) => `Batch ${sequence.index} of ${sequence.total}`;
/** The Scan more button's second line: the days left to the floor while earlier history remains, otherwise the loaded days still to
 * check while there are any, otherwise all caught up. */
export function scanMoreText(report: Pick<DashboardReport, 'cutoff' | 'trackingStart' | 'coverage' | 'history'>) {
  const left = report.history.earlierRemaining ? report.history.notLoadedYet?.days ?? 0 : 0;
  if (left > 0) return `${left.toLocaleString()} ${noun(left, 'day')} left to ${FLOOR_SHORT}`;
  const toCheck = daysToCheck(report);
  return toCheck > 0 ? `${toCheck.toLocaleString()} ${noun(toCheck, 'day')} to check` : ALL_CAUGHT_UP_TEXT;
}
/** The one summary line at the top of Scan more: the loaded range with the Scan more button's second line. */
export const scanMoreSummary = (report: Pick<DashboardReport, 'cutoff' | 'trackingStart' | 'coverage' | 'history'>) =>
  `${historyStatus(report).loaded} · ${scanMoreText(report)}`;
export type DayState = 'checked' | 'read_once' | 'gap';
export const DAY_STATE_TEXT: Record<DayState, string> = { checked: 'Checked', read_once: 'Read once', gap: 'Gap' };
/** Every loaded UTC day, newest first: Checked when all of its loaded time agreed with a second listing, Read once when it was
 * loaded before the check existed (or a rescan still found it listed differently), and Gap when part of it is not loaded. */
export function dayStates(report: Pick<DashboardReport, 'cutoff' | 'trackingStart' | 'coverage'>) {
  const target = coverageTarget(report);
  const within = (ranges: readonly { startTime: number; endTime: number }[], from: number, to: number) =>
    mergeRanges(ranges).some(range => range.startTime <= from && range.endTime >= to);
  const days: { day: string; state: DayState }[] = [];
  for (let day = Math.floor(target.startTime / 86400); day * 86400 < target.endTime; day++) {
    const from = Math.max(target.startTime, day * 86400); const to = Math.min(target.endTime, (day + 1) * 86400);
    days.push({ day: dayText(day), state: within(report.coverage.checked ?? [], from, to) ? 'checked' : within(report.coverage.completed, from, to) ? 'read_once' : 'gap' });
  }
  return days.reverse();
}
