import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { admitJob } from '../src/scanner/engine.js';
import { createRealProviders } from '../src/providers/real.js';
import type { RealProviderOptions } from '../src/providers/real.js';
import { backoffDelay, DEFAULT_RATE_LIMITS, DEFAULT_RETRY, retryAfterMs, scanSpeed, takeToken, waitText } from '../src/providers/limiter.js';
import type { Provider, WaitReason } from '../src/providers/limiter.js';
import { PublicClient } from '../src/registry/http.js';
import { pairsSchema } from '../src/registry/schemas.js';
import { HeliusHistoryClient } from '../src/helius/client.js';
import { DashboardService } from '../src/web/service.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoTransaction } from '../src/cli/demo.js';
import { pairs } from './fixtures/stonkfun.js';
import { fixtureKey, query, response as historyResponse } from './fixtures/helius.js';
import type { Providers } from '../src/scanner/types.js';
import { removeTempFolder } from './temp-folder.js';

const stores: SqliteRewardsStore[] = [];
const directories: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) await removeTempFolder(path); });

describe('token bucket', () => {
  it('lets a full bucket burst, then refills at the configured rate', () => {
    const helius = DEFAULT_RATE_LIMITS.helius;
    let state = 0;
    const take = (now: number) => { const result = takeToken(state, now, helius); if (result.ready === now) state = result.state; return result.ready; };
    // Ten at once from a full bucket, the eleventh one interval (125 ms) later.
    expect(Array.from({ length: 10 }, () => take(0))).toEqual(Array(10).fill(0));
    expect(take(0)).toBe(125);
    expect(take(124)).toBe(125);
    expect(take(125)).toBe(125);
    expect(take(125)).toBe(250);
    // Idle for the full refill time: the whole burst is available again.
    const later = 250 + 10 * 125;
    expect(Array.from({ length: 10 }, () => take(later))).toEqual(Array(10).fill(later));
    expect(take(later)).toBe(later + 125);
  });

  it('paces StonkFun at four per second with a burst of five', () => {
    let state = 0;
    const admitted: number[] = [];
    // Every 10 ms, take as many tokens as the bucket holds.
    for (let now = 0; admitted.length < 9; now += 10) {
      for (let result = takeToken(state, now, DEFAULT_RATE_LIMITS.stonkfun); result.ready === now && admitted.length < 9;
        result = takeToken(state, now, DEFAULT_RATE_LIMITS.stonkfun)) { state = result.state; admitted.push(now); }
    }
    expect(admitted).toEqual([0, 0, 0, 0, 0, 250, 500, 750, 1000]);
  });

  it('rounds a fractional rate up to whole milliseconds, never exceeding it', () => {
    expect(takeToken(0, 0, { perSecond: 3, burst: 1 })).toEqual({ ready: 0, state: 334 });
    expect(takeToken(334, 0, { perSecond: 3, burst: 1 }).ready).toBe(334);
  });

  it('is shared by every connection to the same database and holds back during a server cooldown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rewards-bucket-')); directories.push(directory);
    const [a, b] = [0, 1].map(() => { const store = new SqliteRewardsStore(join(directory, 'shared.sqlite')); stores.push(store); return store; });
    const limit = DEFAULT_RATE_LIMITS.stonkfun;
    for (let i = 0; i < 5; i++) expect(a!.reserveDispatch('stonkfun', 1000, 60_000, limit)).toBe(1000);
    // The other connection sees the emptied bucket, and a refused check takes no token.
    expect(b!.reserveDispatch('stonkfun', 1000, 60_000, limit)).toBe(1250);
    expect(b!.reserveDispatch('stonkfun', 1100, 60_000, limit)).toBe(1250);
    expect(b!.reserveDispatch('stonkfun', 1250, 60_000, limit)).toBe(1250);
    // Helius has its own bucket.
    expect(b!.reserveDispatch('helius', 1250, 60_000, DEFAULT_RATE_LIMITS.helius)).toBe(1250);
    // A server cooldown holds back even a full bucket, and one beyond the longest wait is refused.
    b!.cooldown('helius', 5000);
    expect(a!.reserveDispatch('helius', 1300, 60_000, DEFAULT_RATE_LIMITS.helius)).toBe(5000);
    b!.cooldown('helius', 200_000);
    expect(() => a!.reserveDispatch('helius', 1300, 60_000, DEFAULT_RATE_LIMITS.helius)).toThrow('provider_cooldown');
  });
});

