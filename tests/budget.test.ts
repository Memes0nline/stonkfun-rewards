import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { runScan, STONKFUN_BUDGET_CAP, stonkfunBudgetKey } from '../src/scanner/engine.js';
import type { ScanInput } from '../src/scanner/engine.js';
import { createRealProviders } from '../src/providers/real.js';
import { DashboardService } from '../src/web/service.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoFetch } from '../src/cli/demo.js';
import type { ScanProgress } from '../src/scanner/types.js';
import { FEED_HEAVY_MINTS, feedHeavy } from './fixtures/feed-heavy.js';

const stores: SqliteRewardsStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const LIMITS = { helius: 200, pages: 40, resumes: 3 };
/** Discovery on a fresh database: one launch page, rewards, pairs and the withdraw configuration read. */
const DISCOVERY = 4;

function setup() {
  const store = new SqliteRewardsStore(':memory:'); stores.push(store);
  const data = feedHeavy();
  let clock = DEMO_CUTOFF * 1000;
  const now = () => { clock += 1000; return clock; };
  const stonkfunCalls: string[] = [];
  const base = demoFetch(data, now);
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'www.stonkfun.xyz') stonkfunCalls.push(url.pathname + url.search);
    return base(input, init);
  };
  const events: ScanProgress[] = [];
  const scan = (overrides: Partial<ScanInput> & { stonkfun: number }, signal?: AbortSignal) => runScan(store, {
    wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: `budget-${overrides.stonkfun}-${overrides.resume ?? 'new'}`, owner: 'budget-owner',
    limits: { ...LIMITS, stonkfun: overrides.stonkfun, deadline: now() + 3_600_000 }, ...overrides,
  }, job => createRealProviders({ store, job, apiKey: 'synthetic-budget-key', fetch: fetcher, now, ...(signal ? { signal } : {}) }),
  { now, progress: event => { events.push(event); }, ...(signal ? { signal } : {}) });
  const pricing = () => stonkfunCalls.filter(call => call.startsWith('/api/public/v1/launchlab/pricing?quoteMint=') && !call.endsWith('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  return { store, data, now, scan, stonkfunCalls, pricing, events };
}

describe('sized StonkFun budget', () => {
  it('is discovery plus one request per mint needing a price, and prices every attributed or verified mint', async () => {
    const h = setup();
    const job = await h.scan({ stonkfun: STONKFUN_BUDGET_CAP, sizeStonkfunBudget: true });
    expect(job.status).toBe('complete');
    expect(job.limits.stonkfun).toBe(DISCOVERY + 12);
    expect(job.used.stonkfun).toBe(DISCOVERY + 12);
    // Every mint had its StonkFun request; the six StonkFun leaves unpriced fell through to DAS.
    expect(h.pricing()).toHaveLength(12);
    const prices = FEED_HEAVY_MINTS.map(mint => h.store.price('mainnet-beta', mint));
    expect(prices.filter(price => price?.provider === 'stonkfun' && price.value !== null)).toHaveLength(6);
    expect(prices.filter(price => price?.provider === 'helius')).toHaveLength(6);
    expect(h.events.map(event => event.action)).toContain(`StonkFun budget ${DISCOVERY + 12}: ${DISCOVERY} already used + 12 prices`);
  });

  it('does not count a mint whose saved price is still fresh', async () => {
    const h = setup();
    for (const mint of FEED_HEAVY_MINTS.slice(0, 5)) {
      h.store.savePrice('mainnet-beta', { mint, currency: 'USD', value: '1', provider: 'fixture', observedAt: null,
        retrievedAt: new Date(DEMO_CUTOFF * 1000).toISOString(), expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    }
    const job = await h.scan({ stonkfun: STONKFUN_BUDGET_CAP, sizeStonkfunBudget: true });
    expect(job.limits.stonkfun).toBe(DISCOVERY + 7);
    expect(job.used.stonkfun).toBe(DISCOVERY + 7);
    expect(h.pricing()).toHaveLength(7);
  });

  it('never exceeds its cap; mints beyond it fall through to DAS', async () => {
    const h = setup();
    const job = await h.scan({ stonkfun: 8, sizeStonkfunBudget: true });
    expect(job.limits.stonkfun).toBe(8);
    expect(job.used.stonkfun).toBe(8);
    expect(h.pricing()).toHaveLength(8 - DISCOVERY);
    expect(h.events.map(event => event.action)).toContain(`StonkFun budget 8: ${DISCOVERY} already used + 12 prices, capped at 8`);
  });

  it('keeps an explicit budget as given', async () => {
    const h = setup();
    const job = await h.scan({ stonkfun: 30 });
    expect(job.limits.stonkfun).toBe(30);
    expect(job.used.stonkfun).toBe(DISCOVERY + 12);
    expect(h.store.cache(stonkfunBudgetKey(job.id))).toBeUndefined();
  });

  it('keeps sizing across a resume, from the original cap', async () => {
    const h = setup();
    const controller = new AbortController();
    const first = h.scan({ stonkfun: STONKFUN_BUDGET_CAP, sizeStonkfunBudget: true }, controller.signal);
    controller.abort();
    const paused = await first;
    expect(paused).toMatchObject({ status: 'paused', error: 'cancelled' });
    expect(paused.limits.stonkfun).toBe(STONKFUN_BUDGET_CAP);
    const resumed = await h.scan({ stonkfun: 5, resume: paused.id });
    expect(resumed.status).toBe('complete');
    expect(resumed.limits.stonkfun).toBe(resumed.used.stonkfun);
    expect(h.pricing()).toHaveLength(12);
  });

  it('is what a dashboard scan uses, and its job shows the budget used', async () => {
    const store = new SqliteRewardsStore(':memory:'); stores.push(store);
    const data = feedHeavy();
    let clock = DEMO_CUTOFF * 1000;
    const now = () => { clock += 1000; return clock; };
    const service = new DashboardService({ store: () => store, now,
      prepareProviders: () => (job, signal) => createRealProviders({ store, job, apiKey: 'synthetic-budget-key', fetch: demoFetch(data, now), now, signal }) });
    service.start(DEMO_WALLET); await service.settle();
    const job = service.job(DEMO_WALLET)!;
    expect(job.status).toBe('complete');
    expect(job.limits.stonkfun).toBe(DISCOVERY + 12);
    expect(job.used.stonkfun).toBe(DISCOVERY + 12);
  });
});
