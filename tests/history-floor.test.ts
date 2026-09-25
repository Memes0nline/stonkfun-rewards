import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { createRealProviders } from '../src/providers/real.js';
import { admitJob, runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import { HISTORY_FLOOR, historyTarget, mergeRanges, planRanges } from '../src/scanner/ranges.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, demoData, demoFetch, demoTransaction } from '../src/cli/demo.js';
import { reportView } from '../src/web/view.js';
import { historyStatus } from '../web/model.js';
import type { DemoData } from '../src/cli/demo.js';
import type { ScanInput } from '../src/scanner/engine.js';
import type { Job, Range, ScanProgress } from '../src/scanner/types.js';

const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'history-floor-')); directories.push(directory);
  const store = new SqliteRewardsStore(join(directory, 'test.sqlite')); stores.push(store); return store;
}
const DAY = 86400;
/** Every history request's half-open range, as the fixture Helius endpoint received it. */
function harness(store: SqliteRewardsStore, data: DemoData = demoData(), failBefore?: () => number) {
  let clock = cutoff * 1000;
  const now = () => { clock += 1000; return clock; };
  const requested: Range[] = [];
  const fixture = demoFetch(data, now);
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string; params: [string, { filters: { blockTime: { gte: number; lte: number } } }] } : null;
    if (body?.method === 'getTransactionsForAddress') {
      const { gte, lte } = body.params[1].filters.blockTime;
      requested.push({ startTime: gte, endTime: lte + 1 });
      if (failBefore && gte < failBefore()) return Promise.resolve(new Response('{}', { status: 503 }));
    }
    return fixture(input, init);
  };
  let sequence = 0;
  const events: ScanProgress[] = [];
  return { data, now, requested, events, scan(overrides: Partial<ScanInput> = {}) {
    sequence++;
    return runScan(store, { wallet, cutoff, jobId: `floor-job-${sequence}`, owner: `owner-${sequence}`,
      limits: { stonkfun: 30, helius: 200, pages: 200, resumes: 5, deadline: now() + DAY * 1000 }, ...overrides },
    job => createRealProviders({ store, job, apiKey: 'synthetic-key', fetch, now, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } }),
    { now, progress: event => { events.push(event); } });
  } };
}
/** A wallet first scanned under the old ten-day rule, covered from a later day than the floor. The floor build's admission
 * lowered its oldest loaded day to the floor, as it did for wallets loaded before the floor moved, so it now counts as covered from the floor. */
function tenDayWallet(store: SqliteRewardsStore, start: number, end: number, loadedFrom = HISTORY_FLOOR) {
  const job: Job = { id: 'ten-day-job', network: 'mainnet-beta', wallet, cutoff: end, createdAt: end * 1000, status: 'complete',
    limits: { stonkfun: 30, helius: 100, pages: 100, resumes: 5, deadline: end * 1000 + 3_600_000 },
    used: { stonkfun: 1, helius: 1, pages: 1, resumes: 1 }, pageSize: 100, error: null, registryDone: true, hydrationDone: true };
  store.atomic(() => {
    store.saveWallet({ network: 'mainnet-beta', wallet, trackingStart: loadedFrom, cutoff: end, lastSync: new Date(end * 1000).toISOString() });
    store.saveJob(job); store.createRanges(job, [{ startTime: start, endTime: end }]);
    store.completeRange(job, store.ranges(job.id)[0]!);
  });
}
const union = (ranges: readonly Range[]) => mergeRanges(ranges.map(({ startTime, endTime }) => ({ startTime, endTime })));

