import type { FullTransaction } from '../helius/schemas.js';

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';
export interface InstructionPosition { outer: number; inner: number | null }
export interface NormalizationProvenance {
  source: 'helius' | 'solana-rpc' | 'fixture';
  /** Caller-owned opaque reference, never a URL or credential. */
  evidenceId: string;
  retrievedAt: string;
  commitment: 'confirmed' | 'finalized' | 'unknown';
}
export interface NormalizationInput {
  transaction: FullTransaction;
  wallet: string;
  network: SolanaNetwork;
  provenance: NormalizationProvenance;
}
export type NormalizationReason =
  | 'invalid_account_reference' | 'duplicate_account_key' | 'invalid_signer_metadata'
  | 'invalid_instruction_position' | 'duplicate_instruction_position' | 'inner_instructions_unavailable'
  | 'uninterpreted_instruction' | 'unsupported_program' | 'unsupported_token_instruction' | 'invalid_transfer_evidence'
  | 'missing_owner' | 'conflicting_owner' | 'missing_mint' | 'conflicting_mint'
  | 'missing_decimals' | 'conflicting_decimals' | 'conflicting_token_program'
  | 'missing_pre_balance' | 'missing_post_balance' | 'conflicting_balance'
  | 'account_lifecycle' | 'unexplained_balance_change' | 'ambiguous_fee_allocation'
  | 'reconciliation_blocked' | 'failed_transaction' | 'same_account_transfer';
export interface EvidenceIssue {
  reason: NormalizationReason;
  position?: InstructionPosition;
  account?: string;
}
export interface ResolvedEvidence<T> {
  status: 'resolved' | 'missing' | 'conflicting';
  value: T | null;
  observations: { value: T; evidence: string }[];
}
export type TokenBalanceEvidence = FullTransaction['meta']['preTokenBalances'][number];
export type InstructionEvidence = FullTransaction['transaction']['message']['instructions'][number];
export interface AccountEvidence {
  address: string;
  accountIndex: number | null;
  owner: ResolvedEvidence<string>;
  mint: ResolvedEvidence<string>;
  decimals: ResolvedEvidence<number>;
  tokenProgram: ResolvedEvidence<string>;
  pre: TokenBalanceEvidence[];
  post: TokenBalanceEvidence[];
  /** Only computed from two unambiguous observed balances, never inferred zero. */
  balanceChangeRaw: string | null;
  lifecycle: { type: string; position: InstructionPosition }[];
  /** True only from a recognized creation's parsed `system createAccount`, never from a missing row. */
  createdInTransaction?: boolean;
  reconciliation: 'matched' | 'unresolved';
  reasons: NormalizationReason[];
}
/** A recognized associated-token-account creation lifecycle unit and its cross-checked CPI positions. */
export interface AccountCreationEvidence {
  position: InstructionPosition;
  type: 'create' | 'createIdempotent';
  account: string;
  mint: string;
  /** The future account owner the program takes as a seed, from the instruction's own `wallet` field. */
  owner: string;
  source: string;
  tokenProgram: string;
  /** Null for the idempotent no-op, whose empty CPI list created nothing and moved no lamports. */
  created: {
    position: InstructionPosition; lamports: string;
    dataSize: InstructionPosition; immutableOwner: InstructionPosition; initialization: InstructionPosition;
  } | null;
}
export interface NormalizedTransfer {
  identity: string;
  identityVersion: 1;
  position: InstructionPosition;
  recipientOrdinal: 0;
  programId: string;
  instructionType: 'transfer' | 'transferChecked' | 'transferCheckedWithFee';
  source: string;
  destination: string;
  authority: string;
  authorityKind: 'single' | 'multisig';
  instructionSigners: string[];
  mint: ResolvedEvidence<string>;
  decimals: ResolvedEvidence<number>;
  sourceOwner: ResolvedEvidence<string>;
  destinationOwner: ResolvedEvidence<string>;
  grossAmountRaw: string;
  explicitFeeRaw: string | null;
  /** Per-instruction destination credit after fees; never a wallet-wide delta or reward. */
  netCreditRaw: string | null;
  netCreditBasis: 'instruction_and_balances' | 'unique_balance_reconciliation' | null;
  flags: {
    failedTransaction: boolean;
    walletSigner: boolean;
    sameAccount: boolean;
    selfTransfer: boolean | null;
    walletDirection: 'incoming' | 'outgoing' | 'self' | 'unrelated' | 'unknown';
  };
  reasons: NormalizationReason[];
  evidence: InstructionEvidence;
}
export interface NormalizedTransaction {
  normalizationVersion: 2;
  identityVersion: 1;
  network: SolanaNetwork;
  wallet: string;
  signature: string;
  provenance: NormalizationProvenance;
  signers: string[];
  failedTransaction: boolean;
  walletSigner: boolean;
  transfers: NormalizedTransfer[];
  accounts: AccountEvidence[];
  /** Absent on bodies stored by normalization v1, which recognized no creation unit. */
  accountCreations?: AccountCreationEvidence[];
  issues: EvidenceIssue[];
  /** Full validated snapshot, including unsupported instructions, logs, and extensions. */
  evidence: FullTransaction;
  classification: 'not_performed';
}
export interface CreditIdentityGroup {
  identity: string;
  status: 'single' | 'repeated' | 'conflicting';
  reason: 'conflicting_identity_evidence' | null;
  /** Every present transfer is retained; no last-write-wins selection or amount summation. */
  observations: { resultIndex: number; transferIndex: number; transfer: NormalizedTransfer }[];
  /** Same network/signature results lacking this identity; indexes retain evidence/provenance access. */
  missingTransferObservations: { resultIndex: number }[];
}
