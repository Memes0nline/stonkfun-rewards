import { describe, expect, it, vi } from 'vitest';
import {
  loadStonkFunRegistry, normalizeTransaction, reconcilePayoutEvidence, TOKEN_2022_PROGRAM,
} from '../src/index.js';
import type {
  NormalizationInput, PayoutEvidenceInput, PayoutEvidenceResult, PayoutEvidenceState,
} from '../src/index.js';
import { payoutStructure } from '../src/payout-evidence/reconcile.js';
import type { PayoutPolicyVersion } from '../src/payout-evidence/types.js';
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../src/normalization/associated-token.js';
import { addKey, key, setBalance, signature, transfer, wrapper } from './fixtures/normalization.js';
import {
  batch, createdRecipient, feed, launchA, launchB, moveLamports, payout, retrievedAt, rotate, row, withRent,
} from './fixtures/payout-evidence.js';
import { harness } from './helpers.js';
import { page } from './fixtures/stonkfun.js';

function run(input = payout(), evidence = feed([row(input)]), prior?: PayoutEvidenceState): PayoutEvidenceResult {
  return reconcilePayoutEvidence({ feeds: [evidence], transactions: [normalizeTransaction(input)], ...(prior ? { prior } : {}) });
}
function noSupport(result: PayoutEvidenceResult, reason: string) {
  expect(result.reconciliations[0]!.reasons).toContain(reason);
  expect(result.reconciliations[0]!.status).toBe('unresolved');
  expect(result.authorityPatterns.flatMap(pattern => pattern.observations).every(item => item.status === 'contested')).toBe(true);
}

