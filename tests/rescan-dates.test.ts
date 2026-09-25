import { describe, expect, it } from 'vitest';
import { ALL_CHECKED_TEXT, dayStates, daysToCheck, doneText, jobKindText, loadedDays, NONE_CONFIRMED_TEXT, progressTitle, rescanButtonText, rescanDoneText, rescanError,
  rescanSections, rescanSummary, rescanWeekLabel, rescanWeeks, weekOf } from '../web/model.js';
import { DEMO_CUTOFF } from '../src/cli/demo.js';

const at = (text: string) => Date.parse(`${text}Z`) / 1000;
/** A wallet loaded from Tuesday 2026-09-01 to a Thursday cutoff. */
const september = { trackingStart: at('2026-09-01T00:00:00'), cutoff: at('2026-09-24T20:48:17') };
/** A first scan: seven days before the demo cutoff, Monday 2026-09-14 14:13 to Monday 2026-09-21 14:13. */
const firstScan = { trackingStart: DEMO_CUTOFF - 7 * 86400, cutoff: DEMO_CUTOFF };

describe('Rescan dates quick picks', () => {
  it('offer each Monday-to-Sunday UTC week holding a loaded day, newest first, clipped to the loaded days', () => {
    expect(loadedDays(september)).toEqual({ first: '2026-09-01', last: '2026-09-24' });
    expect(rescanWeeks(september)).toEqual([
      { start: '2026-09-21', end: '2026-09-24' }, { start: '2026-09-14', end: '2026-09-20' },
      { start: '2026-09-07', end: '2026-09-13' }, { start: '2026-09-01', end: '2026-09-06' }]);
    expect(rescanWeeks(firstScan)).toEqual([{ start: '2026-09-21', end: '2026-09-21' }, { start: '2026-09-14', end: '2026-09-20' }]);
    // A cutoff at midnight ends the loaded range on the day before.
    expect(rescanWeeks({ trackingStart: at('2026-09-14T00:00:00'), cutoff: at('2026-09-21T00:00:00') })).toEqual([{ start: '2026-09-14', end: '2026-09-20' }]);
    for (const week of rescanWeeks(september)) expect(rescanError(september, week.start, week.end)).toBeNull();
  });
  it('pick the week of a day, clipped the same way', () => {
    expect(weekOf(september, '2026-09-17')).toEqual({ start: '2026-09-14', end: '2026-09-20' });
    expect(weekOf(september, '2026-09-02')).toEqual({ start: '2026-09-01', end: '2026-09-06' });
    expect(weekOf(september, '2026-09-24')).toEqual({ start: '2026-09-21', end: '2026-09-24' });
  });
});

describe('Rescan dates limits', () => {
  it('allow at most seven days, all inside the loaded range', () => {
    expect(rescanError(september, '2026-09-14', '2026-09-20')).toBeNull();
    expect(rescanError(september, '2026-09-10', '2026-09-10')).toBeNull();
    expect(rescanError(september, '2026-09-14', '2026-09-21')).toBe('Rescan at most 7 days at a time; this is 8.');
    expect(rescanError(september, '2026-08-31', '2026-09-03')).toBe('Rescan only loaded days, 2026-09-01 → 2026-09-24.');
    expect(rescanError(september, '2026-09-22', '2026-09-25')).toBe('Rescan only loaded days, 2026-09-01 → 2026-09-24.');
    expect(rescanError(september, '2026-09-20', '2026-09-14')).toBe('The start must be on or before the end.');
    expect(rescanError(september, '2026-02-30', '2026-09-14')).toBe('Enter both days as real UTC dates.');
    expect(rescanError(september, '', '2026-09-14')).toBe('Enter both days as real UTC dates.');
  });
});

