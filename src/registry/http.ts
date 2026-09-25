import type { z } from 'zod';
import { backoffDelay } from '../providers/limiter.js';
import type { FailureCode, ProgressEvent, Retrieval, Source } from './types.js';

const BASE_URL = 'https://www.stonkfun.xyz/api/public/v1';
export interface HttpOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  /** Backoff before retry n is retryBaseMs · 2^(n−1), capped at retryMaxMs, stretched by up to retryJitter (0–1) of itself. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitter?: number;
  maxWaitMs?: number;
  maxResponseBytes?: number;
}
export interface Runtime {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** The earliest time the shared provider accepts another request, such as a persisted rate-limit cooldown. Awaited before
   * an attempt starts, so it never counts against the attempt's timeout. */
  readyAt?: () => number;
}
/** Jitter is a fraction of the backoff, so unlike the other options it is not a whole number. */
export function boundedFraction(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Invalid retry jitter');
  return value;
}
export class RequestFailure extends Error {
  constructor(readonly code: FailureCode, readonly retryable = false, readonly status?: number) {
    super(code);
  }
}
export function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError('Invalid registry option');
  }
  return value;
}
export function emit(listener: ((event: ProgressEvent) => void) | undefined, event: ProgressEvent): void {
  // A UI observer must not change retrieval success or become a provider error.
  try { listener?.(event); } catch { /* Observer owns its errors. */ }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new RequestFailure('cancelled')); };
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); }).catch(() => undefined);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new RequestFailure('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new RequestFailure('response_too_large');
  }
  if (!response.body) throw new RequestFailure('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new RequestFailure('response_too_large');
      try { body += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new RequestFailure('invalid_response'); }
    }
    try { body += decoder.decode(); return JSON.parse(body) as unknown; }
    catch { throw new RequestFailure('invalid_response'); }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export class PublicClient {
  readonly sources: Retrieval[] = [];
  readonly now: () => number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleeper: NonNullable<Runtime['sleep']>;
  private readonly random: () => number;
  private readonly readyAt: () => number;
  private readonly options: Required<HttpOptions>;
  private nextAllowedAt = 0;

  constructor(
    options: HttpOptions,
    runtime: Runtime,
    private readonly signal?: AbortSignal,
    private readonly listener?: (event: ProgressEvent) => void,
  ) {
    this.now = runtime.now ?? Date.now;
    this.fetcher = runtime.fetch ?? globalThis.fetch;
    this.sleeper = runtime.sleep ?? sleep;
    this.random = runtime.random ?? Math.random;
    this.readyAt = runtime.readyAt ?? (() => 0);
    this.options = {
      maxAttempts: boundedInteger(options.maxAttempts ?? 3, 1, 5),
      timeoutMs: boundedInteger(options.timeoutMs ?? 15_000, 1, 60_000),
      minRequestIntervalMs: boundedInteger(options.minRequestIntervalMs ?? 250, 0, 60_000),
      retryBaseMs: boundedInteger(options.retryBaseMs ?? 500, 0, 60_000),
      retryMaxMs: boundedInteger(options.retryMaxMs ?? 30_000, 0, 60_000),
      retryJitter: boundedFraction(options.retryJitter ?? 0),
      maxWaitMs: boundedInteger(options.maxWaitMs ?? 60_000, 1, 60_000),
      maxResponseBytes: boundedInteger(options.maxResponseBytes ?? 32 * 1024 * 1024, 1, 128 * 1024 * 1024),
    };
  }
  timestamp(): string { return new Date(this.now()).toISOString(); }
  private retryAfter(headers: Headers): number {
    const header = headers.get('retry-after');
    if (header === null) return 0;
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
    return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : 0;
  }
  private rateLimit(headers: Headers): void {
    if (headers.get('x-ratelimit-remaining') !== '0') return;
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
    if (Number.isFinite(reset)) this.nextAllowedAt = Math.max(this.nextAllowedAt, reset);
  }
  async get<T extends { meta?: { generatedAt?: string | undefined } | undefined }>(
    source: Source,
    endpoint: string,
    schema: z.ZodType<T>,
    context: { requestedPage?: number; pass?: number } = {},
  ): Promise<{ value: T; source: Retrieval } | undefined> {
    const record: Retrieval = {
      id: `source-${this.sources.length + 1}`, source, endpoint,
      requestedAt: this.timestamp(), retrievedAt: this.timestamp(), attempts: 0, outcome: 'failure', ...context,
    };
    let value: T | undefined;
    let rateLimited = false;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      let timedOut = false;
      let serverDelay = false;
      const cancel = () => { controller.abort(); };
      this.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (this.signal?.aborted) throw new RequestFailure('cancelled');
        const shared = this.readyAt();
        const delayMs = Math.max(0, Math.max(this.nextAllowedAt, shared) - this.now());
        if (delayMs > this.options.maxWaitMs) throw new RequestFailure('rate_limit');
        if (delayMs > 0) {
          const reason = rateLimited || shared > this.nextAllowedAt ? 'rate_limit' : attempt > 1 ? 'retry' : 'throttle';
          emit(this.listener, { type: 'waiting', at: this.timestamp(), source, reason, delayMs });
          await abortable(this.sleeper(delayMs, controller.signal), controller.signal);
        }
        if (this.signal?.aborted) throw new RequestFailure('cancelled');
        record.attempts++;
        delete record.httpStatus;
        emit(this.listener, {
          type: 'request', at: this.timestamp(), source, attempt,
          ...(context.requestedPage === undefined ? {} : { page: context.requestedPage }),
        });
        this.nextAllowedAt = this.now() + this.options.minRequestIntervalMs;
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs);
        const response = await abortable(this.fetcher(`${BASE_URL}${endpoint}`, {
          method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal,
        }), controller.signal);
        record.httpStatus = response.status;
        this.rateLimit(response.headers);
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
          // A server's Retry-After replaces the backoff; without one the backoff applies.
          if (retryable && response.headers.get('retry-after') !== null) {
            this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + this.retryAfter(response.headers)); serverDelay = true;
          }
          throw new RequestFailure(response.status === 429 ? 'rate_limit' : 'http', retryable, response.status);
        }
        const json = await readJson(response, this.options.maxResponseBytes, controller.signal);
        const parsed = schema.safeParse(json);
        if (!parsed.success) throw new RequestFailure('invalid_response');
        value = parsed.data;
        record.outcome = 'success';
        delete record.failure;
        if (value.meta?.generatedAt !== undefined) record.generatedAt = value.meta.generatedAt;
        break;
      } catch (error) {
        const failure = this.signal?.aborted ? new RequestFailure('cancelled')
          : timedOut ? new RequestFailure('timeout', true)
          : error instanceof RequestFailure ? error : new RequestFailure('network', true);
        record.failure = failure.code;
        if (failure.status !== undefined) record.httpStatus = failure.status;
        if (!failure.retryable || attempt === this.options.maxAttempts) break;
        rateLimited = failure.code === 'rate_limit';
        if (!serverDelay) this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + backoffDelay(attempt,
          { retries: 0, baseMs: this.options.retryBaseMs, maxMs: this.options.retryMaxMs, jitter: this.options.retryJitter }, this.random));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        this.signal?.removeEventListener('abort', cancel);
      }
    }
    record.retrievedAt = this.timestamp();
    this.sources.push(record);
    emit(this.listener, {
      type: 'response', at: record.retrievedAt, source, sourceId: record.id, outcome: record.outcome,
      ...(record.failure === undefined ? {} : { failure: record.failure }),
    });
    return value === undefined ? undefined : { value, source: record };
  }
}
