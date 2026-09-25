import type { Range } from './types.js';

const DAY = 86400;
/** The history floor: nothing before it is ever requested, and Load earlier stops there. */
export const HISTORY_FLOOR = Date.parse('2026-08-01T00:00:00Z') / 1000;
/** A wallet's first scan covers this many days before its cutoff, never reaching before the floor. */
export const FIRST_SCAN_DAYS = 7;
/** Each Load earlier batch covers this many days before the oldest loaded day, never reaching before the floor. */
export const EARLIER_BATCH_DAYS = 7;
/** Each planned missing range starts this many seconds inside the saved coverage before it, to reread delayed indexing. */
export const RANGE_OVERLAP_SECONDS = 60;
/** A check job covers at most this many whole UTC days. */
export const CHECK_MAX_DAYS = 7;
/** The range a scan may ever cover: the history floor up to the fixed, exclusive cutoff. */
export function historyTarget(cutoff: number): Range {
  if (!Number.isSafeInteger(cutoff) || cutoff <= HISTORY_FLOOR) throw new TypeError('Invalid history cutoff');
  return { startTime: HISTORY_FLOOR, endTime: cutoff };
}
/** The oldest loaded day of a wallet's first scan: seven days before the cutoff, clipped at the floor. */
export function firstScanStart(cutoff: number): number {
  historyTarget(cutoff);
  return Math.max(HISTORY_FLOOR, cutoff - FIRST_SCAN_DAYS * DAY);
}
/** The next Load earlier batch: the seven days before the oldest loaded day, clipped at the floor; null at the floor. */
export function earlierBatch(loadedFrom: number): Range | null {
  if (!Number.isSafeInteger(loadedFrom)) throw new TypeError('Invalid loaded range');
  return loadedFrom <= HISTORY_FLOOR ? null : { startTime: Math.max(HISTORY_FLOOR, loadedFrom - EARLIER_BATCH_DAYS * DAY), endTime: loadedFrom };
}

export function mergeRanges(ranges: readonly Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.startTime - b.startTime)) {
    const last = merged.at(-1);
    if (last && range.startTime <= last.endTime) last.endTime = Math.max(last.endTime, range.endTime);
    else merged.push({ ...range });
  }
  return merged;
}
export function missingRanges(start: number, end: number, completed: readonly Range[]): Range[] {
  let cursor = start;
  const gaps: Range[] = [];
  for (const range of mergeRanges(completed)) {
    if (range.endTime <= cursor || range.startTime >= end) continue;
    if (range.startTime > cursor) gaps.push({ startTime: cursor, endTime: range.startTime });
    cursor = Math.max(cursor, range.endTime);
  }
  if (cursor < end) gaps.push({ startTime: cursor, endTime: end });
  return gaps;
}
/** Every missing range in [start, end), in chunks of at most one day. Each overlaps the coverage before it by
 * RANGE_OVERLAP_SECONDS, never reaching before `start`. */
function planMissing(start: number, end: number, completed: readonly Range[], reconcile: boolean): Range[] {
  const work = missingRanges(start, end, completed).map(range => ({ ...range, startTime: Math.max(start, range.startTime - RANGE_OVERLAP_SECONDS) }));
  // A same-cutoff refresh still reconciles the most recent minute for delayed indexing/conflicts.
  if (reconcile && work.length === 0) work.push({ startTime: Math.max(start, end - RANGE_OVERLAP_SECONDS), endTime: end });
  return mergeRanges(work).flatMap(range => {
    const pieces: Range[] = [];
    for (let at = range.startTime; at < range.endTime; at += DAY) pieces.push({ startTime: at, endTime: Math.min(at + DAY, range.endTime) });
    return pieces;
  });
}
/** Refresh: every missing range from the oldest loaded day (the floor by default) to the cutoff, including failed gaps inside
 * it, and never anything earlier. */
export function planRanges(cutoff: number, completed: readonly Range[], loadedFrom = HISTORY_FLOOR): Range[] {
  historyTarget(cutoff);
  if (!Number.isSafeInteger(loadedFrom) || loadedFrom < HISTORY_FLOOR || loadedFrom >= cutoff) throw new TypeError('Invalid loaded range');
  return planMissing(loadedFrom, cutoff, completed, true);
}
/** Load earlier: the batch's missing days only, so an interrupted batch is finished before the next one starts. */
export function planEarlier(batch: Range, completed: readonly Range[]): Range[] {
  if (batch.startTime < HISTORY_FLOOR || batch.endTime <= batch.startTime) throw new TypeError('Invalid earlier batch');
  return planMissing(batch.startTime, batch.endTime, completed, false);
}
/** A check job's days: whole UTC days from `days.startTime` to `days.endTime`, at most seven, none outside the loaded range, each
 * clipped to it. */
export function planCheck(days: Range, loaded: Range): Range[] {
  if (!Number.isSafeInteger(days.startTime) || !Number.isSafeInteger(days.endTime) || days.startTime % DAY !== 0 || days.endTime % DAY !== 0
    || days.endTime <= days.startTime) throw new Error('check_range_invalid');
  if ((days.endTime - days.startTime) / DAY > CHECK_MAX_DAYS) throw new Error('check_range_too_long');
  if (days.startTime < Math.floor(loaded.startTime / DAY) * DAY || days.endTime > Math.ceil(loaded.endTime / DAY) * DAY) throw new Error('check_range_outside_loaded');
  const pieces: Range[] = [];
  for (let at = days.startTime; at < days.endTime; at += DAY) pieces.push({ startTime: Math.max(at, loaded.startTime), endTime: Math.min(at + DAY, loaded.endTime) });
  return pieces.filter(piece => piece.endTime > piece.startTime);
}
