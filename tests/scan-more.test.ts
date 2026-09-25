import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ALL_CAUGHT_UP_TEXT, batchActionText, batchAt, batchDates, batchStatusText, dayStates, daysToCheck, doneText, jobKindText, loadedDays, progressTitle,
  rescanDoneText, scanMoreBatches, scanMoreSummary, scanMoreText, sequenceText } from '../web/model.js';
import type { MoreBatch } from '../web/model.js';
import { ScanMoreDialog } from '../web/ScanMore.js';
import type { DashboardReport } from '../src/web/view.js';
import { DEMO_CUTOFF } from '../src/cli/demo.js';
import { loadedHistory } from '../src/scanner/report.js';
import { EARLIER_BATCH_DAYS, earlierBatch, HISTORY_FLOOR } from '../src/scanner/ranges.js';

const at = (text: string) => Date.parse(`${text}Z`) / 1000;
/** A wallet loaded from Tuesday 2026-09-01 to a Thursday cutoff. */
const september = { trackingStart: at('2026-09-01T00:00:00'), cutoff: at('2026-09-24T20:48:17') };
/** A first scan: seven days before the demo cutoff, Monday 2026-09-14 14:13 to Monday 2026-09-21 14:13. */
const firstScan = { trackingStart: DEMO_CUTOFF - 7 * 86400, cutoff: DEMO_CUTOFF };

describe('Loaded days', () => {
  it('run from the oldest loaded day to the day of the last second before the cutoff', () => {
    expect(loadedDays(september)).toEqual({ first: '2026-09-01', last: '2026-09-24' });
    expect(loadedDays(firstScan)).toEqual({ first: '2026-09-14', last: '2026-09-21' });
    // A cutoff at midnight ends the loaded range on the day before.
    expect(loadedDays({ trackingStart: at('2026-09-14T00:00:00'), cutoff: at('2026-09-21T00:00:00') })).toEqual({ first: '2026-09-14', last: '2026-09-20' });
  });
});

describe('Check text', () => {
  const check = { startTime: at('2026-09-14T00:00:00'), endTime: at('2026-09-21T00:00:00'), days: 7 };
  const result = { days: 7, checkedDays: 7, unconfirmedDays: 0, newTransactions: 3, newPayouts: 2, alreadySaved: 41, newVerified: 0, verifiedAlreadySaved: 0 };
  it('says what a finished rescan found, keeping verified payouts apart', () => {
    expect(rescanDoneText({ check, checkResult: result })).toBe('Rescanned 2026-09-14 → 2026-09-20: 2 new payouts found, 41 already saved. Every day in this range is now checked.');
    expect(rescanDoneText({ check, checkResult: { ...result, newPayouts: 1, alreadySaved: 0 } })).toBe('Rescanned 2026-09-14 → 2026-09-20: 1 new payout found, 0 already saved. Every day in this range is now checked.');
    expect(rescanDoneText({ check, checkResult: { ...result, newPayouts: 0, newVerified: 1 } }))
      .toBe('Rescanned 2026-09-14 → 2026-09-20: 0 new payouts found, 41 already saved. 1 new verified payout. Every day in this range is now checked.');
    expect(rescanDoneText({ check, checkResult: { ...result, checkedDays: 6, unconfirmedDays: 1 } }))
      .toBe('Rescanned 2026-09-14 → 2026-09-20: 2 new payouts found, 41 already saved. Helius listed 1 day differently from its full read; rescan it again later.');
    expect(rescanDoneText({ check, checkResult: null })).toBeNull();
    expect(rescanDoneText({ check: null, checkResult: result })).toBeNull();
  });
  it('titles the progress dialog and the status panel by the rescanned days', () => {
    const job = { wallet: '8'.repeat(32), kind: 'check' as const, batch: null, cutoff: DEMO_CUTOFF, check, checkResult: result,
      ranges: [{ startTime: check.startTime, endTime: check.endTime, status: 'complete' as const, pages: 0 }] };
    expect(progressTitle(job)).toBe('Rescanning 2026-09-14 → 2026-09-20');
    expect(jobKindText(job)).toBe('Rescan · 2026-09-14 → 2026-09-20');
    expect(doneText(job, null)).toBe('Rescanned 2026-09-14 → 2026-09-20: 2 new payouts found, 41 already saved. Every day in this range is now checked.');
  });
});