describe('backoff and Retry-After', () => {
  it('starts at one second, doubles, caps at thirty and adds at most a quarter of jitter', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(failures => backoffDelay(failures, DEFAULT_RETRY, () => 0))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0.999)).toBe(1250);
    expect(backoffDelay(5, DEFAULT_RETRY, () => 0.999)).toBe(19996);
    expect(backoffDelay(6, DEFAULT_RETRY, () => 0.999)).toBe(30000);
  });
  it('reads delay-seconds and HTTP dates, and nothing else', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(retryAfterMs('2', now)).toBe(2000);
    expect(retryAfterMs('0.5', now)).toBe(500);
    expect(retryAfterMs(new Date(now + 3000).toUTCString(), now)).toBe(3000);
    expect(retryAfterMs(new Date(now - 3000).toUTCString(), now)).toBe(0);
    expect([null, '', 'soon'].map(value => retryAfterMs(value, now))).toEqual([null, null, null]);
  });
});

describe('scan speed settings', () => {
  it('uses the defaults, then the environment, then flags', () => {
    expect(scanSpeed({})).toEqual({ limits: DEFAULT_RATE_LIMITS, concurrency: 4 });
    const environment = { SCANNER_HELIUS_RPS: '4', SCANNER_HELIUS_BURST: '6', SCANNER_STONKFUN_RPS: '1.5', SCANNER_STONKFUN_BURST: '2', SCANNER_CONCURRENCY: '2' };
    expect(scanSpeed({}, environment)).toEqual({ limits: { helius: { perSecond: 4, burst: 6 }, stonkfun: { perSecond: 1.5, burst: 2 } }, concurrency: 2 });
    expect(scanSpeed({ heliusRps: '12', stonkfunBurst: '3', concurrency: '8' }, environment))
      .toEqual({ limits: { helius: { perSecond: 12, burst: 6 }, stonkfun: { perSecond: 1.5, burst: 3 } }, concurrency: 8 });
  });
  it.each([['heliusRps', '0'], ['heliusRps', 'fast'], ['heliusRps', ''], ['heliusBurst', '2.5'], ['stonkfunBurst', '0'], ['stonkfunRps', '101'],
    ['concurrency', '0'], ['concurrency', '17'], ['concurrency', '1.5']] as const)(
    'rejects %s=%j rather than clamping it', (setting, value) => {
      expect(() => scanSpeed({ [setting]: value })).toThrow('invalid_speed_option');
    });
  it('describes a wait with its provider, reason and duration', () => {
    expect(waitText('helius', 'rate_limit', 2000)).toBe('Waiting for provider: Helius rate limited by the provider, 2.0 s');
    expect(waitText('stonkfun', 'throttle', 250)).toBe('Waiting for provider: StonkFun request pacing, 0.3 s');
    expect(waitText('helius', 'retry', 4000)).toBe('Waiting for provider: Helius retrying after a failed request, 4.0 s');
  });
});

