import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { createRealProviders } from '../src/providers/real.js';
import { admitJob, earlierRefusal, runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import {
  EARLIER_BATCH_DAYS, FIRST_SCAN_DAYS, HISTORY_FLOOR, earlierBatch, firstScanStart, mergeRanges, planEarlier, planRanges,
} from '../src/scanner/ranges.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, demoData, demoFetch } from '../src/cli/demo.js';
import type { ScanInput } from '../src/scanner/engine.js';
import type { Job, Range } from '../src/scanner/types.js';
import { removeTempFolder } from './temp-folder.js';

const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const path of directories.splice(0)) await removeTempFolder(path);
});
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'layered-scan-')); directories.push(directory);
  const store = new SqliteRewardsStore(join(directory, 'test.sqlite')); stores.push(store); return store;
}
const DAY = 86400;
const limits = { stonkfun: 30, helius: 200, pages: 200, resumes: 5, deadline: cutoff * 1000 + 30 * DAY * 1000 };
const input = (overrides: Partial<ScanInput> = {}): ScanInput => ({ wallet, cutoff, jobId: 'admitted', owner: 'owner', limits, ...overrides });
/** Every history request's half-open range, as the fixture Helius endpoint received it; `fail` answers a range with a 503. */
function harness(store: SqliteRewardsStore, fail: (range: Range) => boolean = () => false) {
  let clock = cutoff * 1000;
  const now = () => { clock += 1000; return clock; };
  const requested: Range[] = [];
  const fixture = demoFetch(demoData(), now);
  const fetch: typeof globalThis.fetch = (resource, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string; params: [string, { filters: { blockTime: { gte: number; lte: number } } }] } : null;
    if (body?.method === 'getTransactionsForAddress') {
      const { gte, lte } = body.params[1].filters.blockTime;
      const range = { startTime: gte, endTime: lte + 1 };
      requested.push(range);
      if (fail(range)) return Promise.resolve(new Response('{}', { status: 503 }));
    }
    return fixture(resource, init);
  };
  let sequence = 0;
  return { requested, scan(overrides: Partial<ScanInput> = {}) {
    sequence++;
    return runScan(store, input({ jobId: `layered-${sequence}`, owner: `owner-${sequence}`, ...overrides }),
      job => createRealProviders({ store, job, apiKey: 'synthetic-key', fetch, now, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } }), { now });
  } };
}
const union = (ranges: readonly Range[]) => mergeRanges(ranges.map(({ startTime, endTime }) => ({ startTime, endTime })));
const loadedFrom = (store: SqliteRewardsStore) => store.wallet('mainnet-beta', wallet)!.trackingStart;
/** A wallet first scanned under the old ten-day rule and never floor-scanned: loaded, and covered, from a later day. */
function laterWallet(store: SqliteRewardsStore, start: number, end: number) {
  const job: Job = { id: 'later-job', network: 'mainnet-beta', wallet, cutoff: end, createdAt: end * 1000, status: 'complete',
    limits, used: { stonkfun: 1, helius: 1, pages: 1, resumes: 1 }, pageSize: 100, error: null, registryDone: true, hydrationDone: true };
  store.atomic(() => {
    store.saveWallet({ network: 'mainnet-beta', wallet, trackingStart: start, cutoff: end, lastSync: new Date(end * 1000).toISOString() });
    store.saveJob(job); store.createRanges(job, [{ startTime: start, endTime: end }]); store.completeRange(job, store.ranges(job.id)[0]!);
  });
}