describe('Coverage day states', () => {
  it('shows each loaded day as Checked, Read once or Gap, newest first, and never as not verified', () => {
    const report = { ...firstScan, coverage: { gaps: [], verifiedZero: false as const,
      completed: [{ startTime: firstScan.trackingStart, endTime: at('2026-09-19T06:00:00') }, { startTime: at('2026-09-20T00:00:00'), endTime: DEMO_CUTOFF }],
      checked: [{ startTime: at('2026-09-16T00:00:00'), endTime: at('2026-09-18T00:00:00') }, { startTime: at('2026-09-21T00:00:00'), endTime: DEMO_CUTOFF }] } };
    expect(dayStates(report)).toEqual([
      { day: '2026-09-21', state: 'checked' }, { day: '2026-09-20', state: 'read_once' }, { day: '2026-09-19', state: 'gap' },
      { day: '2026-09-18', state: 'read_once' }, { day: '2026-09-17', state: 'checked' }, { day: '2026-09-16', state: 'checked' },
      { day: '2026-09-15', state: 'read_once' }, { day: '2026-09-14', state: 'read_once' }]);
    // The first loaded day starts mid-day: its loaded part alone decides its state.
    expect(dayStates({ ...report, coverage: { ...report.coverage, checked: [{ startTime: firstScan.trackingStart, endTime: DEMO_CUTOFF }] } })
      .every(item => item.state === 'checked' || item.day === '2026-09-19')).toBe(true);
  });
});

/** A report's history block for a wallet loaded from `trackingStart`, as the scanner builds it. */
const history = (trackingStart: number) => loadedHistory({ network: 'mainnet-beta', wallet: '8'.repeat(32), trackingStart, cutoff: september.cutoff, lastSync: null });

describe('Scan more second line', () => {
  const coverage = (checked: { startTime: number; endTime: number }[], from = september.trackingStart) => ({ gaps: [], verifiedZero: false as const,
    completed: [{ startTime: from, endTime: september.cutoff }], checked });
  it('counts the days left to Aug 1 while earlier history remains, whatever is left to check', () => {
    const report = { ...september, history: history(september.trackingStart), coverage: coverage([]) };
    expect(scanMoreText(report)).toBe('31 days left to Aug 1');
    expect(scanMoreSummary(report)).toBe('Loaded 2026-09-01 → today · 31 days left to Aug 1');
    const oneDay = { ...report, trackingStart: at('2026-08-02T06:00:00'), history: history(at('2026-08-02T06:00:00')) };
    expect(scanMoreText(oneDay)).toBe('2 days left to Aug 1');
    expect(scanMoreText({ ...oneDay, trackingStart: at('2026-08-01T12:00:00'), history: history(at('2026-08-01T12:00:00')) })).toBe('1 day left to Aug 1');
  });
  it('counts the loaded days still to check once loaded back to the floor, then says all caught up', () => {
    const floor = { trackingStart: HISTORY_FLOOR, cutoff: september.cutoff, history: history(HISTORY_FLOOR) };
    expect(scanMoreText({ ...floor, coverage: coverage([], HISTORY_FLOOR) })).toBe('55 days to check');
    expect(scanMoreText({ ...floor, coverage: coverage([{ startTime: HISTORY_FLOOR, endTime: at('2026-09-24T00:00:00') }], HISTORY_FLOOR) })).toBe('1 day to check');
    const caughtUp = { ...floor, coverage: coverage([{ startTime: HISTORY_FLOOR, endTime: september.cutoff }], HISTORY_FLOOR) };
    expect(scanMoreText(caughtUp)).toBe(ALL_CAUGHT_UP_TEXT);
    expect(ALL_CAUGHT_UP_TEXT).toBe('All caught up');
    expect(scanMoreSummary(caughtUp)).toBe('Full history since 2026-08-01 · All caught up');
  });
});

