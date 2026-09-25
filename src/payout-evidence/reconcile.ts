import { groupCreditIdentities } from '../normalization/identity.js';
import { TOKEN_2022_PROGRAM } from '../normalization/normalizer.js';
import type { InstructionPosition, NormalizedTransaction, NormalizedTransfer, SolanaNetwork } from '../normalization/types.js';
import type {
  DistributionReconciliation, MintEvidenceComparison, PayoutAuthorityPattern, PayoutEvidenceInput,
  PayoutEvidenceReason, PayoutEvidenceResult, PayoutEvidenceState, PayoutPolicyVersion, ReconciledDistributionRow,
  TransactionEvidenceComparison,
} from './types.js';
import { canonical, retainedInputs, unique } from './validation.js';
import { supportedComputePositions } from './compute-budget.js';
import { nativeBalances } from './native-payout.js';
import type { NativeTransferEvidence } from './native-payout.js';

const key = (network: SolanaNetwork, signature: string) => JSON.stringify([network, signature]);
const position = (value: InstructionPosition) => `${value.outer}:${value.inner ?? 'outer'}`;
const reasons = (values: PayoutEvidenceReason[]) => [...new Set(values)].sort();
const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString();

function sourceSupported(row: ReconciledDistributionRow, state: PayoutEvidenceState, feedIndexes: number[]): boolean {
  const observations = row.observations.filter(item => feedIndexes.includes(item.feedIndex));
  return observations.length > 0 && observations.every(item => {
    const feed = state.feeds[item.feedIndex]!;
    return item.sourceIds.length > 0 && item.sourceIds.every(id => {
      const sources = unique(feed.sources.filter(source => source.id === id));
      return sources.length === 1 && sources[0]!.source === 'rewards'
        && sources[0]!.outcome === 'success' && sources[0]!.failure === undefined
        && sources[0]!.attempts > 0
        && (sources[0]!.httpStatus === undefined || (sources[0]!.httpStatus >= 200 && sources[0]!.httpStatus < 300))
        && /^\/rewards\?limit=\d+$/.test(sources[0]!.endpoint);
    });
  });
}

function conflictingLaunches(rows: ReconciledDistributionRow[]): Set<string> {
  const launches = new Map<string, number>();
  for (const row of rows) launches.set(row.value.mint, (launches.get(row.value.mint) ?? 0) + 1);
  return new Set([...launches].filter(([, count]) => count > 1).map(([mint]) => mint));
}

/**
 * A deliberately narrow payout-only structure: parsed token transfers and fee-only SOL movement.
 * A `native` batch, supplied only by the native-SOL lane, replaces the token payout with decoded
 * System transfers: their positions are interpreted structure and their lamports are the expected
 * movement. Every other reason, including any other uninterpreted instruction, still applies.
 */