/** Real provider adapters on a fake clock. `respond` answers each dispatched request in order. */
function providers(respond: (call: number, url: URL) => Promise<Response>, options: Partial<RealProviderOptions> = {}) {
  vi.useFakeTimers(); vi.setSystemTime(DEMO_CUTOFF * 1000);
  const start = Date.now();
  const store = new SqliteRewardsStore(':memory:'); stores.push(store);
  const job = admitJob(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'limiter-test', owner: 'test',
    limits: { stonkfun: 50, helius: 50, pages: 10, resumes: 1, deadline: start + 3_600_000 } }, start);
  const dispatches: { at: number; host: string }[] = [];
  const waits: { provider: Provider; reason: WaitReason; delayMs: number; at: number }[] = [];
  const provider = createRealProviders({ store, job, apiKey: 'synthetic-limiter-key', now: Date.now, random: () => 0,
    waiting: (name, reason, delayMs) => { waits.push({ provider: name, reason, delayMs, at: Date.now() - start }); },
    fetch: input => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      dispatches.push({ at: Date.now() - start, host: url.hostname });
      return respond(dispatches.length, url);
    }, ...options });
  return { store, job, provider, dispatches, waits, used: () => store.job(job.id, 'mainnet-beta')!.used };
}
const json = (value: unknown, status = 200, headers?: HeadersInit) => Promise.resolve(new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) }));
const rpcResult = (result: unknown) => json({ jsonrpc: '2.0', id: 'scanner', result });
const TX = demoTransaction('3', DEMO_CUTOFF - 100);
const SIGNATURE = TX.transaction.signatures[0]!;

