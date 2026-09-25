import { createHash } from 'node:crypto';
import type { InstructionEvidence, NormalizedTransaction, NormalizedTransfer, SolanaNetwork } from '../normalization/types.js';
import { payoutStructure } from '../payout-evidence/reconcile.js';
import { lamportDelta, nativeTransfers, SYSTEM_PROGRAM } from '../payout-evidence/native-payout.js';
import { canonical } from '../payout-evidence/validation.js';
import { associatedTokenAddress } from './ata.js';
import { witnessTime } from './historical-authority.js';
import { ATTRIBUTION_MODEL_VERSION, CLASSIFIER_VERSION, NATIVE_SOL_MINT } from './types.js';
import type {
  AttributionEvidence, AttributionLane, AttributionRevocation, AttributionTrustSource, AuthorityObservation, EvidenceSet, IdentityConflict,
  WithdrawalAuthoritySnapshot,
} from './types.js';
import type { PayoutEvidenceResult } from '../payout-evidence/types.js';

export interface FeedWitness { signature: string; blockTime: number; evidenceIds: string[] }
/** Batch-wide trust inputs, derived only from evidence retained in the same database. */
export interface AttributionContext {
  network: SolanaNetwork;
  witnesses: ReadonlyMap<string, readonly FeedWitness[]>;
  conflicted: ReadonlySet<string>;
  snapshots: readonly WithdrawalAuthoritySnapshot[];
  revocations: readonly AttributionRevocation[];
  launchMints: ReadonlySet<string>;
}
export type AttributionOutcome = { evidence: AttributionEvidence; reasons?: never } | { evidence?: never; reasons: string[] };
type Published = { status: 'not_named' | 'pending' | 'ambiguous' }
  | { status: 'ok'; after: WithdrawalAuthoritySnapshot[]; before: WithdrawalAuthoritySnapshot[] };

// Official-row reconciliation reasons that contradict chain evidence, not merely absent or unsupported support.
const contradiction = (reason: string) => reason.startsWith('conflicting_')
  || reason === 'missing_transfer_observation' || reason === 'mint_mismatch' || reason === 'amount_mismatch';
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export function attributionIdentity(network: SolanaNetwork, sourceOwner: string): string {
  return digest([ATTRIBUTION_MODEL_VERSION, network, sourceOwner]);
}

/** A witness qualifies only as a single-authority distributor paying from its own derived account. */
export function feedWitnesses(network: SolanaNetwork, history: readonly AuthorityObservation[]): Map<string, FeedWitness[]> {
  const byOwner = new Map<string, Map<string, FeedWitness>>();
  for (const item of history) {
    const pattern = item.pattern;
    const time = witnessTime(item);
    if (pattern.network !== network || pattern.status !== 'supported_observations' || pattern.authorityKind !== 'single'
      || pattern.instructionSigners.length > 0 || pattern.transferAuthority !== pattern.observedSourceOwner || time === null
      || associatedTokenAddress(pattern.observedSourceOwner, pattern.quoteMint, pattern.tokenProgram)?.address !== pattern.sourceTokenAccount) continue;
    const witnesses = byOwner.get(pattern.observedSourceOwner) ?? new Map<string, FeedWitness>();
    const prior = witnesses.get(item.signature);
    witnesses.set(item.signature, { signature: item.signature, blockTime: time,
      evidenceIds: [...new Set([...prior?.evidenceIds ?? [], ...item.evidenceIds ?? []])].sort() });
    byOwner.set(pattern.observedSourceOwner, witnesses);
  }
  return new Map([...byOwner].map(([owner, witnesses]) => [owner, [...witnesses.values()]
    .sort((a, b) => a.blockTime - b.blockTime || a.signature.localeCompare(b.signature))]));
}

