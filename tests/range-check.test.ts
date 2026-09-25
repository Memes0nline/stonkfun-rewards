import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { createRealProviders } from '../src/providers/real.js';
import { admitJob, runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import { CHECK_MAX_DAYS, planCheck } from '../src/scanner/ranges.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, demoData, demoFetch } from '../src/cli/demo.js';
import type { DemoData } from '../src/cli/demo.js';
import type { ScanInput } from '../src/scanner/engine.js';
import { removeTempFolder } from './temp-folder.js';

const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const path of directories.splice(0)) await removeTempFolder(path);
});
const paths = new WeakMap<SqliteRewardsStore, string>();
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'range-check-')); directories.push(directory);
  const store = new SqliteRewardsStore(join(directory, 'test.sqlite')); stores.push(store); paths.set(store, join(directory, 'test.sqlite')); return store;
}
/** Job bookkeeping, which every job writes: its record, its ranges, the wallet lease, caches and provider cooldowns. */
const BOOKKEEPING = ['jobs', 'ranges', 'leases', 'cache', 'cooldowns'];
/** Every saved row outside job bookkeeping, table by table, each row with all its fields, read through a second read-only
 * connection so nothing the store holds in memory is compared. */
function savedRows(store: SqliteRewardsStore) {
  const db = new DatabaseSync(paths.get(store)!, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => String(row.name)).filter(name => !BOOKKEEPING.includes(name));
    return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}
const DAY = 86400;
const network = 'mainnet-beta';
const limits = { stonkfun: 30, helius: 200, pages: 200, resumes: 5, deadline: cutoff * 1000 + 30 * DAY * 1000 };
const signature = (character: string) => character.repeat(88);
/** The cutoff's UTC day, where every demo transaction of the first scan falls, and the first scan's loaded range. */
const cutoffDay = Math.floor(cutoff / DAY) * DAY;
const loaded = { startTime: cutoff - 7 * DAY, endTime: cutoff };
interface Request { details: 'full' | 'signatures'; startTime: number; endTime: number }
/** Scans against the demo network. `options.listing` false drops the signatures listing (ranges are read once, as before the
 * check existed) and `options.hydrate` false skips feed hydration, so a transaction the history leaves out stays unsaved. */
function harness(store: SqliteRewardsStore, data: DemoData = demoData(), options = { listing: true, hydrate: true }) {
  let clock = cutoff * 1000;
  const now = () => { clock += 1000; return clock; };
  const requests: Request[] = [];
  /** Each history request's options other than its range, cursor and mode. */
  const shapes: unknown[] = [];
  const fixture = demoFetch(data, now);
  const fetch: typeof globalThis.fetch = (resource, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method: string; params: [string, { transactionDetails: 'full' | 'signatures'; filters: { blockTime: { gte: number; lte: number } } }] } : null;
    if (body?.method === 'getTransactionsForAddress') {
      const { gte, lte } = body.params[1].filters.blockTime;
      requests.push({ details: body.params[1].transactionDetails, startTime: gte, endTime: lte + 1 });
      const options = { ...body.params[1] } as Record<string, unknown> & { filters: Record<string, unknown> };
      delete options.transactionDetails; delete options.paginationToken;
      shapes.push({ ...options, filters: { ...options.filters, blockTime: null } });
    }
    return fixture(resource, init);
  };
  let sequence = 0;
  return { data, requests, shapes, options, scan(overrides: Partial<ScanInput> = {}) {
    sequence++;
    return runScan(store, { wallet, cutoff, jobId: `check-${sequence}`, owner: `owner-${sequence}`, limits, ...overrides }, job => {
      const providers = createRealProviders({ store, job, apiKey: 'synthetic-key', fetch, now, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } });
      if (!options.listing) delete providers.signatures;
      if (!options.hydrate) providers.hydrate = () => Promise.resolve(null);
      return providers;
    }, { now });
  } };
}
const rows = (store: SqliteRewardsStore) => buildReport(store, wallet).counts;
const watched = (store: SqliteRewardsStore, character: string) => store.hasTransaction(network, signature(character)) && store.watchers(network, signature(character)).includes(wallet);