export function payoutStructure(tx: NormalizedTransaction, policyVersion: PayoutPolicyVersion = 'payout-evidence-v3',
  native: readonly NativeTransferEvidence[] | null = null): PayoutEvidenceReason[] {
  const found: PayoutEvidenceReason[] = [];
  const creations = policyVersion === 'payout-evidence-v3' ? tx.accountCreations ?? [] : [];
  const batch = policyVersion === 'payout-evidence-v3' && native?.length ? native : [];
  // Exactly the positions the decoded evidence names: supported compute-budget settings, and the
  // two instructions a recognized creation unit is made of. Never a blanket suppression.
  const exempt = new Set<string>();
  if (policyVersion !== 'payout-evidence-v1') for (const index of supportedComputePositions(tx)) exempt.add(position({ outer: index, inner: null }));
  for (const creation of creations) {
    exempt.add(position(creation.position));
    if (creation.created) exempt.add(position(creation.created.position));
  }
  for (const item of batch) exempt.add(position(item.position));
  const issues = tx.issues.filter(issue => !(issue.reason === 'uninterpreted_instruction'
    && issue.position !== undefined && exempt.has(position(issue.position))));
  if (tx.failedTransaction) found.push('failed_transaction');
  if (tx.transfers.length === 0 && batch.length === 0) found.push('no_supported_transfers');
  if (issues.length > 0 || tx.accounts.some(account => account.reasons.length > 0)) found.push('unresolved_normalization');
  if (issues.some(issue => issue.reason === 'uninterpreted_instruction')) found.push('uninterpreted_activity');
  const balances = nativeBalances.safeParse(tx.evidence.meta);
  const keys = tx.evidence.transaction.message.accountKeys;
  // Each recognized rent funding is expected to leave its named source and arrive at the account the
  // unit created, with no tolerance and no netting: an unrelated movement still breaks one index.
  const expected = new Map<number, bigint>();
  let explained = true;
  const move = (address: string, amount: bigint) => {
    const index = keys.findIndex(item => item.pubkey === address);
    if (index < 0 || index === 0) { explained = false; return; }
    expected.set(index, (expected.get(index) ?? 0n) + amount);
  };
  for (const creation of creations) {
    if (!creation.created) continue;
    const index = keys.findIndex(item => item.pubkey === creation.source);
    if (index < 0) { explained = false; continue; }
    expected.set(index, (expected.get(index) ?? 0n) - BigInt(creation.created.lamports));
    move(creation.account, BigInt(creation.created.lamports));
  }
  for (const item of batch) {
    const index = keys.findIndex(entry => entry.pubkey === item.source);
    if (index < 0) { explained = false; continue; }
    expected.set(index, (expected.get(index) ?? 0n) - BigInt(item.lamports));
    move(item.destination, BigInt(item.lamports));
  }
  if (!explained || !balances.success || !keys[0]?.signer
    || balances.data.preBalances.length !== keys.length || balances.data.postBalances.length !== keys.length
    || balances.data.preBalances.some((pre, index) => BigInt(balances.data.postBalances[index]!) - BigInt(pre)
      !== (index === 0 ? -BigInt(balances.data.fee) : 0n) + (expected.get(index) ?? 0n))) {
    found.push('unexplained_native_movement');
  }
  const sourceOwners = new Set(tx.transfers.map(transfer => transfer.sourceOwner.value));
  const sources = new Set(tx.transfers.map(transfer => transfer.source));
  const mintSources = new Map<string, Set<string>>();
  for (const transfer of tx.transfers) {
    if (transfer.netCreditRaw === null || BigInt(transfer.netCreditRaw) <= 0n) found.push('unproven_net_credit');
    if (transfer.destinationOwner.value === null || transfer.sourceOwner.value === null
      || sourceOwners.has(transfer.destinationOwner.value) || sources.has(transfer.destination)
      || transfer.flags.sameAccount) found.push('ambiguous_attribution');
    if (transfer.destinationOwner.value !== null && tx.signers.includes(transfer.destinationOwner.value)) {
      found.push('recipient_participation');
    }
    if (transfer.authorityKind === 'single' ? !tx.signers.includes(transfer.authority)
      : transfer.instructionSigners.length === 0 || transfer.instructionSigners.some(signer => !tx.signers.includes(signer))) {
      found.push('unsupported_authority_pattern');
    }
    if (transfer.mint.value !== null) {
      const identities = mintSources.get(transfer.mint.value) ?? new Set<string>();
      identities.add(canonical([transfer.source, transfer.sourceOwner.value, transfer.authority,
        transfer.authorityKind, transfer.instructionSigners, transfer.programId]));
      mintSources.set(transfer.mint.value, identities);
    }
  }
  // Feed rows have no source-to-launch allocation. Multiple origins for one mint need more evidence.
  if ([...mintSources.values()].some(origins => origins.size > 1)) found.push('ambiguous_attribution');
  return reasons(found);
}

