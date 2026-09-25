import { backoffDelay } from '../providers/limiter.js';
import { boundedFraction } from '../registry/http.js';
import { failure, hasRpcError, providerFailure, SafeFailure } from './errors.js';
import { historyRequest } from './query.js';
import type { HistoryQuery } from './query.js';
import { historyResponseSchema, rpcErrorSchema, signaturesResponseSchema } from './schemas.js';
import type { HistoryResponse, SignaturesResponse } from './schemas.js';
import type { HeliusFailure, HeliusHttpOptions, HeliusProgressEvent, HeliusRuntime, HistorySource, OperationOptions } from './types.js';

export function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid Helius option');
  return value;
}
export function emit(options: OperationOptions, event: HeliusProgressEvent): void {
  try { options.onProgress?.(structuredClone(event)); } catch { /* Observers do not own retrieval state. */ }
}
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new SafeFailure(failure('cancelled'))); };
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); }).catch(() => undefined);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new SafeFailure(failure('cancelled'))); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new SafeFailure(failure('response_too_large'));
  }
  if (!response.body) throw new SafeFailure(failure('malformed_response'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new SafeFailure(failure('response_too_large'));
      try { text += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new SafeFailure(failure('malformed_response')); }
    }
    try { return JSON.parse(text + decoder.decode()) as unknown; }
    catch { throw new SafeFailure(failure('malformed_response')); }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export interface RequestBudget { made: number; max: number }
type Read<T> = { ok: true; data: T; source: HistorySource } | { ok: false; failure: HeliusFailure; source: HistorySource };
export type PageRead = Read<HistoryResponse>;
export type SignaturePageRead = Read<SignaturesResponse>;

/** Private fields keep credentials out of serialization and returned diagnostics. */
export class HeliusTransport {
  #key: string;
  #url: string;
  #runtime: Required<HeliusRuntime>;
  #options: Required<HeliusHttpOptions>;
  #nextAllowedAt = 0;

  constructor(apiKey: string, options: HeliusHttpOptions, runtime: HeliusRuntime) {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096 || /\s/.test(apiKey)) {
      throw new TypeError('Invalid Helius credentials');
    }
    this.#key = apiKey;
    this.#url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    this.#runtime = { fetch: runtime.fetch ?? globalThis.fetch, now: runtime.now ?? Date.now, sleep: runtime.sleep ?? sleep,
      random: runtime.random ?? Math.random, readyAt: runtime.readyAt ?? (() => 0) };
    this.#options = {
      maxAttempts: integer(options.maxAttempts ?? 3, 1, 5), timeoutMs: integer(options.timeoutMs ?? 15_000, 1, 60_000),
      minRequestIntervalMs: integer(options.minRequestIntervalMs ?? 250, 0, 60_000),
      retryBaseMs: integer(options.retryBaseMs ?? 500, 0, 60_000), retryMaxMs: integer(options.retryMaxMs ?? 30_000, 0, 60_000),
      retryJitter: boundedFraction(options.retryJitter ?? 0), maxWaitMs: integer(options.maxWaitMs ?? 60_000, 1, 60_000),
      maxResponseBytes: integer(options.maxResponseBytes ?? 32 * 1024 * 1024, 1, 128 * 1024 * 1024),
    };
  }
  timestamp(): string { return new Date(this.#runtime.now()).toISOString(); }
  sensitive(value: unknown): boolean {
    // Even a success envelope or opaque cursor must not reflect credentials into evidence/checkpoints.
    const text = JSON.stringify(value) ?? '';
    return text.includes(JSON.stringify(this.#key).slice(1, -1)) || text.includes(encodeURIComponent(this.#key))
      || /https?:\/\/[^\s"<>]*[?&](?:api[-_]?key|access_token|auth_token|token|authorization|password|client_secret)=/i.test(text)
      || /https?:\/\/[^\s/:"]+:[^\s/@"]+@/i.test(text);
  }
  /** Returns whether a server Retry-After now governs the next attempt, which then replaces the backoff. */
  #applyHeaders(headers: Headers, retryable: boolean, receivedAt: number): boolean {
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
      if (Number.isFinite(reset)) this.#nextAllowedAt = Math.max(this.#nextAllowedAt, reset);
    }
    const after = headers.get('retry-after');
    if (retryable && after !== null) {
      const seconds = Number(after);
      const until = Number.isFinite(seconds) ? receivedAt + seconds * 1000 : Date.parse(after);
      if (Number.isFinite(until)) { this.#nextAllowedAt = Math.max(this.#nextAllowedAt, Math.ceil(until)); return true; }
    }
    return false;
  }
  read(query: HistoryQuery, cursor: string | null, budget: RequestBudget, options: OperationOptions): Promise<PageRead> {
    return this.#read(query, cursor, budget, options, 'full', json => { const parsed = historyResponseSchema.safeParse(json); return parsed.success ? parsed.data.result : null; });
  }
  /** One signatures-mode page of the same query: signatures and times only. */
  readSignatures(query: HistoryQuery, cursor: string | null, budget: RequestBudget, options: OperationOptions): Promise<SignaturePageRead> {
    return this.#read(query, cursor, budget, options, 'signatures', json => { const parsed = signaturesResponseSchema.safeParse(json); return parsed.success ? parsed.data.result : null; });
  }
  async #read<T extends { data: unknown[] }>(query: HistoryQuery, cursor: string | null, budget: RequestBudget, options: OperationOptions,
    details: 'full' | 'signatures', parse: (json: unknown) => T | null): Promise<Read<T>> {
    const source: HistorySource = {
      provider: 'helius-mainnet', method: 'getTransactionsForAddress', requestedAt: this.timestamp(), retrievedAt: this.timestamp(), attempts: 0,
    };
    let lastFailure = failure('provider_error');
    let data: T | undefined;
    let rateLimited = false;
    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt++) {
      const controller = new AbortController();
      const cancel = () => { controller.abort(); };
      let timedOut = false;
      let serverDelay = false;
      let providerError: HeliusFailure | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (options.signal?.aborted) throw new SafeFailure(failure('cancelled'));
        if (budget.made >= budget.max) throw new SafeFailure(failure('request_budget'));
        const shared = this.#runtime.readyAt();
        const delayMs = Math.max(0, Math.max(this.#nextAllowedAt, shared) - this.#runtime.now());
        if (delayMs > this.#options.maxWaitMs) throw new SafeFailure(failure('transient', { reason: 'rate_limit' }));
        if (delayMs > 0) {
          const reason = rateLimited || shared > this.#nextAllowedAt ? 'rate_limit' : attempt > 1 ? 'retry' : 'throttle';
          emit(options, { type: 'waiting', at: this.timestamp(), delayMs, reason });
          await abortable(this.#runtime.sleep(delayMs, controller.signal), controller.signal);
        }
        if (options.signal?.aborted) throw new SafeFailure(failure('cancelled'));
        source.attempts++;
        budget.made++;
        delete source.httpStatus;
        emit(options, { type: 'request', at: this.timestamp(), attempt, requestsMade: budget.made });
        this.#nextAllowedAt = this.#runtime.now() + this.#options.minRequestIntervalMs;
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#options.timeoutMs);
        const response = await abortable(this.#runtime.fetch(this.#url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(historyRequest(query, cursor, details)), signal: controller.signal, redirect: 'error',
        }), controller.signal);
        source.httpStatus = response.status;
        const receivedAt = this.#runtime.now();
        // Headers remain authoritative even if the body fails, times out, or exceeds its limit.
        providerError = response.ok ? undefined : providerFailure(response.status, undefined);
        serverDelay = this.#applyHeaders(response.headers, providerError?.retryable ?? false, receivedAt);
        const json = await readJson(response, this.#options.maxResponseBytes, controller.signal);
        if (!response.ok || hasRpcError(json)) {
          if (response.ok && !rpcErrorSchema.safeParse(json).success) throw new SafeFailure(failure('malformed_response'));
          providerError = providerFailure(response.status, json);
          // Text that still reflects the key or a credential-bearing URL is dropped, never shown.
          if (providerError.message !== undefined && this.sensitive(providerError.message)) delete providerError.message;
          serverDelay = this.#applyHeaders(response.headers, providerError.retryable, receivedAt) || serverDelay;
          throw new SafeFailure(providerError);
        }
        if (this.sensitive(json)) throw new SafeFailure(failure('sensitive_response'));
        const parsed = parse(json);
        if (parsed === null || parsed.data.length > query.pageSize) throw new SafeFailure(failure('malformed_response'));
        data = parsed;
        break;
      } catch (error) {
        lastFailure = options.signal?.aborted ? failure('cancelled')
          : providerError ?? (timedOut ? failure('transient', { reason: 'timeout' })
            : error instanceof SafeFailure ? error.failure : failure('transient', { reason: 'network' }));
        if (!lastFailure.retryable || attempt === this.#options.maxAttempts) break;
        rateLimited = lastFailure.reason === 'rate_limit' || lastFailure.httpStatus === 429;
        if (!serverDelay) this.#nextAllowedAt = Math.max(this.#nextAllowedAt, this.#runtime.now() + backoffDelay(attempt,
          { retries: 0, baseMs: this.#options.retryBaseMs, maxMs: this.#options.retryMaxMs, jitter: this.#options.retryJitter }, this.#runtime.random));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        options.signal?.removeEventListener('abort', cancel);
      }
    }
    source.retrievedAt = this.timestamp();
    emit(options, {
      type: 'response', at: source.retrievedAt, outcome: data ? 'success' : 'failure', attempts: source.attempts,
      ...(data ? {} : { failure: lastFailure }),
    });
    return data ? { ok: true, data, source } : { ok: false, failure: lastFailure, source };
  }
}