describe('range check: every range read is checked', () => {
  it('catches a short full-mode page with its signatures listing and saves the missing rows', async () => {
    const baseline = open(); const reference = harness(baseline);
    expect((await reference.scan()).status).toBe('complete');

    const store = open(); const data = demoData();
    // The last day's full read returns one empty page with no pagination token, as the first scan of 2026-09-21 did.
    data.fullOmits = new Map(['3', '5', '6', '7'].map(character => [signature(character), 1]));
    const h = harness(store, data);
    const job = await h.scan();
    expect(job.status).toBe('complete');
    for (const character of ['3', '5', '6', '7']) expect(watched(store, character)).toBe(true);
    expect(rows(store)).toEqual(rows(baseline));
    const last = store.ranges(job.id).at(-1)!;
    expect(last).toMatchObject({ startTime: cutoff - DAY, endTime: cutoff, status: 'complete', pages: 1 });
    expect(last.check).toMatchObject({ status: 'agreed', listed: 4, alreadySaved: 0, missing: 0, unlisted: 0 });
    expect([...last.check!.recovered].sort()).toEqual(['3', '5', '6', '7'].map(signature));
    // One listing per day; the missing span alone is fetched again in full mode.
    const lastDay = h.requests.filter(request => request.startTime >= cutoff - DAY);
    expect(lastDay).toEqual([{ details: 'full', startTime: cutoff - DAY, endTime: cutoff },
      { details: 'signatures', startTime: cutoff - DAY, endTime: cutoff }, { details: 'full', startTime: cutoff - 9000, endTime: cutoff - 3600 + 1 }]);
    expect(h.requests.filter(request => request.details === 'signatures')).toHaveLength(7);
    // The listing is the full read's own request in signatures mode, 1,000 a page, with every filter unchanged.
    const shape = (limit: number) => ({ encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized', sortOrder: 'asc', limit,
      filters: { blockTime: null, status: 'succeeded', tokenAccounts: 'balanceChanged', tokenTransfer: { direction: 'in' } } });
    expect(new Set(h.shapes.map(item => JSON.stringify(item)))).toEqual(new Set([JSON.stringify(shape(100)), JSON.stringify(shape(1000))]));
    expect(h.shapes.filter((_, index) => h.requests[index]!.details === 'signatures')).toEqual(Array(7).fill(shape(1000)));
    // Every extra request is in the job's counts.
    expect(job.used.helius).toBe(h.data.calls.helius);
    expect(store.coverage(network, wallet)).toEqual([loaded]);
    expect(store.wallet(network, wallet)!.checked).toEqual([loaded]);
    expect(job.checkResult).toMatchObject({ days: 7, checkedDays: 7, unconfirmedDays: 0, newTransactions: 4 });
  });

  it('marks a range partial while its full read and listing still disagree, and completes it once they agree', async () => {
    const baseline = open(); await harness(baseline).scan();
    const store = open(); const data = demoData();
    data.fullOmits = new Map([[signature('6'), Number.POSITIVE_INFINITY]]);
    const h = harness(store, data);
    const paused = await h.scan();
    expect(paused.status).toBe('paused');
    expect(paused.failure).toMatchObject({ class: 'check_disagreed' });
    const last = store.ranges(paused.id).at(-1)!;
    expect(last).toMatchObject({ status: 'pending', read: false, cursor: null, check: { status: 'disagreed', missing: 1, unlisted: 0 } });
    // The six other days are loaded and checked; the partial day is neither, and nothing saved is dropped.
    expect(store.coverage(network, wallet)).toEqual([{ startTime: loaded.startTime, endTime: cutoff - DAY }]);
    expect(store.wallet(network, wallet)!.checked).toEqual([{ startTime: loaded.startTime, endTime: cutoff - DAY }]);
    expect(watched(store, '6')).toBe(false);
    expect(watched(store, '7')).toBe(true);

    // Helius answers in full again: Resume reads the partial day from its start and checks it.
    data.fullOmits.clear();
    h.requests.length = 0;
    const resumed = await h.scan({ resume: paused.id });
    expect(resumed).toMatchObject({ id: paused.id, status: 'complete', failure: null });
    expect(h.requests.map(request => request.details)).toEqual(['full', 'signatures']);
    expect(store.coverage(network, wallet)).toEqual([loaded]);
    expect(store.wallet(network, wallet)!.checked).toEqual([loaded]);
    expect(rows(store)).toEqual(rows(baseline));
  });
});