describe('official distribution reconciliation (synthetic)', () => {
  it('reconciles a single credit, retaining independent roles, exact evidence and provenance', () => {
    const result = run();
    expect(result.classification).toBe('not_performed');
    expect(result.reconciliations[0]).toMatchObject({ status: 'reconciled', reasons: [], transactionIndexes: [0] });
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]).toMatchObject({
      feedTotalRaw: '100', grossInstructionTotalRaw: '100', provenNetCreditTotalRaw: '100',
      feedEqualsGross: true, feedEqualsNet: true, basis: 'exact_signature_and_mint_aggregate',
      feedAmountSemantics: 'not_established',
    });
    expect(result.authorityPatterns).toHaveLength(1);
    const pattern = result.authorityPatterns[0]!;
    expect(pattern).toMatchObject({ transferAuthority: key.authority, observedSourceOwner: key.otherOwner,
      sourceTokenAccount: key.source, transactionSigners: [key.authority], feePayer: key.authority,
      validity: 'observed_transactions_only', firstObservedPayoutTime: 1790000000, lastObservedPayoutTime: 1790000000,
      firstRetrievedAt: '2026-09-21T03:00:00.000Z', status: 'supported_observations' });
    expect(pattern.observations[0]).toMatchObject({ status: 'supported', signature, grossAmountRaw: '100', netCreditRaw: '100',
      position: { outer: 0, inner: null }, launchMints: [launchA], perLaunchAllocation: 'not_established',
      witnesses: [{ rowIndexes: [0], feedIndexes: [0], transactionIndexes: [0] }] });
    expect(result.state.feeds[0]!.sources[0]!.generatedAt).toBe(retrievedAt);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('consumes actual loader output with source IDs, without any live requests', async () => {
    const h = harness([{ path: '/launches', body: page(['F'], 1, 1, 100) },
      { path: '/launches', body: page(['F'], 1, 1, 100) },
      { path: '/rewards', body: { data: { launches: [], recentDistributions: [row(), row()] } } },
      { path: '/pairs', body: { data: { pairs: [] } } }]);
    const registry = await loadStonkFunRegistry({}, h.runtime);
    const result = run(payout(), { ...feed(), distributions: registry.distributions, sources: registry.sources,
      withdrawalAuthorities: registry.authorities.withdrawal });
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.reconciliations[0]!.rows[0]!.observations[0]!.sourceIds).toEqual(['source-3']);
    expect(h.remaining).toHaveLength(0);
  });

  it('reconciles a batch with overlapping launch recipients without count or allocation assumptions', () => {
    const input = batch();
    const result = run(input, feed([{ ...row(input, '100'), holderCount: 2 },
      { ...row(input, '50', launchB), holderCount: 2 }]));
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.reconciliations[0]!.rows).toHaveLength(2);
    expect(result.authorityPatterns[0]!.observations).toHaveLength(2);
    expect(result.authorityPatterns[0]!.observations.map(item => item.netCreditRaw)).toEqual(['100', '50']);
    for (const observation of result.authorityPatterns[0]!.observations) {
      expect(observation.launchMints).toEqual([launchA, launchB]);
      expect(observation.perLaunchAllocation).toBe('not_established');
    }
  });

  it('consolidates two launch rows into one recipient credit', () => {
    const result = run(payout(), feed([row(payout(), '60'), row(payout(), '40', launchB)]));
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.authorityPatterns[0]!.observations).toHaveLength(1);
    expect(result.authorityPatterns[0]!.observations[0]!.netCreditRaw).toBe('100');
  });

  it('retains identical-looking transfers at different instruction positions', () => {
    const input = payout();
    input.transaction.transaction.message.instructions.push(transfer());
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '300');
    const result = run(input, feed([row(input, '200')]));
    expect(result.authorityPatterns[0]!.observations).toHaveLength(2);
    expect(new Set(result.authorityPatterns[0]!.observations.map(item => item.identity)).size).toBe(2);
  });

  it('deduplicates exact rows independent of object order and preserves all source references', () => {
    const original = { ...row(), extension: { a: 1, b: 2 } };
    const evidence = feed([original, { ...row(), extension: { b: 2, a: 1 } }, original]);
    evidence.sources.push({ ...evidence.sources[0]!, id: 'source-2' });
    evidence.distributions[0]!.rows[1]!.sourceIds = ['source-2'];
    const result = run(payout(), evidence);
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.reconciliations[0]!.rows).toHaveLength(1);
    expect(result.reconciliations[0]!.rows[0]!.observations[0]!.sourceIds).toEqual(['source-1', 'source-2']);
    expect(result.authorityPatterns[0]!.observations).toHaveLength(1);
  });

  it.each([
    { amountRaw: '101' }, { amountRaw: '0100' }, { holderCount: 2 }, { quoteMint: key.otherMint },
    { distributedAt: '2026-09-20T02:00:00Z' }, { extension: 'different' },
  ])('retains conflicting same-launch rows: %j', change => {
    const result = run(payout(), feed([row(), { ...row(), ...change }]));
    noSupport(result, 'conflicting_feed_rows');
    expect(result.reconciliations[0]!.rows).toHaveLength(2);
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]!.feedTotalRaw).toBeNull();
    expect(result.authorityPatterns).toHaveLength(0);
  });

  it('does bigint accounting and keeps raw leading zeros and unsafe-number amounts', () => {
    const input = payout();
    const amount = '9007199254740993';
    input.transaction.transaction.message.instructions = [transfer('00' + amount)];
    setBalance(input, key.source, 'pre', amount); setBalance(input, key.source, 'post', '0');
    setBalance(input, key.recipient, 'pre', '0'); setBalance(input, key.recipient, 'post', amount);
    const result = run(input, feed([row(input, '000' + amount)]));
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.reconciliations[0]!.rows[0]!.value.amountRaw).toBe('000' + amount);
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]!.feedTotalRaw).toBe(amount);
    expect(result.authorityPatterns[0]!.observations[0]!.grossAmountRaw).toBe('00' + amount);
  });

  it.each(['99', '101', '184467440737095516159876543210123456789'])('withholds authority support for amount mismatch %s', amount => {
    const result = run(payout(), feed([row(payout(), amount)]));
    noSupport(result, 'amount_mismatch'); expect(result.authorityPatterns).toHaveLength(0);
  });
  it('compares by mint and never offsets mismatches across different mints', () => {
    const result = run(payout(), feed([{ ...row(), quoteMint: key.otherMint }]));
    noSupport(result, 'mint_mismatch');
    expect(result.reconciliations[0]!.comparisons[0]!.mints).toHaveLength(2);
  });

  it.each(['100', '97', '95'])('separates fee-bearing gross 100, net 97 and feed %s', amount => {
    const input = payout(TOKEN_2022_PROGRAM);
    input.transaction.transaction.message.instructions = [transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM, '3')];
    setBalance(input, key.recipient, 'post', '197');
    const result = run(input, feed([row(input, amount)]));
    noSupport(result, 'feed_fee_semantics_unresolved');
    expect(result.authorityPatterns).toHaveLength(0);
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]).toMatchObject({
      feedTotalRaw: amount, grossInstructionTotalRaw: '100', provenNetCreditTotalRaw: '97',
      feedEqualsGross: amount === '100', feedEqualsNet: amount === '97',
    });
  });
  it('leaves zero-fee Token-2022 feed semantics unresolved as well', () => {
    noSupport(run(payout(TOKEN_2022_PROGRAM)), 'feed_fee_semantics_unresolved');
  });
  it('does not allocate ambiguous fee credits', () => {
    const input = payout(TOKEN_2022_PROGRAM);
    input.transaction.transaction.message.instructions.push(transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM));
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '294');
    const result = run(input, feed([row(input, '200')]));
    noSupport(result, 'unproven_net_credit');
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]!.provenNetCreditTotalRaw).toBeNull();
  });
});

