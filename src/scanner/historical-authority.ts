import { createHash } from 'node:crypto';
import type { NormalizedTransaction, NormalizedTransfer } from '../normalization/types.js';
import { payoutStructure } from '../payout-evidence/reconcile.js';
import { canonical } from '../payout-evidence/validation.js';
import { AUTHORITY_MODEL_VERSION } from './types.js';
import type { AuthorityObservation, AuthorityRevocation, Classification } from './types.js';

type EpochEvidence = NonNullable<Classification['authorityEvidence']>;
type Witness = { signature: string; time: number; evidenceIds: string[]; observation: AuthorityObservation };
// A long silent interval cannot establish that an observed distributor remained active.
const MAX_WITNESS_SPAN_SECONDS = 86400;

export function witnessTime(item: AuthorityObservation, requireSupported = true): number | null {
  const times = [...new Set(item.pattern.observations
    .filter(observation => observation.signature === item.signature && (!requireSupported || observation.status === 'supported'))
    .flatMap(observation => observation.observedPayoutTimes))];
  return times.length === 1 && Number.isSafeInteger(times[0]) ? times[0]! : null;
}

export function authorityIdentity(item: AuthorityObservation): string {
  const pattern = item.pattern;
  return canonical([AUTHORITY_MODEL_VERSION, pattern.network, pattern.transferAuthority,
    pattern.authorityKind, pattern.instructionSigners, pattern.sourceTokenAccount,
    pattern.observedSourceOwner, pattern.tokenProgram, pattern.quoteMint,
    pattern.transactionSigners, pattern.feePayer]);
}

function matches(tx: NormalizedTransaction, transfer: NormalizedTransfer, item: AuthorityObservation): boolean {
  const pattern = item.pattern;
  return pattern.status === 'supported_observations' && pattern.network === tx.network
    && pattern.transferAuthority === transfer.authority && pattern.sourceTokenAccount === transfer.source
    && pattern.observedSourceOwner === transfer.sourceOwner.value && pattern.quoteMint === transfer.mint.value
    && pattern.tokenProgram === transfer.programId && pattern.authorityKind === transfer.authorityKind
    && canonical(pattern.instructionSigners) === canonical([...transfer.instructionSigners].sort())
    && canonical(pattern.transactionSigners) === canonical([...tx.signers].sort())
    && pattern.feePayer === tx.evidence.transaction.message.accountKeys[0]?.pubkey;
}

/** A verified identity has only an interior observed interval. Unobserved edges stay unresolved. */
export function historicalAuthority(
  tx: NormalizedTransaction, transfer: NormalizedTransfer, witnesses: readonly AuthorityObservation[], wallet: string,
  revocations: readonly AuthorityRevocation[] = [],
): EpochEvidence | null {
  const time = tx.evidence.blockTime;
  if (time === null || time === undefined || !Number.isSafeInteger(time) || tx.transfers.length === 0
    || tx.evidence.transaction.message.accountKeys.some(key => key.pubkey === wallet)
    || tx.transfers.some(item => item.sourceOwner.value === wallet || item.source === wallet
      || item.destination === wallet || item.authority === wallet || item.instructionSigners.includes(wallet))
    || payoutStructure(tx).length > 0) return null;
  const account = tx.accounts.find(item => item.address === transfer.destination);
  const incoming = tx.transfers.filter(item => item.destination === transfer.destination);
  if (!account || account.owner.value !== wallet || account.balanceChangeRaw === null
    || BigInt(account.balanceChangeRaw) <= 0n || transfer.netCreditRaw === null
    || transfer.netCreditBasis === null || transfer.decimals.value === null
    || !/^\d+$/.test(transfer.grossAmountRaw)
    || incoming.some(item => item.netCreditRaw === null)
    || BigInt(account.balanceChangeRaw) !== incoming.reduce((sum, item) => sum + BigInt(item.netCreditRaw!), 0n)) return null;
  const feePayer = tx.evidence.transaction.message.accountKeys[0]?.pubkey;
  const allowedSigners = new Set([feePayer, ...tx.transfers.flatMap(item => [item.authority, ...item.instructionSigners])]);
  if (tx.signers.some(signer => !allowedSigners.has(signer))) return null;

  const byPattern = new Map<string, Witness[]>();
  for (const observation of witnesses) {
    if (observation.signature === tx.signature || observation.pattern.network !== tx.network
      || observation.pattern.quoteMint !== transfer.mint.value
      || observation.pattern.status !== 'supported_observations') continue;
    const observed = witnessTime(observation);
    if (observed === null) continue;
    const key = authorityIdentity(observation);
    const list = byPattern.get(key) ?? [];
    list.push({ signature: observation.signature, time: observed,
      evidenceIds: [...new Set(observation.evidenceIds ?? [])].sort(), observation });
    byPattern.set(key, list);
  }
  const epochs = [...byPattern.values()].flatMap(items => {
    const distinct = [...new Map(items.map(item => [item.signature, item])).values()]
      .sort((a, b) => a.time - b.time || a.signature.localeCompare(b.signature));
    return distinct.slice(1).flatMap((item, index) => item.time > distinct[index]!.time
      && item.time - distinct[index]!.time <= MAX_WITNESS_SPAN_SECONDS ? [[distinct[index]!, item]] : []);
  });
  const active = epochs.filter(items => items[0]!.time < time && time < items.at(-1)!.time);
  if (active.length !== 1) return null;
  const epoch = active[0]!;
  const pattern = epoch[0]!.observation;
  if (epoch.some(item => !matches(tx, transfer, item.observation)
    || tx.transfers.some(other => !matches(tx, other, item.observation)))) return null;
  // A different witnessed payout identity in this mint during the proposed epoch
  // makes its rotation boundary ambiguous, including overlapping epoch intervals.
  if (witnesses.some(item => {
    if (item.pattern.network !== tx.network || item.pattern.quoteMint !== transfer.mint.value) return false;
    if (authorityIdentity(item) === authorityIdentity(pattern) && item.pattern.status === 'supported_observations') return false;
    const otherTime = witnessTime(item, false);
    return otherTime !== null && epoch[0]!.time <= otherTime && otherTime <= epoch.at(-1)!.time;
  }) || epochs.some(items => items !== epoch && items[0]!.time < time && time < items.at(-1)!.time)
    || revocations.some(item => item.modelVersion === AUTHORITY_MODEL_VERSION
      && item.patternId === authorityIdentity(pattern) && time >= item.effectiveFrom)) return null;
  const boundaries = [epoch[0]!, epoch.at(-1)!];
  const refs = boundaries.map(item => ({ signature: item.signature, evidenceIds: item.evidenceIds }));
  const epochId = createHash('sha256').update(canonical([
    AUTHORITY_MODEL_VERSION, tx.network, authorityIdentity(pattern),
    boundaries.map(item => [item.signature, item.time]),
  ])).digest('hex');
  return { modelVersion: AUTHORITY_MODEL_VERSION, epochId, patternId: authorityIdentity(pattern),
    validAfter: boundaries[0]!.time, validBefore: boundaries[1]!.time, witnesses: refs };
}
