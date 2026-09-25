import type { FullTransaction } from '../helius/schemas.js';
import type { HistoryPage, HistoryResult, SignatureList } from '../helius/types.js';
import type { HistoryQuery } from '../helius/query.js';
import type { NormalizedTransaction, NormalizationProvenance, SolanaNetwork } from '../normalization/types.js';
import type { DistributionEvidenceInput, PayoutAuthorityPattern } from '../payout-evidence/types.js';
import type { RateLimit } from '../providers/limiter.js';
import type { HoldingsSet, HoldingsSnapshot, StoredHoldings, WalletTokenBalance } from './holdings.js';
import type { JobFailure } from './failures.js';
export type { ScanProgress } from './progress.js';

export const CLASSIFIER_VERSION = 'stonkfun-classifier-v4';
/** Every version that evaluated the attributed tier. v3 rows the v6 requeue left alone are rows v4
 * classifies identically, so the report treats them as evaluated rather than permanently pending. */
export const TIER_EVALUATING_VERSIONS: ReadonlySet<string> = new Set(['stonkfun-classifier-v3', CLASSIFIER_VERSION]);
export const AUTHORITY_MODEL_VERSION = 'historical-authority-v1';
export const ATTRIBUTION_MODEL_VERSION = 'distributor-pattern-v1';
export type AttributionTrustSource = 'feed_witnessed_identity' | 'published_withdraw_authority';
/** Native SOL is not a token mint. This sentinel is deliberately not a base58 address, so it can
 * never collide with a real mint or be confused with wrapped SOL, which stays out of scope. */
export const NATIVE_SOL_MINT = 'native-sol';
export const NATIVE_SOL_DECIMALS = 9;
export const NATIVE_SOL_SYMBOL = 'SOL';
export const NATIVE_SOL_NAME = 'Solana (native)';
/** The mint both price sources quote SOL under. Prices fetched with it are saved under the sentinel. */
export const NATIVE_SOL_PRICE_MINT = 'So11111111111111111111111111111111111111112';
/** `token` is the only lane rows recorded before the native lane, so an absent value means `token`. */
export type AttributionLane = 'token' | 'native_sol';
/** Provenance of a separately reported, explicitly weaker claim than confirmation. No wall-clock field. */
export interface AttributionEvidence {
  basis: 'distributor_pattern'; modelVersion: typeof ATTRIBUTION_MODEL_VERSION; classifierVersion: typeof CLASSIFIER_VERSION;
  identityId: string; trustSources: AttributionTrustSource[]; primaryTrustSource: AttributionTrustSource;
  publishedSnapshots: {
    id: string; role: 'nearest_at_or_after' | 'nearest_before'; authority: string; retrievedAt: string;
    generatedAt: string | null; configurationQuoteMint: string; evidenceId: string;
  }[];
  /** Distance from the credit to the nearest recorded snapshot; null without published trust. */
  secondsToNearestSnapshot: number | null;
  witnesses: {
    count: number; digest: string;
    first: { signature: string; blockTime: number; evidenceIds: string[] };
    last: { signature: string; blockTime: number; evidenceIds: string[] };
    signatures: string[];
    relation: 'before_first_witness' | 'within_witness_span' | 'after_last_witness';
    secondsToNearestWitness: number;
  } | null;
  /** Absent on every row recorded before the native lane; those are all `token`. */
  lane?: AttributionLane;
  /** On the native lane `sourceAta` is the distributor's own system account and `ataBump` is null. */
  sourceOwner: string; sourceAta: string; ataBump: number | null; mint: string; tokenProgram: string;
  signerShape: { kind: 'owner_is_fee_payer' | 'owner_and_separate_fee_payer'; feePayer: string; signers: string[] };
  batch: { outerTransfersFromSource: number; transfersFromSource: number; distinctRecipientOwners: number };
  creditedMintAlsoRetainedLaunch: boolean;
}
export interface AttributionRevocation {
  modelVersion: typeof ATTRIBUTION_MODEL_VERSION; identityId: string; sourceOwner: string; effectiveFrom: number;
  decisionId: string; trustSources: AttributionTrustSource[]; witnessSignatures: string[]; snapshotIds: string[];
  evidenceIds: string[]; scope: 'local_safety_revocation';
}
/** Derived: a retained official row names a transaction of this source owner and contradicts it. */
export interface IdentityConflict { network: SolanaNetwork; signature: string; owner: string; reasons: string[]; evidenceIds: string[] }
export interface Range { startTime: number; endTime: number }
export interface WalletState {
  /** `trackingStart` is the oldest loaded day: every refresh covers from it to the cutoff, and only a completed Load earlier
   * batch moves it back. The days between the history floor and it are not loaded yet. */
  network: SolanaNetwork; wallet: string; trackingStart: number; cutoff: number; lastSync: string | null;
  /** The most recent completed batch, a first scan or a Load earlier job: its range, the days it planned and its run time. */
  lastBatch?: LoadedBatch;
  /** Merged ranges whose full read was checked against a signatures listing and agreed. Loaded time outside them was read once,
   * before the check existed, and keeps its rows and coverage. */
  checked?: Range[];
}
export interface LoadedBatch { kind: 'first' | 'earlier'; jobId: string; startTime: number; endTime: number; days: number; elapsedSeconds: number; finishedAt: number }
/** A refresh covers the loaded range up to a new cutoff; Load earlier adds one batch before the oldest loaded day; a check lists
 * chosen days of the loaded range again and fetches only what is missing. */
