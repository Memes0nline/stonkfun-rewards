import type { Runtime, HttpOptions } from '../registry/http.js';
import type { HistoryQuery } from './query.js';
import type { FullTransaction } from './schemas.js';

export type HeliusRuntime = Runtime;
export type HeliusHttpOptions = HttpOptions;
export type HeliusFailureCategory = 'authentication' | 'entitlement' | 'access_denied' | 'invalid_parameter'
  | 'method_unavailable' | 'transient' | 'provider_error' | 'malformed_response' | 'response_too_large'
  | 'sensitive_response' | 'cancelled' | 'request_budget' | 'page_budget' | 'cursor_cycle' | 'consumer_failure';
export interface HeliusFailure {
  category: HeliusFailureCategory;
  retryable: boolean;
  action: 'check_api_key' | 'check_plan_access' | 'check_query' | 'check_method_availability'
    | 'retry' | 'inspect_provider_response' | 'resume' | 'restart_range' | 'fix_consumer';
  reason?: 'network' | 'timeout' | 'rate_limit';
  httpStatus?: number;
  rpcCode?: number;
  /** Helius's own words for a refusal the user acts on (plan, quota, access, or an unrecognized error), sanitized by
   * `providerMessage`. Never kept for a key rejection or a transient failure. */
  message?: string;
}
export interface HistorySource {
  provider: 'helius-mainnet';
  method: 'getTransactionsForAddress';
  requestedAt: string;
  retrievedAt: string;
  attempts: number;
  httpStatus?: number;
}
export interface HistoryPage {
  query: HistoryQuery;
  pageIndex: number;
  requestedCursor: string | null;
  nextCursor: string | null;
  source: HistorySource;
  reusedCapability: boolean;
  transactions: FullTransaction[];
  /** Evidence that cannot be accepted into the requested successful/time-bounded stream. */
  excluded: { reason: EvidenceIssue; transaction: FullTransaction }[];
  duplicateCount: number;
}
export type EvidenceIssue = 'missing_timestamp' | 'outside_range' | 'failed_transaction' | 'conflicting_signature';
export interface HistoryResult {
  query: HistoryQuery;
  status: 'complete' | 'partial' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  requestsMade: number;
  pagesFetched: number;
  pagesDelivered: number;
  transactionsDelivered: number;
  duplicates: number;
  excluded: number;
  reusedCapability: boolean;
  issues: (EvidenceIssue | 'prefix_unverified')[];
  failure?: HeliusFailure;
  coverage: {
    convention: '[startTime,endTime)';
    startedFromBeginning: boolean;
    paginationExhausted: boolean;
    rangeComplete: boolean;
    persisted: false;
  };
  continuation: {
    query: HistoryQuery;
    kind: 'next_page' | 'retry_page' | 'restart_range' | 'exhausted';
    cursor: string | null;
    restartRequired: boolean;
  };
}
/** One succeeded transaction a signatures-mode listing names inside the query's range. */
export interface ListedSignature { signature: string; slot: number; blockTime: number }
/** Every signature the query lists, in order, across its pages. Complete only once pagination ended without a failure. */
export interface SignatureList {
  query: HistoryQuery;
  status: 'complete' | 'partial' | 'cancelled';
  signatures: ListedSignature[];
  requestsMade: number;
  pagesFetched: number;
  failure?: HeliusFailure;
}
export type CapabilityResult = {
  query: HistoryQuery;
  checkedAt: string;
  requestsMade: number;
} & ({ status: 'supported'; source: HistorySource; pageTransactionCount: number }
  | { status: 'failed'; failure: HeliusFailure });

export type HeliusProgressEvent =
  | { type: 'started'; at: string; operation: 'capability' | 'history' }
  | { type: 'request'; at: string; attempt: number; requestsMade: number }
  | { type: 'waiting'; at: string; delayMs: number; reason: 'retry' | 'throttle' | 'rate_limit' }
  | { type: 'response'; at: string; outcome: 'success' | 'failure'; attempts: number; failure?: HeliusFailure }
  | { type: 'capability_reused'; at: string }
  | { type: 'page'; at: string; pageIndex: number; transactions: number; duplicates: number; excluded: number; hasMore: boolean }
  | { type: 'finished'; at: string; operation: 'capability' | 'history'; status: CapabilityResult['status'] | HistoryResult['status']; pagesDelivered: number; requestsMade: number };

export interface OperationOptions {
  signal?: AbortSignal;
  maxRequests?: number;
  onProgress?: (event: HeliusProgressEvent) => void;
}
export interface HistoryOptions extends OperationOptions {
  maxPages?: number;
  /** Starting midstream never independently certifies coverage of the whole query. */
  startCursor?: string;
  /** Awaited backpressure; a failed/unacknowledged delivery leaves this page retryable. */
  onPage: (page: HistoryPage, signal?: AbortSignal) => void | Promise<void>;
}
