import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { admitJob } from '../src/scanner/engine.js';
import { createRealProviders, WITHDRAW_AUTHORITY_CONFIGURATION_MINT } from '../src/providers/real.js';
import { DEMO_CUTOFF, DEMO_MINT, DEMO_WALLET, demoTransaction } from '../src/cli/demo.js';
import type { Job } from '../src/scanner/types.js';

const stores: SqliteRewardsStore[] = [];
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup(fetcher: typeof fetch, liveAllowance = false) {
  const store = new SqliteRewardsStore(':memory:'); stores.push(store);
  let time = DEMO_CUTOFF * 1000;
  const now = () => { time += 1000; return time; };
  const job = admitJob(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'provider-test', owner: 'test',
    limits: { stonkfun: 20, helius: 40, pages: 100, resumes: 10, deadline: now() + 3600000 } }, now());
  const provider = createRealProviders({ store, job, apiKey: 'synthetic-provider-key', now, fetch: fetcher, liveAllowance });
  return { store, job, provider, now };
}
/** Two requests a second, one at a time: the pacing these cross-connection tests were written against. */
const SINGLE = { helius: { perSecond: 2, burst: 1 }, stonkfun: { perSecond: 2, burst: 1 } };
const NO_RETRY = { retries: 0, baseMs: 1000, maxMs: 30_000, jitter: 0 };
const response = (value: unknown, status = 200, headers?: HeadersInit) => Promise.resolve(new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) }));
const price = (mint = DEMO_MINT, value: unknown = '1.50', time = new Date(DEMO_CUTOFF * 1000).toISOString()) => ({ data: { quote: { mint }, prices: { quoteUsd: value, observedAt: time } } });
const das = (mint = DEMO_MINT, currency = 'USD', value: unknown = '2.00') => ({ jsonrpc: '2.0', id: 'scanner', result: { id: mint, token_info: { price_info: { currency, price_per_token: value } } } });