describe('layered scanning: first scan', () => {
  it('plans the seven days before the cutoff for a wallet with no coverage', async () => {
    expect(FIRST_SCAN_DAYS).toBe(7); expect(EARLIER_BATCH_DAYS).toBe(7);
    const store = open(); const job = admitJob(store, input(), cutoff * 1000);
    expect(loadedFrom(store)).toBe(cutoff - 7 * DAY);
    expect(job).toMatchObject({ kind: 'refresh', batch: { kind: 'first', startTime: cutoff - 7 * DAY, endTime: cutoff } });
    expect(union(store.ranges(job.id))).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(store.ranges(job.id)).toHaveLength(7);

    const scanned = open(); const h = harness(scanned); const done = await h.scan();
    expect(done.status).toBe('complete');
    expect(union(h.requested)).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(scanned.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(scanned.wallet('mainnet-beta', wallet)!.lastBatch).toMatchObject({ kind: 'first', jobId: done.id, startTime: cutoff - 7 * DAY, endTime: cutoff, days: 7 });
    expect(scanned.wallet('mainnet-beta', wallet)!.lastBatch!.elapsedSeconds).toBeGreaterThan(0);
  });

  it('clips at the floor when seven days would cross it', () => {
    const early = HISTORY_FLOOR + 3 * DAY + 100;
    expect(firstScanStart(early)).toBe(HISTORY_FLOOR);
    const store = open(); const job = admitJob(store, input({ cutoff: early }), early * 1000);
    expect(loadedFrom(store)).toBe(HISTORY_FLOOR);
    expect(union(store.ranges(job.id))).toEqual([{ startTime: HISTORY_FLOOR, endTime: early }]);
    expect(store.ranges(job.id)).toHaveLength(4);
  });
});

describe('layered scanning: refresh', () => {
  it('never plans before the oldest loaded day, and retries a failed gap inside the loaded range', async () => {
    const store = open();
    const failed = { startTime: cutoff - 5 * DAY, endTime: cutoff - 4 * DAY };
    let failing = true;
    const h = harness(store, range => failing && range.startTime === failed.startTime);
    const first = await h.scan();
    expect(first.status).toBe('paused');
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 7 * DAY, endTime: failed.startTime }, { startTime: failed.endTime, endTime: cutoff }]);
    // A later refresh plans the failed day, with the usual overlap, and the new tail; nothing before the oldest loaded day.
    const planned = planRanges(cutoff + DAY, store.coverage('mainnet-beta', wallet), loadedFrom(store));
    expect(union(planned)).toEqual([{ startTime: failed.startTime - 60, endTime: failed.endTime }, { startTime: cutoff - 60, endTime: cutoff + DAY }]);
    failing = false;
    const resumed = await h.scan({ resume: first.id });
    expect(resumed.status).toBe('complete');
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    const refresh = admitJob(store, input({ jobId: 'refresh-again' }), cutoff * 1000 + 60_000);
    expect(store.ranges(refresh.id).map(({ startTime, endTime }) => ({ startTime, endTime }))).toEqual([{ startTime: cutoff - 60, endTime: cutoff }]);
    for (const range of h.requested) expect(range.startTime).toBeGreaterThanOrEqual(cutoff - 7 * DAY);
    expect(loadedFrom(store)).toBe(cutoff - 7 * DAY);
  });

  it('keeps the oldest loaded day of a wallet first covered from a later day', () => {
    const store = open(); const start = cutoff - 10 * DAY; const end = cutoff - 3 * DAY;
    laterWallet(store, start, end);
    const job = admitJob(store, input(), cutoff * 1000);
    expect(union(store.ranges(job.id))).toEqual([{ startTime: end - 60, endTime: cutoff }]);
    expect(job.batch).toBeUndefined();
    expect(loadedFrom(store)).toBe(start);
  });
});

