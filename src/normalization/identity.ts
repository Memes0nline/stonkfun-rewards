import type { CreditIdentityGroup, InstructionPosition, NormalizedTransaction, SolanaNetwork } from './types.js';

export function individualCreditIdentity(
  network: SolanaNetwork, signature: string, position: InstructionPosition, recipientOrdinal = 0,
): string {
  if (!['mainnet-beta', 'devnet', 'testnet'].includes(network)
    || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)
    || !Number.isSafeInteger(position.outer) || position.outer < 0
    || (position.inner !== null && (!Number.isSafeInteger(position.inner) || position.inner < 0))
    || !Number.isSafeInteger(recipientOrdinal) || recipientOrdinal < 0) {
    throw new Error('Invalid individual-credit identity input');
  }
  // Recipient slot, not mutable recipient metadata, detects contradictory destinations.
  return JSON.stringify(['solana-token-credit', 1, network, signature, position.outer, position.inner, recipientOrdinal]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Pure review grouping. A difference requires review, even if it is only enrichment. */
export function groupCreditIdentities(results: readonly NormalizedTransaction[]): CreditIdentityGroup[] {
  const groups = new Map<string, CreditIdentityGroup>();
  const fingerprints = new Map<string, { transaction: string; transfer: string }>();
  const transactions = new Map<string, { resultIndexes: number[]; groups: Set<CreditIdentityGroup> }>();
  results.forEach((result, resultIndex) => {
    const transactionKey = JSON.stringify([result.network, result.signature]);
    let transaction = transactions.get(transactionKey);
    if (!transaction) {
      transaction = { resultIndexes: [], groups: new Set() };
      transactions.set(transactionKey, transaction);
    }
    transaction.resultIndexes.push(resultIndex);
    const transactionGroups = transaction.groups;
    // Serialize shared transaction evidence once, not once per credit in a large batch.
    // Comparing the two components preserves the former canonical object equality exactly.
    const transactionFingerprint = canonical({ evidence: result.evidence, wallet: result.wallet });
    result.transfers.forEach((transfer, transferIndex) => {
      // Provenance is deliberately excluded; all transaction evidence and wallet context count.
      const fingerprint = { transaction: transactionFingerprint, transfer: canonical(transfer) };
      const previous = fingerprints.get(transfer.identity);
      let group = groups.get(transfer.identity);
      if (!group) {
        group = { identity: transfer.identity, status: 'single', reason: null,
          observations: [], missingTransferObservations: [] };
        groups.set(transfer.identity, group);
        fingerprints.set(transfer.identity, fingerprint);
      } else if (previous?.transaction !== fingerprint.transaction || previous.transfer !== fingerprint.transfer
        || group.observations.some(observation => observation.resultIndex === resultIndex)) {
        group.status = 'conflicting';
        group.reason = 'conflicting_identity_evidence';
      } else if (group.status !== 'conflicting') group.status = 'repeated';
      group.observations.push({ resultIndex, transferIndex, transfer });
      transactionGroups.add(group);
    });
  });
  // Check absence after discovering every identity so input order cannot hide a conflict.
  for (const transaction of transactions.values()) {
    for (const group of transaction.groups) {
      const presentResults = new Set(group.observations.map(observation => observation.resultIndex));
      for (const resultIndex of transaction.resultIndexes) {
        if (!presentResults.has(resultIndex)) group.missingTransferObservations.push({ resultIndex });
      }
      if (group.missingTransferObservations.length > 0) {
        group.status = 'conflicting';
        group.reason = 'conflicting_identity_evidence';
      }
    }
  }
  return [...groups.values()];
}
