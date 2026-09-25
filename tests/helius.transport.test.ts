import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeliusHistoryClient } from '../src/index.js';
import type { HeliusHttpOptions, HeliusProgressEvent } from '../src/index.js';
import { fixtureKey, query, response, rpcError, tokenProgram, transaction, wallet } from './fixtures/helius.js';
import { heliusHarness } from './helius.helpers.js';

afterEach(() => { vi.useRealTimers(); });

describe('capability failures and safe diagnostics', () => {
  it.each([
    [401, {}, 'authentication', 'check_api_key'],
    [200, rpcError(-32000, 'Invalid API key'), 'authentication', 'check_api_key'],
    [403, rpcError(-32000, 'Upgrade your subscription plan'), 'entitlement', 'check_plan_access'],
    [200, rpcError(-32601, 'This method requires a paid plan'), 'entitlement', 'check_plan_access'],
    [403, { message: 'Forbidden' }, 'access_denied', 'check_plan_access'],
    [400, {}, 'invalid_parameter', 'check_query'],
    [200, rpcError(-32602, 'Invalid params'), 'invalid_parameter', 'check_query'],
    [200, rpcError(-32601, 'Method not found'), 'method_unavailable', 'check_method_availability'],
    [200, rpcError(-32123, 'Unknown provider error'), 'provider_error', 'inspect_provider_response'],
  ] as const)('categorizes HTTP %s / %j without fallback', async (status, body, category, action) => {
    const h = heliusHarness([{ status, body }], { maxAttempts: 3 });
    const events: HeliusProgressEvent[] = [];
    const result = await h.client.probe(query, { onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category, action, retryable: false } });
    expect(h.requests).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['started', 'request', 'response', 'finished']);
    expect(events.at(-1)).toMatchObject({ status: 'failed', pagesDelivered: 0, requestsMade: 1 });
  });

  it('does not cache a failed probe or expose provider text, URLs, or injected exception text', async () => {
    const secretUrl = `https://example.test/?api-key=${fixtureKey}`;
    const h = heliusHarness([
      { status: 401, body: rpcError(-32000, `Invalid API key at ${secretUrl}`) },
      { error: new Error(`Network rejected ${secretUrl}`) },
    ]);
    const events: HeliusProgressEvent[] = [];
    const options = { onProgress: (event: HeliusProgressEvent) => events.push(event) };
    const probe = await h.client.probe(query, options);
    const scan = await h.client.scanHistory(query, { ...options, onPage: h.onPage });
    expect(scan).toMatchObject({ status: 'partial', reusedCapability: false, failure: { category: 'transient', reason: 'network' } });
    const output = JSON.stringify([h.client, probe, scan, events, h.pages]);
    expect(output).not.toContain(fixtureKey);
    expect(output).not.toContain('https://');
    expect(output).not.toContain('Network rejected');
    expect(h.requests).toHaveLength(2);
  });

  it.each([
    response([], fixtureKey),
    response([{ ...transaction(), futureEvidence: { reflectedKey: fixtureKey } }]),
    response([{ ...transaction(), meta: { ...transaction().meta, logMessages: [`secret ${fixtureKey}`] } }]),
    response([], 'https://example.test/?access_token=credential'),
    response([{ ...transaction(), futureEvidence: { url: 'https://user:password@example.test/' } }]),
  ])('rejects credential reflections even inside a successful response', async (body) => {
    const h = heliusHarness([{ body }]);
    const events: HeliusProgressEvent[] = [];
    const result = await h.client.scanHistory(query, { onPage: h.onPage, onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ status: 'partial', failure: { category: 'sensitive_response' }, pagesDelivered: 0 });
    expect(JSON.stringify([result, events])).not.toContain(fixtureKey);
    expect(h.pages).toEqual([]);
  });

  it('blocks credential-bearing input cursors before sending a request', async () => {
    const h = heliusHarness([]);
    await expect(h.client.scanHistory(query, { onPage: h.onPage, startCursor: `prefix:${fixtureKey}` })).rejects.toThrow('Invalid Helius history options');
    await expect(h.client.scanHistory(query, { onPage: h.onPage, startCursor: 'https://example.test/?api_key=secret' })).rejects.toThrow('Invalid Helius history options');
    expect(h.requests).toHaveLength(0);
  });
  it('rejects reflected credentials containing JSON or URL escape characters', async () => {
    const key = 'fixture-key-"-backslash-\\-percent-%';
    for (const reflected of [key, encodeURIComponent(key)]) {
      const h = heliusHarness([{ body: response([], reflected) }]);
      const client = new HeliusHistoryClient(key, {}, h.runtime);
      const result = await client.probe(query);
      expect(result).toMatchObject({ status: 'failed', failure: { category: 'sensitive_response' } });
      expect(JSON.stringify(result)).not.toContain(reflected);
    }
  });

  it('reuses an empty successful probe only once and only for the same wallet', async () => {
    const h = heliusHarness([{ body: response() }, { body: response() }, { body: response() }, { body: response() }]);
    expect((await h.client.probe(query)).status).toBe('supported');
    expect(await h.client.scanHistory(query, { onPage: h.onPage })).toMatchObject({ status: 'complete', requestsMade: 0, reusedCapability: true });
    expect((await h.client.scanHistory(query, { onPage: h.onPage })).reusedCapability).toBe(false);
    await h.client.probe(query);
    expect((await h.client.scanHistory({ ...query, wallet: 'So11111111111111111111111111111111111111112' }, { onPage: h.onPage })).reusedCapability).toBe(false);
    expect(h.requests).toHaveLength(4);
  });
});

