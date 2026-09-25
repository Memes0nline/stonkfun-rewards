import { reconcilePayoutEvidence, payoutStructure } from '../payout-evidence/reconcile.js';
import { canonical } from '../payout-evidence/validation.js';
import type { NormalizedTransaction, NormalizedTransfer } from '../normalization/types.js';
import type { PayoutEvidenceResult } from '../payout-evidence/types.js';
import { SYSTEM_PROGRAM } from '../payout-evidence/native-payout.js';
import { CLASSIFIER_VERSION, NATIVE_SOL_DECIMALS, NATIVE_SOL_MINT } from './types.js';
import { historicalAuthority } from './historical-authority.js';
import { attributionContext, distributorPattern, identityConflicts, nativeDistributorPattern } from './distributor-pattern.js';
import type { AttributionContext } from './distributor-pattern.js';
import type {
  AttributionRevocation, AuthorityObservation, AuthorityRevocation, Classification, EvidenceSet, IdentityConflict, RewardsStore,
  WithdrawalAuthoritySnapshot,
} from './types.js';

function matchingWitness(tx: NormalizedTransaction, transfer: NormalizedTransfer, item: AuthorityObservation): boolean {
    const pattern = item.pattern;
    return item.signature !== tx.signature && item.slot === tx.evidence.slot
      && pattern.status === 'supported_observations' && pattern.network === tx.network
      && pattern.transferAuthority === transfer.authority && pattern.sourceTokenAccount === transfer.source
      && pattern.observedSourceOwner === transfer.sourceOwner.value && pattern.quoteMint === transfer.mint.value
      && pattern.tokenProgram === transfer.programId && pattern.authorityKind === transfer.authorityKind
      && canonical(pattern.instructionSigners) === canonical([...transfer.instructionSigners].sort())
      && canonical(pattern.transactionSigners) === canonical([...tx.signers].sort())
      && pattern.feePayer === tx.evidence.transaction.message.accountKeys[0]?.pubkey;
}
function matchingPattern(tx: NormalizedTransaction, transfer: NormalizedTransfer, witnesses: AuthorityObservation[]): string[] {
  const index = tx.evidence.transactionIndex;
  if (index === undefined || payoutStructure(tx).length > 0) return [];
  const matching = witnesses.filter(item => item.transactionIndex !== null && matchingWitness(tx, transfer, item));
  const before = matching.find(item => item.transactionIndex! < index);
  const after = matching.find(item => item.transactionIndex! > index);
  return before && after && before.signature !== after.signature ? [before.signature, after.signature].sort() : [];
}

/** Pure wallet classification over one signature and bounded, exact-feed-supported witnesses. Attribution
 * trust uses the same independently reconciled witnesses plus any supplied retained snapshots or decisions. */
export function classifySignature(evidence: EvidenceSet, wallet: string, quoteMints: ReadonlySet<string>, witnessEvidence: readonly EvidenceSet[] = [],
  historicalQuoteMints: ReadonlySet<string> = new Set(), attribution: {
    snapshots?: readonly WithdrawalAuthoritySnapshot[]; revocations?: readonly AttributionRevocation[];
    identityConflicts?: readonly IdentityConflict[]; launchMints?: Iterable<string>;
  } = {}): Classification[] {
  const result = reconcile(evidence);
  const witnesses: AuthorityObservation[] = witnessEvidence.flatMap(witness => {
    const support = reconcile(witness);
    const tx = witness.transactions[0];
    return !tx || witness.overflow ? [] : support.authorityPatterns.map(pattern => ({
      signature: tx.signature, slot: tx.evidence.slot, transactionIndex: tx.evidence.transactionIndex ?? null, pattern,
      evidenceIds: [...new Set([...(witness.transactionObservationIds ?? witness.transactions.map(item => item.provenance.evidenceId)),
        ...witness.feeds.map(feed => feed.provenance.evidenceId)])].sort(),
    }));
  });
  const network = evidence.transactions[0]?.network ?? 'mainnet-beta';
  return classifyReconciled(evidence, wallet, quoteMints, witnesses, result, [], historicalQuoteMints,
    attributionContext({ network, authorityHistory: witnesses, ...attribution }));
}

