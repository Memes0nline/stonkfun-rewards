import { describe, expect, it } from 'vitest';
import { loadStonkFunRegistry } from '../src/index.js';
import type { ProgressEvent, RegistryOptions } from '../src/index.js';
import { at, config, distribution, huge, mint, page, pair, pairs, rewards, signature, summary } from './fixtures/stonkfun.js';
import { harness } from './helpers.js';
import type { Step } from './helpers.js';

const options: RegistryOptions = { pageSize: 2, http: { maxAttempts: 1, minRequestIntervalMs: 0 } };
const extras = (): Step[] => [{ path: '/rewards', body: rewards() }, { path: '/pairs', body: pairs() }];
const stablePages = (): Step[] => [0, 1].flatMap(() => [
  { path: '/launches', page: 1, body: page(['A', 'B'], 1, 3) },
  { path: '/launches', page: 2, body: page(['C'], 2, 3) },
]);

describe('registry discovery and evidence', () => {
  it('follows returned page size/boundaries, reconciles, deduplicates launches, and records real progress', async () => {
    const h = harness([...stablePages(), ...extras()]);
    const events: ProgressEvent[] = [];
    const result = await loadStonkFunRegistry({ ...options, pageSize: 100, onProgress: (event) => events.push(event) }, h.runtime);
    expect(result.status).toBe('complete');
    expect(h.requests.map((url) => url.searchParams.get('page'))).toEqual(['1', '2', '1', '2', null, null]);
    expect(result.launches).toHaveLength(4);
    expect(result.launches[0]?.ledger[0]?.sourceIds).toEqual(['source-1', 'source-3']);
    expect(result.discovery).toMatchObject({ incomplete: false, ledger: 'observed_stable', atomicSnapshot: false, lifetimeCoverage: 'not_guaranteed', pagesFetched: 4, passes: 2 });
    expect(result.sources[0]).toMatchObject({ generatedAt: at, requestedAt: at, retrievedAt: at, requestedPage: 1, pagination: { pageSize: 2, totalPages: 2 } });
    expect(events.filter((event) => event.type === 'page')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'request')).toHaveLength(h.requests.length);
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'complete', pagesFetched: 4 });
    expect(h.remaining).toHaveLength(0);
  });

  it.each([0, 1, 2, 3, 4])('terminates exactly at the returned last page for %i launches', async (total) => {
    const ids = ['A', 'B', 'C', 'D'].slice(0, total);
    const sweep: Step[] = Array.from({ length: Math.max(1, Math.ceil(total / 2)) }, (_, i) => ({
      path: '/launches', page: i + 1, body: page(ids.slice(i * 2, i * 2 + 2), i + 1, total),
    }));
    const h = harness([...sweep, ...sweep, ...extras()]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.discovery.incomplete).toBe(false);
    expect(result.discovery.pagesFetched).toBe(sweep.length * 2);
    expect(h.remaining).toHaveLength(0);
  });

  it('retains missing, non-launchable, and unfamiliar-category quotes without admitting unrelated pairs', async () => {
    const h = harness([...stablePages(), ...extras()]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.quoteAssets.map((asset) => asset.mint)).toEqual([mint('Q'), mint('Z')]);
    expect(result.quoteAssets[0]?.pairMetadata[0]?.value).toMatchObject({ launchable: false, category: 'future-unfamiliar-category' });
    expect(result.quoteAssets[1]).toMatchObject({ mint: mint('Z'), pairMetadata: [], evidence: [{ kind: 'rewardSummary', launchMint: mint('R'), decimals: 6 }] });
  });

  it('groups shared signatures, removes only exact duplicates, and preserves integer strings', async () => {
    const feed = rewards();
    const rows = [distribution(), distribution('B', '000123'), { ...distribution(), holderCount: 3 },
      { ...distribution(), extension: { b: 2, a: 1 } }, { ...distribution(), extension: { a: 1, b: 2 } }, distribution()];
    const h = harness([...stablePages(), { path: '/rewards', body: { ...feed, data: { ...feed.data, recentDistributions: rows } } }, { path: '/pairs', body: pairs() }]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.distributions).toHaveLength(1);
    expect(result.distributions[0]?.signature).toBe(signature);
    expect(result.distributions[0]?.rows).toHaveLength(4);
    expect(result.distributions[0]?.rows.map((row) => row.value.amountRaw)).toEqual([huge, '000123', huge, huge]);
    expect(result.launches.find((entry) => entry.mint === mint('R'))?.rewardSummaries[0]?.value.distributedRaw).toBe(huge);
    expect(JSON.stringify(result)).toContain(huge);
  });

  it('includes a quote supported only by a feed row and does not invent a launch summary', async () => {
    const h = harness([...stablePages(), { path: '/rewards', body: { data: { launches: [], recentDistributions: [{ ...distribution('X'), quoteMint: mint('Y') }] } } }, { path: '/pairs', body: pairs() }]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.quoteAssets.find((asset) => asset.mint === mint('Y'))?.evidence[0]?.kind).toBe('distribution');
    expect(result.launches.some((entry) => entry.mint === mint('X'))).toBe(false);
  });

  it('keeps withdrawal configuration separate and never invents payout-authority evidence', async () => {
    const h = harness([...stablePages(), ...extras(), { path: '/launchlab/pricing', body: config() }]);
    const result = await loadStonkFunRegistry({ ...options, authorityQuoteMint: mint('Q') }, h.runtime);
    expect(result.authorities.withdrawal).toEqual([{ role: 'withdrawWithheldAuthority', authority: mint('W'), configurationQuoteMint: mint('Q'), sourceId: 'source-7' }]);
    expect(result.authorities.payout).toEqual({ status: 'not_verified', evidence: [] });
    expect(result.authorities.configuration).toBe('loaded');
    expect(result.sources.at(-1)?.endpoint).toBe(`/launchlab/pricing?quoteMint=${mint('Q')}`);
  });

  it('flags conflicting launch quote identities while retaining both observations', async () => {
    const h = harness([...stablePages(), { path: '/rewards', body: { data: { launches: [summary('A', 'Z')], recentDistributions: [] } } }, { path: '/pairs', body: pairs() }]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.discovery.incomplete).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'launch_quote_conflict')).toBe(true);
    expect(result.launches[0]?.rewardSummaries[0]?.value.quote.mint).toBe(mint('Z'));
    expect(result.launches[0]?.ledger[0]?.value.quote.mint).toBe(mint('Q'));
  });

  it('preserves conflicting pair variants without overwriting discovery metadata', async () => {
    const h = harness([...stablePages(), { path: '/rewards', body: rewards() }, { path: '/pairs', body: { data: { pairs: [pair(), { ...pair(), decimals: 6 }] } } }]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.quoteAssets[0]?.pairMetadata).toHaveLength(2);
  });
});

