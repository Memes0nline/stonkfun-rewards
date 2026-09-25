import type { DistributionRow, Launch, Pair, Pagination, RewardLaunch } from './schemas.js';

export type Source = 'launches' | 'rewards' | 'pairs' | 'withdrawalConfig';
export type FailureCode = 'network' | 'timeout' | 'http' | 'rate_limit' | 'invalid_response'
  | 'response_too_large' | 'cancelled';
export interface Retrieval {
  id: string;
  source: Source;
  /** Public relative endpoint only. */
  endpoint: string;
  requestedAt: string;
  retrievedAt: string;
  attempts: number;
  outcome: 'success' | 'failure';
  generatedAt?: string;
  httpStatus?: number;
  failure?: FailureCode;
  requestedPage?: number;
  pass?: number;
  pagination?: Pagination;
}
export type ProgressEvent =
  | { type: 'started'; at: string }
  | { type: 'request'; at: string; source: Source; attempt: number; page?: number }
  | { type: 'waiting'; at: string; source: Source; reason: 'throttle' | 'retry' | 'rate_limit'; delayMs: number }
  | { type: 'response'; at: string; source: Source; sourceId: string; outcome: 'success' | 'failure'; failure?: FailureCode }
  | { type: 'page'; at: string; pass: number; requestedPage: number; returnedPage: number; totalPages: number; pagesFetched: number; uniqueLaunches: number }
  | { type: 'source'; at: string; source: Source; outcome: 'success' | 'failure'; records: number }
  | { type: 'finished'; at: string; status: Registry['status']; pagesFetched: number; uniqueLaunches: number; quoteMints: number };

export interface Observation<T> { value: T; sourceIds: string[] }
export interface LaunchEntry {
  mint: string;
  ledger: Observation<Launch>[];
  rewardSummaries: Observation<RewardLaunch>[];
}
export interface QuoteEvidence {
  sourceId: string;
  kind: 'launch' | 'rewardSummary' | 'distribution';
  launchMint: string;
  symbol?: string;
  decimals?: number;
}
export interface QuoteAsset {
  mint: string;
  evidence: QuoteEvidence[];
  pairMetadata: Observation<Pair>[];
}
export interface WithdrawalAuthority {
  role: 'withdrawWithheldAuthority';
  authority: string;
  configurationQuoteMint: string;
  sourceId: string;
}
export interface Issue {
  code: 'source_failure' | 'page_limit' | 'clamped_page' | 'repeated_page' | 'inconsistent_pagination'
    | 'changing_totals' | 'unstable_discovery' | 'launch_quote_conflict' | 'cancelled';
  source: Source;
  sourceId?: string;
}
export interface Registry {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'partial' | 'cancelled';
  /** Successful retrieval does not establish lifetime or atomic completeness. */
  discovery: {
    incomplete: boolean;
    ledger: 'observed_stable' | 'incomplete';
    rewards: 'loaded' | 'failed' | 'not_requested';
    atomicSnapshot: false;
    lifetimeCoverage: 'not_guaranteed';
    passes: number;
    pagesFetched: number;
  };
  enrichment: 'loaded' | 'failed' | 'not_requested';
  launches: LaunchEntry[];
  quoteAssets: QuoteAsset[];
  distributions: { signature: string; rows: Observation<DistributionRow>[] }[];
  authorities: {
    withdrawal: WithdrawalAuthority[];
    /** The loader never verifies payout authorities; transaction verification is a later phase. */
    payout: { status: 'not_verified'; evidence: readonly [] };
    configuration: 'loaded' | 'failed' | 'not_requested';
  };
  sources: Retrieval[];
  issues: Issue[];
}