describe('bounded retries, throttling, and request accounting', () => {
  it.each([
    { status: 408 }, { status: 425 }, { status: 429 }, { status: 503 },
    { body: rpcError(-32005, 'Rate limit reached') }, { body: rpcError(-32603, 'Internal error') },
    { error: new Error('Connection interrupted') },
  ])('retries a transient %j within the budget', async (step) => {
    const h = heliusHarness([step, { body: response() }], { maxAttempts: 2, retryBaseMs: 25 });
    const events: HeliusProgressEvent[] = [];
    const result = await h.client.scanHistory(query, { onPage: h.onPage, onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ status: 'complete', requestsMade: 2, pagesFetched: 1, pagesDelivered: 1 });
    expect(h.pages[0]?.source).toMatchObject({ attempts: 2, httpStatus: 200, provider: 'helius-mainnet' });
    expect(h.waits).toEqual([25]);
    expect(events.filter((event) => event.type === 'request').map((event) => event.requestsMade)).toEqual([1, 2]);
    expect(events.filter((event) => event.type === 'page')).toHaveLength(1);
  });

  it('stops after bounded exponential retry attempts and reports no delivered page', async () => {
    const h = heliusHarness([{ status: 503 }, { status: 503 }, { status: 503 }], { maxAttempts: 3, retryBaseMs: 25 });
    expect(await h.client.scanHistory(query, { onPage: h.onPage })).toMatchObject({ status: 'partial', pagesFetched: 0, pagesDelivered: 0, requestsMade: 3 });
    expect(h.waits).toEqual([25, 50]);
  });

  it.each(['2', new Date((query.endTime + 1002) * 1000).toUTCString()])('honors Retry-After %s', async (after) => {
    const h = heliusHarness([{ status: 429, headers: { 'retry-after': after } }, { body: response() }], { maxAttempts: 2, retryBaseMs: 1 });
    expect((await h.client.probe(query)).status).toBe('supported');
    expect(h.waits).toEqual([2000]);
  });

  it('carries a successful response rate reset across page and operation boundaries', async () => {
    const h = heliusHarness([
      { body: response([], 'next'), headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(query.endTime + 1002) } },
      { body: response(), headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(query.endTime + 1005) } },
      { body: response() },
    ]);
    await h.client.scanHistory(query, { onPage: h.onPage });
    await h.client.probe(query);
    expect(h.waits).toEqual([2000, 3000]);
  });

  it('retains excessive cooldown without retrying early or reporting a fictitious HTTP attempt', async () => {
    const h = heliusHarness([{ status: 429, headers: { 'retry-after': '120' } }], { maxAttempts: 3, maxWaitMs: 1000 });
    const events: HeliusProgressEvent[] = [];
    expect(await h.client.probe(query, { onProgress: (event) => events.push(event) })).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'transient', reason: 'rate_limit' } });
    expect(await h.client.probe(query)).toMatchObject({ status: 'failed', requestsMade: 0 });
    expect(h.waits).toEqual([]);
    expect(events.filter((event) => event.type === 'request')).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });

  it('throttles successive pages independently of retries', async () => {
    const h = heliusHarness([{ body: response([], 'a') }, { body: response() }], { minRequestIntervalMs: 50 });
    await h.client.scanHistory(query, { onPage: h.onPage });
    expect(h.waits).toEqual([50]);
  });
});