describe('range check: a short listing', () => {
  it('leaves the range partial when the listing leaves out a transaction its full read saved', async () => {
    const store = open(); const data = demoData();
    data.listOmits = new Set([signature('7')]);
    const h = harness(store, data);
    const paused = await h.scan();
    expect(paused).toMatchObject({ status: 'paused', failure: { class: 'check_disagreed' } });
    expect(store.ranges(paused.id).at(-1)).toMatchObject({ status: 'pending', check: { status: 'disagreed', missing: 0, unlisted: 1 } });
    // The full read's rows stay saved; the day is simply not counted as loaded until the two agree.
    expect(watched(store, '7')).toBe(true);
    expect(store.coverage(network, wallet)).toEqual([{ startTime: loaded.startTime, endTime: cutoff - DAY }]);
    data.listOmits.clear();
    expect(await h.scan({ resume: paused.id })).toMatchObject({ status: 'complete' });
    expect(store.wallet(network, wallet)!.checked).toEqual([loaded]);
  });
});

describe('range check: check jobs', () => {
  /** A wallet read once before the check existed: its first scan missed the verified payout `3` and saved the day complete. */
  async function readOnce() {
    const store = open(); const data = demoData();
    data.fullOmits = new Map([[signature('3'), Number.POSITIVE_INFINITY]]);
    const h = harness(store, data, { listing: false, hydrate: false });
    expect((await h.scan()).status).toBe('complete');
    expect(store.coverage(network, wallet)).toEqual([loaded]);
    expect(store.wallet(network, wallet)!.checked).toBeUndefined();
    expect(watched(store, '3')).toBe(false);
    data.fullOmits.clear(); h.options.listing = true; h.options.hydrate = true;
    return { store, h };
  }

  it('checks read-once days and fetches only what is missing, counting nothing twice', async () => {
    const { store, h } = await readOnce();
    const before = rows(store); const lastSync = store.wallet(network, wallet)!.lastSync;
    const days = { startTime: cutoffDay - 2 * DAY, endTime: cutoffDay + DAY };
    h.requests.length = 0; const calls = { ...h.data.calls };
    const job = await h.scan({ kind: 'check', check: days });
    expect(job).toMatchObject({ status: 'complete', kind: 'check', cutoff, check: { ...days, days: 3 }, registryDone: true, hydrationDone: true });
    // No StonkFun request, no hydration, no price: one listing per day and one full read of the missing transaction alone.
    expect(h.data.calls.stonkfun).toBe(calls.stonkfun);
    expect(h.requests).toEqual([
      { details: 'signatures', startTime: cutoffDay - 2 * DAY, endTime: cutoffDay - DAY },
      { details: 'signatures', startTime: cutoffDay - DAY, endTime: cutoffDay },
      { details: 'signatures', startTime: cutoffDay, endTime: cutoff },
      { details: 'full', startTime: cutoff - 3600, endTime: cutoff - 3600 + 1 }]);
    expect(job.used.helius).toBe(h.data.calls.helius - calls.helius);
    expect(watched(store, '3')).toBe(true);
    expect(job.checkResult).toEqual({ days: 3, checkedDays: 3, unconfirmedDays: 0, newTransactions: 1,
      newPayouts: 0, alreadySaved: 0, newVerified: 1, verifiedAlreadySaved: 1 });
    expect(rows(store)).toEqual({ ...before, confirmed: before.confirmed + 1 });
    // Coverage is unchanged; the checked days are marked, and the rest stay read once.
    expect(store.coverage(network, wallet)).toEqual([loaded]);
    expect(store.wallet(network, wallet)!.checked).toEqual([{ startTime: cutoffDay - 2 * DAY, endTime: cutoff }]);
    // A check is not a refresh: the last refresh time stays.
    expect(store.wallet(network, wallet)!.lastSync).toBe(lastSync);

    // The same days again find nothing new and change no count.
    const again = await h.scan({ kind: 'check', check: days });
    expect(again.checkResult).toMatchObject({ newTransactions: 0, newPayouts: 0, newVerified: 0, verifiedAlreadySaved: 2 });
    expect(rows(store)).toEqual({ ...before, confirmed: before.confirmed + 1 });
    expect(store.payoutRows(network, wallet, loaded.startTime, loaded.endTime).filter(row => row.signature === signature('3'))).toHaveLength(1);
  });

  it('keeps coverage and reports a day whose listing still disagrees', async () => {
    const { store, h } = await readOnce();
    h.data.fullOmits = new Map([[signature('3'), Number.POSITIVE_INFINITY]]);
    const job = await h.scan({ kind: 'check', check: { startTime: cutoffDay, endTime: cutoffDay + DAY } });
    expect(job.status).toBe('complete');
    expect(job.checkResult).toMatchObject({ days: 1, checkedDays: 0, unconfirmedDays: 1, newTransactions: 0 });
    expect(store.coverage(network, wallet)).toEqual([loaded]);
    expect(store.wallet(network, wallet)!.checked).toBeUndefined();
  });

  it('allows at most seven days and refuses days outside the loaded range', async () => {
    expect(CHECK_MAX_DAYS).toBe(7);
    // The loaded range starts mid-day on its first day and ends at the cutoff on its last: both days are clipped to it.
    const first = { startTime: cutoffDay - 7 * DAY, endTime: cutoffDay };
    expect(planCheck(first, loaded)).toHaveLength(7);
    expect(planCheck(first, loaded)[0]).toEqual({ startTime: loaded.startTime, endTime: cutoffDay - 6 * DAY });
    const range = { startTime: cutoffDay - 6 * DAY, endTime: cutoffDay + DAY };
    expect(planCheck(range, loaded)).toHaveLength(7);
    expect(planCheck(range, loaded)[0]).toEqual({ startTime: cutoffDay - 6 * DAY, endTime: cutoffDay - 5 * DAY });
    expect(planCheck(range, loaded).at(-1)).toEqual({ startTime: cutoffDay, endTime: cutoff });
    expect(() => planCheck({ startTime: cutoffDay - 7 * DAY, endTime: cutoffDay + DAY }, loaded)).toThrow('check_range_too_long');
    expect(() => planCheck({ startTime: cutoffDay - 8 * DAY, endTime: cutoffDay - 6 * DAY }, loaded)).toThrow('check_range_outside_loaded');
    expect(() => planCheck({ startTime: cutoffDay, endTime: cutoffDay + 2 * DAY }, loaded)).toThrow('check_range_outside_loaded');
    expect(() => planCheck({ startTime: cutoffDay + 100, endTime: cutoffDay + DAY }, loaded)).toThrow('check_range_invalid');
    expect(() => planCheck({ startTime: cutoffDay, endTime: cutoffDay }, loaded)).toThrow('check_range_invalid');

    const empty = open();
    expect(() => admitJob(empty, { wallet, cutoff, jobId: 'nothing-loaded', owner: 'o', limits, kind: 'check', check: range }, cutoff * 1000)).toThrow('wallet_not_loaded');
    const { store } = await readOnce();
    const admit = (id: string, check: { startTime: number; endTime: number }) => admitJob(store, { wallet, cutoff, jobId: id, owner: 'o', limits, kind: 'check', check }, cutoff * 1000 + 60_000);
    expect(() => admit('eight-days', { startTime: cutoffDay - 7 * DAY, endTime: cutoffDay + DAY })).toThrow('check_range_too_long');
    expect(() => admit('before-loaded', { startTime: cutoffDay - 8 * DAY, endTime: cutoffDay - 6 * DAY })).toThrow('check_range_outside_loaded');
    expect(() => admit('after-cutoff', { startTime: cutoffDay + DAY, endTime: cutoffDay + 2 * DAY })).toThrow('check_range_outside_loaded');
    const week = admit('seven-days', range);
    expect(store.ranges(week.id)).toHaveLength(7);
    expect(store.coverage(network, wallet)).toEqual([loaded]);
  });
});