export type JobKind = 'refresh' | 'earlier' | 'check';
/** What a range check found. `recovered` are the signatures it saved for this wallet that were not saved before. */
export interface RangeCheck {
  status: 'agreed' | 'disagreed'; listed: number; alreadySaved: number; recovered: string[];
  /** Listed signatures still not saved, and saved history transactions the listing left out; both 0 when it agreed. */
  missing: number; unlisted: number;
}
/** A finished job's checks: the days it checked, the payouts in transactions they saved, and the payouts already saved there.
 * Attributed and verified payouts are counted apart and never added together. */
export interface CheckResult {
  days: number; checkedDays: number; unconfirmedDays: number; newTransactions: number;
  newPayouts: number; alreadySaved: number; newVerified: number; verifiedAlreadySaved: number;
}
export interface Limits { stonkfun: number; helius: number; pages: number; resumes: number; deadline: number }
export interface Job {
  id: string; network: SolanaNetwork; wallet: string; cutoff: number; createdAt: number;
  status: 'running' | 'paused' | 'complete' | 'exhausted';
  limits: Limits; used: { stonkfun: number; helius: number; pages: number; resumes: number };
  pageSize: number; error: string | null; registryDone: boolean; hydrationDone: boolean;
  /** Absent on jobs saved before Load earlier; those are all refreshes. */
  kind?: JobKind;
  /** The history a first scan or Load earlier job adds beyond the saved loaded range. */
  batch?: { kind: LoadedBatch['kind']; startTime: number; endTime: number };
  /** A check job's chosen UTC days, whole days from its start to its end. */
  check?: { startTime: number; endTime: number; days: number };
  /** Set when a job with range checks finishes its history. */
  checkResult?: CheckResult;
  /** Run time summed over every run of this job, and when its last run ended. */
  elapsedMs?: number; finishedAt?: number;
  /** The classified reason this job stopped or struggled; cleared when it resumes. */
  failure?: JobFailure | null;
}
export interface JobRange extends Range {
  id: number; jobId: string; query: HistoryQuery; cursor: string | null;
  status: 'pending' | 'complete'; pages: number; tainted: boolean; restarts: number;
  /** The full read reached the range's end and awaits its check; absent on ranges saved before the check existed. */
  read?: boolean;
  check?: RangeCheck;
}
export interface Metadata {
  mint: string; symbol?: string; name?: string; decimals?: number; retrievedAt: string;
  membershipEvidence?: { kind: 'launch' | 'rewardSummary' | 'distribution'; launchMint: string; endpoint: string; retrievedAt: string }[];
}
export interface Price {
  mint: string; currency: 'USD'; value: string | null; provider: 'stonkfun' | 'helius' | 'fixture';
  observedAt: string | null; retrievedAt: string; expiresAt: number; reason: string | null;
}
export interface Classification {
  identity: string; signature: string; network: SolanaNetwork; wallet: string;
  blockTime: number | null; mint: string | null; decimals: number | null;
  grossRaw: string | null; netRaw: string | null;
  /** `attributed` is never a confirmation and is never summed with confirmed totals. */
  status: 'confirmed' | 'attributed' | 'excluded' | 'unknown_candidate'; reasons: string[];
  basis: 'official_feed' | 'same_slot_pattern' | 'verified_historical_authority' | 'distributor_pattern' | null; version: typeof CLASSIFIER_VERSION;
  evidenceIds: string[]; supportingSignatures: string[];
  sourceAccount: string | null; sourceOwner: string | null; authority: string | null;
  recipient: string | null; program: string | null; signers: string[];
  destinationOwner?: string | null; feePayer?: string | null;
  authorityEvidence?: {
    modelVersion: typeof AUTHORITY_MODEL_VERSION; epochId: string; patternId: string;
    validAfter: number; validBefore: number;
    witnesses: { signature: string; evidenceIds: string[] }[];
  } | null;
  attributionEvidence?: AttributionEvidence | null;
  temporalScope: 'exact_transaction' | 'same_slot_bracket' | 'witness_bounded_epoch' | 'identity_attributed' | 'unestablished';
}
export interface EvidenceSet { transactions: NormalizedTransaction[]; feeds: DistributionEvidenceInput[]; overflow: boolean; transactionObservationIds?: string[] }
export interface AuthorityObservation { signature: string; slot: number; transactionIndex: number | null; pattern: PayoutAuthorityPattern; evidenceIds?: string[] }
export interface AuthorityRevocation {
  modelVersion: typeof AUTHORITY_MODEL_VERSION; patternId: string; effectiveFrom: number;
  decisionId: string; witnessSignatures: string[]; evidenceIds: string[];
  scope: 'local_safety_revocation';
}
/** One successful published LaunchLab configuration read. A role snapshot, never payout verification. */
export interface WithdrawalAuthoritySnapshot {
  id: string; network: SolanaNetwork; role: 'withdrawWithheldAuthority'; authority: string; configurationQuoteMint: string;
  /** Retrieval completion time; `observed` is the same instant in UTC seconds. */
  retrievedAt: string; observed: number; generatedAt: string | null;
  endpoint: string; evidenceId: string; sourceId: string;
}
export interface RegistryUpdate {
  feeds: DistributionEvidenceInput[]; quotes: Metadata[];
  retrievedAt: string; complete: boolean; detail: string;
}
export interface CacheEntry<T> { value: T; expiresAt: number }