describe('versioned payout roles and historical evidence', () => {
  it('withdrawal configuration alone supplies no payout support', () => {
    const evidence = feed([]);
    evidence.withdrawalAuthorities = [{ role: 'withdrawWithheldAuthority', authority: key.authority,
      configurationQuoteMint: key.mint, sourceId: 'source-config' }];
    const result = reconcilePayoutEvidence({ feeds: [evidence], transactions: [] });
    expect(result.authorityPatterns).toEqual([]);
    expect(result.withdrawalConfiguration[0]).toMatchObject({ evidence: evidence.withdrawalAuthorities[0], payoutVerification: 'not_provided' });
    noSupport(run(payout(), evidence), 'missing_official_distribution');
  });

  it('keeps withdrawal, fee payer, extra signer, source owner and transfer authority separate', () => {
    const input = payout();
    input.transaction.transaction.message.accountKeys[11]!.signer = true;
    input.transaction.transaction.signatures.push('4'.repeat(88));
    // First account pays; the other signer authorizes the token transfer.
    input.transaction.transaction.message.instructions = [JSON.parse(JSON.stringify(transfer()).replaceAll(key.authority, key.cosigner)) as ReturnType<typeof transfer>];
    const evidence = feed();
    evidence.withdrawalAuthorities = [{ role: 'withdrawWithheldAuthority', authority: key.multisig,
      configurationQuoteMint: key.mint, sourceId: 'config' }];
    const result = run(input, evidence);
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.authorityPatterns).toHaveLength(1);
    expect(result.authorityPatterns[0]).toMatchObject({ transferAuthority: key.cosigner,
      observedSourceOwner: key.otherOwner, feePayer: key.authority, transactionSigners: [key.authority, key.cosigner] });
    expect(result.withdrawalConfiguration[0]!.evidence.authority).toBe(key.multisig);
  });

  it('requires evidence for a new authority and retains old observations across feed omission', () => {
    const first = run();
    const changed = rotate(payout(), 'H'.repeat(32), '4'.repeat(88), 1790100000);
    const absent = run(changed, feed([]), first.state);
    expect(absent.authorityPatterns).toHaveLength(1);
    const evidence = feed([row(changed)]); evidence.provenance.retrievedAt = changed.provenance.retrievedAt;
    const next = run(changed, evidence, first.state);
    expect(next.authorityPatterns).toHaveLength(2);
    expect(next.authorityPatterns.map(item => item.transferAuthority)).toEqual([key.authority, 'H'.repeat(32)]);
    expect(next.authorityPatterns[0]).toMatchObject({ firstObservedPayoutTime: 1790000000,
      lastObservedPayoutTime: 1790000000, validity: 'observed_transactions_only' });
    expect(next.authorityPatterns[1]!.firstObservedPayoutTime).toBe(1790100000);
    const omitted = reconcilePayoutEvidence({ feeds: [feed([])], transactions: [], prior: next.state });
    expect(omitted.authorityPatterns).toEqual(next.authorityPatterns);
  });

  it('coexisting authorities remain supported with distinct signatures', () => {
    const input = rotate(payout(), 'H'.repeat(32), '4'.repeat(88), 1790000000);
    const result = reconcilePayoutEvidence({ feeds: [feed([row(), row(input)])],
      transactions: [normalizeTransaction(payout()), normalizeTransaction(input)] });
    expect(result.authorityPatterns).toHaveLength(2);
    expect(result.authorityPatterns.every(item => item.status === 'supported_observations')).toBe(true);
  });

  it('observed time ranges span samples only, with retrieval times tracked separately', () => {
    const first = run();
    const input = rotate(payout(), key.authority, '4'.repeat(88), 1790600000);
    const result = run(input, feed([row(input)]), first.state);
    const pattern = result.authorityPatterns[0]!;
    expect(pattern.observations).toHaveLength(2);
    expect(pattern).toMatchObject({ firstObservedPayoutTime: 1790000000, lastObservedPayoutTime: 1790600000,
      firstRetrievedAt: '2026-09-21T03:00:00.000Z', lastRetrievedAt: '2026-09-22T03:00:00.000Z',
      validity: 'observed_transactions_only' });
    expect(pattern).not.toHaveProperty('validFrom'); expect(pattern).not.toHaveProperty('validUntil');
  });

  it('does not substitute feed/retrieval time for missing block time', () => {
    const input = payout(); input.transaction.blockTime = null;
    const pattern = run(input).authorityPatterns[0]!;
    expect(pattern.firstObservedPayoutTime).toBeNull(); expect(pattern.lastObservedPayoutTime).toBeNull();
    expect(pattern.observations[0]!.observedPayoutTimes).toEqual([]);
  });

  it('repeated evidence is idempotent and new provenance does not create extra payouts', () => {
    const first = run();
    expect(run(payout(), feed(), first.state)).toEqual(first);
    const input = payout(); input.provenance.evidenceId = 'retrieved-again'; input.provenance.retrievedAt = '2026-09-23T01:00:00Z';
    const evidence = feed(); evidence.provenance.evidenceId = 'feed-again';
    const next = run(input, evidence, first.state);
    expect(next.identityGroups[0]!.status).toBe('repeated');
    expect(next.authorityPatterns[0]!.observations).toHaveLength(1);
    expect(next.authorityPatterns[0]!.observations[0]!.witnesses[0]!.transactionIndexes).toEqual([0, 1]);
    expect(next.authorityPatterns[0]!.lastObservedPayoutTime).toBe(first.authorityPatterns[0]!.lastObservedPayoutTime);
    expect(next.authorityPatterns[0]!.lastRetrievedAt).toBe('2026-09-23T01:00:00.000Z');
  });

  it('retains previously supported roles as contested after conflicting feed evidence', () => {
    const first = run();
    const next = run(payout(), feed([row(payout(), '99')]), first.state);
    noSupport(next, 'conflicting_feed_rows');
    expect(next.authorityPatterns).toHaveLength(1);
    expect(next.authorityPatterns[0]!.observations[0]!.witnesses[0]!.feedIndexes).toEqual([0]);
    const repeated = run(payout(), feed(), next.state);
    expect(repeated.authorityPatterns[0]!.status).toBe('contested_observations');
    expect(repeated.reconciliations[0]!.rows).toHaveLength(2);
  });

  it('marks only the affected signature contested while keeping other observations', () => {
    const second = rotate(payout(), key.authority, '4'.repeat(88), 1790100000);
    const first = run(second, feed([row(second)]), run().state);
    const result = run(payout(), feed([row(payout(), '99')]), first.state);
    expect(result.authorityPatterns[0]!.status).toBe('mixed_observations');
    expect(result.authorityPatterns[0]!.observations.map(item => item.status)).toEqual(['contested', 'supported']);
  });
});