export function attributionContext(input: {
  network: SolanaNetwork; authorityHistory: readonly AuthorityObservation[]; identityConflicts?: readonly IdentityConflict[];
  snapshots?: readonly WithdrawalAuthoritySnapshot[]; revocations?: readonly AttributionRevocation[]; launchMints?: Iterable<string>;
}): AttributionContext {
  const conflicted = new Set((input.identityConflicts ?? []).filter(item => item.network === input.network).map(item => item.owner));
  // A contested or mixed witness makes either named role unresolved for the identity.
  for (const item of input.authorityHistory) {
    if (item.pattern.network === input.network && item.pattern.status !== 'supported_observations') {
      conflicted.add(item.pattern.observedSourceOwner); conflicted.add(item.pattern.transferAuthority);
    }
  }
  return { network: input.network, witnesses: feedWitnesses(input.network, input.authorityHistory), conflicted,
    snapshots: [...input.snapshots ?? []].filter(item => item.network === input.network)
      .sort((a, b) => a.observed - b.observed || a.id.localeCompare(b.id)),
    revocations: input.revocations ?? [], launchMints: new Set(input.launchMints ?? []) };
}

/** Source owners of a retained feed signature whose official row contradicts its transaction evidence. */
export function identityConflicts(evidence: EvidenceSet, result: Pick<PayoutEvidenceResult, 'reconciliations'>): IdentityConflict[] {
  const tx = evidence.transactions[0];
  if (!tx || evidence.feeds.length === 0) return [];
  const reasons = [...new Set(result.reconciliations.filter(item => item.signature === tx.signature && item.network === tx.network)
    .flatMap(item => item.reasons).filter(contradiction))].sort();
  if (!reasons.length) return [];
  const evidenceIds = [...new Set([...(evidence.transactionObservationIds ?? evidence.transactions.map(item => item.provenance.evidenceId)),
    ...evidence.feeds.map(feed => feed.provenance.evidenceId)])].sort();
  return [...new Set(evidence.transactions.flatMap(item => item.transfers.flatMap(transfer => transfer.sourceOwner.value ?? [])))].sort()
    .map(owner => ({ network: tx.network, signature: tx.signature, owner, reasons, evidenceIds }));
}

/** Nearest snapshot at or after the credit must name the owner, and so must the nearest before it. */
function publishedTrust(owner: string, time: number, snapshots: readonly WithdrawalAuthoritySnapshot[]): Published {
  if (!snapshots.some(item => item.authority === owner)) return { status: 'not_named' };
  const later = snapshots.filter(item => item.observed >= time);
  if (!later.length) return { status: 'pending' };
  const earlier = snapshots.filter(item => item.observed < time);
  const after = later.filter(item => item.observed === later[0]!.observed);
  const before = earlier.filter(item => item.observed === earlier.at(-1)?.observed);
  // Includes disagreeing snapshots retrieved in the same second.
  if ([...after, ...before].some(item => item.authority !== owner)) return { status: 'ambiguous' };
  return { status: 'ok', after, before };
}

/** A searched-wallet reference anywhere in an instruction's accounts or decoded fields. */
function references(instruction: InstructionEvidence, address: string): boolean {
  if (instruction.accounts?.includes(address)) return true;
  const inside = (value: unknown): boolean => typeof value === 'string' ? value === address
    : Array.isArray(value) ? value.some(inside)
      : value !== null && typeof value === 'object' ? Object.values(value).some(inside) : false;
  return inside(instruction.parsed);
}
/**
 * The associated-token-account program takes the future owner's address only as a seed, and a
 * non-signer, non-writable key authorizes nothing. The wallet key is tolerated only when it is that
 * seed and nothing else: every instruction in the transaction that names it is either the outer
 * instruction of a recognized creation unit for the wallet, or that unit's own initializeAccount3.
 */
function walletOnlyOwnerSeed(tx: NormalizedTransaction, wallet: string): boolean {
  const entry = tx.evidence.transaction.message.accountKeys.find(item => item.pubkey === wallet);
  if (!entry || entry.signer || entry.writable) return false;
  const units = (tx.accountCreations ?? []).filter(item => item.owner === wallet);
  if (units.length === 0) return false;
  const allowed = new Set(units.flatMap(item => [`${item.position.outer}:outer`,
    ...item.created ? [`${item.created.initialization.outer}:${item.created.initialization.inner}`] : []]));
  const outer = tx.evidence.transaction.message.instructions;
  const positioned = [...outer.map((instruction, index) => ({ at: `${index}:outer`, instruction })),
    ...(tx.evidence.meta.innerInstructions ?? []).flatMap(group => group.instructions
      .map((instruction, index) => ({ at: `${group.index}:${index}`, instruction })))];
  return positioned.every(item => !references(item.instruction, wallet) || allowed.has(item.at));
}