/** A report for a wallet loaded from `from` to `cutoff`, every loaded second saved, with the given checked ranges. */
const loadedReport = (from: number, cutoff: number, checked: { startTime: number; endTime: number }[] = [], completed = [{ startTime: from, endTime: cutoff }]) => ({
  trackingStart: from, cutoff, history: loadedHistory({ network: 'mainnet-beta', wallet: '8'.repeat(32), trackingStart: from, cutoff, lastSync: null }),
  coverage: { gaps: [], verifiedZero: false as const, completed, checked } });
const rows = (batches: MoreBatch[]) => batches.map(batch => `${batch.label} | ${batchStatusText(batch)} | ${batchActionText(batch)}`);
/** Every row, oldest first: contiguous from the floor to the cutoff, never overlapping, none longer than seven days. */
function tiles(batches: MoreBatch[], cutoff: number) {
  const ordered = [...batches].reverse();
  expect(ordered[0]!.startTime).toBe(HISTORY_FLOOR);
  expect(ordered.at(-1)!.endTime).toBe(cutoff);
  ordered.forEach((batch, index) => {
    expect(batch.endTime).toBeGreaterThan(batch.startTime);
    expect(batch.endTime - batch.startTime).toBeLessThanOrEqual(EARLIER_BATCH_DAYS * 86400);
    if (index > 0) expect(batch.startTime).toBe(ordered[index - 1]!.endTime);
  });
}
/** The spans Load earlier reads, one batch after another, from the oldest loaded time back to the floor. */
function loadEarlierChain(from: number) {
  const spans: { startTime: number; endTime: number }[] = [];
  for (let batch = earlierBatch(from); batch; batch = earlierBatch(batch.startTime)) spans.push(batch);
  return spans;
}