describe('mutable and faulty pagination', () => {
  it.each(['clamped', 'repeated'] as const)('halts a %s page instead of looping', async (kind) => {
    const h = harness([
      { path: '/launches', page: 1, body: page(['A', 'B'], 1, 4) },
      { path: '/launches', page: 2, body: page(['A', 'B'], kind === 'clamped' ? 1 : 2, 4) }, ...extras(),
    ]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.status).toBe('partial');
    expect(result.discovery.pagesFetched).toBe(2);
    expect(result.issues.some((issue) => issue.code === `${kind}_page`)).toBe(true);
    expect(result.quoteAssets.some((asset) => asset.mint === mint('Z'))).toBe(true);
    expect(h.remaining).toHaveLength(0);
  });

  it('follows growth and bounded full catch-up until two consistent sweeps agree', async () => {
    const finalSweep: Step[] = [
      { path: '/launches', page: 1, body: page(['D', 'A'], 1, 4) },
      { path: '/launches', page: 2, body: page(['B', 'C'], 2, 4) },
    ];
    const h = harness([
      { path: '/launches', page: 1, body: page(['A', 'B'], 1, 3) },
      { path: '/launches', page: 2, body: page(['B', 'C'], 2, 4) },
      ...finalSweep, ...finalSweep, ...extras(),
    ]);
    const result = await loadStonkFunRegistry({ ...options, maxCatchUpPasses: 2 }, h.runtime);
    expect(result.status).toBe('complete');
    expect(result.discovery.passes).toBe(3);
    expect(result.launches.filter((entry) => entry.ledger.length > 0)).toHaveLength(4);
    expect(result.issues.some((issue) => issue.code === 'changing_totals')).toBe(true);
  });

  it('handles shrinking totals with a newly clamped last page explicitly', async () => {
    const h = harness([
      { path: '/launches', body: page(['A', 'B'], 1, 5) },
      { path: '/launches', page: 2, body: page(['C', 'D'], 2, 5) },
      { path: '/launches', page: 3, body: page(['C'], 2, 3) }, ...extras(),
    ]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.discovery.incomplete).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'clamped_page')).toBe(true);
  });

  it('visits newly advertised tail pages when totalPages grows during a pass', async () => {
    const sweep: Step[] = [
      { path: '/launches', page: 1, body: page(['A', 'B'], 1, 5) },
      { path: '/launches', page: 2, body: page(['C', 'D'], 2, 5) },
      { path: '/launches', page: 3, body: page(['E'], 3, 5) },
    ];
    const h = harness([
      { path: '/launches', page: 1, body: page(['A', 'B'], 1, 3) },
      ...sweep.slice(1), ...sweep, ...sweep, ...extras(),
    ]);
    const result = await loadStonkFunRegistry({ ...options, maxCatchUpPasses: 2 }, h.runtime);
    expect(result.status).toBe('complete');
    expect(result.discovery.pagesFetched).toBe(9);
    expect(result.launches.some((entry) => entry.mint === mint('E'))).toBe(true);
    expect(h.remaining).toHaveLength(0);
  });

  it('does not claim stable discovery when totals or identities keep changing', async () => {
    const h = harness([
      { path: '/launches', body: page(['A'], 1, 1) },
      { path: '/launches', body: page(['B'], 1, 1) }, ...extras(),
    ]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.status).toBe('partial');
    expect(result.discovery.passes).toBe(2);
    expect(result.launches.filter((entry) => entry.ledger.length > 0)).toHaveLength(2);
  });

  it('enforces a page budget and reports catch-up disabled as incomplete', async () => {
    const h = harness([{ path: '/launches', body: page(['A', 'B'], 1, 4) }, ...extras()]);
    const result = await loadStonkFunRegistry({ ...options, maxPages: 1 }, h.runtime);
    expect(result.issues.some((issue) => issue.code === 'page_limit')).toBe(true);
    const h2 = harness([{ path: '/launches', body: page(['A']) }, ...extras()]);
    expect((await loadStonkFunRegistry({ ...options, maxCatchUpPasses: 0 }, h2.runtime)).discovery.incomplete).toBe(true);
  });

  it('reports malformed metadata and overlapping boundary omissions without discarding evidence', async () => {
    const overlapping = [
      { path: '/launches', body: page(['A', 'B'], 1, 3) },
      { path: '/launches', body: page(['B'], 2, 3) },
    ];
    const h = harness([...overlapping, ...overlapping, ...extras()]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.discovery.incomplete).toBe(true);
    expect(result.launches.filter((entry) => entry.ledger.length > 0)).toHaveLength(2);
    const malformed = page(['A']);
    malformed.data.pagination.totalPages = 0;
    const h2 = harness([{ path: '/launches', body: malformed }, { path: '/launches', body: malformed }, ...extras()]);
    expect((await loadStonkFunRegistry(options, h2.runtime)).issues.some((issue) => issue.code === 'inconsistent_pagination')).toBe(true);
  });
});