function reconcile(evidence: EvidenceSet) {
  const keys = new Set([
    ...evidence.transactions.map(tx => canonical([tx.network, tx.signature])),
    ...evidence.feeds.flatMap(feed => feed.distributions.map(group => canonical([feed.network, group.signature]))),
  ]);
  if (keys.size > 1) throw new Error('Invalid classification evidence input');
  return reconcilePayoutEvidence({ feeds: evidence.feeds, transactions: evidence.transactions, policyVersion: 'payout-evidence-v3' });
}

type Analysis = Pick<PayoutEvidenceResult, 'reconciliations' | 'authorityPatterns'>;
/** Storage returns already-normalized content. With one snapshot and no feed there is no
 * identity alternative or exact-feed support to recompute. Pattern checks still require
 * independently reconciled witnesses and all structural/ownership/amount gates below. */
function analyzeStored(evidence: EvidenceSet): Analysis {
  const tx = evidence.transactions[0];
  if (tx && evidence.transactions.length === 1 && evidence.feeds.length === 0 && !evidence.overflow) {
    return { authorityPatterns: [], reconciliations: [{ network: tx.network, signature: tx.signature, status: 'unresolved',
      rows: [], transactionIndexes: [0], identityKeys: tx.transfers.map(transfer => transfer.identity), comparisons: [],
      reasons: ['missing_official_distribution', ...payoutStructure(tx)] }] };
  }
  return reconcile(evidence);
}