describe('real provider adapters with injected evidence', () => {
  it('uses validated StonkFun pricing before DAS', async () => {
    let calls = 0; const { provider, store } = setup(() => { calls++; return response(price()); });
    expect(await provider.price(DEMO_MINT)).toMatchObject({ value: '1.50', provider: 'stonkfun', currency: 'USD' });
    expect(calls).toBe(1); expect(store.job('provider-test', 'mainnet-beta')?.used).toMatchObject({ stonkfun: 1, helius: 0 });
  });
  it.each([
    price('B'.repeat(32)), price(DEMO_MINT, null), price(DEMO_MINT, -1), price(DEMO_MINT, '1e9999'),
    price(DEMO_MINT, '1.0', '2020-01-01T00:00:00Z'), price(DEMO_MINT, '1.0', '2099-01-01T00:00:00Z'),
  ])('falls back after wrong identity, missing, invalid or stale primary data', async invalid => {
    let calls = 0; const { provider } = setup(() => response(++calls === 1 ? invalid : das()));
    expect(await provider.price(DEMO_MINT)).toMatchObject({ value: '2.00', provider: 'helius', observedAt: null, reason: 'provider_may_cache_600_seconds' }); expect(calls).toBe(2);
  });
  it.each([das('B'.repeat(32)), das(DEMO_MINT, 'EUR'), das(DEMO_MINT, 'USD', -1), das(DEMO_MINT, 'USD', 'NaN'),
    { jsonrpc: '2.0', id: 'scanner', result: { id: DEMO_MINT, token_info: {} } }])('keeps invalid/missing DAS prices unpriced', async invalid => {
    let calls = 0; const { provider } = setup(() => response(++calls === 1 ? price(DEMO_MINT, null) : invalid));
    expect(await provider.price(DEMO_MINT)).toMatchObject({ value: null, reason: 'no_valid_usd_price' });
  });
  it('rejects credential reflections without copying errors or URLs into output', async () => {
    let calls = 0; const { provider } = setup(() => response(++calls === 1 ? price(DEMO_MINT, null) : { ...das(), reflected: 'synthetic-provider-key' }));
    const result = await provider.price(DEMO_MINT);
    expect(result.value).toBeNull(); expect(JSON.stringify(result)).not.toContain('synthetic-provider-key');
  });
  it('hydrates only the requested signature and never persists null/malformed responses', async () => {
    const tx = demoTransaction('3', DEMO_CUTOFF - 100);
    const { provider } = setup(() => response({ jsonrpc: '2.0', id: 'scanner', result: tx }));
    expect(await provider.hydrate('4'.repeat(88))).toBeNull();
    expect((await provider.hydrate('3'.repeat(88)))?.transaction).toEqual(tx);
  });
  it('retains shared cooldowns after body failure and across provider instances', async () => {
    let calls = 0; const { provider, store, job, now } = setup(() => {
      calls++;
      return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(new Error('private provider detail')); } }), { status: 429, headers: { 'Retry-After': '120' } }));
    });
    expect(await provider.hydrate('3'.repeat(88))).toBeNull();
    const second = createRealProviders({ store, job, now, apiKey: 'synthetic-provider-key', fetch: () => { calls++; return response(das()); } });
    expect(await second.hydrate('3'.repeat(88))).toBeNull(); expect(calls).toBe(1);
    expect(store.cooldown('helius')).toBeGreaterThan(now());
  });
  it('rechecks a later 429 before an earlier reservation dispatches across SQLite connections', async () => {
    vi.useFakeTimers(); vi.setSystemTime(DEMO_CUTOFF * 1000);
    const directory = mkdtempSync(join(tmpdir(), 'rewards-cooldown-')); directories.push(directory);
    const path = join(directory, 'shared.sqlite');
    const firstStore = new SqliteRewardsStore(path); const secondStore = new SqliteRewardsStore(path);
    stores.push(firstStore, secondStore);
    const now = Date.now;
    const job = admitJob(firstStore, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'concurrent-provider-test', owner: 'test',
      limits: { stonkfun: 20, helius: 40, pages: 100, resumes: 10, deadline: now() + 3600000 } }, now());
    let finishFirst!: (response: Response) => void;
    let dispatches = 0;
    // One token at a time, so the second connection waits for its turn while the first is in flight.
    const first = createRealProviders({ store: firstStore, job, apiKey: 'synthetic-provider-key', now, limits: SINGLE, retry: NO_RETRY,
      fetch: () => { dispatches++; return new Promise<Response>(resolve => { finishFirst = resolve; }); } });
    const second = createRealProviders({ store: secondStore, job, apiKey: 'synthetic-provider-key', now, limits: SINGLE, retry: NO_RETRY,
      fetch: () => { dispatches++; return response(das()); } });
    const a = first.hydrate('3'.repeat(88));
    const b = second.hydrate('4'.repeat(88));
    expect(dispatches).toBe(1);
    finishFirst(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await a;
    await vi.advanceTimersByTimeAsync(500);
    expect(await b).toBeNull();
    expect(dispatches).toBe(1);
    expect(secondStore.job(job.id, 'mainnet-beta')?.used.helius).toBe(1);
    expect(firstStore.cooldown('helius')).toBeGreaterThan(now());
  });
  it('maintains actual dispatch spacing when three connections outwait a short server cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(DEMO_CUTOFF * 1000);
    const start = Date.now();
    const directory = mkdtempSync(join(tmpdir(), 'rewards-spacing-')); directories.push(directory);
    const connections = Array.from({ length: 3 }, () => new SqliteRewardsStore(join(directory, 'shared.sqlite')));
    stores.push(...connections);
    const job = admitJob(connections[0]!, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'spacing-test', owner: 'test',
      limits: { stonkfun: 20, helius: 40, pages: 100, resumes: 10, deadline: start + 3600000 } }, start);
    const dispatches: number[] = [];
    let finishFirst!: (response: Response) => void;
    const providers = connections.map((store, index) => createRealProviders({ store, job, apiKey: 'synthetic-provider-key', now: Date.now, liveAllowance: true,
      limits: SINGLE, retry: NO_RETRY, fetch: () => {
        dispatches.push(Date.now() - start);
        return index === 0 ? new Promise<Response>(resolve => { finishFirst = resolve; }) : response({ jsonrpc: '2.0', id: 'scanner', result: null });
      } }));
    const requests = providers.map(provider => provider.hydrate('3'.repeat(88)));
    expect(dispatches).toEqual([0]);
    await vi.advanceTimersByTimeAsync(100);
    finishFirst(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }));
    await requests[0];
    await vi.advanceTimersByTimeAsync(1999);
    expect(dispatches).toEqual([0]);
    expect(connections[2]!.job(job.id, 'mainnet-beta')?.used.helius).toBe(1);
    expect(connections[1]!.cache('live-milestone-2026-09-21')?.value).toEqual({ stonkfun: 0, helius: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatches).toEqual([0, 2100]);
    await vi.advanceTimersByTimeAsync(499);
    expect(dispatches).toEqual([0, 2100]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(requests);
    expect(dispatches).toEqual([0, 2100, 2600]);
    expect(connections[0]!.job(job.id, 'mainnet-beta')?.used.helius).toBe(3);
    expect(connections[2]!.cache('live-milestone-2026-09-21')?.value).toEqual({ stonkfun: 0, helius: 3 });
  });
  it.each(['cancel', 'deadline', 'budget', 'allowance'])('does not charge a waiting request blocked by %s', async reason => {
    vi.useFakeTimers(); vi.setSystemTime(DEMO_CUTOFF * 1000);
    const store = new SqliteRewardsStore(':memory:'); stores.push(store);
    const job = admitJob(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'blocked-test', owner: 'test',
      limits: { stonkfun: 20, helius: 40, pages: 100, resumes: 10, deadline: Date.now() + 3600000 } }, Date.now());
    const controller = new AbortController(); let calls = 0;
    const provider = createRealProviders({ store, job, apiKey: 'synthetic-provider-key', now: Date.now, liveAllowance: true, signal: controller.signal,
      limits: SINGLE, fetch: () => { calls++; return response({ jsonrpc: '2.0', id: 'scanner', result: null }); } });
    await provider.hydrate('3'.repeat(88));
    const waiting = provider.hydrate('3'.repeat(88));
    if (reason === 'cancel') controller.abort();
    else if (reason === 'deadline') job.limits.deadline = Date.now() + 250;
    else if (reason === 'budget') store.saveJob({ ...store.job(job.id, 'mainnet-beta')!, limits: { ...job.limits, helius: 1 } });
    else store.saveCache('live-milestone-2026-09-21', { value: { stonkfun: 0, helius: 30 }, expiresAt: Number.MAX_SAFE_INTEGER });
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toBeNull(); expect(calls).toBe(1);
    expect(store.job(job.id, 'mainnet-beta')?.used.helius).toBe(1);
    expect(store.cache('live-milestone-2026-09-21')?.value).toEqual({ stonkfun: 0, helius: reason === 'allowance' ? 30 : 1 });
    // Failed accounting rolls admission back as well; it never consumes the next token.
    expect(store.reserveDispatch('helius', Date.now(), Date.now() + 10000, SINGLE.helius)).toBe(Date.now());
  });
  it('enforces one milestone allowance across multiple jobs and stage attempts', async () => {
    let calls = 0; const { provider, store, job, now } = setup(() => { calls++; return response(price()); }, true);
    store.saveCache('live-milestone-2026-09-21', { value: { stonkfun: 4, helius: 30 }, expiresAt: Number.MAX_SAFE_INTEGER });
    expect((await provider.price(DEMO_MINT)).value).toBe('1.50');
    const next: Job = { ...job, id: 'provider-test-next', status: 'running' };
    store.saveJob({ ...store.job(job.id, 'mainnet-beta')!, status: 'complete' }); store.saveJob(next);
    const second = createRealProviders({ store, job: next, now, apiKey: 'synthetic-provider-key', liveAllowance: true, fetch: () => { calls++; return response(price()); } });
    expect((await second.price(DEMO_MINT)).value).toBeNull(); expect(calls).toBe(1);
    expect(store.cache('live-milestone-2026-09-21')?.value).toEqual({ stonkfun: 5, helius: 30 });
  });
  it('refreshes the distribution feed and one withdraw configuration without repeating cached catalogue requests', async () => {
    const endpoints: string[] = []; const { provider, store, now } = setup(input => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      endpoints.push(url.pathname + url.search);
      return response({ data: { launches: [], recentDistributions: [] }, meta: { generatedAt: new Date(DEMO_CUTOFF * 1000).toISOString() } });
    });
    store.saveCache('catalogue-read:mainnet-beta', { value: true, expiresAt: now() + 86400000 });
    const registry = await provider.registry(); expect(registry.complete).toBe(false);
    expect(endpoints).toEqual(['/api/public/v1/rewards?limit=100', `/api/public/v1/launchlab/pricing?quoteMint=${WITHDRAW_AUTHORITY_CONFIGURATION_MINT}`]);
    // An invalid configuration body is a failed read: no snapshot is offered for retention.
    expect(registry.feeds[0]!.withdrawalAuthorities).toEqual([]);
    expect(registry.detail).toContain('withdraw-configuration=failed');
  });
  it('does not turn a failed quote request into an assumed stablecoin dollar', async () => {
    const { provider } = setup(() => response({}, 404));
    expect((await provider.price('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).value).toBeNull();
  });
});