describe('Scan more batches', () => {
  it('split a wallet loaded from midnight into whole 7-day batches from the oldest loaded day, each way, the oldest clipped at the floor', () => {
    const report = loadedReport(september.trackingStart, september.cutoff, [{ startTime: at('2026-09-08T00:00:00'), endTime: at('2026-09-15T00:00:00') }]);
    const batches = scanMoreBatches(report);
    expect(rows(batches)).toEqual([
      '2026-09-22 → 2026-09-24 20:48 | Loaded | Check · 3 days', '2026-09-15 → 2026-09-21 | Loaded | Check · 7 days',
      '2026-09-08 → 2026-09-14 | Checked | Confirmed', '2026-09-01 → 2026-09-07 | Loaded | Check · 7 days',
      '2026-08-25 → 2026-08-31 | Not loaded | Load', '2026-08-18 → 2026-08-24 | Not loaded | Load', '2026-08-11 → 2026-08-17 | Not loaded | Load',
      '2026-08-04 → 2026-08-10 | Not loaded | Load', '2026-08-01 → 2026-08-03 | Not loaded | Load']);
    tiles(batches, september.cutoff);
    // The rows not loaded are exactly what Load earlier reads, batch after batch, and Load reads `back` of them to reach each.
    const earlier = batches.filter(batch => batch.status === 'not_loaded');
    expect(earlier.map(batch => ({ startTime: batch.startTime, endTime: batch.endTime }))).toEqual(loadEarlierChain(september.trackingStart));
    expect(earlier.map(batch => batch.back)).toEqual([1, 2, 3, 4, 5]);
    expect(earlier[0]).toMatchObject({ startTime: report.history.nextBatch!.startTime, endTime: report.history.nextBatch!.endTime });
    // A loaded batch checks its whole UTC days, at most seven.
    expect(batches.filter(batch => batch.status !== 'not_loaded').map(batch => [batch.first, batch.last, batch.days])).toEqual([
      ['2026-09-22', '2026-09-24', 3], ['2026-09-15', '2026-09-21', 7], ['2026-09-08', '2026-09-14', 7], ['2026-09-01', '2026-09-07', 7]]);
  });

  it('follow Load earlier to the minute for a first scan that started mid-day, and print that minute so no two rows share a day', () => {
    // Loaded from 2026-09-11 14:13, ten days before the demo cutoff, as the later-day fixture wallet.
    const from = DEMO_CUTOFF - 10 * 86400;
    const batches = scanMoreBatches(loadedReport(from, DEMO_CUTOFF, [{ startTime: from, endTime: at('2026-09-18T00:00:00') }]));
    expect(rows(batches)).toEqual([
      '2026-09-18 → 2026-09-21 14:13 | Loaded | Check · 4 days', '2026-09-11 14:13 → 2026-09-17 | Checked | Confirmed',
      '2026-09-04 14:13 → 2026-09-11 14:13 | Not loaded | Load', '2026-08-28 14:13 → 2026-09-04 14:13 | Not loaded | Load',
      '2026-08-21 14:13 → 2026-08-28 14:13 | Not loaded | Load', '2026-08-14 14:13 → 2026-08-21 14:13 | Not loaded | Load',
      '2026-08-07 14:13 → 2026-08-14 14:13 | Not loaded | Load', '2026-08-01 → 2026-08-07 14:13 | Not loaded | Load']);
    tiles(batches, DEMO_CUTOFF);
    expect(batches.filter(batch => batch.status === 'not_loaded').map(batch => ({ startTime: batch.startTime, endTime: batch.endTime }))).toEqual(loadEarlierChain(from));
    // The partial oldest day checks from the minute it was loaded; the check reads the whole days 2026-09-11 → 2026-09-17.
    expect(batches[1]).toMatchObject({ first: '2026-09-11', last: '2026-09-17', startTime: from, days: 7 });
  });

  it('list nothing before the floor once history reaches it, and start the batches at the floor', () => {
    const batches = scanMoreBatches(loadedReport(HISTORY_FLOOR, september.cutoff));
    expect(batches.every(batch => batch.status !== 'not_loaded' && batch.startTime >= HISTORY_FLOOR)).toBe(true);
    expect(batches.map(batch => batch.label)).toEqual(['2026-09-19 → 2026-09-24 20:48', '2026-09-12 → 2026-09-18', '2026-09-05 → 2026-09-11', '2026-08-29 → 2026-09-04',
      '2026-08-22 → 2026-08-28', '2026-08-15 → 2026-08-21', '2026-08-08 → 2026-08-14', '2026-08-01 → 2026-08-07']);
    tiles(batches, september.cutoff);
    // A wallet one partial day above the floor lists that part as its one batch not loaded.
    const near = scanMoreBatches(loadedReport(at('2026-08-01T06:00:00'), september.cutoff)).filter(batch => batch.status === 'not_loaded');
    expect(near.map(batch => batch.label)).toEqual(['2026-08-01 → 2026-08-01 06:00']);
  });

  it('count the read-once and partly loaded days of a loaded batch, and say how much of an interrupted batch is saved', () => {
    // Loaded 2026-09-01 → 2026-09-24: 09-15 → 09-21 read once but 09-17 checked, and 09-22 partly not loaded.
    const report = loadedReport(september.trackingStart, september.cutoff,
      [{ startTime: september.trackingStart, endTime: at('2026-09-15T00:00:00') }, { startTime: at('2026-09-17T00:00:00'), endTime: at('2026-09-18T00:00:00') },
        { startTime: at('2026-09-23T00:00:00'), endTime: september.cutoff }],
      [{ startTime: september.trackingStart, endTime: at('2026-09-22T06:00:00') }, { startTime: at('2026-09-22T12:00:00'), endTime: september.cutoff },
        { startTime: at('2026-08-28T00:00:00'), endTime: september.trackingStart }]);
    expect(daysToCheck(report)).toBe(7);
    const batches = scanMoreBatches(report);
    expect(rows(batches).slice(0, 5)).toEqual(['2026-09-22 → 2026-09-24 20:48 | Loaded | Check · 1 day', '2026-09-15 → 2026-09-21 | Loaded | Check · 6 days',
      '2026-09-08 → 2026-09-14 | Checked | Confirmed', '2026-09-01 → 2026-09-07 | Checked | Confirmed', '2026-08-25 → 2026-08-31 | Not loaded · 4 of 7 days saved | Load']);
    const all = loadedReport(september.trackingStart, september.cutoff, [{ startTime: september.trackingStart, endTime: september.cutoff }]);
    expect(daysToCheck(all)).toBe(0);
    expect(scanMoreBatches(all).filter(batch => batch.status !== 'not_loaded').every(batch => batch.status === 'checked')).toBe(true);
  });

  it('highlight the row holding the time another place opened Scan more on', () => {
    const from = DEMO_CUTOFF - 10 * 86400;
    const batches = scanMoreBatches(loadedReport(from, DEMO_CUTOFF));
    // Coverage's days not loaded yet, and the empty overview, open the batch before the oldest loaded day.
    expect(batchAt(batches, from - 1)?.label).toBe('2026-09-04 14:13 → 2026-09-11 14:13');
    // A loaded day opens its batch, the partial oldest day included.
    expect(batchAt(batches, from)?.label).toBe('2026-09-11 14:13 → 2026-09-17');
    expect(batchAt(batches, at('2026-09-19T00:00:00'))?.label).toBe('2026-09-18 → 2026-09-21 14:13');
    // A period that needs 30 days opens the batch holding its first day; the floor opens the oldest batch.
    expect(batchAt(batches, at('2026-08-23T00:00:00'))?.label).toBe('2026-08-21 14:13 → 2026-08-28 14:13');
    expect(batchAt(batches, HISTORY_FLOOR)?.label).toBe('2026-08-01 → 2026-08-07 14:13');
    expect(batchAt(batches, null)).toBeNull();
    expect(batchAt(batches, HISTORY_FLOOR - 1)).toBeNull();
  });

  it('print a batch edge inside a day with its minute, and name the running batch of a Load', () => {
    expect(batchDates({ startTime: at('2026-09-01T00:00:00'), endTime: at('2026-09-08T00:00:00') })).toBe('2026-09-01 → 2026-09-07');
    expect(batchDates({ startTime: at('2026-09-01T14:13:00'), endTime: at('2026-09-08T14:13:00') })).toBe('2026-09-01 14:13 → 2026-09-08 14:13');
    expect(sequenceText({ index: 1, total: 2 })).toBe('Batch 1 of 2');
  });
});