function classifyReconciled(evidence: EvidenceSet, wallet: string, quoteMints: ReadonlySet<string>, witnesses: AuthorityObservation[], result: Analysis,
  revocations: readonly AuthorityRevocation[], historicalQuoteMints: ReadonlySet<string>, attribution: AttributionContext): Classification[] {
  const rows = new Map<string, Classification>();
  for (const tx of evidence.transactions) {
    const group = result.reconciliations.find(item => item.signature === tx.signature && item.network === tx.network)!;
    const conflict = evidence.overflow || group.reasons.some(reason => /conflicting|missing_transfer/.test(reason));
    const related = tx.transfers.filter(t => t.destinationOwner.value === wallet || t.sourceOwner.value === wallet || t.destinationOwner.value === null);
    for (const transfer of related) {
      const reasons: string[] = [];
      let status: Classification['status'] = 'unknown_candidate';
      let basis: Classification['basis'] = null;
      let supports: string[] = [];
      let authorityEvidence: Classification['authorityEvidence'] = null;
      let attributionEvidence: Classification['attributionEvidence'] = null;
      if (conflict) reasons.push('conflicting_evidence_quarantined');
      else if (tx.failedTransaction) { status = 'excluded'; reasons.push('failed_transaction'); }
      else if (transfer.sourceOwner.value === wallet || transfer.source === transfer.destination) { status = 'excluded'; reasons.push('self_or_outgoing_transfer'); }
      else if (tx.signers.includes(wallet)) { status = 'excluded'; reasons.push('wallet_participation'); }
      else if (transfer.destinationOwner.value !== wallet) reasons.push('recipient_ownership_unresolved');
      else if (transfer.netCreditRaw === null || BigInt(transfer.netCreditRaw) <= 0n) reasons.push('positive_credit_unproven');
      else if (transfer.mint.value === null || !quoteMints.has(transfer.mint.value)) reasons.push('reward_quote_unverified');
      else if (tx.evidence.blockTime === null || tx.evidence.blockTime === undefined) reasons.push('timestamp_missing');
      else if (group.status === 'reconciled') { status = 'confirmed'; basis = 'official_feed'; supports = [tx.signature]; reasons.push('exact_feed_and_proven_credit'); }
      else if (group.rows.length === 0 && tx.transfers.every(item => matchingPattern(tx, item, witnesses).length === 2)
        && (supports = matchingPattern(tx, transfer, witnesses)).length === 2) {
        status = 'confirmed'; basis = 'same_slot_pattern'; reasons.push('two_feed_witnesses_bracket_same_slot');
      } else if (group.rows.length === 0 && transfer.mint.value !== null && historicalQuoteMints.has(transfer.mint.value)
        && tx.transfers.every(item => item.mint.value !== null && historicalQuoteMints.has(item.mint.value)
          && historicalAuthority(tx, item, witnesses, wallet, revocations) !== null)
        && (authorityEvidence = historicalAuthority(tx, transfer, witnesses, wallet, revocations)) !== null) {
        status = 'confirmed'; basis = 'verified_historical_authority';
        supports = authorityEvidence.witnesses.map(item => item.signature);
        reasons.push('verified_witness_bounded_authority_and_proven_credit');
      } else {
        reasons.push(...group.reasons, 'payout_origin_unverified');
        if (group.rows.length === 0 && (tx.evidence.transactionIndex === undefined
          || witnesses.some(item => item.transactionIndex === null && matchingWitness(tx, transfer, item)))) reasons.push('ordering_unavailable');
        // Distributor-pattern tier: never for a signature an official row names, so an unreconciled
        // exact-feed attempt keeps its reasons and is never downgraded to attribution.
        if (group.rows.length === 0) {
          const outcome = distributorPattern(tx, transfer, wallet, historicalQuoteMints, attribution);
          if (outcome.evidence) {
            status = 'attributed'; basis = 'distributor_pattern'; attributionEvidence = outcome.evidence;
            supports = outcome.evidence.witnesses?.signatures ?? [];
            reasons.splice(0, reasons.length, 'trusted_distributor_pattern_and_proven_credit');
          } else reasons.push(...outcome.reasons);
        }
      }
      rows.set(transfer.identity, {
        identity: transfer.identity, signature: tx.signature, network: tx.network, wallet,
        blockTime: tx.evidence.blockTime ?? null, mint: transfer.mint.value, decimals: transfer.decimals.value,
        grossRaw: transfer.grossAmountRaw, netRaw: transfer.netCreditRaw, status, reasons: [...new Set(reasons)], basis,
        version: CLASSIFIER_VERSION, evidenceIds: evidence.transactionObservationIds ?? evidence.transactions.map(t => t.provenance.evidenceId), supportingSignatures: supports,
        sourceAccount: transfer.source, sourceOwner: transfer.sourceOwner.value, authority: transfer.authority,
        recipient: transfer.destination, destinationOwner: transfer.destinationOwner.value,
        feePayer: tx.evidence.transaction.message.accountKeys[0]?.pubkey ?? null,
        program: transfer.programId, signers: tx.signers, authorityEvidence, attributionEvidence,
        temporalScope: basis === 'official_feed' ? 'exact_transaction' : basis === 'same_slot_pattern' ? 'same_slot_bracket'
          : basis === 'verified_historical_authority' ? 'witness_bounded_epoch' : basis === 'distributor_pattern' ? 'identity_attributed' : 'unestablished',
      });
    }
    if (related.length === 0 && tx.transfers.length === 0) {
      const identity = `transaction:${tx.network}:${tx.signature}`;
      // Native-SOL lane: a lamport-only credit that a trusted distributor identity funds and signs.
      // Reached only after the quarantine and exclusion checks above, and never excluded afterwards.
      const lane = conflict || tx.failedTransaction || tx.signers.includes(wallet) ? null
        : nativeDistributorPattern(tx, wallet, attribution);
      const attributed = lane?.outcome.evidence ?? null;
      const owner = lane?.owner ?? null;
      // The RPC emits a token-balance row for every token account a transaction touches, so the
      // absence of a wallet-owned row in both phases establishes that no token moved for this wallet.
      // The rows themselves are the evidence: a contradicted owner consensus is an unresolved
      // observation, not an absent one, and must never be read as proof that nothing was credited.
      const walletRows = [...tx.evidence.meta.preTokenBalances, ...tx.evidence.meta.postTokenBalances]
        .filter(item => item.owner === wallet);
      const keys = tx.evidence.transaction.message.accountKeys;
      const zeroValueCredit = walletRows.length > 0 && walletRows.every(item => {
        const address = keys[item.accountIndex]?.pubkey;
        const account = address === undefined ? undefined : tx.accounts.find(entry => entry.address === address);
        return account?.createdInTransaction === true && account.pre.length === 0 && account.post.length === 1
          && BigInt(account.post[0]!.uiTokenAmount.amount) === 0n;
      });
      const excludedWithoutCredit = lane === null && (walletRows.length === 0 || zeroValueCredit);
      rows.set(identity, {
        identity, signature: tx.signature, network: tx.network, wallet,
        blockTime: tx.evidence.blockTime ?? null,
        mint: attributed ? NATIVE_SOL_MINT : null, decimals: attributed ? NATIVE_SOL_DECIMALS : null,
        grossRaw: attributed ? lane!.lamports : null, netRaw: attributed ? lane!.lamports : null,
        status: tx.failedTransaction || tx.signers.includes(wallet) ? 'excluded'
          : attributed ? 'attributed' : conflict || !excludedWithoutCredit ? 'unknown_candidate' : 'excluded',
        reasons: conflict ? ['conflicting_evidence_quarantined'] : tx.failedTransaction ? ['failed_transaction']
          : tx.signers.includes(wallet) ? ['wallet_participation']
            : attributed ? ['trusted_distributor_pattern_and_proven_credit']
              : lane ? ['native_credit_from_distributor_unproven', ...lane.outcome.reasons ?? []]
                : walletRows.length === 0 ? ['no_token_credit_to_wallet']
                  : zeroValueCredit ? ['zero_value_token_credit'] : ['credit_without_supported_transfer_instruction'],
        basis: attributed ? 'distributor_pattern' : null,
        version: CLASSIFIER_VERSION, evidenceIds: evidence.transactionObservationIds ?? evidence.transactions.map(t => t.provenance.evidenceId),
        supportingSignatures: attributed?.witnesses?.signatures ?? [],
        sourceAccount: attributed ? owner : null, sourceOwner: attributed ? owner : null, authority: attributed ? owner : null,
        recipient: attributed ? wallet : null, destinationOwner: attributed ? wallet : null,
        feePayer: tx.evidence.transaction.message.accountKeys[0]?.pubkey ?? null,
        program: attributed ? SYSTEM_PROGRAM : null, signers: tx.signers,
        authorityEvidence: null, attributionEvidence: attributed,
        temporalScope: attributed ? 'identity_attributed' : 'unestablished',
      });
    }
  }
  return [...rows.values()];
}

