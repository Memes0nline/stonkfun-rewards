import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { orderedPool } from '../src/scanner/pool.js';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { runScan } from '../src/scanner/engine.js';
import { createRealProviders } from '../src/providers/real.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoFetch } from '../src/cli/demo.js';
import { feedHeavy } from './fixtures/feed-heavy.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
/** A fixed permutation of delays, so completion order differs from start order the same way every run. */
const delay = (index: number) => (index * 7919) % 23;

describe('ordered pool', () => {
  it('commits in item order whatever order the work finishes in, with at most `limit` in flight', async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const finished: number[] = []; const committed: number[] = [];
    let running = 0; let peak = 0;
    const count = await orderedPool(items, 4, async item => {
      running++; peak = Math.max(peak, running);
      await tick(delay(item)); running--; finished.push(item); return item * 10;
    }, (result, item, index) => { expect(result).toBe(item * 10); expect(index).toBe(item); committed.push(item); });
    expect(count).toBe(20);
    expect(committed).toEqual(items);
    expect(finished).not.toEqual(items);
    expect(peak).toBe(4);
  });

  it('commits each result as soon as every earlier one is committed', async () => {
    const committedAt: number[] = [];
    let clock = 0;
    await orderedPool([30, 5, 5, 5], 4, async ms => { await tick(ms); clock = Math.max(clock, ms); return ms; }, () => { committedAt.push(clock); });
    // Items 1–3 finish first but wait for item 0; then all four commit together.
    expect(committedAt).toEqual([30, 30, 30, 30]);
  });

  it('stops starting work when admission says so, and still commits what already started', async () => {
    const started: number[] = []; const committed: number[] = [];
    const count = await orderedPool([0, 1, 2, 3, 4, 5], 2, async item => { started.push(item); await tick(delay(item)); return item; },
      result => { committed.push(result); }, item => item < 3);
    expect(started).toEqual([0, 1, 2]);
    expect(committed).toEqual([0, 1, 2]);
    expect(count).toBe(3);
  });

  it('on cancellation starts nothing further, waits for work in flight, commits nothing after it and rethrows', async () => {
    const controller = new AbortController();
    const started: number[] = []; const committed: number[] = []; let settled = 0;
    const pool = orderedPool(Array.from({ length: 10 }, (_, index) => index), 3, async item => {
      started.push(item); if (item === 4) controller.abort(); await tick(10); settled++; return item;
    }, result => { if (controller.signal.aborted) throw new Error('cancelled'); committed.push(result); },
    () => { if (controller.signal.aborted) throw new Error('cancelled'); return true; });
    await expect(pool).rejects.toThrow('cancelled');
    expect(started.length).toBeLessThan(10);
    expect(settled).toBe(started.length);
    expect(committed).toEqual(Array.from({ length: committed.length }, (_, index) => index));
    expect(committed.length).toBeLessThan(started.length);
  });

  it('rejects a pool size below one', async () => {
    await expect(orderedPool([1], 0, item => Promise.resolve(item), () => undefined)).rejects.toThrow('Invalid pool size');
  });
});