describe('range check: saved rows', () => {
  const week = { startTime: cutoffDay - 6 * DAY, endTime: cutoffDay + DAY };

  it('leaves every saved row identical when every day of the week is already checked, with one listing request per day', async () => {
    const store = open(); const h = harness(store);
    expect((await h.scan()).status).toBe('complete');
    expect(store.wallet(network, wallet)!.checked).toEqual([loaded]);
    const before = savedRows(store);
    expect(before.transactions!.length).toBeGreaterThan(0);
    expect(before.classifications!.length).toBeGreaterThan(0);
    h.requests.length = 0; const calls = { ...h.data.calls };
    const job = await h.scan({ kind: 'check', check: week });
    expect(job).toMatchObject({ status: 'complete', checkResult: { days: 7, checkedDays: 7, unconfirmedDays: 0, newTransactions: 0, newPayouts: 0, newVerified: 0 } });
    // The same rows with the same fields, the wallet record included.
    expect(savedRows(store)).toEqual(before);
    // One signatures listing per day and nothing else: no full-mode page, no other Helius method, no StonkFun request.
    expect(h.requests).toEqual(planCheck(week, loaded).map(day => ({ details: 'signatures', ...day })));
    expect(h.data.calls.helius - calls.helius).toBe(7);
    expect(h.data.calls.stonkfun).toBe(calls.stonkfun);
    expect(job.used).toMatchObject({ helius: 7, stonkfun: 0, pages: 0 });
  });

  it('adds exactly the missing payout and keeps every row saved before identical', async () => {
    // Read once before the check existed: the first scan missed the payout 3 on the cutoff day and saved the day complete.
    const store = open(); const data = demoData();
    data.fullOmits = new Map([[signature('3'), Number.POSITIVE_INFINITY]]);
    const h = harness(store, data, { listing: false, hydrate: false });
    expect((await h.scan()).status).toBe('complete');
    data.fullOmits.clear(); h.options.listing = true; h.options.hydrate = true;
    const before = savedRows(store); const payoutsBefore = store.payoutRows(network, wallet, loaded.startTime, loaded.endTime);
    expect(payoutsBefore.some(row => row.signature === signature('3'))).toBe(false);

    const job = await h.scan({ kind: 'check', check: week });
    expect(job.checkResult).toMatchObject({ days: 7, checkedDays: 7, newTransactions: 1 });
    const after = savedRows(store);
    // Every row saved before is still there with every field unchanged; the wallet record changes only in its checked days.
    for (const [table, rows] of Object.entries(before)) {
      if (table === 'wallets') continue;
      expect(after[table], table).toEqual(expect.arrayContaining(rows));
    }
    const walletBody = (rows: string[]) => { const body = JSON.parse((JSON.parse(rows[0]!) as { body: string }).body) as Record<string, unknown>; delete body.checked; return body; };
    expect(after.wallets).toHaveLength(1);
    expect(walletBody(after.wallets!)).toEqual(walletBody(before.wallets!));
    expect(store.wallet(network, wallet)!.checked).toEqual([{ startTime: week.startTime, endTime: cutoff }]);
    // Every added row belongs to the missed transaction, and it adds exactly one payout.
    const added = Object.entries(after).filter(([table]) => table !== 'wallets')
      .flatMap(([table, rows]) => rows.filter(row => !before[table]!.includes(row)).map(row => ({ table, row })));
    expect(added.length).toBeGreaterThan(0);
    const transactionIds = added.filter(item => item.table === 'transactions').map(item => (JSON.parse(item.row) as { id: string }).id);
    expect(transactionIds).toHaveLength(1);
    for (const { table, row } of added) {
      // Provenance is keyed by the id of the transaction row it describes.
      if (table === 'provenance') expect(transactionIds).toContain((JSON.parse(row) as { evidence: string }).evidence);
      else expect(row, table).toContain(signature('3'));
    }
    const payoutsAfter = store.payoutRows(network, wallet, loaded.startTime, loaded.endTime);
    expect(payoutsAfter).toHaveLength(payoutsBefore.length + 1);
    expect(payoutsAfter).toEqual(expect.arrayContaining([...payoutsBefore, { signature: signature('3'), status: 'confirmed' }]));
  });
});