function exactCredit(tx: NormalizedTransaction, transfer: NormalizedTransfer, wallet: string): boolean {
  const account = tx.accounts.find(item => item.address === transfer.destination);
  const incoming = tx.transfers.filter(item => item.destination === transfer.destination);
  return !!account && account.owner.value === wallet && account.balanceChangeRaw !== null && BigInt(account.balanceChangeRaw) > 0n
    && transfer.netCreditRaw !== null && BigInt(transfer.netCreditRaw) > 0n && transfer.netCreditBasis !== null
    && transfer.decimals.value !== null && /^\d+$/.test(transfer.grossAmountRaw) && incoming.every(item => item.netCreditRaw !== null)
    && BigInt(account.balanceChangeRaw) === incoming.reduce((sum, item) => sum + BigInt(item.netCreditRaw!), 0n);
}

/** Gates G1–G6 in fixed order. Only for a credit no official row names; the first failing gate is returned. */
export function distributorPattern(tx: NormalizedTransaction, transfer: NormalizedTransfer, wallet: string,
  memberMints: ReadonlySet<string>, context: AttributionContext): AttributionOutcome {
  const fail = (reason: string): AttributionOutcome => ({ reasons: [reason] });
  const time = tx.evidence.blockTime;
  // G1: every wallet credit in the transaction is exact, and every transferred mint has reward-quote membership.
  const credits = tx.transfers.filter(item => item.destinationOwner.value === wallet);
  if (time === null || time === undefined || !Number.isSafeInteger(time) || tx.network !== context.network || !credits.includes(transfer)
    || credits.some(item => !exactCredit(tx, item, wallet))
    || tx.transfers.some(item => item.mint.value === null || !memberMints.has(item.mint.value))) return fail('distributor_credit_unreconciled');
  // G2: the source owner holds a trust source. Exact address equality only.
  const owner = transfer.sourceOwner.value;
  const witnesses = owner === null ? [] : (context.witnesses.get(owner) ?? []).filter(item => item.signature !== tx.signature);
  const published: Published = owner === null ? { status: 'not_named' } : publishedTrust(owner, time, context.snapshots);
  if (owner === null || (!witnesses.length && published.status === 'not_named')) return fail('distributor_trust_unestablished');
  // G3: one source owner, and each source is that owner's derived account for the transfer's mint and program.
  const accounts = tx.transfers.map(item => item.sourceOwner.value === owner && item.mint.value !== null
    ? associatedTokenAddress(owner, item.mint.value, item.programId) : null);
  if (accounts.some((account, index) => account?.address !== tx.transfers[index]!.source)) return fail('distributor_source_not_ata');
  // G4: the owner is the single signing authority; any other signer is the fee payer; the wallet has no role.
  const keys = tx.evidence.transaction.message.accountKeys.map(key => key.pubkey);
  const feePayer = keys[0];
  if (feePayer === undefined || tx.transfers.some(item => item.authorityKind !== 'single' || item.authority !== owner || item.instructionSigners.length > 0)
    || !tx.signers.includes(owner) || tx.signers.some(signer => signer !== owner && signer !== feePayer) || tx.signers.includes(wallet)
    || tx.transfers.some(item => item.sourceOwner.value === wallet || item.source === wallet || item.destination === wallet
      || item.authority === wallet || item.instructionSigners.includes(wallet))) return fail('distributor_signer_shape_unsupported');
  if (keys.includes(wallet) && !walletOnlyOwnerSeed(tx, wallet)) return fail('wallet_in_account_keys');
  // G5: production payout-evidence v2 structure.
  const structure = payoutStructure(tx);
  if (structure.length) return { reasons: structure };
  // G6: contests, contradictions, local revocation, and published rotation gaps or pending snapshots.
  if (context.conflicted.has(owner)) return fail('distributor_identity_conflicted');
  if (context.revocations.some(item => item.modelVersion === ATTRIBUTION_MODEL_VERSION && item.sourceOwner === owner
    && time >= item.effectiveFrom)) return fail('distributor_attribution_revoked');
  // Feed-witnessed trust is independent evidence; a published timeline gap only matters without it.
  if (!witnesses.length && published.status !== 'ok') {
    return fail(published.status === 'pending' ? 'published_authority_snapshot_pending' : 'published_authority_rotation_ambiguous');
  }

  const source = accounts[tx.transfers.indexOf(transfer)]!;
  const fromSource = tx.transfers.filter(item => item.source === transfer.source);
  return { evidence: attributionEvidence({ tx, owner, time, witnesses, published, feePayer,
    sourceAta: source.address, ataBump: source.bump, mint: transfer.mint.value!, tokenProgram: transfer.programId,
    batch: { outerTransfersFromSource: fromSource.filter(item => item.position.inner === null).length, transfersFromSource: fromSource.length,
      distinctRecipientOwners: new Set(fromSource.map(item => item.destinationOwner.value)).size },
    creditedMintAlsoRetainedLaunch: context.launchMints.has(transfer.mint.value!) }) };
}

