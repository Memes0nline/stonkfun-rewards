import { afterEach, expect, vi } from 'vitest';
import type { Runtime } from '../src/index.js';
import { at } from './fixtures/stonkfun.js';

export interface Step { path: string; page?: number; body?: unknown; status?: number; headers?: HeadersInit; error?: Error }
const unexpected: string[] = [];
afterEach(() => {
  const actual = unexpected.splice(0);
  expect(actual, 'All requests must match fixture routing').toEqual([]);
});
export function harness(steps: Step[]) {
  let now = Date.parse(at);
  const remaining = [...steps];
  const requests: URL[] = [];
  const delays: number[] = [];
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    const step = remaining.shift();
    if (!step || url.pathname !== `/api/public/v1${step.path}` || (step.page !== undefined && Number(url.searchParams.get('page')) !== step.page)) {
      unexpected.push(url.pathname + url.search);
      throw new Error('Unexpected fixture request');
    }
    if (step.error) return Promise.reject(step.error);
    return Promise.resolve(new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, ...(step.headers === undefined ? {} : { headers: step.headers }) }));
  });
  const runtime: Runtime = {
    fetch: fetcher, now: () => now,
    sleep: (ms) => { delays.push(ms); now += ms; return Promise.resolve(); },
  };
  return { runtime, remaining, requests, delays, fetcher };
}
