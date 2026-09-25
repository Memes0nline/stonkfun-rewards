import { afterEach, expect, vi } from 'vitest';
import type { HeliusHttpOptions, HeliusRuntime, HistoryPage } from '../src/index.js';
import { HeliusHistoryClient } from '../src/index.js';
import { fixtureKey, query, response } from './fixtures/helius.js';

export interface HeliusStep { body?: unknown; status?: number; headers?: HeadersInit; error?: Error; raw?: Response }
const unexpected: string[] = [];
afterEach(() => { expect(unexpected.splice(0), 'Every fixture request is budgeted').toEqual([]); });
export function heliusHarness(steps: HeliusStep[], http: HeliusHttpOptions = {}) {
  let now = (query.endTime + 1000) * 1000;
  const remaining = [...steps];
  const requests: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  const waits: number[] = [];
  const pages: HistoryPage[] = [];
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Fixture expected a JSON body');
    requests.push({ url: input instanceof Request ? input.url : String(input), init, body: JSON.parse(init.body) as unknown });
    const step = remaining.shift();
    if (!step) { unexpected.push('unexpected request'); return Promise.reject(new Error('Unexpected fixture request')); }
    if (step.error) return Promise.reject(step.error);
    return Promise.resolve(step.raw ?? new Response(JSON.stringify(step.body ?? response()), {
      status: step.status ?? 200, ...(step.headers === undefined ? {} : { headers: step.headers }),
    }));
  });
  const runtime: HeliusRuntime = { fetch: fetcher, now: () => now, sleep: (ms) => { waits.push(ms); now += ms; return Promise.resolve(); } };
  const client = new HeliusHistoryClient(fixtureKey, { minRequestIntervalMs: 0, maxAttempts: 1, ...http }, runtime);
  return { client, runtime, requests, remaining, waits, pages, fetcher, onPage: (page: HistoryPage) => { pages.push(page); } };
}