function compare(
  state: PayoutEvidenceState, rows: ReconciledDistributionRow[], rowIndexes: number[],
  feedIndexes: number[], transactionIndex: number,
): TransactionEvidenceComparison {
  const tx = state.transactions[transactionIndex]!;
  const selected = rowIndexes.map(index => rows[index]!);
  const conflicts = conflictingLaunches(selected);
  const found = payoutStructure(tx, state.policyVersion);
  if (selected.length === 0) found.push('missing_official_distribution');
  if (conflicts.size > 0) found.push('conflicting_feed_rows');
  if (selected.some(row => !sourceSupported(row, state, feedIndexes))) found.push('feed_provenance_unresolved');
  const mints = [...new Set([...selected.map(row => row.value.quoteMint),
    ...tx.transfers.flatMap(transfer => transfer.mint.value === null ? [] : [transfer.mint.value])])].sort();
  const comparisons: MintEvidenceComparison[] = mints.map(quoteMint => {
    const mintRows = rowIndexes.filter(index => rows[index]!.value.quoteMint === quoteMint);
    const transfers = tx.transfers.filter(transfer => transfer.mint.value === quoteMint);
    const mintReasons: PayoutEvidenceReason[] = [];
    const conflict = mintRows.some(index => conflicts.has(rows[index]!.value.mint));
    const feedTotalRaw = conflict || mintRows.length === 0 ? null : sum(mintRows.map(index => rows[index]!.value.amountRaw));
    const grossInstructionTotalRaw = sum(transfers.map(transfer => transfer.grossAmountRaw));
    const provenNetCreditTotalRaw = transfers.some(transfer => transfer.netCreditRaw === null)
      ? null : sum(transfers.map(transfer => transfer.netCreditRaw!));
    if (conflict) mintReasons.push('conflicting_feed_rows');
    if (selected.length > 0 && (mintRows.length === 0 || transfers.length === 0)) mintReasons.push('mint_mismatch');
    const feeBearing = transfers.some(transfer => transfer.programId === TOKEN_2022_PROGRAM);
    // No supported source defines amountRaw's fee semantics, even if this sample's fee is zero.
    if (feeBearing && state.policyVersion === 'payout-evidence-v1') mintReasons.push('feed_fee_semantics_unresolved');
    if (provenNetCreditTotalRaw === null) mintReasons.push('unproven_net_credit');
    const feedEqualsGross = feedTotalRaw === null ? null : BigInt(feedTotalRaw) === BigInt(grossInstructionTotalRaw);
    const feedEqualsNet = feedTotalRaw === null || provenNetCreditTotalRaw === null
      ? null : BigInt(feedTotalRaw) === BigInt(provenNetCreditTotalRaw);
    if (feedEqualsGross === false && (!feeBearing || feedEqualsNet === false)) mintReasons.push('amount_mismatch');
    found.push(...mintReasons);
    return { quoteMint, rowIndexes: mintRows, transferIdentities: unique(transfers.map(transfer => transfer.identity)),
      feedTotalRaw, grossInstructionTotalRaw, provenNetCreditTotalRaw, feedEqualsGross, feedEqualsNet,
      basis: 'exact_signature_and_mint_aggregate', feedAmountSemantics: 'not_established', reasons: reasons(mintReasons) };
  });
  return { transactionIndex, mints: comparisons, reasons: reasons(found) };
}