interface Run { path: string; job: Awaited<ReturnType<typeof runScan>>; calls: number }
async function scan(concurrency: number, options: { shuffle?: boolean; failEvery?: number; abortAfter?: number } = {}): Promise<Run> {
  const directory = mkdtempSync(join(tmpdir(), 'rewards-pool-')); directories.push(directory);
  const path = join(directory, 'pool.sqlite');
  const store = new SqliteRewardsStore(path);
  const data = feedHeavy();
  // A clock that stands still gives both runs identical provider answers and retrieval times, so their outputs can be
  // compared byte for byte; the buckets are large enough that no request waits for a refill.
  const now = () => DEMO_CUTOFF * 1000 + 5000;
  const base = demoFetch(data, now);
  const controller = new AbortController();
  let calls = 0; let hydrations = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const index = calls++;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: string } : {};
    if (body.method === 'getTransaction' && ++hydrations === options.abortAfter) controller.abort();
    if (options.shuffle) await tick(delay(index));
    if (options.failEvery && index % options.failEvery === options.failEvery - 1) return new Response('{}', { status: 503 });
    return base(input, init);
  };
  try {
    const job = await runScan(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'pool-job', owner: 'pool-owner',
      limits: { stonkfun: 60, helius: 100, pages: 40, resumes: 2, deadline: now() + 3_600_000 } },
    item => createRealProviders({ store, job: item, apiKey: 'synthetic-pool-key', fetch: fetcher, now, signal: controller.signal,
      limits: { helius: { perSecond: 100, burst: 100 }, stonkfun: { perSecond: 100, burst: 100 } }, dasLimit: { perSecond: 100, burst: 100 },
      retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } }), { now, concurrency, signal: controller.signal });
    return { path, job, calls };
  } finally { store.close(); }
}
/** Everything a scan derives from provider answers. */
function outputs(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const digest = (sql: string) => createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
    return {
      transactions: db.prepare('SELECT signature, id FROM transactions ORDER BY signature, id').all().map(row => `${String(row.signature).slice(0, 4)}:${String(row.id).slice(0, 12)}`),
      classifications: digest('SELECT wallet, identity, status, body FROM classifications ORDER BY wallet, identity'),
      authorities: digest('SELECT signature, id, body FROM authorities ORDER BY signature, id'),
      dependencies: digest('SELECT * FROM dependencies ORDER BY 1, 2, 3, 4'),
      prices: db.prepare("SELECT mint, json_extract(body,'$.value') AS value, json_extract(body,'$.provider') AS provider, json_extract(body,'$.reason') AS reason FROM prices ORDER BY mint").all(),
      priceBodies: digest('SELECT mint, retrieved, body FROM prices ORDER BY mint, retrieved'),
      provenance: digest('SELECT evidence, id, body FROM provenance ORDER BY evidence, id'),
      feeds: digest('SELECT signature, id, body FROM feeds ORDER BY signature, id'),
      watchers: db.prepare('SELECT signature FROM watchers ORDER BY signature').all().length,
    };
  } finally { db.close(); }
}

describe('bounded provider pool in the scan', () => {
  it('writes byte-identical derived evidence to the serial path under shuffled completion', async () => {
    const serial = await scan(1);
    const pooled = await scan(4, { shuffle: true });
    expect(serial.job.status).toBe('complete'); expect(pooled.job.status).toBe('complete');
    const expected = outputs(serial.path);
    expect(expected.transactions).toHaveLength(12);
    expect(expected.prices).toHaveLength(12);
    expect(outputs(pooled.path)).toEqual(expected);
    // Same requests, counted once each.
    expect(pooled.job.used).toEqual(serial.job.used);
    expect(pooled.calls).toBe(serial.calls);
  });

  it('keeps request accounting exact with retries: every dispatch counts once and every retry counts', async () => {
    const run = await scan(4, { shuffle: true, failEvery: 5 });
    expect(run.job.used.helius + run.job.used.stonkfun).toBe(run.calls);
    expect(run.job.status).toBe('complete');
    // Retried 5xx answers leave the evidence the clean run derives.
    const clean = await scan(1);
    expect(outputs(run.path).classifications).toBe(outputs(clean.path).classifications);
  });

  it('stops mid-pool on cancellation: accounting stays exact and only a prefix of the feed is saved', async () => {
    const run = await scan(4, { shuffle: true, abortAfter: 6 });
    expect(run.job).toMatchObject({ status: 'paused', error: 'cancelled' });
    expect(run.job.used.helius + run.job.used.stonkfun).toBe(run.calls);
    const saved = outputs(run.path).transactions.map(item => item.slice(0, 1));
    // Whatever was saved is the leading prefix of the feed's order, never a later hydration on its own.
    const db = new DatabaseSync(run.path, { readOnly: true });
    let feed: string[];
    try { feed = (JSON.parse(String(db.prepare("SELECT body FROM cache WHERE key='job-feed:pool-job'").get()!.body)) as { value: string[] }).value.map(item => item.slice(0, 1)); }
    finally { db.close(); }
    expect([...feed].sort()).toEqual([...'abcdefghijkm']);
    expect(saved.length).toBeLessThan(12);
    expect([...saved].sort()).toEqual(feed.slice(0, saved.length).sort());
  });
});