describe('Scan more dialog', () => {
  const from = DEMO_CUTOFF - 10 * 86400;
  const report = { ...loadedReport(from, DEMO_CUTOFF, [{ startTime: from, endTime: at('2026-09-18T00:00:00') }]) } as unknown as DashboardReport;
  const dialog = (focus: number | null) => renderToStaticMarkup(createElement(ScanMoreDialog, { report, focus, busy: false, onLoad: () => undefined, onCheck: () => undefined,
    onClose: () => undefined }));
  it('has no date fields and no Check other dates, only one summary line and one action per row', () => {
    const html = dialog(null);
    expect(html).not.toMatch(/type="date"|<input|Check other dates|Start day|End day|<details|Rescan/);
    expect(html).toContain('<p class="more-summary">Loaded 2026-09-11 → today · 42 days left to Aug 1</p>');
    expect(html.match(/<li /g)).toHaveLength(8);
    expect(html.match(/class="more-action"/g)).toHaveLength(8);
    expect(html).not.toContain('highlight');
  });
  it('greys out a checked batch as Confirmed, not clickable, and highlights the row it was opened on', () => {
    const html = dialog(from - 1);
    expect(html).toContain('<button type="button" class="more-action" disabled="" aria-disabled="true" aria-label="Confirmed, 2026-09-11 14:13 → 2026-09-17">Confirmed</button>');
    expect(html).toContain('<li class="more-row not_loaded highlight" aria-current="true"><span class="more-dates">2026-09-04 14:13 → 2026-09-11 14:13</span>');
    expect(html.match(/highlight/g)).toHaveLength(1);
  });
});