describe('cooldowns and HTTP status survive unreadable bodies', () => {
  const start = (query.endTime + 1000) * 1000;
  const resetHeaders = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 60) };
  const bodyFailures = ['broken', 'timeout', 'declared_oversize', 'streamed_oversize'] as const;

  function failingBody(mode: typeof bodyFailures[number], status: number, headers: HeadersInit = {}, http: HeliusHttpOptions = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const cancel = vi.fn();
    const responseHeaders = new Headers(headers);
    if (mode === 'declared_oversize') responseHeaders.set('content-length', '500');
    const body = mode === 'broken' || mode === 'timeout'
      ? new ReadableStream<Uint8Array>({
        start(controller) { if (mode === 'broken') controller.error(new Error('Broken fixture body')); }, cancel,
      }) : 'x'.repeat(500);
    const h = heliusHarness([{ raw: new Response(body, { status, headers: responseHeaders }) }, { body: response() }]);
    const client = new HeliusHistoryClient(fixtureKey, {
      minRequestIntervalMs: 0, retryBaseMs: 10, timeoutMs: 20, maxResponseBytes: 128, maxAttempts: 1, ...http,
    }, { fetch: h.fetcher });
    return { ...h, client, cancel };
  }

  it.each(['broken', 'timeout'] as const)('waits the full HTTP 429 Retry-After before retrying a %s body', async (mode) => {
    const h = failingBody(mode, 429, { 'retry-after': '60' }, { maxAttempts: 2 });
    const pending = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'supported', requestsMade: 2 });
    if (mode === 'timeout') expect(h.cancel).toHaveBeenCalledOnce();
  });

  it.each([200, 503])('retains exhausted reset headers after an HTTP %s stream failure across operations', async (status) => {
    const h = failingBody('broken', status, resetHeaders);
    expect(await h.client.probe(query)).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'transient' } });
    const pending = h.client.scanHistory(query, { onPage: h.onPage });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'complete', requestsMade: 1 });
  });

  it.each(bodyFailures)('preserves HTTP 429 and its cooldown across operations after a %s body', async (mode) => {
    const h = failingBody(mode, 429, { 'retry-after': '60' });
    const failed = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(20);
    expect(await failed).toMatchObject({ status: 'failed', requestsMade: 1,
      failure: { category: 'transient', reason: 'rate_limit', httpStatus: 429, retryable: true } });
    const pending = h.client.scanHistory(query, { onPage: h.onPage });
    await vi.advanceTimersByTimeAsync(59_979);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'complete', requestsMade: 1 });
  });

  it.each(bodyFailures)('keeps HTTP 401 non-retryable after a %s body', async (mode) => {
    const h = failingBody(mode, 401, {}, { maxAttempts: 3 });
    const pending = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: 'failed', requestsMade: 1,
      failure: { category: 'authentication', httpStatus: 401, retryable: false, action: 'check_api_key' } });
    expect(h.requests).toHaveLength(1);
    if (mode === 'timeout') expect(h.cancel).toHaveBeenCalledOnce();
  });

  it.each(bodyFailures)('retains cooldown beyond maxWaitMs after a %s body without an early request', async (mode) => {
    const h = failingBody(mode, 429, { 'retry-after': '120' }, { maxAttempts: 3, maxWaitMs: 1000 });
    const pending = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'transient', reason: 'rate_limit' } });
    expect(await h.client.scanHistory(query, { onPage: h.onPage })).toMatchObject({ status: 'partial', requestsMade: 0 });
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(118_980);
    const resumed = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await resumed).toMatchObject({ status: 'supported', requestsMade: 1 });
  });

  it.each([401, 429])('cancels a pending HTTP %s body promptly while keeping received reset headers', async (status) => {
    const h = failingBody('timeout', status, resetHeaders, { maxAttempts: 3 });
    const controller = new AbortController();
    const pending = h.client.probe(query, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'cancelled' } });
    expect(Date.now()).toBe(start);
    expect(h.cancel).toHaveBeenCalledOnce();
    const resumed = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await resumed).toMatchObject({ status: 'supported', requestsMade: 1 });
  });

  it('refines HTTP 200 from a delayed JSON-RPC error using the header arrival time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(rpcError(-32005, 'Rate limit reached'))));
        controller.close();
      }, 20);
    } });
    const h = heliusHarness([{ raw: new Response(body, { headers: { 'retry-after': '60' } }) }, { body: response() }]);
    const client = new HeliusHistoryClient(fixtureKey, { maxAttempts: 2, timeoutMs: 100, minRequestIntervalMs: 0, retryBaseMs: 10 }, { fetch: h.fetcher });
    const pending = client.probe(query);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'supported', requestsMade: 2 });
  });
});