describe('provider requests under the limiter', () => {
  it('dispatches a full burst at once with no sleep, then paces the rest', async () => {
    const h = providers(() => rpcResult(null));
    const requests = Array.from({ length: 12 }, () => h.provider.hydrate(SIGNATURE));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.dispatches.map(item => item.at)).toEqual(Array(10).fill(0));
    expect(h.waits.every(wait => wait.reason === 'throttle')).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all(requests);
    expect(h.dispatches.map(item => item.at)).toEqual([...Array<number>(10).fill(0), 125, 250]);
    expect(h.used().helius).toBe(12);
  });

  it('never waits while the bucket has tokens', async () => {
    const h = providers(() => rpcResult(null));
    for (let i = 0; i < 10; i++) { await h.provider.hydrate(SIGNATURE); await vi.advanceTimersByTimeAsync(125); }
    expect(h.waits).toEqual([]);
    expect(h.dispatches.map(item => item.at)).toEqual(Array.from({ length: 10 }, (_, index) => index * 125));
  });

  it('paces DAS calls, holdings pages and the price fallback alike, at 2 per second apart from the RPC bucket', async () => {
    const das: number[] = []; const rpcs: number[] = [];
    let pages = 0;
    const h = providers(() => rpcResult(null), { holdingsPageLimit: 1, fetch: (input, init) => {
      const at = Date.now() - DEMO_CUTOFF * 1000;
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'www.stonkfun.xyz') return json({ data: { quote: { mint: DEMO_WALLET }, prices: { quoteUsd: null, observedAt: new Date().toISOString() } } });
      const body = JSON.parse(init?.body as string) as { method: string };
      if (body.method === 'getTransaction') { rpcs.push(at); return rpcResult(null); }
      das.push(at);
      if (body.method === 'getAsset') return rpcResult(null);
      pages++;
      return rpcResult({ items: pages < 3 ? [{ id: DEMO_WALLET, token_info: { balance: 1, decimals: 0 } }] : [] });
    } });
    const work = [h.provider.holdings!(DEMO_WALLET), h.provider.price(DEMO_WALLET), ...Array.from({ length: 3 }, () => h.provider.hydrate(SIGNATURE))];
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(work);
    // Three holdings pages and one getAsset share one token every 500 ms; the RPC calls never wait for them.
    expect([...das].sort((a, b) => a - b)).toEqual([0, 500, 1000, 1500]);
    expect(rpcs).toEqual([0, 0, 0]);
    expect(h.waits.filter(wait => wait.provider === 'helius').every(wait => wait.reason === 'throttle')).toBe(true);
    expect(h.used().helius).toBe(7);
  });

  it('honours a 429 Retry-After across the provider, then retries', async () => {
    const h = providers(call => call === 1 ? json({}, 429, { 'Retry-After': '2' }) : rpcResult(TX));
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(0);
    // A concurrent DAS lookup is held back by the same provider-wide cooldown.
    const price = h.provider.price(DEMO_WALLET);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.dispatches.filter(item => item.host === 'mainnet.helius-rpc.com').map(item => item.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await hydrated)?.transaction.transaction.signatures[0]).toBe(SIGNATURE);
    await price;
    expect(h.waits.filter(wait => wait.provider === 'helius')[0]).toMatchObject({ reason: 'rate_limit', delayMs: 2000, at: 0 });
    expect(h.dispatches.filter(item => item.host === 'mainnet.helius-rpc.com').map(item => item.at)).toEqual([0, 2000, 2000]);
    expect(h.used().helius).toBe(3);
  });

  it('backs off a 429 without Retry-After exponentially, per provider', async () => {
    const h = providers(call => call <= 2 ? json({}, 429) : rpcResult(TX));
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await hydrated)?.transaction).toEqual(TX);
    // Consecutive rate limits: one second, then two.
    expect(h.dispatches.map(item => item.at)).toEqual([0, 1000, 3000]);
    expect(h.waits.map(wait => [wait.reason, wait.delayMs])).toEqual([['rate_limit', 1000], ['rate_limit', 2000]]);
    expect(h.store.cooldown('helius')).toBe(DEMO_CUTOFF * 1000 + 3000);
  });

  it('retries a 5xx three times with backoff, counts every retry, then gives up', async () => {
    const h = providers(() => json({}, 503));
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await hydrated).toBeNull();
    expect(h.dispatches.map(item => item.at)).toEqual([0, 1000, 3000, 7000]);
    expect(h.waits.map(wait => [wait.reason, wait.delayMs])).toEqual([['retry', 1000], ['retry', 2000], ['retry', 4000]]);
    expect(h.used().helius).toBe(4);
  });

  it('retries a network failure and a timeout', async () => {
    const h = providers(call => call === 1 ? Promise.reject(new TypeError('synthetic reset'))
      : call === 2 ? new Promise<Response>(() => undefined) : rpcResult(TX));
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await hydrated)?.transaction).toEqual(TX);
    // The second attempt times out after 15 s and is retried two seconds later.
    expect(h.dispatches.map(item => item.at)).toEqual([0, 1000, 18_000]);
    expect(h.used().helius).toBe(3);
  });

  it('retries a JSON-RPC rate-limit error like HTTP 429 and gives up on other provider errors', async () => {
    const h = providers(call => call === 1 ? json({ jsonrpc: '2.0', id: 'scanner', error: { code: -32005, message: 'rate limited' } })
      : call === 2 ? rpcResult(TX) : json({ jsonrpc: '2.0', id: 'scanner', error: { code: -32602, message: 'invalid params' } }));
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await hydrated)?.transaction).toEqual(TX);
    expect(h.waits.map(wait => wait.reason)).toEqual(['rate_limit']);
    expect(await h.provider.hydrate(SIGNATURE)).toBeNull();
    expect(h.dispatches).toHaveLength(3);
  });

  it('stops at the budget: a refused request is never retried or waited on', async () => {
    const h = providers(() => json({}, 503));
    h.store.saveJob({ ...h.store.job('limiter-test', 'mainnet-beta')!, limits: { ...h.job.limits, helius: 2 } });
    const hydrated = h.provider.hydrate(SIGNATURE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await hydrated).toBeNull();
    // Two dispatched attempts, each backed off; the third is refused by the budget and ends the call.
    expect(h.dispatches.map(item => item.at)).toEqual([0, 1000]);
    expect(h.waits.map(wait => [wait.reason, wait.delayMs])).toEqual([['retry', 1000], ['retry', 2000]]);
    expect(h.used().helius).toBe(2);
  });

  it('falls through to DAS at once when StonkFun pricing is out of budget', async () => {
    const h = providers(() => json({ jsonrpc: '2.0', id: 'scanner', result: { id: DEMO_WALLET, token_info: { price_info: { currency: 'USD', price_per_token: '2.00' } } } }));
    const saved = h.store.job('limiter-test', 'mainnet-beta')!;
    h.store.saveJob({ ...saved, used: { ...saved.used, stonkfun: saved.limits.stonkfun } });
    const price = h.provider.price(DEMO_WALLET);
    await vi.advanceTimersByTimeAsync(0);
    expect(await price).toMatchObject({ value: '2.00', provider: 'helius' });
    expect(h.dispatches.map(item => item.host)).toEqual(['mainnet.helius-rpc.com']);
    expect(h.waits).toEqual([]);
  });
});

