import { describe, expect, it } from 'vitest';
import { HeliusHistoryClient } from '../src/index.js';
import type { HeliusProgressEvent } from '../src/index.js';
import { exactAmount, fixtureKey, query, response, sig, transaction, wallet } from './fixtures/helius.js';
import { heliusHarness } from './helius.helpers.js';

describe('Helius query and full evidence', () => {
  it('maps a half-open range to the verified request configuration', async () => {
    const h = heliusHarness([{ body: response([transaction()]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(h.requests[0]?.body).toEqual({
      jsonrpc: '2.0', id: 'history', method: 'getTransactionsForAddress', params: [wallet, {
        transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1,
        commitment: 'finalized', sortOrder: 'asc', limit: 100,
        filters: { blockTime: { gte: query.startTime, lte: query.endTime - 1 }, status: 'succeeded', tokenAccounts: 'balanceChanged', tokenTransfer: { direction: 'in' } },
      }],
    });
    expect(h.requests[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(result.status).toBe('complete');
    expect(result.coverage).toEqual({ convention: '[startTime,endTime)', startedFromBeginning: true, paginationExhausted: true, rangeComplete: true, persisted: false });
  });

  it('accepts months-long gaps and freezes the query even if the caller mutates it between pages', async () => {
    const input = { ...query, startTime: query.endTime - 90 * 86400 };
    const expected = { ...input };
    const h = heliusHarness([{ body: response([transaction()], 'opaque:page:2') }, { body: response() }]);
    const result = await h.client.scanHistory(input, { onPage: (page) => { h.onPage(page); input.startTime = 0; input.endTime++; } });
    expect(result.query).toEqual(expected);
    for (const request of h.requests) expect(request.body).toMatchObject({ params: [wallet, { filters: { blockTime: { gte: expected.startTime, lte: expected.endTime - 1 } } }] });
    expect(h.requests[1]?.body).toMatchObject({ params: [wallet, { paginationToken: 'opaque:page:2' }] });
  });

  it('includes start and end-minus-one, preserves transactions sharing timestamps, and excludes both outside boundaries', async () => {
    const h = heliusHarness([{ body: response([
      transaction('2', query.startTime - 1), transaction('3', query.startTime), transaction('4', query.startTime),
      transaction('5', query.endTime - 1), transaction('6', query.endTime),
    ]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(h.pages[0]?.transactions.map((row) => row.transaction.signatures[0])).toEqual([sig('3'), sig('4'), sig('5')]);
    expect(h.pages[0]?.excluded.map((row) => row.reason)).toEqual(['outside_range', 'outside_range']);
    expect(result.status).toBe('partial');
    expect(result.coverage.paginationExhausted).toBe(true);
    expect(result.continuation).toMatchObject({ kind: 'restart_range', cursor: null, restartRequired: true });
  });

  it('retains exact amounts, all distinct and repeated transfers, and full transaction/metadata extensions', async () => {
    const tx = transaction();
    const h = heliusHarness([{ body: response([tx, tx]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(h.pages[0]?.transactions).toEqual([tx]);
    expect(h.pages[0]?.transactions[0]?.meta.preTokenBalances[0]?.uiTokenAmount.amount).toBe('000123');
    expect(h.pages[0]?.transactions[0]?.meta.postTokenBalances[0]?.uiTokenAmount.amount).toBe(exactAmount);
    expect(h.pages[0]?.transactions[0]?.transaction.message.instructions).toHaveLength(2);
    expect(h.pages[0]?.transactions[0]?.meta.innerInstructions?.[0]?.instructions).toHaveLength(2);
    expect(result.duplicates).toBe(1);
  });

  it.each([
    { ...query, startTime: query.endTime }, { ...query, endTime: query.startTime - 1 },
    { ...query, startTime: 1.2 }, { ...query, wallet: 'invalid' }, { ...query, pageSize: 1001 },
  ])('rejects invalid history input safely', async (input) => {
    const h = heliusHarness([]);
    await expect(h.client.scanHistory(input, { onPage: h.onPage })).rejects.toThrow('Invalid Helius history query');
    expect(h.requests).toHaveLength(0);
  });
});

describe('cursor pagination and coverage', () => {
  it('only finishes on explicit null, including empty pages and a duplicate page with a new cursor', async () => {
    const h = heliusHarness([
      { body: response([], 'a') }, { body: response([transaction()], 'b') },
      { body: response([transaction()], 'c') }, { body: response([], 'd') }, { body: response([transaction('4')]) },
    ]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result).toMatchObject({ status: 'complete', pagesDelivered: 5, transactionsDelivered: 2, duplicates: 1, requestsMade: 5 });
    expect(h.pages.map((page) => page.transactions.length)).toEqual([0, 1, 0, 0, 1]);
    expect(h.remaining).toHaveLength(0);
  });
  it('accepts a genuinely empty exhausted result', async () => {
    const h = heliusHarness([{ body: response() }]);
    expect(await h.client.scanHistory(query, { onPage: h.onPage })).toMatchObject({ status: 'complete', transactionsDelivered: 0, pagesDelivered: 1 });
  });
  it('follows the cursor across transactions sharing the final included second', async () => {
    const h = heliusHarness([
      { body: response([transaction('3', query.endTime - 1)], 'next') },
      { body: response([transaction('4', query.endTime - 1)]) },
    ]);
    const result = await h.client.scanHistory({ ...query, pageSize: 1 }, { onPage: h.onPage });
    expect(result).toMatchObject({ status: 'complete', pagesDelivered: 2, transactionsDelivered: 2, duplicates: 0 });
    expect(h.pages.flatMap((page) => page.transactions.map((tx) => tx.transaction.signatures[0]))).toEqual([sig('3'), sig('4')]);
  });
  it.each([['a', 'a'], ['a', 'b', 'a']])('stops a repeated/cyclic cursor sequence %s', async (...tokens) => {
    const h = heliusHarness(tokens.map((token) => ({ body: response([transaction()], token) })));
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result.status).toBe('partial');
    expect(result.failure?.category).toBe('cursor_cycle');
    expect(result.coverage.rangeComplete).toBe(false);
    expect(result.continuation.kind).toBe('restart_range');
    expect(h.requests).toHaveLength(tokens.length);
  });
  it('does not infer completion from the last transaction timestamp or a full page', async () => {
    const h = heliusHarness([{ body: response([transaction('3', query.endTime - 1)], 'remaining') }]);
    const result = await h.client.scanHistory({ ...query, pageSize: 1 }, { onPage: h.onPage, maxPages: 1 });
    expect(result).toMatchObject({ status: 'partial', failure: { category: 'page_budget' }, continuation: { kind: 'next_page', cursor: 'remaining' } });
    expect(result.coverage.paginationExhausted).toBe(false);
  });
  it('limits total HTTP attempts separately from successful pages', async () => {
    const h = heliusHarness([{ status: 503 }, { body: response([transaction()], 'a') }], { maxAttempts: 3, retryBaseMs: 0 });
    const result = await h.client.scanHistory(query, { onPage: h.onPage, maxRequests: 2 });
    expect(result).toMatchObject({ status: 'partial', requestsMade: 2, pagesDelivered: 1, failure: { category: 'request_budget' } });
    expect(result.continuation.cursor).toBe('a');
  });
  it('never certifies a whole range when starting at a supplied continuation', async () => {
    const h = heliusHarness([{ body: response([transaction()]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage, startCursor: 'resume:opaque' });
    expect(result.status).toBe('partial');
    expect(result.issues).toEqual(['prefix_unverified']);
    expect(result.coverage).toMatchObject({ paginationExhausted: true, startedFromBeginning: false, rangeComplete: false });
  });
  it.each([undefined, null])('retains missing timestamp evidence (%s) but cannot certify coverage', async (blockTime) => {
    const h = heliusHarness([{ body: response([{ ...transaction(), blockTime }]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result.status).toBe('partial');
    expect(result.issues).toEqual(['missing_timestamp']);
    expect(h.pages[0]?.transactions).toEqual([]);
    expect(h.pages[0]?.excluded[0]?.transaction.transaction.signatures).toEqual([sig()]);
  });
  it('flags failed transactions and conflicting evidence for an already-seen signature', async () => {
    const tx = transaction();
    const h = heliusHarness([{ body: response([tx], 'a') }, { body: response([
      { ...tx, slot: 101 }, { ...transaction('4'), meta: { ...tx.meta, err: { InstructionError: [0, 'Custom'] } } },
    ]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result.issues).toEqual(['conflicting_signature', 'failed_transaction']);
    expect(result.transactionsDelivered).toBe(1);
    expect(h.pages[1]?.excluded).toHaveLength(2);
  });
});

describe('capability reuse and interrupted delivery', () => {
  it('reuses the identical successful capability page once, with original provenance and no fake request event', async () => {
    const h = heliusHarness([{ body: response([transaction()], 'next') }, { body: response() }]);
    const probe = await h.client.probe(query);
    const events: HeliusProgressEvent[] = [];
    const result = await h.client.scanHistory({ ...query }, { onPage: h.onPage, onProgress: (event) => events.push(event) });
    expect(probe).toMatchObject({ status: 'supported', requestsMade: 1, pageTransactionCount: 1 });
    expect(result).toMatchObject({ status: 'complete', requestsMade: 1, pagesDelivered: 2, reusedCapability: true });
    expect(h.pages[0]?.source.retrievedAt).toBe(probe.checkedAt);
    expect(events.filter((event) => event.type === 'request')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'capability_reused')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'complete', pagesDelivered: 2 });
  });
  it.each([{ pageSize: 5 }, { startTime: query.startTime - 1 }, { endTime: query.endTime + 1 }])('does not reuse a different query (%j)', async (change) => {
    const h = heliusHarness([{ body: response([transaction()]) }, { body: response() }]);
    await h.client.probe(query);
    const result = await h.client.scanHistory({ ...query, ...change }, { onPage: h.onPage });
    expect(result.reusedCapability).toBe(false);
    expect(h.requests).toHaveLength(2);
  });
  it('preserves acknowledged pages and the retry cursor when a later request fails', async () => {
    const h = heliusHarness([{ body: response([transaction()], 'next') }, { status: 503 }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(result).toMatchObject({ status: 'partial', pagesDelivered: 1, transactionsDelivered: 1, continuation: { cursor: 'next', kind: 'retry_page', restartRequired: false } });
    expect(result.query).toEqual(query);
  });
  it('does not advance past a failed page consumer or expose its exception', async () => {
    const h = heliusHarness([{ body: response([transaction()], 'next') }, { body: response([transaction('4')]) }]);
    const result = await h.client.scanHistory(query, { onPage: (page) => {
      if (page.pageIndex === 2) throw new Error(fixtureKey);
      h.onPage(page);
    } });
    expect(result).toMatchObject({ status: 'partial', pagesFetched: 2, pagesDelivered: 1, failure: { category: 'consumer_failure' }, continuation: { kind: 'retry_page', cursor: 'next' } });
    expect(JSON.stringify(result)).not.toContain(fixtureKey);
  });
  it('cancels after an acknowledged page and never reports fabricated completion', async () => {
    const controller = new AbortController();
    const h = heliusHarness([{ body: response([transaction()], 'next') }]);
    const result = await h.client.scanHistory(query, { signal: controller.signal, onPage: (page) => { h.onPage(page); }, onProgress: (event) => {
      if (event.type === 'page') controller.abort();
    } });
    expect(result).toMatchObject({ status: 'cancelled', pagesDelivered: 1, continuation: { cursor: 'next' }, coverage: { rangeComplete: false } });
    expect(h.requests).toHaveLength(1);
  });
  it('supports cancellation before fetching or while waiting for a consumer acknowledgement', async () => {
    const h = heliusHarness([]);
    expect((await h.client.scanHistory(query, { signal: AbortSignal.abort(), onPage: h.onPage })).status).toBe('cancelled');
    expect(h.requests).toHaveLength(0);
    const h2 = heliusHarness([{ body: response() }]);
    const controller = new AbortController();
    const result = await h2.client.scanHistory(query, { signal: controller.signal, onPage: () => {
      controller.abort(); return new Promise(() => undefined);
    } });
    expect(result).toMatchObject({ status: 'cancelled', pagesDelivered: 0, continuation: { cursor: null, kind: 'retry_page' } });
  });
  it('awaits page handling before requesting the next page and isolates observer/data mutations', async () => {
    const h = heliusHarness([{ body: response([transaction()], 'next') }, { body: response() }]);
    let release: (() => void) | undefined;
    let delivered: (() => void) | undefined;
    const deliveredSignal = new Promise<void>((resolve) => { delivered = resolve; });
    const scan = h.client.scanHistory(query, { onPage: (page) => {
      if (page.pageIndex !== 1) return;
      page.nextCursor = 'tampered';
      delivered?.();
      return new Promise<void>((resolve) => { release = resolve; });
    }, onProgress: () => { throw new Error(fixtureKey); } });
    await deliveredSignal;
    expect(h.requests).toHaveLength(1);
    await expect(h.client.probe(query)).rejects.toThrow('active operation');
    release?.();
    expect((await scan).status).toBe('complete');
    expect(h.requests[1]?.body).toMatchObject({ params: [wallet, { paginationToken: 'next' }] });
  });
  it('does not serialize the key through the client, results, or pages', async () => {
    const h = heliusHarness([{ body: response([transaction()]) }]);
    const result = await h.client.scanHistory(query, { onPage: h.onPage });
    expect(JSON.stringify([h.client, result, h.pages])).not.toContain(fixtureKey);
    expect(() => new HeliusHistoryClient('')).toThrow('Invalid Helius credentials');
  });
});