describe('malformed and oversized response handling', () => {
  it.each([
    {}, { ...response(), id: 'wrong' }, { ...response(), jsonrpc: '1.0' },
    { jsonrpc: '2.0', id: 'history', result: { data: [] } },
    { ...response(), error: { code: -32000, message: 'ambiguous' } },
    { ...rpcError(-32000, 'error'), id: 'wrong' },
    { ...rpcError(-32000, 'error'), error: { code: 'not a number' } },
    response([{}]), response([{ ...transaction(), meta: null }]),
    response([{ ...transaction(), blockTime: 1.5 }]),
    response([{ ...transaction(), transaction: ['base64', 'base64'] }]),
    response([{ ...transaction(), meta: { ...transaction().meta, postTokenBalances: [{ accountIndex: 1, mint: wallet, uiTokenAmount: { amount: 9007199254740992, decimals: 9 } }] } }]),
    response([{ ...transaction(), transaction: { ...transaction().transaction, message: { ...transaction().transaction.message, instructions: [{ program: 'spl-token', programId: wallet, parsed: { info: { amount: 9007199254740992 } } }] } } }]),
    response([{ ...transaction(), transaction: { ...transaction().transaction, message: { ...transaction().transaction.message, instructions: [{ program: 'spl-token', programId: wallet, parsed: { info: { tokenAmount: { amount: 42, decimals: 9 } } } }] } } }]),
    response([{ ...transaction(), transaction: { ...transaction().transaction, message: { ...transaction().transaction.message, instructions: [{ programId: tokenProgram, parsed: { info: { amount: 42 } } }] } } }]),
  ])('fails closed for malformed envelope or evidence %j', async (body) => {
    const h = heliusHarness([{ body }], { maxAttempts: 3 });
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result).toMatchObject({ status: 'partial', failure: { category: 'malformed_response' }, pagesDelivered: 0, requestsMade: 1 });
    expect(result.coverage.rangeComplete).toBe(false);
    expect(h.pages).toEqual([]);
  });

  it('rejects invalid JSON and pages exceeding the requested limit', async () => {
    const h = heliusHarness([{ raw: new Response('not json') }, { body: response([transaction(), transaction('4')]) }]);
    expect(await h.client.probe(query)).toMatchObject({ status: 'failed', failure: { category: 'malformed_response' } });
    expect(await h.client.probe({ ...query, pageSize: 1 })).toMatchObject({ status: 'failed', failure: { category: 'malformed_response' } });
  });

  it('keeps authentication status actionable even when an HTTP error body is not JSON', async () => {
    const h = heliusHarness([{ raw: new Response('Unauthorized', { status: 401 }) }]);
    expect(await h.client.probe(query)).toMatchObject({ status: 'failed', failure: { category: 'authentication', httpStatus: 401 } });
  });

  it.each([true, false])('bounds response bytes with declared length %s', async (declared) => {
    const h = heliusHarness([{ raw: new Response(JSON.stringify(response()), { headers: declared ? { 'content-length': '500' } : {} }) }], { maxResponseBytes: 20 });
    expect(await h.client.probe(query)).toMatchObject({ status: 'failed', failure: { category: 'response_too_large' } });
  });

  it('retains earlier successful pages when a later page is malformed', async () => {
    const h = heliusHarness([{ body: response([transaction()], 'next') }, { body: {} }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result).toMatchObject({ status: 'partial', pagesDelivered: 1, transactionsDelivered: 1, failure: { category: 'malformed_response' }, continuation: { kind: 'retry_page', cursor: 'next' } });
  });
});