describe('partial failures and cancellation', () => {
  it('retains earlier pages after a later page fails and continues independent sources', async () => {
    const h = harness([
      { path: '/launches', page: 1, body: page(['A', 'B'], 1, 3) },
      { path: '/launches', page: 2, status: 503 }, ...extras(),
    ]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.status).toBe('partial');
    expect(result.discovery.pagesFetched).toBe(1);
    expect(result.launches.filter((entry) => entry.ledger.length > 0)).toHaveLength(2);
    expect(result.discovery.rewards).toBe('loaded');
    expect(result.enrichment).toBe('loaded');
  });

  it.each(['launches', 'rewards', 'pairs', 'withdrawalConfig'] as const)('preserves independent evidence when %s fails', async (source) => {
    const steps: Step[] = source === 'launches'
      ? [{ path: '/launches', status: 503 }]
      : stablePages();
    steps.push({ path: '/rewards', ...(source === 'rewards' ? { status: 503 } : { body: rewards() }) });
    steps.push({ path: '/pairs', ...(source === 'pairs' ? { status: 503 } : { body: pairs() }) });
    steps.push({ path: '/launchlab/pricing', ...(source === 'withdrawalConfig' ? { status: 503 } : { body: config() }) });
    const h = harness(steps);
    const result = await loadStonkFunRegistry({ ...options, authorityQuoteMint: mint('Q') }, h.runtime);
    expect(result.status).toBe('partial');
    expect(result.quoteAssets.length).toBeGreaterThan(0);
    expect(result.discovery.incomplete).toBe(source === 'launches' || source === 'rewards');
    expect(result.sources.find((record) => record.source === source && record.outcome === 'failure')?.failure).toBe('http');
  });

  it('rejects numeric raw amounts instead of silently losing precision', async () => {
    const h = harness([...stablePages(), { path: '/rewards', body: { data: { launches: [], recentDistributions: [{ ...distribution(), amountRaw: 9007199254740992 }] } } }, { path: '/pairs', body: pairs() }]);
    const result = await loadStonkFunRegistry(options, h.runtime);
    expect(result.discovery.rewards).toBe('failed');
    expect(result.distributions).toEqual([]);
    expect(result.sources.find((record) => record.source === 'rewards')?.failure).toBe('invalid_response');
  });

  it.each(['1e18', '-1', '1.2', ''])('rejects non-integer raw string %s', async (amountRaw) => {
    const h = harness([...stablePages(), { path: '/rewards', body: { data: { launches: [], recentDistributions: [distribution('A', amountRaw)] } } }, { path: '/pairs', body: pairs() }]);
    expect((await loadStonkFunRegistry(options, h.runtime)).discovery.rewards).toBe('failed');
  });

  it('stops on cancellation with collected evidence and no invented later-stage success', async () => {
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const h = harness([{ path: '/launches', body: page(['A', 'B'], 1, 4) }]);
    const result = await loadStonkFunRegistry({ ...options, signal: controller.signal, onProgress: (event) => {
      events.push(event); if (event.type === 'page') controller.abort();
    } }, h.runtime);
    expect(result.status).toBe('cancelled');
    expect(result.launches).toHaveLength(2);
    expect(result.discovery.rewards).toBe('not_requested');
    expect(events.some((event) => event.type === 'source')).toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  it('makes no requests when already cancelled and validates configuration before network work', async () => {
    const h = harness([]);
    const result = await loadStonkFunRegistry({ ...options, signal: AbortSignal.abort() }, h.runtime);
    expect(result.status).toBe('cancelled');
    expect(h.requests).toHaveLength(0);
    await expect(loadStonkFunRegistry({ maxPages: Infinity }, h.runtime)).rejects.toThrow('Invalid registry option');
    await expect(loadStonkFunRegistry({ authorityQuoteMint: 'https://credential.invalid' }, h.runtime)).rejects.toThrow('Invalid authority quote mint');
  });
});