/** All methods are synchronous and local. atomic must roll back every nested mutation on failure. */
export interface RewardsStore {
  atomic<T>(work: () => T): T;
  wallet(network: SolanaNetwork, wallet: string): WalletState | undefined;
  saveWallet(wallet: WalletState): void;
  coverage(network: SolanaNetwork, wallet: string): Range[];
  completeRange(job: Job, range: JobRange): void;
  acquire(network: SolanaNetwork, wallet: string, owner: string, now: number): void;
  renew(network: SolanaNetwork, wallet: string, owner: string, now: number): void;
  release(network: SolanaNetwork, wallet: string, owner: string): void;
  job(idOrWallet: string, network: SolanaNetwork): Job | undefined;
  saveJob(job: Job): void;
  createRanges(job: Job, ranges: Range[]): void;
  ranges(jobId: string): JobRange[];
  saveRange(range: JobRange): void;
  reserveRequest(jobId: string, provider: 'stonkfun' | 'helius', now: number): void;
  /** Admit now and take a token from the provider's shared bucket, or return the next check time without reserving a
   * future slot. A server cooldown holds every dispatch back. */
  reserveDispatch(provider: string, now: number, deadline: number, limit: RateLimit): number;
  cooldown(provider: string, until?: number): number;
  addTransaction(network: SolanaNetwork, transaction: FullTransaction, provenance: NormalizationProvenance): string;
  watch(network: SolanaNetwork, signature: string, wallet: string): void;
  addFeed(feed: DistributionEvidenceInput): string[];
  evidence(network: SolanaNetwork, signature: string): EvidenceSet;
  hasTransaction(network: SolanaNetwork, signature: string): boolean;
  dirty(network: SolanaNetwork, limit: number): string[];
  pendingClassifications(network: SolanaNetwork, wallet: string): { networkSignatures: number; walletSignatures: number };
  clean(network: SolanaNetwork, signature: string): void;
  watchers(network: SolanaNetwork, signature: string): string[];
  saveClassifications(network: SolanaNetwork, signature: string, wallet: string, rows: Classification[]): void;
  classifications(network: SolanaNetwork, wallet: string, after: string, limit: number): Classification[];
  saveAuthorities(network: SolanaNetwork, signature: string, observations: AuthorityObservation[]): void;
  authorities(network: SolanaNetwork, slot: number): AuthorityObservation[];
  authorityHistory(network: SolanaNetwork): AuthorityObservation[];
  authorityRevocations(network: SolanaNetwork): AuthorityRevocation[];
  saveAuthorityRevocation(network: SolanaNetwork, patternId: string, effectiveFrom: number, decisionId: string): void;
  /** Inserts validated configuration snapshots by content id and returns the newly retained ids. */
  saveWithdrawalSnapshots(feed: DistributionEvidenceInput): string[];
  withdrawalSnapshots(network: SolanaNetwork): WithdrawalAuthoritySnapshot[];
  /** Replaces one signature's derived contradictions; any change invalidates every attributed row. */
  saveIdentityConflicts(network: SolanaNetwork, signature: string, conflicts: IdentityConflict[]): void;
  identityConflicts(network: SolanaNetwork): IdentityConflict[];
  attributionRevocations(network: SolanaNetwork): AttributionRevocation[];
  saveAttributionRevocation(network: SolanaNetwork, sourceOwner: string, effectiveFrom: number, decisionId: string): void;
  /** Launch mints named by retained quote membership evidence or official feed rows. */
  retainedLaunchMints(network: SolanaNetwork): string[];
  quote(network: SolanaNetwork, mint: string): Metadata | undefined;
  saveQuote(network: SolanaNetwork, metadata: Metadata): void;
  price(network: SolanaNetwork, mint: string): Price | undefined;
  /** Optional: the most recent saved observation carrying a USD value, from any job. Reports value a mint at it when the
   * latest observation has none; without it they use `price` alone. */
  latestPrice?(network: SolanaNetwork, mint: string): Price | undefined;
  savePrice(network: SolanaNetwork, price: Price): void;
  /** Signatures with a classification row for the wallet whose block time is in [start, end): a cheap indexed read. */
  classifiedSignatures(network: SolanaNetwork, wallet: string, start: number, end: number): string[];
  /** Whether a succeeded transaction with this signature was saved from a history page of one of this wallet's jobs. */
  historySaved(network: SolanaNetwork, signature: string, wallet: string): boolean;
  /** The wallet's verified and attributed payout rows whose block time is in [start, end). */
  payoutRows(network: SolanaNetwork, wallet: string, start: number, end: number): { signature: string; status: 'confirmed' | 'attributed' }[];
  /** Optional local reads and writes behind the holdings a successful refresh stores. A store without them never stores
   * holdings, and readers compute them from retained transactions instead. */
  walletTokenBalances?(network: SolanaNetwork, wallet: string): WalletTokenBalance[];
  retainedFingerprint?(network: SolanaNetwork, wallet: string): string;
  saveHoldings?(network: SolanaNetwork, wallet: string, set: HoldingsSet): void;
  holdings?(network: SolanaNetwork, wallet: string): StoredHoldings | undefined;
  cache<T>(key: string): CacheEntry<T> | undefined;
  saveCache<T>(key: string, entry: CacheEntry<T>): void;
  close(): void;
}
export interface Providers {
  registry(): Promise<RegistryUpdate>;
  hydrate(signature: string): Promise<{ transaction: FullTransaction; provenance: NormalizationProvenance } | null>;
  history(query: HistoryQuery, cursor: string | null, onPage: (page: HistoryPage) => void): Promise<HistoryResult>;
  /** Optional: every signature the same history query lists in signatures mode. Without it ranges are read once, unchecked. */
  signatures?(query: HistoryQuery): Promise<SignatureList>;
  price(mint: string): Promise<Price>;
  /** Optional: the wallet's current fungible token holdings, every page, or null when any page could not be read. */
  holdings?(wallet: string): Promise<HoldingsSnapshot | null>;
}
