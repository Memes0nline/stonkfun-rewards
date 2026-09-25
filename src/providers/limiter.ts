/** Per-provider request pacing and retry policy. Pure: every clock and random source is injected by the caller. */
export type Provider = 'helius' | 'stonkfun';
export interface RateLimit { perSecond: number; burst: number }
export const DEFAULT_RATE_LIMITS: Readonly<Record<Provider, RateLimit>> = {
  helius: { perSecond: 8, burst: 10 }, stonkfun: { perSecond: 4, burst: 5 },
};
/** Helius DAS calls (`getAsset`, `getAssetsByOwner`) share their own bucket, apart from the RPC one: Helius's free plan allows
 * DAS 2 requests a second, so one token every 500 ms and no burst. They still count against the job's Helius budget. */
export const DAS_BUCKET = 'helius-das';
export const DAS_RATE_LIMIT: Readonly<RateLimit> = { perSecond: 2, burst: 1 };
/** Retries after the first attempt, and the exponential backoff between them. */
export interface RetryPolicy { retries: number; baseMs: number; maxMs: number; jitter: number }
export const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseMs: 1_000, maxMs: 30_000, jitter: 0.25 };
/** Why a request waits before it is dispatched. `throttle` is this scanner's own bucket; `rate_limit` is the provider asking
 * it to slow down (HTTP 429, Retry-After, an exhausted rate-limit header); `retry` is backoff after a failed attempt. */
export type WaitReason = 'throttle' | 'rate_limit' | 'retry';

const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { helius: 'Helius', stonkfun: 'StonkFun' };
const WAIT_TEXT: Readonly<Record<WaitReason, string>> = {
  throttle: 'request pacing', rate_limit: 'rate limited by the provider', retry: 'retrying after a failed request',
};
/** One line for a wait, as job progress and the command line show it. */
export const waitText = (provider: Provider, reason: WaitReason, delayMs: number) =>
  `Waiting for provider: ${PROVIDER_NAMES[provider]} ${WAIT_TEXT[reason]}, ${(Math.max(0, delayMs) / 1000).toFixed(1)} s`;

/** Whole milliseconds between tokens, rounded up so the configured rate is never exceeded. */
export const tokenInterval = (limit: RateLimit) => Math.ceil(1000 / limit.perSecond);

/**
 * A token bucket in virtual-scheduling form: its whole state is one theoretical arrival time, so one integer column holds
 * it and every connection shares it. A full bucket admits `burst` requests at once and refills at `perSecond`. Returns the
 * admission time — `now` when a token is taken, with the advanced state — or the later time a token will exist, with the
 * state unchanged, so a waiter never reserves a future slot.
 */
export function takeToken(state: number, now: number, limit: RateLimit): { ready: number; state: number } {
  const interval = tokenInterval(limit);
  const arrival = Math.max(state, now);
  const ready = arrival - (limit.burst - 1) * interval;
  return ready <= now ? { ready: now, state: arrival + interval } : { ready, state };
}

/** Backoff before retry `failures` (1 for the first): 1 s, 2 s, 4 s … capped at 30 s, stretched by up to 25 % jitter and
 * never beyond the cap. */
export function backoffDelay(failures: number, policy: RetryPolicy = DEFAULT_RETRY, random: () => number = Math.random) {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, failures - 1));
  return Math.min(policy.maxMs, Math.round(exponential * (1 + policy.jitter * random())));
}

/** A Retry-After header as milliseconds from `now`: delay-seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : null;
}

/** Scan speed settings: a bucket per provider and the worker count for independent provider work. */
export interface ScanSpeed { limits: Record<Provider, RateLimit>; concurrency: number }
export const DEFAULT_CONCURRENCY = 4;
/** Environment names, each overridden by the matching command-line flag. */
export const SPEED_ENVIRONMENT = {
  heliusRps: 'SCANNER_HELIUS_RPS', heliusBurst: 'SCANNER_HELIUS_BURST',
  stonkfunRps: 'SCANNER_STONKFUN_RPS', stonkfunBurst: 'SCANNER_STONKFUN_BURST', concurrency: 'SCANNER_CONCURRENCY',
} as const;
export type SpeedSetting = keyof typeof SPEED_ENVIRONMENT;

/** Flags first, then the environment, then the defaults. Rates may be fractional (0.1–100 per second); bursts are whole
 * numbers (1–100) and so is the worker count (1–16). Anything else is rejected rather than clamped. */
export function scanSpeed(flags: Partial<Record<SpeedSetting, string | undefined>>, environment: Readonly<Record<string, string | undefined>> = {}): ScanSpeed {
  const read = (setting: SpeedSetting, fallback: number, min: number, max: number, whole: boolean) => {
    const text = flags[setting] ?? environment[SPEED_ENVIRONMENT[setting]];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) throw new Error('invalid_speed_option');
    return value;
  };
  return {
    limits: {
      helius: { perSecond: read('heliusRps', DEFAULT_RATE_LIMITS.helius.perSecond, 0.1, 100, false), burst: read('heliusBurst', DEFAULT_RATE_LIMITS.helius.burst, 1, 100, true) },
      stonkfun: { perSecond: read('stonkfunRps', DEFAULT_RATE_LIMITS.stonkfun.perSecond, 0.1, 100, false), burst: read('stonkfunBurst', DEFAULT_RATE_LIMITS.stonkfun.burst, 1, 100, true) },
    },
    concurrency: read('concurrency', DEFAULT_CONCURRENCY, 1, 16, true),
  };
}