function addWitness(
  patterns: Map<string, PayoutAuthorityPattern>, state: PayoutEvidenceState, group: DistributionReconciliation,
  transfer: NormalizedTransfer, transactionIndexes: number[], rowIndexes: number[], feedIndexes: number[],
) {
  const tx = state.transactions[transactionIndexes[0]!]!;
  const fields = {
    network: tx.network, transferAuthority: transfer.authority, authorityKind: transfer.authorityKind,
    instructionSigners: [...transfer.instructionSigners].sort(), sourceTokenAccount: transfer.source,
    observedSourceOwner: transfer.sourceOwner.value!, tokenProgram: transfer.programId, quoteMint: transfer.mint.value!,
    transactionSigners: [...tx.signers].sort(), feePayer: tx.evidence.transaction.message.accountKeys[0]!.pubkey,
  };
  const patternId = canonical(['stonkfun-observed-payout-pattern', 1, fields]);
  const retrieved = [
    ...transactionIndexes.map(index => state.transactions[index]!.provenance.retrievedAt),
    ...feedIndexes.flatMap(index => [state.feeds[index]!.provenance.retrievedAt,
      ...rowIndexes.flatMap(rowIndex => group.rows[rowIndex]!.observations
        .filter(observation => observation.feedIndex === index)
        .flatMap(observation => state.feeds[index]!.sources.filter(source => observation.sourceIds.includes(source.id))
          .map(source => source.retrievedAt)))]),
  ].map(value => new Date(value).toISOString()).sort();
  let pattern = patterns.get(patternId);
  if (!pattern) {
    pattern = { patternId, ...fields, observations: [], status: 'supported_observations',
      firstObservedPayoutTime: null, lastObservedPayoutTime: null,
      firstRetrievedAt: retrieved[0]!, lastRetrievedAt: retrieved.at(-1)!, validity: 'observed_transactions_only' };
    patterns.set(patternId, pattern);
  }
  pattern.firstRetrievedAt = [pattern.firstRetrievedAt, ...retrieved].sort()[0]!;
  pattern.lastRetrievedAt = [pattern.lastRetrievedAt, ...retrieved].sort().at(-1)!;
  const launchMints = unique(rowIndexes.filter(index => group.rows[index]!.value.quoteMint === transfer.mint.value)
    .map(index => group.rows[index]!.value.mint)).sort();
  // An observation is an individual credit variant, not a retrieval and not a launch row.
  let observation = pattern.observations.find(item => item.identity === transfer.identity
    && item.recipientTokenAccount === transfer.destination && item.recipientOwner === transfer.destinationOwner.value
    && item.grossAmountRaw === transfer.grossAmountRaw && item.netCreditRaw === transfer.netCreditRaw);
  if (!observation) {
    observation = { identity: transfer.identity, signature: tx.signature,
      status: group.status === 'reconciled' ? 'supported' : 'contested', reasons: [...group.reasons],
      position: { ...transfer.position }, recipientTokenAccount: transfer.destination,
      recipientOwner: transfer.destinationOwner.value!, grossAmountRaw: transfer.grossAmountRaw,
      netCreditRaw: transfer.netCreditRaw!, netCreditBasis: transfer.netCreditBasis,
      observedPayoutTimes: [], launchMints: [], launchAssociation: 'signature_and_quote_mint_only',
      perLaunchAllocation: 'not_established', witnesses: [] };
    pattern.observations.push(observation);
  }
  observation.launchMints = unique([...observation.launchMints, ...launchMints]).sort();
  const blockTime = tx.evidence.blockTime;
  if (blockTime !== null && blockTime !== undefined) {
    observation.observedPayoutTimes = unique([...observation.observedPayoutTimes, blockTime]).sort((a, b) => a - b);
  }
  observation.witnesses = unique([...observation.witnesses, { transactionIndexes, rowIndexes, feedIndexes }]);
}