interface LaneEvidence {
  tx: NormalizedTransaction; owner: string; time: number; feePayer: string;
  witnesses: readonly FeedWitness[]; published: Published; lane?: AttributionLane;
  sourceAta: string; ataBump: number | null; mint: string; tokenProgram: string;
  batch: AttributionEvidence['batch']; creditedMintAlsoRetainedLaunch: boolean;
}
/** Identical provenance for both lanes; `lane` is recorded only when it is not the token lane. */
function attributionEvidence(input: LaneEvidence): AttributionEvidence {
  const { tx, owner, time, witnesses, published } = input;
  const trustSources: AttributionTrustSource[] = [
    ...witnesses.length ? ['feed_witnessed_identity' as const] : [], ...published.status === 'ok' ? ['published_withdraw_authority' as const] : []];
  const snapshots = published.status === 'ok' ? [...published.after.map(item => ({ item, role: 'nearest_at_or_after' as const })),
    ...published.before.map(item => ({ item, role: 'nearest_before' as const }))] : [];
  const first = witnesses[0]; const last = witnesses.at(-1);
  return {
    basis: 'distributor_pattern', modelVersion: ATTRIBUTION_MODEL_VERSION, classifierVersion: CLASSIFIER_VERSION,
    identityId: attributionIdentity(tx.network, owner), trustSources, primaryTrustSource: trustSources[0]!,
    ...input.lane === undefined ? {} : { lane: input.lane },
    publishedSnapshots: snapshots.map(({ item, role }) => ({ id: item.id, role, authority: item.authority, retrievedAt: item.retrievedAt,
      generatedAt: item.generatedAt, configurationQuoteMint: item.configurationQuoteMint, evidenceId: item.evidenceId })),
    secondsToNearestSnapshot: snapshots.length ? Math.min(...snapshots.map(({ item }) => Math.abs(item.observed - time))) : null,
    witnesses: first && last ? {
      count: witnesses.length, digest: digest([...witnesses].sort((a, b) => a.signature.localeCompare(b.signature)).map(item => [item.signature, item.evidenceIds])),
      first: { signature: first.signature, blockTime: first.blockTime, evidenceIds: first.evidenceIds },
      last: { signature: last.signature, blockTime: last.blockTime, evidenceIds: last.evidenceIds },
      signatures: witnesses.slice(0, 32).map(item => item.signature),
      relation: time < first.blockTime ? 'before_first_witness' : time > last.blockTime ? 'after_last_witness' : 'within_witness_span',
      secondsToNearestWitness: Math.min(...witnesses.map(item => Math.abs(item.blockTime - time))),
    } : null,
    sourceOwner: owner, sourceAta: input.sourceAta, ataBump: input.ataBump, mint: input.mint, tokenProgram: input.tokenProgram,
    signerShape: { kind: input.feePayer === owner ? 'owner_is_fee_payer' : 'owner_and_separate_fee_payer',
      feePayer: input.feePayer, signers: [...tx.signers].sort() },
    batch: input.batch, creditedMintAlsoRetainedLaunch: input.creditedMintAlsoRetainedLaunch,
  };
}

export interface NativeLaneResult { owner: string; lamports: string; outcome: AttributionOutcome }
/**
 * Rule A2, the native-SOL lane. It returns null unless a trusted distributor identity both funds and
 * signs this lamport-only credit, which is exactly the condition under which rule X1 may still
 * exclude the transaction. Once it returns a result the row is never excluded: it is either
 * attributed or stays unknown with the lane's own unproven reason.
 */