describe('layered scanning: Load earlier', () => {
  it('plans the seven days before the oldest loaded day, clips at the floor, and is refused at the floor', async () => {
    const store = open(); const h = harness(store);
    expect(earlierRefusal(store, 'mainnet-beta', wallet)).toBe('wallet_not_loaded');
    expect(() => admitJob(store, input({ kind: 'earlier' }), cutoff * 1000)).toThrow('wallet_not_loaded');
    await h.scan();
    const lastSync = store.wallet('mainnet-beta', wallet)!.lastSync;
    const confirmedBefore = buildReport(store, wallet).counts.confirmed;
    expect(earlierRefusal(store, 'mainnet-beta', wallet)).toBeNull();
    expect(earlierBatch(loadedFrom(store))).toEqual({ startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY });

    h.requested.length = 0;
    const one = await h.scan({ kind: 'earlier', cutoff: cutoff - DAY });
    expect(one).toMatchObject({ status: 'complete', kind: 'earlier', cutoff, batch: { kind: 'earlier', startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY } });
    expect(union(h.requested)).toEqual([{ startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY }]);
    // Seven days, each read and then checked with the same range.
    expect(h.requested).toHaveLength(14);
    expect(loadedFrom(store)).toBe(cutoff - 14 * DAY);
    // The saved cutoff and last refresh stay; the receipt eight days back is now counted.
    expect(store.wallet('mainnet-beta', wallet)).toMatchObject({ cutoff, lastSync, lastBatch: { kind: 'earlier', jobId: one.id, days: 7 } });
    expect(buildReport(store, wallet).counts.confirmed).toBe(confirmedBefore + 1);

    // Each later batch takes the next seven days back; the one reaching the floor is clipped there.
    const batches = [];
    while (earlierRefusal(store, 'mainnet-beta', wallet) === null) {
      h.requested.length = 0;
      const batch = (await h.scan({ kind: 'earlier' })).batch!;
      batches.push(batch);
      expect(union(h.requested)).toEqual([{ startTime: batch.startTime, endTime: batch.endTime }]);
      expect(loadedFrom(store)).toBe(batch.startTime);
    }
    const whole = Math.floor((cutoff - 14 * DAY - HISTORY_FLOOR) / (7 * DAY));
    expect(batches).toEqual([
      ...Array.from({ length: whole }, (_, index) => ({ kind: 'earlier', startTime: cutoff - (21 + 7 * index) * DAY, endTime: cutoff - (14 + 7 * index) * DAY })),
      { kind: 'earlier', startTime: HISTORY_FLOOR, endTime: cutoff - (14 + 7 * whole) * DAY }]);
    expect(loadedFrom(store)).toBe(HISTORY_FLOOR);
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: HISTORY_FLOOR, endTime: cutoff }]);

    expect(earlierBatch(HISTORY_FLOOR)).toBeNull();
    expect(earlierRefusal(store, 'mainnet-beta', wallet)).toBe('earlier_history_at_floor');
    expect(() => admitJob(store, input({ jobId: 'at-floor', kind: 'earlier' }), cutoff * 1000)).toThrow('earlier_history_at_floor');
  });

  it('keeps an interrupted batch’s completed days, and the next Load earlier finishes that batch first', async () => {
    const store = open(); const h = harness(store);
    await h.scan();
    // Three pages in, the batch stops at its page budget with its three oldest days saved.
    const stopped = await h.scan({ kind: 'earlier', limits: { ...limits, pages: 3 } });
    expect(stopped.status).toBe('exhausted');
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 14 * DAY, endTime: cutoff - 11 * DAY }, { startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(loadedFrom(store)).toBe(cutoff - 7 * DAY);
    expect(store.wallet('mainnet-beta', wallet)!.lastBatch).toMatchObject({ kind: 'first' });
    // A refresh meanwhile stays inside the loaded range.
    const refresh = admitJob(store, input({ jobId: 'refresh-between' }), cutoff * 1000 + 60_000);
    expect(store.ranges(refresh.id).every(range => range.startTime >= cutoff - 7 * DAY)).toBe(true);
    store.atomic(() => { store.saveJob({ ...refresh, status: 'complete' }); });

    h.requested.length = 0;
    const finished = await h.scan({ kind: 'earlier' });
    expect(finished).toMatchObject({ status: 'complete', batch: { startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY } });
    expect(union(h.requested)).toEqual([{ startTime: cutoff - 11 * DAY - 60, endTime: cutoff - 7 * DAY }]);
    expect(planEarlier({ startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY }, [{ startTime: cutoff - 14 * DAY, endTime: cutoff }])).toEqual([]);
    expect(loadedFrom(store)).toBe(cutoff - 14 * DAY);
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 14 * DAY, endTime: cutoff }]);
    expect(store.wallet('mainnet-beta', wallet)!.lastBatch).toMatchObject({ kind: 'earlier', jobId: finished.id, days: store.ranges(finished.id).length });
  });

  it('resumes a paused batch as the same job, and refuses to replace an unfinished job of the other kind', async () => {
    const store = open(); let failing = true;
    const h = harness(store, range => failing && range.startTime >= cutoff - 14 * DAY && range.startTime < cutoff - 13 * DAY);
    await h.scan();
    const paused = await h.scan({ kind: 'earlier' });
    expect(paused.status).toBe('paused');
    expect(loadedFrom(store)).toBe(cutoff - 7 * DAY);
    expect(() => admitJob(store, input({ jobId: 'refresh-over-paused' }), cutoff * 1000 + 60_000)).toThrow('other_job_unfinished');
    failing = false;
    const resumed = await h.scan({ kind: 'earlier' });
    expect(resumed).toMatchObject({ id: paused.id, status: 'complete' });
    expect(loadedFrom(store)).toBe(cutoff - 14 * DAY);
  });
});