/** Pure evidence reconciliation. No authority allowlist, classifier, I/O, or wall-clock reads. */
export function reconcilePayoutEvidence(input: PayoutEvidenceInput): PayoutEvidenceResult {
  const state = retainedInputs(input);
  const identityGroups = groupCreditIdentities(state.transactions);
  const groups = new Map<string, DistributionReconciliation>();
  function groupFor(network: SolanaNetwork, signature: string): DistributionReconciliation {
    const id = key(network, signature);
    let group = groups.get(id);
    if (!group) {
      group = { network, signature, status: 'unresolved', rows: [], transactionIndexes: [],
        identityKeys: [], comparisons: [], reasons: [] };
      groups.set(id, group);
    }
    return group;
  }
  state.feeds.forEach((feed, feedIndex) => {
    for (const distribution of feed.distributions) {
      const group = groupFor(feed.network, distribution.signature);
      for (const row of distribution.rows) {
        let entry = group.rows.find(item => canonical(item.value) === canonical(row.value));
        if (!entry) { entry = { value: row.value, observations: [] }; group.rows.push(entry); }
        const observation = entry.observations.find(item => item.feedIndex === feedIndex);
        if (observation) observation.sourceIds = unique([...observation.sourceIds, ...row.sourceIds]).sort();
        else entry.observations.push({ feedIndex, sourceIds: unique(row.sourceIds).sort() });
      }
    }
  });
  state.transactions.forEach((tx, index) => groupFor(tx.network, tx.signature).transactionIndexes.push(index));
  const patterns = new Map<string, PayoutAuthorityPattern>();
  for (const group of groups.values()) {
    const allRows = group.rows.map((_, index) => index);
    const allFeeds = unique(group.rows.flatMap(row => row.observations.map(item => item.feedIndex))).sort((a, b) => a - b);
    const identities = identityGroups.filter(identity => identity.observations.some(item => group.transactionIndexes.includes(item.resultIndex)));
    group.identityKeys = identities.map(identity => identity.identity);
    if (group.rows.length === 0) group.reasons.push('missing_official_distribution');
    if (group.transactionIndexes.length === 0) group.reasons.push('missing_transaction');
    if (conflictingLaunches(group.rows).size > 0) group.reasons.push('conflicting_feed_rows');
    if (group.rows.some(row => !sourceSupported(row, state, allFeeds))) group.reasons.push('feed_provenance_unresolved');
    if (identities.some(identity => identity.status === 'conflicting')) group.reasons.push('conflicting_identity_evidence');
    if (identities.some(identity => identity.missingTransferObservations.length > 0)) group.reasons.push('missing_transfer_observation');
    const variants = new Map<string, number[]>();
    for (const index of group.transactionIndexes) {
      const tx = state.transactions[index]!;
      const fingerprint = canonical({ wallet: tx.wallet, evidence: tx.evidence });
      variants.set(fingerprint, [...variants.get(fingerprint) ?? [], index]);
      group.comparisons.push(compare(state, group.rows, allRows, allFeeds, index));
    }
    if (variants.size > 1) group.reasons.push('conflicting_transaction_evidence');
    group.reasons = reasons([...group.reasons, ...group.comparisons.flatMap(item => item.reasons)]);
    group.status = group.reasons.length === 0 ? 'reconciled' : 'unresolved';

    // Preserve support witnesses from earlier complete snapshots even after contradictory input.
    // Every witness is independently rechecked from retained inputs; no prior derived trust is used.
    const subsets = unique([{ rowIndexes: allRows, feedIndexes: allFeeds }, ...allFeeds.map(feedIndex => ({
      rowIndexes: allRows.filter(index => group.rows[index]!.observations.some(item => item.feedIndex === feedIndex)),
      feedIndexes: [feedIndex],
    }))]);
    for (const transactionIndexes of variants.values()) {
      for (const subset of subsets) {
        const comparison = compare(state, group.rows, subset.rowIndexes, subset.feedIndexes, transactionIndexes[0]!);
        if (comparison.reasons.length > 0) continue;
        for (const transfer of state.transactions[transactionIndexes[0]!]!.transfers) {
          addWitness(patterns, state, group, transfer, transactionIndexes, subset.rowIndexes, subset.feedIndexes);
        }
      }
    }
  }
  for (const pattern of patterns.values()) {
    const times = pattern.observations.flatMap(item => item.observedPayoutTimes).sort((a, b) => a - b);
    pattern.firstObservedPayoutTime = times[0] ?? null;
    pattern.lastObservedPayoutTime = times.at(-1) ?? null;
    const supported = pattern.observations.some(item => item.status === 'supported');
    const contested = pattern.observations.some(item => item.status === 'contested');
    pattern.status = supported && contested ? 'mixed_observations' : contested ? 'contested_observations' : 'supported_observations';
  }
  return { schemaVersion: 1, policyVersion: state.policyVersion, classification: 'not_performed', state,
    identityGroups, reconciliations: [...groups.values()], authorityPatterns: [...patterns.values()],
    withdrawalConfiguration: state.feeds.flatMap((feed, feedIndex) => feed.withdrawalAuthorities.map(evidence => ({
      network: feed.network, feedIndex, evidence, payoutVerification: 'not_provided' as const,
    }))),
  };
}
