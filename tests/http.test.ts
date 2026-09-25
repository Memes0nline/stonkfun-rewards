import { describe, expect, it, vi } from 'vitest';
import { PublicClient } from '../src/registry/http.js';
import type { HttpOptions, Runtime } from '../src/registry/http.js';
import { pairsSchema } from '../src/registry/schemas.js';
import type { ProgressEvent } from '../src/index.js';
import { at, pairs } from './fixtures/stonkfun.js';
import { harness } from './helpers.js';

function client(runtime: Runtime, options: HttpOptions = {}, signal?: AbortSignal, events?: ProgressEvent[]) {
  return new PublicClient({ minRequestIntervalMs: 0, ...options }, runtime, signal, (event) => events?.push(event));
}

describe('public request safeguards', () => {
  it('uses GET on the fixed public origin, never reads environment credentials, and refuses redirects', async () => {
    const h = harness([{ path: '/pairs', body: pairs() }]);
    const api = client(h.runtime);
    await api.get('pairs', '/pairs', pairsSchema);
    expect(h.requests[0]?.origin).toBe('https://www.stonkfun.xyz');
    expect(h.fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } });
    expect(api.sources[0]).toMatchObject({ endpoint: '/pairs', attempts: 1, outcome: 'success' });
  });

  it('bounds retries with exponential backoff and keeps raw errors out of output/events', async () => {
    const secret = 'synthetic-private-value';
    const h = harness(Array.from({ length: 3 }, () => ({ path: '/pairs', error: new Error(`https://provider.invalid/?key=${secret}`) })));
    const events: ProgressEvent[] = [];
    const api = client(h.runtime, { retryBaseMs: 100 }, undefined, events);
    expect(await api.get('pairs', '/pairs', pairsSchema)).toBeUndefined();
    expect(h.delays).toEqual([100, 200]);
    expect(api.sources[0]).toMatchObject({ attempts: 3, failure: 'network', outcome: 'failure' });
    expect(JSON.stringify([api.sources, events])).not.toContain(secret);
    expect(events.filter((event) => event.type === 'request')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'response', outcome: 'failure', failure: 'network' });
  });

  it.each([408, 425, 429, 500, 503])('retries HTTP %i and retains final success evidence', async (status) => {
    const h = harness([{ path: '/pairs', status }, { path: '/pairs', body: pairs() }]);
    const api = client(h.runtime, { retryBaseMs: 10 });
    expect((await api.get('pairs', '/pairs', pairsSchema))?.value.data.pairs).toHaveLength(2);
    expect(api.sources[0]).toMatchObject({ attempts: 2, outcome: 'success', httpStatus: 200 });
    expect(api.sources[0]?.failure).toBeUndefined();
  });

  it.each(['2', new Date(Date.parse(at) + 2000).toUTCString()])('honors Retry-After %s', async (retryAfter) => {
    const h = harness([{ path: '/pairs', status: 429, headers: { 'Retry-After': retryAfter } }, { path: '/pairs', body: pairs() }]);
    const api = client(h.runtime);
    await api.get('pairs', '/pairs', pairsSchema);
    expect(h.delays).toEqual([2000]);
    expect(api.sources[0]?.retrievedAt).toBe('2026-09-20T00:00:02.000Z');
  });

  it('does not retry earlier than an excessive server wait; carries cooldown to later sources', async () => {
    const h = harness([{ path: '/pairs', status: 429, headers: { 'Retry-After': '3600' } }]);
    const api = client(h.runtime, { maxWaitMs: 1000 });
    await api.get('pairs', '/pairs', pairsSchema);
    await api.get('pairs', '/pairs', pairsSchema);
    expect(h.requests).toHaveLength(1);
    expect(h.delays).toEqual([]);
    expect(api.sources.map((source) => source.failure)).toEqual(['rate_limit', 'rate_limit']);
    expect(api.sources[1]?.attempts).toBe(0);
  });

  it('throttles at 250 ms by default and observes the successful-response reset header', async () => {
    const h = harness([
      { path: '/pairs', body: pairs() },
      { path: '/pairs', body: pairs(), headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.parse(at) / 1000 + 3) } },
      { path: '/pairs', body: pairs() },
    ]);
    const api = new PublicClient({}, h.runtime);
    for (let i = 0; i < 3; i++) await api.get('pairs', '/pairs', pairsSchema);
    expect(h.delays).toEqual([250, 2750]);
  });

  it.each([400, 401, 403, 404])('does not retry non-transient HTTP %i or expose response bodies', async (status) => {
    const h = harness([{ path: '/pairs', status, body: { error: 'synthetic-sensitive-provider-message' } }]);
    const api = client(h.runtime);
    await api.get('pairs', '/pairs', pairsSchema);
    expect(h.requests).toHaveLength(1);
    expect(api.sources[0]).toMatchObject({ failure: 'http', httpStatus: status });
    expect(JSON.stringify(api.sources)).not.toContain('synthetic-sensitive');
  });

  it('rejects invalid JSON and schema responses without storing raw data', async () => {
    const api = client({ fetch: () => Promise.resolve(new Response('{invalid sensitive JSON')) });
    await api.get('pairs', '/pairs', pairsSchema);
    expect(api.sources[0]?.failure).toBe('invalid_response');
    const h = harness([{ path: '/pairs', body: { data: { pairs: [{ mint: 'bad' }] } } }]);
    const api2 = client(h.runtime);
    await api2.get('pairs', '/pairs', pairsSchema);
    expect(api2.sources[0]?.failure).toBe('invalid_response');
    expect(api2.sources[0]?.attempts).toBe(1);
  });

  it.each([true, false])('limits response size with or without Content-Length (%s)', async (declared) => {
    const api = client({ fetch: () => Promise.resolve(new Response('x'.repeat(40), {
      headers: declared ? { 'Content-Length': '40' } : {},
    })) }, { maxResponseBytes: 20 });
    await api.get('pairs', '/pairs', pairsSchema);
    expect(api.sources[0]?.failure).toBe('response_too_large');
    expect(api.sources[0]?.attempts).toBe(1);
  });

  it('times out and bounds attempts even when the fetch adapter ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const api = client({ fetch: fetcher }, { timeoutMs: 50, maxAttempts: 2, retryBaseMs: 10 });
    const result = api.get('pairs', '/pairs', pairsSchema);
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toBeUndefined();
    expect(api.sources[0]).toMatchObject({ failure: 'timeout', attempts: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the timeout active while streaming the response body', async () => {
    vi.useFakeTimers();
    const api = client({ fetch: () => Promise.resolve(new Response(new ReadableStream())) }, { timeoutMs: 50, maxAttempts: 1 });
    const result = api.get('pairs', '/pairs', pairsSchema);
    await vi.advanceTimersByTimeAsync(60);
    expect(await result).toBeUndefined();
    expect(api.sources[0]?.failure).toBe('timeout');
  });

  it('retries a connection failure while reading a body', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('synthetic connection reset')); },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(pairs())));
    const api = client({ fetch: fetcher }, { retryBaseMs: 0 });
    expect(await api.get('pairs', '/pairs', pairsSchema)).toBeDefined();
    expect(api.sources[0]).toMatchObject({ attempts: 2, outcome: 'success' });
  });

  it('cancels an in-flight request without retries', async () => {
    const controller = new AbortController();
    const api = client({ fetch: () => new Promise(() => undefined) }, {}, controller.signal);
    const result = api.get('pairs', '/pairs', pairsSchema);
    controller.abort();
    expect(await result).toBeUndefined();
    expect(api.sources[0]).toMatchObject({ failure: 'cancelled', attempts: 1 });
  });

  it('cancels during Retry-After waiting without a second request', async () => {
    const controller = new AbortController();
    const h = harness([{ path: '/pairs', status: 429, headers: { 'Retry-After': '10' } }]);
    const api = client({ ...h.runtime, sleep: () => { controller.abort(); return Promise.resolve(); } }, {}, controller.signal);
    await api.get('pairs', '/pairs', pairsSchema);
    expect(api.sources[0]?.failure).toBe('cancelled');
    expect(h.requests).toHaveLength(1);
  });

  it('isolates progress-listener exceptions from request success', async () => {
    const h = harness([{ path: '/pairs', body: pairs() }]);
    const api = new PublicClient({}, h.runtime, undefined, () => { throw new Error('UI error'); });
    expect(await api.get('pairs', '/pairs', pairsSchema)).toBeDefined();
  });
});
