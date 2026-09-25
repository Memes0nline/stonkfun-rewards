import type { DistributionRow } from '../registry/schemas.js';
import type { Registry, Retrieval, WithdrawalAuthority } from '../registry/types.js';
import type {
  CreditIdentityGroup, NormalizedTransaction, NormalizedTransfer, SolanaNetwork,
} from '../normalization/types.js';

/** One caller-attributed registry observation; source IDs are local to this observation. */
export interface DistributionEvidenceInput {
  network: SolanaNetwork;
  provenance: {
    source: 'stonkfun-public-api' | 'fixture';
    evidenceId: string;
    retrievedAt: string;
  };
  distributions: Registry['distributions'];
  sources: Retrieval[];
  withdrawalAuthorities: WithdrawalAuthority[];
}

/** v2 adds decoded compute-budget positions and fee-bearing transfers; v3 adds the recognized
 * associated-token-account creation unit, its exact rent movement, and native distributor batches. */
export type PayoutPolicyVersion = 'payout-evidence-v1' | 'payout-evidence-v2' | 'payout-evidence-v3';
/** Retained inputs only. Derived support is always recomputed, never accepted as a trust flag. */
export interface PayoutEvidenceState {
  schemaVersion: 1;
  policyVersion: PayoutPolicyVersion;
  feeds: DistributionEvidenceInput[];
  transactions: NormalizedTransaction[];
}
export interface PayoutEvidenceInput {
  policyVersion?: PayoutEvidenceState['policyVersion'];
  feeds: readonly DistributionEvidenceInput[];
  transactions: readonly NormalizedTransaction[];
  prior?: PayoutEvidenceState;
}
export type PayoutEvidenceReason =
  | 'missing_official_distribution' | 'missing_transaction' | 'failed_transaction'
  | 'conflicting_feed_rows' | 'feed_provenance_unresolved' | 'conflicting_transaction_evidence'
  | 'conflicting_identity_evidence' | 'missing_transfer_observation' | 'no_supported_transfers'
  | 'unresolved_normalization' | 'uninterpreted_activity' | 'unexplained_native_movement'
  | 'mint_mismatch' | 'amount_mismatch' | 'feed_fee_semantics_unresolved'
  | 'unproven_net_credit' | 'ambiguous_attribution' | 'recipient_participation'
  | 'unsupported_authority_pattern';

export interface ReconciledDistributionRow {
  value: DistributionRow;
  observations: { feedIndex: number; sourceIds: string[] }[];
}
export interface MintEvidenceComparison {
  quoteMint: string;
  rowIndexes: number[];
  transferIdentities: string[];
  /** Null when there are contradictory rows for a launch. Never sum alternatives. */
  feedTotalRaw: string | null;
  grossInstructionTotalRaw: string;
  /** Null unless every selected transfer has a proven net credit. */
  provenNetCreditTotalRaw: string | null;
  feedEqualsGross: boolean | null;
  feedEqualsNet: boolean | null;
  basis: 'exact_signature_and_mint_aggregate';
  feedAmountSemantics: 'not_established';
  reasons: PayoutEvidenceReason[];
}
export interface TransactionEvidenceComparison {
  transactionIndex: number;
  mints: MintEvidenceComparison[];
  reasons: PayoutEvidenceReason[];
}
export interface DistributionReconciliation {
  network: SolanaNetwork;
  signature: string;
  status: 'reconciled' | 'unresolved';
  rows: ReconciledDistributionRow[];
  transactionIndexes: number[];
  identityKeys: string[];
  comparisons: TransactionEvidenceComparison[];
  reasons: PayoutEvidenceReason[];
}
export interface PayoutRoleWitness {
  /** All indexes refer to returned state / this signature's reconciliation rows. */
  transactionIndexes: number[];
  rowIndexes: number[];
  feedIndexes: number[];
}
export interface ObservedPayoutCredit {
  identity: string;
  signature: string;
  status: 'supported' | 'contested';
  reasons: PayoutEvidenceReason[];
  position: NormalizedTransfer['position'];
  recipientTokenAccount: string;
  recipientOwner: string;
  grossAmountRaw: string;
  netCreditRaw: string;
  netCreditBasis: NormalizedTransfer['netCreditBasis'];
  /** Actual observed block times, not retrieval times or validity bounds. */
  observedPayoutTimes: number[];
  launchMints: string[];
  launchAssociation: 'signature_and_quote_mint_only';
  perLaunchAllocation: 'not_established';
  witnesses: PayoutRoleWitness[];
}
export interface PayoutAuthorityPattern {
  patternId: string;
  network: SolanaNetwork;
  transferAuthority: string;
  authorityKind: NormalizedTransfer['authorityKind'];
  instructionSigners: string[];
  sourceTokenAccount: string;
  observedSourceOwner: string;
  tokenProgram: string;
  quoteMint: string;
  transactionSigners: string[];
  /** First message account, separately checked as a signer; never promoted by that role. */
  feePayer: string;
  observations: ObservedPayoutCredit[];
  status: 'supported_observations' | 'contested_observations' | 'mixed_observations';
  firstObservedPayoutTime: number | null;
  lastObservedPayoutTime: number | null;
  firstRetrievedAt: string;
  lastRetrievedAt: string;
  validity: 'observed_transactions_only';
}
export interface PayoutEvidenceResult {
  schemaVersion: 1;
  policyVersion: PayoutPolicyVersion;
  classification: 'not_performed';
  state: PayoutEvidenceState;
  identityGroups: CreditIdentityGroup[];
  reconciliations: DistributionReconciliation[];
  authorityPatterns: PayoutAuthorityPattern[];
  withdrawalConfiguration: {
    network: SolanaNetwork;
    feedIndex: number;
    evidence: WithdrawalAuthority;
    payoutVerification: 'not_provided';
  }[];
}