describe('Rescan dates text', () => {
  it('names the exact range before it starts', () => {
    expect(rescanSummary('2026-09-14', '2026-09-20')).toBe('Rescan 2026-09-14 → 2026-09-20 (7 days). Checks these days again and adds anything missed. Payouts already saved are not counted twice.');
    expect(rescanSummary('2026-09-21', '2026-09-21')).toBe('Rescan 2026-09-21 → 2026-09-21 (1 day). Checks these days again and adds anything missed. Payouts already saved are not counted twice.');
  });
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

describe('Rescan dates sections', () => {
  // Loaded 2026-09-01 → 2026-09-24: 09-01 to 09-13 and 09-21, 09-23 and 09-24 checked, 09-14 to 09-20 read once, and 09-22 partly not loaded.
  const report = { ...september, coverage: { gaps: [], verifiedZero: false as const,
    completed: [{ startTime: september.trackingStart, endTime: at('2026-09-22T06:00:00') }, { startTime: at('2026-09-22T12:00:00'), endTime: september.cutoff }],
    checked: [{ startTime: september.trackingStart, endTime: at('2026-09-14T00:00:00') }, { startTime: at('2026-09-21T00:00:00'), endTime: at('2026-09-22T00:00:00') },
      { startTime: at('2026-09-23T00:00:00'), endTime: september.cutoff }] } };
  it('sort each week into To check, with its read-once and partial days counted, or Already confirmed, newest first', () => {
    expect(rescanSections(report)).toEqual({
      toCheck: [{ start: '2026-09-21', end: '2026-09-24', toCheck: 1 }, { start: '2026-09-14', end: '2026-09-20', toCheck: 7 }],
      confirmed: [{ start: '2026-09-07', end: '2026-09-13', toCheck: 0 }, { start: '2026-09-01', end: '2026-09-06', toCheck: 0 }] });
    // One unchecked day anywhere in a week keeps the whole week to check.
    const oneDay = { ...report, coverage: { ...report.coverage, completed: [{ startTime: september.trackingStart, endTime: september.cutoff }],
      checked: [{ startTime: september.trackingStart, endTime: at('2026-09-10T00:00:00') }, { startTime: at('2026-09-11T00:00:00'), endTime: september.cutoff }] } };
    expect(rescanSections(oneDay).toCheck).toEqual([{ start: '2026-09-07', end: '2026-09-13', toCheck: 1 }]);
    expect(rescanSections(oneDay).confirmed.map(week => week.start)).toEqual(['2026-09-21', '2026-09-14', '2026-09-01']);
  });
  it('label a week by its days to check, or as confirmed', () => {
    expect(rescanSections(report).toCheck.map(rescanWeekLabel)).toEqual(['2026-09-21 → 2026-09-24 · 1 day to check', '2026-09-14 → 2026-09-20 · 7 days to check']);
    expect(rescanSections(report).confirmed.map(rescanWeekLabel)).toEqual(['2026-09-07 → 2026-09-13 · confirmed', '2026-09-01 → 2026-09-06 · confirmed']);
  });
  it('leave To check empty once every loaded day is checked, and Already confirmed empty before any week is', () => {
    const all = { ...report, coverage: { ...report.coverage, completed: [{ startTime: september.trackingStart, endTime: september.cutoff }],
      checked: [{ startTime: september.trackingStart, endTime: september.cutoff }] } };
    expect(rescanSections(all)).toEqual({ toCheck: [], confirmed: rescanWeeks(september).map(week => ({ ...week, toCheck: 0 })) });
    expect(ALL_CHECKED_TEXT).toBe('Every loaded day is checked.');
    const none = { ...report, coverage: { ...report.coverage, checked: [] } };
    expect(rescanSections(none).confirmed).toEqual([]);
    expect(rescanSections(none).toCheck.map(week => week.toCheck)).toEqual([4, 7, 7, 6]);
    expect(NONE_CONFIRMED_TEXT).toBe('No week is fully checked yet.');
  });
  it('count the days still to check on the header button, and name it alone when there are none', () => {
    expect(daysToCheck(report)).toBe(8);
    expect(rescanButtonText(daysToCheck(report))).toBe('Rescan dates · 8 days to check');
    expect(rescanButtonText(1)).toBe('Rescan dates · 1 day to check');
    expect(rescanButtonText(1234)).toBe('Rescan dates · 1,234 days to check');
    const all = { ...report, coverage: { ...report.coverage, completed: [{ startTime: september.trackingStart, endTime: september.cutoff }],
      checked: [{ startTime: september.trackingStart, endTime: september.cutoff }] } };
    expect(daysToCheck(all)).toBe(0);
    expect(rescanButtonText(daysToCheck(all))).toBe('Rescan dates');
  });
  it('add that the range is now checked only when every day in it agreed', () => {
    const check = { startTime: at('2026-09-14T00:00:00'), endTime: at('2026-09-21T00:00:00'), days: 7 };
    const result = { days: 7, checkedDays: 7, unconfirmedDays: 0, newTransactions: 0, newPayouts: 0, alreadySaved: 2, newVerified: 0, verifiedAlreadySaved: 0 };
    expect(rescanDoneText({ check, checkResult: result })).toBe('Rescanned 2026-09-14 → 2026-09-20: 0 new payouts found, 2 already saved. Every day in this range is now checked.');
    expect(rescanDoneText({ check, checkResult: { ...result, checkedDays: 6, unconfirmedDays: 1 } })).not.toContain('now checked');
    expect(rescanDoneText({ check, checkResult: { ...result, checkedDays: 6 } })).not.toContain('now checked');
  });
});