describe('timeouts and cancellation', () => {
  it('times out even when injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const client = new HeliusHistoryClient(fixtureKey, { maxAttempts: 1, timeoutMs: 20 }, { fetch: fetcher });
    const pending = client.probe(query);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'transient', reason: 'timeout' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('includes body streaming in the timeout and cancels the stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const h = heliusHarness([{ raw: new Response(new ReadableStream<Uint8Array>({ cancel })) }], { timeoutMs: 20 });
    const pending = h.client.probe(query);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: 'failed', failure: { category: 'transient', reason: 'timeout' } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight second page while preserving the first page and retry cursor', async () => {
    const controller = new AbortController();
    const h = heliusHarness([{ body: response([transaction()], 'next') }]);
    const firstFetch = h.runtime.fetch;
    let count = 0;
    const client = new HeliusHistoryClient(fixtureKey, { minRequestIntervalMs: 0 }, { ...h.runtime, fetch: (input, init) => {
      count++;
      if (count === 1 && firstFetch) return firstFetch(input, init);
      controller.abort();
      return new Promise(() => undefined);
    } });
    const events: HeliusProgressEvent[] = [];
    const result = await client.scanHistory(query, { signal: controller.signal, onPage: h.onPage, onProgress: (event) => events.push(event) });
    expect(result).toMatchObject({ status: 'cancelled', requestsMade: 2, pagesDelivered: 1, continuation: { cursor: 'next', kind: 'retry_page' } });
    expect(events.filter((event) => event.type === 'page')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'cancelled', requestsMade: 2 });
  });

  it('cancels a pending retry wait without another request', async () => {
    const controller = new AbortController();
    const h = heliusHarness([{ status: 503 }]);
    const client = new HeliusHistoryClient(fixtureKey, { maxAttempts: 3, minRequestIntervalMs: 0 }, { ...h.runtime, sleep: () => {
      controller.abort(); return new Promise(() => undefined);
    } });
    expect(await client.probe(query, { signal: controller.signal })).toMatchObject({ status: 'failed', requestsMade: 1, failure: { category: 'cancelled' } });
    expect(h.requests).toHaveLength(1);
  });
});