describe('history floor', () => {
  it('is one constant at the start of the floor day, and the target runs from it to the cutoff', () => {
    expect(new Date(HISTORY_FLOOR * 1000).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(historyTarget(cutoff)).toEqual({ startTime: HISTORY_FLOOR, endTime: cutoff });
    for (const bad of [HISTORY_FLOOR, HISTORY_FLOOR - 1, 0, 1.5, Number.NaN]) expect(() => historyTarget(bad)).toThrow('Invalid history cutoff');
  });

  it('plans one range from the floor to now when the loaded range starts at the floor with no coverage', () => {
    const planned = planRanges(cutoff, []);
    expect(union(planned)).toEqual([{ startTime: HISTORY_FLOOR, endTime: cutoff }]);
    expect(planned).toHaveLength(Math.ceil((cutoff - HISTORY_FLOOR) / DAY));
    for (const range of planned) expect(range.endTime - range.startTime).toBeLessThanOrEqual(DAY);
  });

  it('plans the days before the first covered day of a floor-loaded wallet, keeping its coverage', () => {
    const store = open(); const start = cutoff - 10 * DAY; const end = cutoff - 3 * DAY;
    tenDayWallet(store, start, end);
    const job = admitJob(store, { wallet, cutoff, jobId: 'widened', owner: 'owner',
      limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: cutoff * 1000 + 60_000 } }, cutoff * 1000);
    expect(union(store.ranges(job.id))).toEqual([{ startTime: HISTORY_FLOOR, endTime: start }, { startTime: end - 60, endTime: cutoff }]);
    expect(store.ranges(job.id)[0]!.startTime).toBe(HISTORY_FLOOR);
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: start, endTime: end }]);
    expect(store.wallet('mainnet-beta', wallet)!.trackingStart).toBe(HISTORY_FLOOR);
  });

  it('scans the earlier days with the same overlap and dedupe, merges touching coverage and reports days', async () => {
    const store = open(); const start = cutoff - 10 * DAY; const end = cutoff - 3 * DAY;
    const data = demoData();
    const early = demoTransaction('A', HISTORY_FLOOR + 2 * DAY + 5); const boundary = demoTransaction('B', end - 30);
    data.transactions.push(early, boundary);
    tenDayWallet(store, start, end);
    // The boundary transaction was saved by the earlier scan; the 60-second overlap fetches it again.
    store.atomic(() => {
      store.addTransaction('mainnet-beta', boundary, { source: 'helius', evidenceId: 'ten-day-page', retrievedAt: new Date(end * 1000).toISOString(), commitment: 'finalized' });
      store.watch('mainnet-beta', boundary.transaction.signatures[0]!, wallet);
    });
    const h = harness(store, data); const job = await h.scan();
    expect(job.status).toBe('complete');
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: HISTORY_FLOOR, endTime: cutoff }]);
    expect(h.requested.some(range => range.startTime === end - 60)).toBe(true);
    expect(store.evidence('mainnet-beta', boundary.transaction.signatures[0]!).transactions).toHaveLength(1);
    expect(store.hasTransaction('mainnet-beta', early.transaction.signatures[0]!)).toBe(true);
    for (const range of h.requested) expect(range.startTime).toBeGreaterThanOrEqual(HISTORY_FLOOR);
    const report = buildReport(store, wallet);
    expect(report.trackingStart).toBe(HISTORY_FLOOR); expect(report.coverage.gaps).toEqual([]);
    const days = store.ranges(job.id).length;
    expect(h.events.find(event => event.phase === 'planning' && event.kind === 'completed')).toMatchObject({
      action: `${days} days planned`, progress: { completed: days, total: days, unit: 'days' } });
    expect(h.events.find(event => event.phase === 'history' && event.kind === 'completed')).toMatchObject({
      action: `All ${days} planned days saved`, progress: { completed: days, total: days, unit: 'days' } });
  });

  it('keeps coverage and rows when a scan fails, records the gap, and the next plan resumes there', async () => {
    const store = open(); const start = cutoff - 10 * DAY; const end = cutoff - 3 * DAY;
    tenDayWallet(store, start, end);
    let failBefore = HISTORY_FLOOR + DAY;
    const h = harness(store, demoData(), () => failBefore);
    const failed = await h.scan();
    expect(failed.status).toBe('paused');
    // Every day but the failed first one is covered; the ten-day coverage and its neighbours merged into one range.
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: HISTORY_FLOOR + DAY, endTime: cutoff }]);
    const report = buildReport(store, wallet);
    expect(report.coverage.gaps).toEqual([{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + DAY }]);
    expect(report.counts.confirmed).toBeGreaterThan(0);
    expect(store.hasTransaction('mainnet-beta', demoData().transactions[0]!.transaction.signatures[0]!)).toBe(true);
    expect(planRanges(cutoff + 60, store.coverage('mainnet-beta', wallet))).toEqual([
      { startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + DAY }, { startTime: cutoff - 60, endTime: cutoff + 60 }]);
    failBefore = 0;
    const resumed = await h.scan({ resume: failed.id });
    expect(resumed.status).toBe('complete');
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: HISTORY_FLOOR, endTime: cutoff }]);
    expect(buildReport(store, wallet).coverage.gaps).toEqual([]);
    for (const range of h.requested) expect(range.startTime).toBeGreaterThanOrEqual(HISTORY_FLOOR);
  });

  it('never starts a range before the floor', () => {
    // Coverage ending just after the floor would overlap back past it; coverage before the floor is not a gap.
    expect(planRanges(HISTORY_FLOOR + DAY, [{ startTime: HISTORY_FLOOR - 5 * DAY, endTime: HISTORY_FLOOR + 30 }]))
      .toEqual([{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + DAY }]);
    expect(planRanges(HISTORY_FLOOR + 30, [{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 30 }]))
      .toEqual([{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 30 }]);
    for (const coverage of [[], [{ startTime: HISTORY_FLOOR + DAY, endTime: HISTORY_FLOOR + 3 * DAY }], [{ startTime: 0, endTime: HISTORY_FLOOR + 10 }]]) {
      for (const range of planRanges(cutoff, coverage)) expect(range.startTime).toBeGreaterThanOrEqual(HISTORY_FLOOR);
    }
    const store = open();
    expect(() => admitJob(store, { wallet, cutoff: HISTORY_FLOOR, jobId: 'too-early', owner: 'owner',
      limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: cutoff * 1000 } }, cutoff * 1000)).toThrow('Invalid history cutoff');
    expect(store.wallet('mainnet-beta', wallet)).toBeUndefined();
  });

  it('offers a wallet loaded from 2026-09-01 the week before it, and keeps what it saved', async () => {
    const day = (text: string) => Date.parse(`${text}T00:00:00Z`) / 1000;
    const store = open(); tenDayWallet(store, day('2026-09-01'), cutoff, day('2026-09-01'));
    const saved = { wallet: store.wallet('mainnet-beta', wallet), coverage: store.coverage('mainnet-beta', wallet) };
    const report = buildReport(store, wallet);
    expect(report.history).toMatchObject({ floor: HISTORY_FLOOR, loadedFrom: day('2026-09-01'), oldestLoadedDay: '2026-09-01', earlierRemaining: true,
      notLoadedYet: { startTime: HISTORY_FLOOR, endTime: day('2026-09-01'), days: 31 }, nextBatch: { startTime: day('2026-08-25'), endTime: day('2026-09-01'), days: 7 } });
    expect(report.coverage.gaps).toEqual([]);
    expect(historyStatus(reportView(report))).toEqual({ loaded: 'Loaded 2026-09-01 → today', left: '31 days left to Aug 1',
      earlier: { label: 'Load earlier history', note: null, range: 'Loads 2026-08-25 → 2026-08-31' } });
    // Reading the report changes nothing saved.
    expect({ wallet: store.wallet('mainnet-beta', wallet), coverage: store.coverage('mainnet-beta', wallet) }).toEqual(saved);

    const h = harness(store);
    const job = await h.scan({ kind: 'earlier' });
    expect(job).toMatchObject({ status: 'complete', batch: { kind: 'earlier', startTime: day('2026-08-25'), endTime: day('2026-09-01') } });
    expect(union(h.requested)).toEqual([{ startTime: day('2026-08-25'), endTime: day('2026-09-01') }]);
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: day('2026-08-25'), endTime: cutoff }]);
    expect(buildReport(store, wallet).history).toMatchObject({ loadedFrom: day('2026-08-25'), earlierRemaining: true,
      nextBatch: { startTime: day('2026-08-18'), endTime: day('2026-08-25'), days: 7 } });
  });

  it('merges touching coverage into one continuous range', () => {
    expect(mergeRanges([{ startTime: 20, endTime: 30 }, { startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }]))
      .toEqual([{ startTime: 10, endTime: 30 }, { startTime: 40, endTime: 50 }]);
    const store = open(); tenDayWallet(store, cutoff - 3 * DAY, cutoff - DAY);
    const job = store.job('ten-day-job', 'mainnet-beta')!;
    store.createRanges(job, [{ startTime: cutoff - 5 * DAY, endTime: cutoff - 3 * DAY }]);
    store.completeRange(job, store.ranges(job.id).at(-1)!);
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 5 * DAY, endTime: cutoff - DAY }]);
  });
});