describe('unresolved, conflicting and unrelated evidence', () => {
  it('keeps missing transactions and unrelated transfers unresolved', () => {
    const missing = reconcilePayoutEvidence({ feeds: [feed()], transactions: [] });
    noSupport(missing, 'missing_transaction');
    noSupport(run(payout(), feed([])), 'missing_official_distribution');
  });
  it('failed transaction cannot support a payout role', () => {
    const input = payout(); input.transaction.meta.err = { InstructionError: [0, 'Custom'] };
    noSupport(run(input), 'failed_transaction');
  });

  it.each(['unsupported', 'empty', 'null-inner', 'one-missing'] as const)('retains missingTransferObservations for %s in both orders and after repeats', change => {
    const original = change === 'one-missing' ? batch() : payout();
    const altered = structuredClone(original);
    if (change === 'unsupported') altered.transaction.transaction.message.instructions[0] = {
      programId: original.transaction.transaction.message.instructions[0]!.programId,
      parsed: { type: 'burn', info: {} },
    };
    if (change === 'empty') altered.transaction.transaction.message.instructions = [];
    if (change === 'null-inner') {
      original.transaction.transaction.message.instructions = [wrapper()];
      original.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }];
      altered.transaction.transaction.message.instructions = [wrapper()]; altered.transaction.meta.innerInstructions = null;
    }
    if (change === 'one-missing') altered.transaction.transaction.message.instructions.pop();
    const present = normalizeTransaction(original), absent = normalizeTransaction(altered);
    for (const observations of [[present, absent], [absent, present], [present, absent, present]]) {
      const result = reconcilePayoutEvidence({ feeds: [feed([row(original, change === 'one-missing' ? '150' : '100')])], transactions: observations });
      noSupport(result, 'missing_transfer_observation');
      const group = result.identityGroups.find(item => item.missingTransferObservations.length > 0)!;
      expect(group.status).toBe('conflicting');
      const missing = group.missingTransferObservations[0]!;
      expect(result.state.transactions[missing.resultIndex]!.evidence).toEqual(absent.evidence);
      if (change !== 'null-inner') expect(result.authorityPatterns[0]!.status).toBe('contested_observations');
    }
  });

  it('preserves zero-transfer transaction contradictions without inventing identities', () => {
    const first = payout(); first.transaction.transaction.message.instructions = [];
    const second = structuredClone(first); second.transaction.meta.logMessages = ['changed'];
    const result = reconcilePayoutEvidence({ feeds: [feed()], transactions: [normalizeTransaction(first), normalizeTransaction(second)] });
    noSupport(result, 'conflicting_transaction_evidence'); expect(result.identityGroups).toEqual([]);
  });

  it('retains full transaction contradictions and does not clear prior conflicts', () => {
    const first = run();
    const input = payout(); input.transaction.meta.logMessages = ['different observation'];
    const next = run(input, feed(), first.state);
    noSupport(next, 'conflicting_identity_evidence');
    expect(next.authorityPatterns[0]!.observations).toHaveLength(1);
    expect(next.authorityPatterns[0]!.status).toBe('contested_observations');
    noSupport(run(payout(), feed(), next.state), 'conflicting_identity_evidence');
  });

  it.each(['swap', 'claim', 'LP'])('does not bootstrap from an uninterpreted %s wrapper with matching credits', label => {
    const input = payout();
    const instruction = wrapper(); instruction.program = label;
    input.transaction.transaction.message.instructions = [instruction];
    input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }];
    const tx = normalizeTransaction(input); expect(tx.transfers[0]!.netCreditRaw).toBe('100');
    const result = run(input); noSupport(result, 'uninterpreted_activity'); expect(result.authorityPatterns).toHaveLength(0);
  });

  it('blocks unsupported token operations and unexplained native movement', () => {
    const input = payout(); input.transaction.transaction.message.instructions.push({
      programId: transfer().programId, parsed: { type: 'mintTo', info: {} },
    });
    noSupport(run(input), 'unresolved_normalization');
    const native = payout(); (native.transaction.meta.postBalances as number[])[2]! += 1;
    noSupport(run(native), 'unexplained_native_movement');
  });

  it('requires complete native movement evidence', () => {
    const input = payout(); delete input.transaction.meta.preBalances;
    noSupport(run(input), 'unexplained_native_movement');
  });

  it('blocks reciprocal token flows even when all feed sums match', () => {
    const input = payout();
    input.transaction.transaction.message.instructions.push(transfer('40', key.recipient, key.source));
    setBalance(input, key.source, 'post', '940'); setBalance(input, key.recipient, 'post', '160');
    noSupport(run(input, feed([row(input, '140')])), 'ambiguous_attribution');
  });

  it('blocks recipient signers independently of the searched wallet', () => {
    const input = payout(); input.wallet = key.sink;
    input.transaction.transaction.message.accountKeys[6]!.signer = true;
    input.transaction.transaction.signatures.push('4'.repeat(88));
    noSupport(run(input), 'recipient_participation');
  });

  it('does not trust a non-signing direct transfer authority', () => {
    const input = payout();
    input.transaction.transaction.message.instructions = [JSON.parse(JSON.stringify(transfer()).replaceAll(key.authority, key.cosigner)) as ReturnType<typeof transfer>];
    noSupport(run(input), 'unsupported_authority_pattern');
  });

  it.each(['network', 'signature'] as const)('isolates official evidence by exact %s', isolation => {
    const input = payout();
    if (isolation === 'network') input.network = 'devnet';
    else input.transaction.transaction.signatures[0] = '4'.repeat(88);
    const result = run(input, feed());
    expect(result.reconciliations).toHaveLength(2);
    expect(result.authorityPatterns).toHaveLength(0);
    expect(result.reconciliations.map(item => item.reasons)).toEqual([
      ['missing_transaction'], expect.arrayContaining(['missing_official_distribution']),
    ]);
  });

  it('unrelated network/signature observations cannot contest a supported payout', () => {
    const a = payout(); a.network = 'devnet'; a.transaction.transaction.message.instructions = [];
    const b = payout(); b.transaction.transaction.signatures[0] = '4'.repeat(88); b.transaction.transaction.message.instructions = [];
    const result = reconcilePayoutEvidence({ feeds: [feed()], transactions: [normalizeTransaction(payout()), normalizeTransaction(a), normalizeTransaction(b)] });
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.authorityPatterns[0]!.status).toBe('supported_observations');
    expect(result.identityGroups[0]!.missingTransferObservations).toEqual([]);
  });

  it('the same signature on two explicitly attributed networks has independent roles and identities', () => {
    const other = payout(); other.network = 'testnet';
    const result = reconcilePayoutEvidence({ feeds: [feed(), feed([row(other)], 'testnet')],
      transactions: [normalizeTransaction(payout()), normalizeTransaction(other)] });
    expect(result.authorityPatterns).toHaveLength(2);
    expect(result.identityGroups).toHaveLength(2);
    expect(result.reconciliations.every(item => item.status === 'reconciled')).toBe(true);
  });

  it('keeps recipient alternatives at one identity contested, rather than producing two supported credits', () => {
    const original = payout(); const changed = payout();
    changed.transaction.transaction.message.instructions = [transfer('100', key.source, key.recipientB)];
    setBalance(changed, key.recipient, 'post', '100'); setBalance(changed, key.recipientB, 'post', '100');
    for (const transactions of [[original, changed], [changed, original]]) {
      const result = reconcilePayoutEvidence({ feeds: [feed()], transactions: transactions.map(normalizeTransaction) });
      expect(result.identityGroups).toHaveLength(1);
      noSupport(result, 'conflicting_identity_evidence');
      const observations = result.authorityPatterns[0]!.observations;
      expect(observations).toHaveLength(2);
      expect(new Set(observations.map(item => item.identity)).size).toBe(1);
      expect(observations.every(item => item.status === 'contested')).toBe(true);
    }
  });

  it('retains the existing conservative wallet-context conflict policy', () => {
    const other = payout(); other.wallet = key.sink;
    const result = reconcilePayoutEvidence({ feeds: [feed()], transactions: [normalizeTransaction(payout()), normalizeTransaction(other)] });
    noSupport(result, 'conflicting_identity_evidence');
    expect(result.authorityPatterns[0]!.observations).toHaveLength(1);
  });

  it('compares separate quote mints without inventing a cross-mint total', () => {
    const input = payout();
    for (const balances of [input.transaction.meta.preTokenBalances, input.transaction.meta.postTokenBalances]) {
      for (const balance of balances) if (balance.accountIndex === 3 || balance.accountIndex === 4) balance.mint = key.otherMint;
    }
    setBalance(input, key.sink, 'pre', '50'); setBalance(input, key.sink, 'post', '0');
    setBalance(input, key.recipientB, 'post', '50');
    const second = JSON.parse(JSON.stringify(transfer('50', key.sink, key.recipientB)).replaceAll(key.mint, key.otherMint)) as ReturnType<typeof transfer>;
    input.transaction.transaction.message.instructions.push(second);
    const result = run(input, feed([row(input), { ...row(input, '50', launchB), quoteMint: key.otherMint }]));
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.reconciliations[0]!.comparisons[0]!.mints.map(item => item.feedTotalRaw)).toEqual(['100', '50']);
    expect(result.authorityPatterns).toHaveLength(2);
    expect(result.authorityPatterns.map(item => item.observations[0]!.launchMints)).toEqual([[launchA], [launchB]]);
  });

  it('keeps multiple source origins for one mint unresolved despite matching totals', () => {
    const input = payout();
    setBalance(input, key.sink, 'pre', '50'); setBalance(input, key.sink, 'post', '0');
    setBalance(input, key.recipientB, 'post', '50');
    input.transaction.transaction.message.instructions.push(transfer('50', key.sink, key.recipientB));
    const result = run(input, feed([row(input, '150')]));
    noSupport(result, 'ambiguous_attribution'); expect(result.authorityPatterns).toHaveLength(0);
  });

  it('retains multisig authority and instruction signers separately from transaction signers', () => {
    const input = payout();
    const instruction = transfer();
    instruction.parsed = { type: 'transferChecked', info: { source: key.source, destination: key.recipient,
      multisigAuthority: key.multisig, signers: [key.authority], mint: key.mint,
      tokenAmount: { amount: '100', decimals: 6 } } };
    input.transaction.transaction.message.instructions = [instruction];
    const result = run(input);
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(result.authorityPatterns[0]).toMatchObject({ authorityKind: 'multisig', transferAuthority: key.multisig,
      instructionSigners: [key.authority], transactionSigners: [key.authority] });
  });

  it('does not use proven credits alone when unrelated token accounts have unexplained changes', () => {
    const input = payout(); setBalance(input, key.sink, 'post', '10');
    const normalized = normalizeTransaction(input);
    expect(normalized.transfers[0]!.netCreditRaw).toBe('100');
    noSupport(run(input), 'unresolved_normalization');
  });

  it('retains duplicate instruction position conflicts from the existing identity grouper', () => {
    const input = payout(); input.transaction.transaction.message.instructions = [wrapper()];
    input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }, { index: 0, instructions: [transfer()] }];
    const result = run(input);
    noSupport(result, 'conflicting_identity_evidence');
    expect(result.identityGroups[0]!.observations).toHaveLength(2);
  });

  it.each(['missing', 'failure', 'wrong-source', 'conflicting-id', 'http-failure', 'zero-attempts'] as const)('requires resolvable source provenance: %s', kind => {
    const evidence = feed();
    if (kind === 'missing') evidence.sources = [];
    if (kind === 'failure') evidence.sources[0]!.outcome = 'failure';
    if (kind === 'wrong-source') evidence.sources[0]!.source = 'pairs';
    if (kind === 'conflicting-id') evidence.sources.push({ ...evidence.sources[0]!, generatedAt: '2026-09-22T00:00:00Z' });
    if (kind === 'http-failure') evidence.sources[0]!.httpStatus = 500;
    if (kind === 'zero-attempts') evidence.sources[0]!.attempts = 0;
    noSupport(run(payout(), evidence), 'feed_provenance_unresolved');
  });

  it('rejects mismatched normalized derivatives instead of accepting a supplied trust boolean', () => {
    const normalized = normalizeTransaction(payout()); normalized.transfers[0]!.netCreditRaw = '999';
    expect(() => reconcilePayoutEvidence({ feeds: [feed()], transactions: [normalized] })).toThrow('Invalid payout evidence input');
    const forged = { feeds: [feed()], transactions: [], trusted: true } as PayoutEvidenceInput;
    expect(() => reconcilePayoutEvidence(forged)).toThrow('Invalid payout evidence input');
    const prior = { ...run().state, authorityPatterns: [{ trusted: true }] } as PayoutEvidenceState;
    expect(() => reconcilePayoutEvidence({ feeds: [], transactions: [], prior })).toThrow('Invalid payout evidence input');
    expect(() => reconcilePayoutEvidence({ feeds: [], transactions: [], prior: null as unknown as PayoutEvidenceState })).toThrow('Invalid payout evidence input');
  });

  it('rejects incompatible state versions and inconsistent feed signatures', () => {
    const prior = { ...run().state, schemaVersion: 2 } as unknown as PayoutEvidenceState;
    expect(() => reconcilePayoutEvidence({ feeds: [], transactions: [], prior })).toThrow('Invalid payout evidence input');
    const evidence = feed(); evidence.distributions[0]!.signature = '4'.repeat(88);
    expect(() => run(payout(), evidence)).toThrow('Invalid payout evidence input');
  });

  it('rejects numeric raw amounts and credential-style endpoints without reflecting inputs', () => {
    const evidence = feed(); evidence.sources[0]!.endpoint = 'https://example.invalid/?api-key=synthetic';
    expect(() => run(payout(), evidence)).toThrow(/^Invalid payout evidence input$/);
    const numeric = feed(); numeric.distributions[0]!.rows[0]!.value.amountRaw = 100 as unknown as string;
    expect(() => run(payout(), numeric)).toThrow(/^Invalid payout evidence input$/);
  });

  it('does not mutate inputs, access live fetch, read the clock or require storage', () => {
    const input = { feeds: [feed()], transactions: [normalizeTransaction(payout())] };
    const before = structuredClone(input);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No clock reads'); });
    const result = reconcilePayoutEvidence(input);
    expect(input).toEqual(before); expect(clock).not.toHaveBeenCalled();
    expect(reconcilePayoutEvidence({ feeds: [], transactions: [], prior: JSON.parse(JSON.stringify(result.state)) as PayoutEvidenceState })).toEqual(result);
    clock.mockRestore();
  });
});