describe('the HTTP clients under the shared policy', () => {
  it('waits a provider cooldown before the attempt starts, reported as a rate limit', async () => {
    let now = Date.parse('2026-09-20T00:00:00Z');
    const waits: number[] = [];
    const events: { type: string; reason?: string }[] = [];
    const client = new PublicClient({ minRequestIntervalMs: 0 }, {
      now: () => now, sleep: ms => { waits.push(ms); now += ms; return Promise.resolve(); }, readyAt: () => Date.parse('2026-09-20T00:00:02Z'),
      fetch: () => Promise.resolve(new Response(JSON.stringify(pairs()))),
    }, undefined, event => { events.push(event); });
    expect(await client.get('pairs', '/pairs', pairsSchema)).toBeDefined();
    expect(waits).toEqual([2000]);
    expect(events.find(event => event.type === 'waiting')).toMatchObject({ reason: 'rate_limit' });
  });

  it('lets a server Retry-After replace the backoff, and caps the backoff with jitter otherwise', async () => {
    let now = Date.parse('2026-09-20T00:00:00Z');
    const waits: number[] = [];
    const answers = [new Response('{}', { status: 503, headers: { 'Retry-After': '1' } }), new Response('{}', { status: 503 }), new Response(JSON.stringify(pairs()))];
    const client = new PublicClient({ minRequestIntervalMs: 0, maxAttempts: 3, retryBaseMs: 5000, retryMaxMs: 6000, retryJitter: 0.25 }, {
      now: () => now, sleep: ms => { waits.push(ms); now += ms; return Promise.resolve(); }, random: () => 1,
      fetch: () => Promise.resolve(answers.shift()!),
    });
    expect(await client.get('pairs', '/pairs', pairsSchema)).toBeDefined();
    // One second from Retry-After, not the five-second backoff; then 10 s × 1.25 capped at 6 s.
    expect(waits).toEqual([1000, 6000]);
  });

  it('backs off history pages with the capped, jittered policy', async () => {
    let now = (query.endTime + 1000) * 1000;
    const waits: number[] = [];
    const answers = [new Response('{}', { status: 503 }), new Response('{}', { status: 503 }), new Response(JSON.stringify(historyResponse()))];
    const client = new HeliusHistoryClient(fixtureKey, { minRequestIntervalMs: 0, maxAttempts: 4, retryBaseMs: 1000, retryMaxMs: 30_000, retryJitter: 0.25 }, {
      now: () => now, sleep: ms => { waits.push(ms); now += ms; return Promise.resolve(); }, random: () => 0.5,
      fetch: () => Promise.resolve(answers.shift()!),
    });
    const result = await client.scanHistory(query, { onPage: () => undefined });
    expect(result.status).toBe('complete');
    expect(waits).toEqual([1125, 2250]);
  });
});

describe('waits in job progress', () => {
  it('surface as "waiting for provider" with the reason while a scan runs', async () => {
    const store = new SqliteRewardsStore(':memory:'); stores.push(store);
    let clock = DEMO_CUTOFF * 1000;
    let release!: () => void;
    const service = new DashboardService({ store: () => store, now: () => clock, prepareProviders: () => (_job, signal, _progress, waiting) => ({
      registry: () => new Promise((_resolve, reject) => {
        waiting('helius', 'rate_limit', 2000);
        release = () => { reject(new Error('cancelled')); };
        signal.addEventListener('abort', () => { reject(new Error('cancelled')); }, { once: true });
      }),
      hydrate: () => Promise.resolve(null), history: () => { throw new Error('unexpected'); }, price: () => { throw new Error('unexpected'); },
    } satisfies Providers) });
    const job = service.start(DEMO_WALLET);
    clock += 1000;
    const running = service.job(job.id)!;
    expect(running.progress.action).toBe('Waiting for provider: Helius rate limited by the provider, 2.0 s');
    expect(running.progress.awaitingProvider).toBe(true);
    release();
    await service.settle();
  });
});
