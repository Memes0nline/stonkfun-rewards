import { providerMessage, SafeFailure } from '../helius/errors.js';
import type { HeliusFailure } from '../helius/types.js';
import { RequestFailure } from '../registry/http.js';
import type { RegistryUpdate } from './types.js';

/** Why a job stopped or struggled, from the responses the clients already handle. `helius_rate_limited` is temporary, not a
 * failure: the job retries, and a paused job continues on Resume or Refresh. */
export type FailureClass = 'key_rejected' | 'helius_rate_limited' | 'helius_quota' | 'stonkfun_unreachable' | 'network' | 'check_disagreed' | 'other';
/** `detail` is Helius's own message for a quota or plan refusal, or the raw message of anything unrecognized, sanitized. */
export interface JobFailure { class: FailureClass; message: string; detail?: string }

const MESSAGES: Record<FailureClass, string> = {
  key_rejected: 'Helius rejected the API key.',
  helius_rate_limited: 'Helius is rate limiting requests. This is temporary, not a failure: the scan retries, and Resume or Refresh continues.',
  helius_quota: 'Helius refused the request: a quota or plan limit.',
  stonkfun_unreachable: 'StonkFun could not be reached; its feed and prices may be missing from this job.',
  network: 'A network request to Helius failed or timed out.',
  check_disagreed: 'Helius listed a day differently from its full read, even after the missing part was fetched again. That day is not counted as loaded yet; Resume or Refresh reads it again.',
  other: 'The scan stopped on an unrecognized error.',
};
const failureOf = (kind: FailureClass, detail?: string): JobFailure => ({ class: kind, message: MESSAGES[kind], ...(detail ? { detail } : {}) });
/** A range whose full read and signatures listing still disagree after the missing span was fetched again. */
export const CHECK_DISAGREED: JobFailure = failureOf('check_disagreed');
/** Classes that every later Helius request would repeat, so the job stops at once instead of spending more requests. */
export const HALTING_CLASSES: ReadonlySet<FailureClass> = new Set(['key_rejected', 'helius_quota']);

/** A Helius failure's class, or null when it is not a failure: a cancellation or a spent budget. */
export function heliusFailureClass(failure: HeliusFailure): JobFailure | null {
  switch (failure.category) {
    case 'cancelled': case 'request_budget': case 'page_budget': return null;
    // Saving a delivered page failed locally; the page stays unacknowledged and is fetched again on resume.
    case 'consumer_failure': return failureOf('other', 'Saving a history page failed; Resume fetches that page again.');
    case 'authentication': return failureOf('key_rejected');
    case 'entitlement': case 'access_denied': return failureOf('helius_quota', failure.message);
    case 'transient':
      if (failure.reason === 'rate_limit' || failure.httpStatus === 429) return failureOf('helius_rate_limited');
      if (failure.reason === 'network' || failure.reason === 'timeout') return failureOf('network');
      break;
    default: break;
  }
  const raw = `Helius ${failure.category}${failure.httpStatus === undefined ? '' : ` HTTP ${failure.httpStatus}`}`
    + `${failure.rpcCode === undefined ? '' : ` JSON-RPC ${failure.rpcCode}`}${failure.message === undefined ? '' : `: ${failure.message}`}`;
  return failureOf('other', raw);
}
/** StonkFun is unreachable when every registry request failed without an answer: a network failure, a timeout or an HTTP error. */
export function stonkfunFailure(update: RegistryUpdate): JobFailure | null {
  const sources = update.feeds.flatMap(feed => feed.sources);
  return sources.length > 0 && sources.every(source => source.outcome === 'failure'
    && (source.failure === 'network' || source.failure === 'timeout' || source.failure === 'http')) ? failureOf('stonkfun_unreachable') : null;
}
/** The class of an error that ended a run, or null for a cancellation, a spent budget or the deadline. */
export function thrownFailureClass(error: unknown): JobFailure | null {
  if (error instanceof SafeFailure) return heliusFailureClass(error.failure);
  if (error instanceof RequestFailure) return error.code === 'cancelled' ? null : failureOf('stonkfun_unreachable');
  const raw = error instanceof Error ? error.message : String(error);
  if (['cancelled', 'deadline', 'page_budget', 'request_budget_or_deadline'].includes(raw)) return null;
  // A dispatched request the network refused carries this code alone.
  if (raw === 'network') return failureOf('network');
  return failureOf('other', providerMessage(raw) ?? 'unknown error');
}