export function nativeDistributorPattern(tx: NormalizedTransaction, wallet: string, context: AttributionContext): NativeLaneResult | null {
  // The lane exists only for a transaction with no supported token transfer and no wallet-owned
  // token-balance observation in either phase: the same evidence rule X1's first clause rests on.
  if (tx.transfers.length !== 0) return null;
  if ([...tx.evidence.meta.preTokenBalances, ...tx.evidence.meta.postTokenBalances].some(item => item.owner === wallet)) return null;
  const batch = nativeTransfers(tx);
  const credits = (batch ?? []).filter(item => item.destination === wallet);
  if (!batch?.length || !credits.length) return null;
  const keys = tx.evidence.transaction.message.accountKeys.map(key => key.pubkey);
  const trustedWitnesses = (owner: string) => (context.witnesses.get(owner) ?? []).filter(item => item.signature !== tx.signature);
  const owner = [...new Set(credits.map(item => item.source))].sort().find(source => tx.signers.includes(source)
    && (trustedWitnesses(source).length > 0 || context.snapshots.some(item => item.authority === source)));
  if (owner === undefined) return null;
  const lamports = credits.reduce((total, item) => total + BigInt(item.lamports), 0n).toString();
  const fail = (reason: string): NativeLaneResult => ({ owner, lamports, outcome: { reasons: [reason] } });
  const time = tx.evidence.blockTime;
  // G1n: the wallet's lamport delta is exactly the System transfers naming it, and no token moves.
  const delta = lamportDelta(tx, wallet);
  if (time === null || time === undefined || !Number.isSafeInteger(time) || tx.network !== context.network
    || tx.evidence.meta.preTokenBalances.length > 0 || tx.evidence.meta.postTokenBalances.length > 0
    || delta === null || delta !== BigInt(lamports) || BigInt(lamports) <= 0n) return fail('distributor_credit_unreconciled');
  // G2: the funding identity holds a trust source. Exact address equality only.
  const witnesses = trustedWitnesses(owner);
  const published = publishedTrust(owner, time, context.snapshots);
  if (!witnesses.length && published.status === 'not_named') return fail('distributor_trust_unestablished');
  // G3n: one funding source, the identity's own system account. A native payout has no token account.
  if (!keys.includes(owner) || batch.some(item => item.source !== owner)) return fail('distributor_native_source_unsupported');
  // G4n: the owner signs, any other signer is the fee payer, and the wallet funds and signs nothing.
  const feePayer = keys[0];
  if (feePayer === undefined || feePayer === wallet || !tx.signers.includes(owner) || tx.signers.includes(wallet)
    || tx.signers.some(signer => signer !== owner && signer !== feePayer)
    || batch.some(item => item.source === wallet)) return fail('distributor_signer_shape_unsupported');
  // G5: production payout structure, with the decoded lamport batch as the payout.
  const structure = payoutStructure(tx, 'payout-evidence-v3', batch);
  if (structure.length) return { owner, lamports, outcome: { reasons: structure } };
  // G6: identical to the token lane.
  if (context.conflicted.has(owner)) return fail('distributor_identity_conflicted');
  if (context.revocations.some(item => item.modelVersion === ATTRIBUTION_MODEL_VERSION && item.sourceOwner === owner
    && time >= item.effectiveFrom)) return fail('distributor_attribution_revoked');
  if (!witnesses.length && published.status !== 'ok') {
    return fail(published.status === 'pending' ? 'published_authority_snapshot_pending' : 'published_authority_rotation_ambiguous');
  }
  const fromSource = batch.filter(item => item.source === owner);
  return { owner, lamports, outcome: { evidence: attributionEvidence({ tx, owner, time, witnesses, published, feePayer,
    lane: 'native_sol', sourceAta: owner, ataBump: null, mint: NATIVE_SOL_MINT, tokenProgram: SYSTEM_PROGRAM,
    batch: { outerTransfersFromSource: fromSource.filter(item => item.position.inner === null).length,
      transfersFromSource: fromSource.length, distinctRecipientOwners: new Set(fromSource.map(item => item.destination)).size },
    creditedMintAlsoRetainedLaunch: false }) } };
}