/** Two passes ensure new same-slot witnesses are available without lifetime history recomputation. */
export function processDirty(store: RewardsStore, network: NormalizedTransaction['network'], limit = 1000): number {
  // Queue acknowledgement and every derived write must commit together, also for offline callers.
  return store.atomic(() => processDirtyBatch(store, network, limit));
}
function processDirtyBatch(store: RewardsStore, network: NormalizedTransaction['network'], limit: number): number {
  const signatures = store.dirty(network, limit);
  const work = signatures.map(signature => ({ signature, evidence: store.evidence(network, signature) }));
  const reconciled = work.map(item => ({ ...item, result: analyzeStored(item.evidence) }));
  for (const { signature, evidence, result } of reconciled) {
    const tx = evidence.transactions[0];
    store.saveAuthorities(network, signature, !tx || evidence.overflow ? [] : result.authorityPatterns.map(pattern => ({
      signature, slot: tx.evidence.slot, transactionIndex: tx.evidence.transactionIndex ?? null, pattern,
      evidenceIds: [...new Set([...(evidence.transactionObservationIds ?? evidence.transactions.map(item => item.provenance.evidenceId)),
        ...evidence.feeds.map(feed => feed.provenance.evidenceId)])].sort(),
    })));
    store.saveIdentityConflicts(network, signature, identityConflicts(evidence, result));
  }
  // All batch witnesses have been refreshed; make them visible to the second pass atomically.
  for (const { signature } of reconciled) store.clean(network, signature);
  const authorityHistory = store.authorityHistory(network);
  const revocations = store.authorityRevocations(network);
  const attribution = attributionContext({ network, authorityHistory, identityConflicts: store.identityConflicts(network),
    snapshots: store.withdrawalSnapshots(network), revocations: store.attributionRevocations(network), launchMints: store.retainedLaunchMints(network) });
  for (const { signature, evidence, result } of reconciled) {
    const metadata = new Map(evidence.transactions.flatMap(tx => tx.transfers.flatMap(t => t.mint.value
      ? [[t.mint.value, store.quote(network, t.mint.value)] as const] : [])));
    const quotes = new Set([...metadata].filter(([, value]) => value !== undefined).map(([mint]) => mint));
    const historicalQuotes = new Set([...metadata].filter(([, value]) => value?.membershipEvidence?.some(item =>
      item.kind === 'launch' || item.kind === 'rewardSummary' || item.kind === 'distribution')).map(([mint]) => mint));
    const slot = evidence.transactions[0]?.evidence.slot;
    for (const wallet of store.watchers(network, signature)) {
      store.saveClassifications(network, signature, wallet,
        classifyReconciled(evidence, wallet, quotes, slot === undefined ? [] : authorityHistory, result, revocations, historicalQuotes, attribution));
    }
  }
  return signatures.length;
}