describe('payout structure with a recognized account creation (policy v3)', () => {
  const structure = (input: NormalizationInput, policyVersion?: PayoutPolicyVersion) =>
    payoutStructure(normalizeTransaction(input), policyVersion);

  it('accepts the recognized unit and its exact rent, which policy v2 still refuses', () => {
    const input = createdRecipient();
    expect(structure(input)).toEqual([]);
    expect(normalizeTransaction(input).transfers[0]).toMatchObject({ netCreditRaw: '100', reasons: [] });
    expect(structure(input, 'payout-evidence-v2'))
      .toEqual(['unexplained_native_movement', 'uninterpreted_activity', 'unresolved_normalization']);
  });

  it('expects every recognized rent when one transaction creates two accounts', () => {
    const input = batch();
    setBalance(input, key.recipient, 'pre', null); setBalance(input, key.recipient, 'post', '100');
    setBalance(input, key.recipientB, 'pre', null);
    withRent(input, { account: key.recipient, owner: key.wallet });
    withRent(input, { account: key.recipientB, owner: key.wallet, lamports: 2074080 });
    expect(normalizeTransaction(input).accountCreations).toHaveLength(2);
    expect(structure(input)).toEqual([]);
  });

  it('adds no rent expectation for an idempotent no-op, which moves no lamports', () => {
    expect(structure(withRent(payout(), { noop: 'empty' }))).toEqual([]);
    const moved = withRent(payout(), { noop: 'empty' });
    moveLamports(moved, key.authority, key.recipient, 1);
    expect(structure(moved)).toContain('unexplained_native_movement');
  });

  it.each([
    ['one lamport short of the recognized rent', (input: NormalizationInput) => { moveLamports(input, key.recipient, key.authority, 1); }],
    ['an extra unrelated system transfer', (input: NormalizationInput) => { moveLamports(input, key.authority, key.recipientB, 25_000); }],
    ['rent arriving at a different account', (input: NormalizationInput) => { moveLamports(input, key.recipient, key.recipientB, 2039280); }],
    // Wrapped SOL moves a destination's lamport balance with its token balance.
    ['a wrapped-SOL destination whose lamports follow its tokens', (input: NormalizationInput) => { moveLamports(input, key.source, key.recipient, 100); }],
  ])('refuses %s with unexplained_native_movement', (_label, mutate) => {
    const input = createdRecipient();
    mutate(input);
    expect(structure(input)).toContain('unexplained_native_movement');
  });

  it('never exempts the program at an unrecognized position or another system instruction type', () => {
    const unrecognized = payout();
    addKey(unrecognized, ASSOCIATED_TOKEN_PROGRAM);
    unrecognized.transaction.transaction.message.instructions.push(
      { programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [key.authority, key.sink], data: '2' });
    expect(structure(unrecognized)).toContain('uninterpreted_activity');
    const other = createdRecipient();
    addKey(other, SYSTEM_PROGRAM);
    other.transaction.transaction.message.instructions.push({ program: 'system', programId: SYSTEM_PROGRAM,
      parsed: { type: 'transfer', info: { source: key.authority, destination: key.sink, lamports: 0 } } });
    expect(structure(other)).toEqual(['uninterpreted_activity', 'unresolved_normalization']);
  });
});
