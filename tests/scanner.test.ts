import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { createRealProviders } from '../src/providers/real.js';
import { admitJob, runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import { processDirty, classifySignature } from '../src/scanner/classifier.js';
import { HISTORY_FLOOR, missingRanges, planRanges } from '../src/scanner/ranges.js';
import { decimal, rounded, valueOf } from '../src/scanner/decimal.js';
import { DEMO_CUTOFF as cutoff, DEMO_MINT as mint, DEMO_WALLET as wallet, demoData, demoFetch, demoTransaction, runDemo } from '../src/cli/demo.js';
import { normalizeTransaction } from '../src/normalization/normalizer.js';
import { reconcilePayoutEvidence } from '../src/payout-evidence/reconcile.js';
import { computeBudgetTag, COMPUTE_BUDGET_PROGRAM } from '../src/payout-evidence/compute-budget.js';
import { base58Encode } from '../src/scanner/ata.js';
import type { DemoData } from '../src/cli/demo.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import type { DistributionEvidenceInput } from '../src/payout-evidence/types.js';
import type { ScanInput } from '../src/scanner/engine.js';
import { batch } from './fixtures/payout-evidence.js';
import { removeTempFolder } from './temp-folder.js';

const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } } for (const path of directories.splice(0)) await removeTempFolder(path); });
function database() { const directory = mkdtempSync(join(tmpdir(), 'rewards-test-')); directories.push(directory); return join(directory, 'test.sqlite'); }
function open(path = database()) { const store = new SqliteRewardsStore(path); stores.push(store); return store; }
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-test', retrievedAt: new Date(cutoff * 1000).toISOString(), commitment: 'finalized' as const };
function feed(txs: FullTransaction[]): DistributionEvidenceInput {
  return { network: 'mainnet-beta', provenance: { source: 'fixture', evidenceId: 'synthetic-feed', retrievedAt: provenance.retrievedAt }, withdrawalAuthorities: [],
    sources: [{ id: 'source-1', source: 'rewards', endpoint: '/rewards?limit=100', requestedAt: provenance.retrievedAt, retrievedAt: provenance.retrievedAt, attempts: 1, outcome: 'success' }],
    distributions: txs.map(tx => ({ signature: tx.transaction.signatures[0]!, rows: [{ sourceIds: ['source-1'], value: {
      signature: tx.transaction.signatures[0]!, mint: 'F'.repeat(32), quoteMint: tx.meta.preTokenBalances[0]!.mint,
      amountRaw: tx.meta.preTokenBalances[0]!.uiTokenAmount.amount, holderCount: 1, distributedAt: provenance.retrievedAt,
    } }] })),
  };
}
function evidence(tx: FullTransaction, official = true) { return { transactions: [normalizeTransaction({ transaction: tx, wallet, network: 'mainnet-beta', provenance })], feeds: official ? [feed([tx])] : [], overflow: false }; }
function seed(store: SqliteRewardsStore, txs: FullTransaction[], official = txs) {
  store.atomic(() => {
    store.saveWallet({ wallet, network: 'mainnet-beta', trackingStart: cutoff - 864000, cutoff, lastSync: null });
    for (const tx of txs) { store.saveQuote('mainnet-beta', { mint: tx.meta.preTokenBalances[0]!.mint, retrievedAt: provenance.retrievedAt,
      membershipEvidence: [{ kind: 'rewardSummary', launchMint: 'F'.repeat(32), endpoint: '/rewards?limit=100', retrievedAt: provenance.retrievedAt }] });
      store.addTransaction('mainnet-beta', tx, provenance); store.watch('mainnet-beta', tx.transaction.signatures[0]!, wallet); }
    store.addFeed(feed(official)); drain(store);
  });
}
function drain(store: SqliteRewardsStore) { for (let i = 0; i < 10 && store.dirty('mainnet-beta', 1).length; i++) processDirty(store, 'mainnet-beta'); expect(store.dirty('mainnet-beta', 1)).toEqual([]); }
function harness(store: SqliteRewardsStore, data: DemoData = demoData()) {
  let clock = cutoff * 1000; let sequence = 0;
  const now = () => { clock += 1000; return clock; };
  return { data, now, setTime(value: number) { clock = value; }, async scan(overrides: Partial<ScanInput> = {}) {
    sequence++;
    return runScan(store, { wallet, cutoff, jobId: `synthetic-job-${sequence}`, owner: `owner-${sequence}`, limits: { stonkfun: 30, helius: 100, pages: 100, resumes: 5, deadline: now() + 86400000 }, ...overrides },
      // Retries keep their count; their backoff is instant so an injected 5xx does not wait in real time.
      job => createRealProviders({ store, job, apiKey: 'synthetic-key', fetch: demoFetch(data, now), now, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } }), { now });
  } };
}

describe('payout v2 / final classification', () => {
  it('decodes documented compute bytes and confirms a positive exact-feed receipt', () => {
    const tx = demoTransaction('3', cutoff - 100);
    expect(computeBudgetTag(tx.transaction.message.instructions[0]!)).toBe(2);
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]).toMatchObject({ status: 'confirmed', basis: 'official_feed', netRaw: '1000000' });
    const ev = evidence(tx);
    expect(reconcilePayoutEvidence({ transactions: ev.transactions, feeds: ev.feeds }).reconciliations[0]!.status).toBe('unresolved');
  });
  it.each(['', '0OIl', '1111', 'Fj2Eoy1'])('rejects malformed compute payload %s', data => {
    expect(computeBudgetTag({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data })).toBeNull();
  });
  it('decodes both documented compute unit limit encodings and refuses a wider parameter', () => {
    const tag = (bytes: number[]) => computeBudgetTag({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: base58Encode(Uint8Array.from(bytes)) });
    // SetComputeUnitLimit 1,000,000 as four and as eight little-endian parameter bytes.
    expect(tag([2, 64, 66, 15, 0])).toBe(2);
    expect(computeBudgetTag({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: '2fPReCdvo79R' })).toBe(2);
    expect(tag([2, 64, 66, 15, 0, 0, 0, 0, 0])).toBe(2);
    // A ninth byte carrying value exceeds the documented parameter, and no other tag widens.
    expect(tag([2, 64, 66, 15, 0, 0, 0, 0, 1])).toBeNull();
    expect(tag([2, 64, 66, 15, 0, 0, 0])).toBeNull();
    expect(tag([1, 0, 0, 1, 0, 0, 0, 0, 0])).toBeNull();
    expect(tag([4, 64, 66, 15, 0, 0, 0, 0, 0])).toBeNull();
  });
  it('rejects wrong program, extra accounts, duplicate compute settings, and unknown wrappers', () => {
    const tx = demoTransaction('3', cutoff - 100);
    tx.transaction.message.instructions[0]!.accounts = [wallet];
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.status).toBe('unknown_candidate');
    tx.transaction.message.instructions[0]!.accounts = [];
    tx.transaction.message.instructions.unshift(structuredClone(tx.transaction.message.instructions[0]!));
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.status).toBe('unknown_candidate');
    tx.transaction.message.instructions.splice(0, 1);
    tx.transaction.message.instructions[0]!.programId = 'A'.repeat(32);
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.status).toBe('unknown_candidate');
  });
  it.each(['0', '30000'])('supports proven Token-2022 fees %s while retaining gross/feed/net', feeAmount => {
    const tx = demoTransaction('3', cutoff - 100, '1000000', mint, feeAmount);
    const ev = evidence(tx);
    const result = reconcilePayoutEvidence({ transactions: ev.transactions, feeds: ev.feeds, policyVersion: 'payout-evidence-v2' });
    expect(result.reconciliations[0]!.status).toBe('reconciled');
    expect(classifySignature(ev, wallet, new Set([mint]))[0]).toMatchObject({ status: 'confirmed', grossRaw: '1000000', netRaw: (1000000n - BigInt(feeAmount)).toString() });
  });
  it('accepts net-equal fee-bearing feed attribution without asserting general feed semantics', () => {
    const ev = evidence(demoTransaction('3', cutoff - 100, '1000000', mint, '30000'));
    ev.feeds[0]!.distributions[0]!.rows[0]!.value.amountRaw = '970000';
    const result = reconcilePayoutEvidence({ transactions: ev.transactions, feeds: ev.feeds, policyVersion: 'payout-evidence-v2' });
    expect(result.reconciliations[0]!.comparisons[0]!.mints[0]).toMatchObject({ feedEqualsGross: false, feedEqualsNet: true, feedAmountSemantics: 'not_established' });
    expect(result.reconciliations[0]!.status).toBe('reconciled');
  });
  it('keeps ordinary unverified quote transfers unknown and rejects wallet participation and failures', () => {
    const tx = demoTransaction('3', cutoff - 100);
    const unverified = classifySignature(evidence(tx, false), wallet, new Set([mint]))[0]!;
    expect(unverified.status).toBe('unknown_candidate');
    expect(unverified.reasons).not.toContain('amount_mismatch');
    expect(unverified.reasons).not.toContain('mint_mismatch');
    tx.transaction.message.accountKeys.find(key => key.pubkey === wallet)!.signer = true;
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.reasons).toContain('wallet_participation');
    tx.meta.err = { InstructionError: [0, 'failure'] };
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.reasons).toContain('failed_transaction');
  });
  it('requires quote membership, ownership and exact positive credits', () => {
    const tx = demoTransaction('3', cutoff - 100);
    expect(classifySignature(evidence(tx), wallet, new Set())[0]!.reasons).toContain('reward_quote_unverified');
    tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = '0';
    expect(classifySignature(evidence(tx), wallet, new Set([mint]))[0]!.reasons).toContain('positive_credit_unproven');
  });
  it('revalidates full witness evidence for the public pure pattern classifier', () => {
    const a = demoTransaction('3', cutoff - 100); const b = demoTransaction('4', cutoff - 100); const c = demoTransaction('5', cutoff - 100);
    a.transactionIndex = 1; b.transactionIndex = 2; c.transactionIndex = 3;
    expect(classifySignature(evidence(b, false), wallet, new Set([mint]), [evidence(a), evidence(c)])[0]!.basis).toBe('same_slot_pattern');
    delete a.transactionIndex;
    const unbracketed = classifySignature(evidence(b, false), wallet, new Set([mint]), [evidence(a), evidence(c)])[0]!;
    expect(unbracketed.status).toBe('unknown_candidate');
    expect(unbracketed.reasons).toContain('ordering_unavailable');
    a.transactionIndex = 1;
    const forged = evidence(a); forged.transactions[0]!.transfers[0]!.netCreditRaw = '999';
    expect(() => classifySignature(evidence(b, false), wallet, new Set([mint]), [forged, evidence(c)])).toThrow('Invalid payout evidence input');
    const mixed = evidence(a); mixed.transactions.push(...evidence(c).transactions); mixed.feeds.push(...evidence(c).feeds);
    expect(() => classifySignature(evidence(b, false), wallet, new Set([mint]), [mixed])).toThrow('Invalid classification evidence input');
  });
});

describe('witness-bounded historical authority', () => {
  const passive = (tx: FullTransaction) => {
    const index = tx.transaction.message.accountKeys.findIndex(key => key.pubkey === wallet);
    tx.transaction.message.accountKeys.splice(index, 1);
    (tx.meta.preBalances as number[]).splice(index, 1);
    (tx.meta.postBalances as number[]).splice(index, 1);
    return tx;
  };
  const trio = () => [passive(demoTransaction('J', cutoff - 300)), passive(demoTransaction('K', cutoff - 200)),
    passive(demoTransaction('L', cutoff - 100))] as const;
  const candidateRow = (store: SqliteRewardsStore) => buildReport(store, wallet).details.find(row => row.signature === 'K'.repeat(88))!;
  const replaceAuthority = (tx: FullTransaction, authority: string) => {
    const old = tx.transaction.message.accountKeys[0]!.pubkey;
    tx.transaction.message.accountKeys[0]!.pubkey = authority;
    const info = (tx.transaction.message.instructions[1]!.parsed as { info: Record<string, unknown> }).info;
    expect(info.authority).toBe(old); info.authority = authority;
  };
  const changeFeePayer = (tx: FullTransaction, payer: string) => {
    tx.transaction.message.accountKeys.unshift({ pubkey: payer, signer: true, writable: true });
    tx.transaction.signatures.push('Q'.repeat(88));
    const preBalances = tx.meta.preBalances as number[]; const postBalances = tx.meta.postBalances as number[];
    preBalances.unshift(2039280); postBalances.unshift(2034280);
    postBalances[1] = preBalances[1]!;
    for (const balance of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) balance.accountIndex++;
  };

  it('confirms only inside two exact-feed witnesses and retains distinct full provenance', () => {
    const store = open(); const [before, original, after] = trio();
    const candidate = passive(demoTransaction('K', original.blockTime!, '18446744073709551615'));
    expect(classifySignature(evidence(candidate, false), wallet, new Set([mint]),
      [evidence(before), evidence(after)], new Set([mint]))[0]!.basis).toBe('verified_historical_authority');
    seed(store, [before, candidate, after], [before, after]);
    const report = buildReport(store, wallet); const row = candidateRow(store);
    expect(row).toMatchObject({ status: 'confirmed', basis: 'verified_historical_authority',
      temporalScope: 'witness_bounded_epoch', grossRaw: '18446744073709551615', netRaw: '18446744073709551615', decimals: 6,
      destinationOwner: wallet, sourceOwner: '9'.repeat(32), feePayer: '2'.repeat(32) });
    expect(row.authorityEvidence).toMatchObject({ modelVersion: 'historical-authority-v1',
      validAfter: cutoff - 300, validBefore: cutoff - 100,
      witnesses: [{ signature: 'J'.repeat(88) }, { signature: 'L'.repeat(88) }] });
    expect(row.authorityEvidence!.witnesses.every(item => item.evidenceIds.length > 0)).toBe(true);
    expect(report.confirmationBasisCounts).toEqual({ official_feed: 2, same_slot_pattern: 0, verified_historical_authority: 1 });
    expect(report.cumulative.assets[0]!.raw).toBe('18446744073711551615');
    expect(report.uniqueSignatures).toEqual({ all: 3, confirmed: 3, attributed: 0, excluded: 0, unknown_candidate: 0 });
    const stable = JSON.stringify(row); store.atomic(() => { store.addTransaction('mainnet-beta', candidate, provenance); drain(store); });
    expect(JSON.stringify(candidateRow(store))).toBe(stable);
    expect(buildReport(store, wallet).counts.confirmed).toBe(3);
    store.atomic(() => { store.saveQuote('mainnet-beta', { mint, retrievedAt: provenance.retrievedAt, membershipEvidence: [] }); drain(store); });
    expect(candidateRow(store).status).toBe('unknown_candidate');
  });

  it('does not trust a supplied address or extend validity past observed epoch boundaries', () => {
    const store = open(); const [before, candidate, after] = trio();
    replaceAuthority(candidate, '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD');
    seed(store, [before, candidate, after], [before, after]);
    expect(candidateRow(store)).toMatchObject({ status: 'unknown_candidate', basis: null });
    const outside = demoTransaction('M', cutoff - 301); store.atomic(() => {
      store.addTransaction('mainnet-beta', outside, provenance);
      store.watch('mainnet-beta', outside.transaction.signatures[0]!, wallet); drain(store);
    });
    expect(buildReport(store, wallet).details.find(row => row.signature === 'M'.repeat(88))?.status).toBe('unknown_candidate');
  });

  it('requires a witnessed fee-payer and signer role variant', () => {
    const store = open(); const [before, candidate, after] = trio();
    changeFeePayer(candidate, 'P'.repeat(32));
    seed(store, [before, candidate, after], [before, after]);
    expect(candidateRow(store).status).toBe('unknown_candidate');
    const mixed = open(); const [mixedBefore, mixedCandidate, mixedAfter] = trio();
    changeFeePayer(mixedCandidate, 'P'.repeat(32)); changeFeePayer(mixedAfter, 'P'.repeat(32));
    seed(mixed, [mixedBefore, mixedCandidate, mixedAfter], [mixedBefore, mixedAfter]);
    expect(candidateRow(mixed).status).toBe('unknown_candidate');
    const supported = open(); const [a, b, c] = trio();
    changeFeePayer(a, 'P'.repeat(32));
    changeFeePayer(b, 'P'.repeat(32)); changeFeePayer(c, 'P'.repeat(32));
    seed(supported, [a, b, c], [a, c]);
    expect(candidateRow(supported).basis).toBe('verified_historical_authority');
  });

  it('persists explicit local safety revocation with witness provenance and reclassifies idempotently', () => {
    const path = database(); const store = open(path); const [before, candidate, after] = trio();
    seed(store, [before, candidate, after], [before, after]);
    const patternId = candidateRow(store).authorityEvidence!.patternId;
    store.saveAuthorityRevocation('mainnet-beta', patternId, cutoff - 200, 'reviewed-revocation-1');
    expect(candidateRow(store).status).toBe('unknown_candidate');
    drain(store);
    expect(candidateRow(store).status).toBe('unknown_candidate');
    expect(store.authorityRevocations('mainnet-beta')).toMatchObject([{ modelVersion: 'historical-authority-v1',
      patternId, effectiveFrom: cutoff - 200, decisionId: 'reviewed-revocation-1',
      witnessSignatures: ['J'.repeat(88), 'L'.repeat(88)] }]);
    store.saveAuthorityRevocation('mainnet-beta', patternId, cutoff - 200, 'reviewed-revocation-1');
    expect(store.dirty('mainnet-beta', 100)).toEqual([]);
    store.close(); const reopened = open(path);
    expect(candidateRow(reopened).status).toBe('unknown_candidate');
  });

  it('blocks rotation overlap and revokes dependent credits when a witness becomes contested', () => {
    const store = open(); const [before, candidate, after] = trio();
    seed(store, [before, candidate, after], [before, after]);
    expect(candidateRow(store).status).toBe('confirmed');
    const rotated = demoTransaction('N', cutoff - 200); replaceAuthority(rotated, 'A'.repeat(32));
    store.atomic(() => { store.addTransaction('mainnet-beta', rotated, provenance); store.addFeed(feed([rotated])); drain(store); });
    expect(candidateRow(store).status).toBe('unknown_candidate');
    const conflicting = structuredClone(before); conflicting.meta.postTokenBalances[1]!.uiTokenAmount.amount = '999999';
    store.atomic(() => { store.addTransaction('mainnet-beta', conflicting, provenance); drain(store); });
    expect(candidateRow(store).status).toBe('unknown_candidate');
  });

  it('rejects wallet participation, unsupported activity, and missing exact balance credit', () => {
    for (const variant of ['wallet_readonly', 'wallet_signer', 'wallet_writable', 'swap', 'ordinary_deposit', 'missing_balance'] as const) {
      const store = open(); const [before, candidate, after] = trio();
      if (variant === 'wallet_readonly' || variant === 'wallet_signer' || variant === 'wallet_writable') {
        candidate.transaction.message.accountKeys.push({ pubkey: wallet,
          signer: variant === 'wallet_signer', writable: variant === 'wallet_writable' });
        (candidate.meta.preBalances as number[]).push(2039280);
        (candidate.meta.postBalances as number[]).push(2039280);
        if (variant === 'wallet_signer') candidate.transaction.signatures.push('R'.repeat(88));
      }
      if (variant === 'swap') candidate.transaction.message.instructions.push({ programId: 'A'.repeat(32), accounts: [], data: '2' });
      if (variant === 'ordinary_deposit') {
        candidate.transaction.message.accountKeys[1]!.pubkey = 'S'.repeat(32);
        (candidate.transaction.message.instructions[1]!.parsed as { info: Record<string, unknown> }).info.source = 'S'.repeat(32);
      }
      if (variant === 'missing_balance') candidate.meta.postTokenBalances.pop();
      seed(store, [before, candidate, after], [before, after]);
      expect(candidateRow(store).status, variant).not.toBe('confirmed');
    }
  });
});

describe('SQLite, conflicts and authority dependencies', () => {
  it('retains distinct wallet credits in one signature while grouping pricing coverage once', () => {
    const store = open(); const tx = batch().transaction; tx.blockTime = cutoff - 100;
    seed(store, [tx], []); const official = feed([tx]); official.distributions[0]!.rows[0]!.value.amountRaw = '150';
    store.atomic(() => { store.addFeed(official); drain(store); store.addTransaction('mainnet-beta', tx, provenance); drain(store); });
    const report = buildReport(store, wallet);
    expect(report.counts.confirmed).toBe(2); expect(report.cumulative.assets[0]!.raw).toBe('150');
    expect(report.uniqueSignatures).toMatchObject({ all: 1, confirmed: 1 });
    expect(report.cumulative.pricingCoverage.totalWalletCreditGroups).toBe(1);
  });
  it('preserves u64 strings and aggregate amounts above signed-64 limits across reopening', () => {
    const path = database(); const store = open(path);
    seed(store, [demoTransaction('3', cutoff - 100, '18446744073709551615'), demoTransaction('4', cutoff - 99, '18446744073709551615')]);
    store.close(); const reopened = open(path);
    expect(buildReport(reopened, wallet).cumulative.assets[0]!.raw).toBe('36893488147419103230');
  });
  it('does not manufacture chain conflicts from two searched wallets', () => {
    const store = open(); const tx = demoTransaction('3', cutoff - 100); seed(store, [tx]);
    store.atomic(() => { store.watch('mainnet-beta', tx.transaction.signatures[0]!, '9'.repeat(32)); drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(1);
    expect(store.evidence('mainnet-beta', tx.transaction.signatures[0]!).transactions).toHaveLength(1);
  });
  it.each(['history-first', 'hydration-first'])('accepts only transactionIndex enrichment through stored classification: %s', order => {
    const path = database(); const store = open(path);
    const indexed = demoTransaction('3', cutoff - 100);
    const hydrated = structuredClone(indexed); delete hydrated.transactionIndex;
    const observations = order === 'history-first' ? [indexed, hydrated] : [hydrated, indexed];
    store.atomic(() => {
      store.saveWallet({ wallet, network: 'mainnet-beta', trackingStart: cutoff - 864000, cutoff, lastSync: null });
      store.saveQuote('mainnet-beta', { mint, retrievedAt: provenance.retrievedAt });
      store.addFeed(feed([indexed]));
      for (const tx of observations) store.addTransaction('mainnet-beta', tx, provenance);
      store.watch('mainnet-beta', indexed.transaction.signatures[0]!, wallet);
      drain(store);
    });
    for (const tx of observations) store.addTransaction('mainnet-beta', tx, provenance);
    expect(store.evidence('mainnet-beta', indexed.transaction.signatures[0]!).transactions).toHaveLength(1);
    expect(store.evidence('mainnet-beta', indexed.transaction.signatures[0]!).transactions[0]!.evidence.transactionIndex).toBe(1);
    expect(buildReport(store, wallet).counts.confirmed).toBe(1);
    expect(buildReport(store, wallet).details[0]!.evidenceIds).toHaveLength(2);
    store.close();
    const reopened = open(path);
    expect(buildReport(reopened, wallet).counts.confirmed).toBe(1);
    expect(reopened.evidence('mainnet-beta', indexed.transaction.signatures[0]!).transactions).toHaveLength(1);
  });
  it('keeps contradictory supplied ordering contested after compatible enrichment', () => {
    const store = open(); const indexed = demoTransaction('3', cutoff - 100); seed(store, [indexed]);
    const hydrated = structuredClone(indexed); delete hydrated.transactionIndex;
    store.atomic(() => { store.addTransaction('mainnet-beta', hydrated, provenance); drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(1);
    const contradiction = structuredClone(indexed); contradiction.transactionIndex = 2;
    store.atomic(() => { store.addTransaction('mainnet-beta', contradiction, provenance); drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(0);
    expect(store.evidence('mainnet-beta', indexed.transaction.signatures[0]!).transactions).toHaveLength(3);
  });
  it('does not fill absent transfer or account evidence from an indexed observation', () => {
    const store = open(); const indexed = demoTransaction('3', cutoff - 100); seed(store, [indexed]);
    const incomplete = structuredClone(indexed);
    delete incomplete.transactionIndex;
    incomplete.meta.postTokenBalances.pop();
    store.atomic(() => { store.addTransaction('mainnet-beta', incomplete, provenance); drain(store); });
    expect(store.evidence('mainnet-beta', indexed.transaction.signatures[0]!).transactions).toHaveLength(2);
    expect(buildReport(store, wallet).counts.confirmed).toBe(0);
  });
  it.each(['missing', 'changed'])('quarantines existing receipts on %s evidence and later repeats cannot clear it', variant => {
    const store = open(); const tx = demoTransaction('3', cutoff - 100); seed(store, [tx]);
    const changed = structuredClone(tx);
    if (variant === 'missing') changed.transaction.message.instructions.pop();
    else changed.meta.postTokenBalances[1]!.uiTokenAmount.amount = '999999';
    store.atomic(() => { store.addTransaction('mainnet-beta', changed, provenance); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(0);
    store.atomic(() => { drain(store); store.addTransaction('mainnet-beta', tx, provenance); drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(0);
    expect(store.evidence('mainnet-beta', tx.transaction.signatures[0]!).transactions).toHaveLength(2);
  });
  it('preserves conflicting feed alternatives and quarantines prior support', () => {
    const store = open(); const tx = demoTransaction('3', cutoff - 100); seed(store, [tx]);
    const changed = feed([tx]); changed.distributions[0]!.rows[0]!.value.amountRaw = '1';
    store.atomic(() => { store.addFeed(changed); drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(0);
    expect(store.evidence('mainnet-beta', tx.transaction.signatures[0]!).feeds).toHaveLength(2);
  });
  it('supports strictly bracketed same-slot patterns and revokes dependents when a witness conflicts', () => {
    const store = open(); const before = demoTransaction('3', cutoff - 100); const candidate = demoTransaction('4', cutoff - 100); const after = demoTransaction('5', cutoff - 100);
    before.transactionIndex = 1; candidate.transactionIndex = 2; after.transactionIndex = 3;
    seed(store, [before, candidate, after], [before, after]);
    expect(buildReport(store, wallet).details.find(row => row.signature === candidate.transaction.signatures[0])?.basis).toBe('same_slot_pattern');
    const changed = structuredClone(before); changed.transaction.message.instructions.pop();
    store.atomic(() => { store.addTransaction('mainnet-beta', changed, provenance); });
    expect(buildReport(store, wallet).details.find(row => row.signature === candidate.transaction.signatures[0])?.status).toBe('unknown_candidate');
    store.atomic(() => { drain(store); });
    expect(buildReport(store, wallet).counts.confirmed).toBe(1);
  });
  it('does not use first/last observed timestamps as permanent authority validity', () => {
    const store = open(); const before = demoTransaction('3', cutoff - 100000); const candidate = demoTransaction('4', cutoff - 500); const after = demoTransaction('5', cutoff - 100);
    seed(store, [before, candidate, after], [before, after]);
    expect(buildReport(store, wallet).counts).toMatchObject({ confirmed: 2, unknown_candidate: 1 });
  });
  it('rolls back evidence and classifications as one transaction', () => {
    const store = open(); const tx = demoTransaction('3', cutoff - 100);
    expect(() => store.atomic(() => { seed(store, [tx]); throw new Error('synthetic interruption'); })).toThrow();
    expect(store.hasTransaction('mainnet-beta', tx.transaction.signatures[0]!)).toBe(false);
    expect(store.wallet('mainnet-beta', wallet)).toBeUndefined();
  });
  it('rejects future schema versions without destructive migrations', () => {
    const path = database(); const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
    expect(() => new SqliteRewardsStore(path)).toThrow('database_schema_newer_than_scanner');
  });
  it('migrates v1 metadata transactionally without losing saved receipts', () => {
    const path = database(); const store = open(path); seed(store, [demoTransaction('3', cutoff - 100)]); store.close();
    const db = new DatabaseSync(path); db.exec('DROP TABLE metadata_observations; ALTER TABLE transactions DROP COLUMN compatibility; ALTER TABLE cooldowns DROP COLUMN server_until; PRAGMA user_version=1'); db.close();
    const migrated = open(path); expect(buildReport(migrated, wallet).counts.confirmed).toBe(1); migrated.close();
    const check = new DatabaseSync(path); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
    expect(check.prepare('SELECT count(*) AS count FROM metadata_observations').get()?.count).toBe(1); check.close();
  });
  it('migrates v2 observations and shared cooldown without losing receipts', () => {
    const path = database(); const store = open(path); seed(store, [demoTransaction('3', cutoff - 100)]);
    store.cooldown('helius', cutoff * 1000 + 120000); store.close();
    const old = new DatabaseSync(path);
    old.exec('UPDATE cooldowns SET until=server_until; ALTER TABLE transactions DROP COLUMN compatibility; ALTER TABLE cooldowns DROP COLUMN server_until; PRAGMA user_version=2;'); old.close();
    const migrated = open(path);
    expect(buildReport(migrated, wallet).counts.confirmed).toBe(1);
    expect(migrated.cooldown('helius')).toBe(cutoff * 1000 + 120000);
    const tx = demoTransaction('3', cutoff - 100); const noIndex = structuredClone(tx); delete noIndex.transactionIndex;
    migrated.atomic(() => { migrated.addTransaction('mainnet-beta', noIndex, provenance); drain(migrated); });
    expect(buildReport(migrated, wallet).counts.confirmed).toBe(1);
  });
  it('views v4 read-only and reseeds the classifier version once on explicit writable open', () => {
    const path = database(); const original = open(path); seed(original, [demoTransaction('3', cutoff - 100)]); original.close();
    const previous = new DatabaseSync(path);
    previous.exec(`DELETE FROM classification_versions WHERE version='stonkfun-classifier-v3'; DELETE FROM dirty;
      DROP TABLE withdrawal_authority_snapshots; DROP TABLE identity_conflicts; PRAGMA user_version=4;
      UPDATE classifications SET status='unknown_candidate',
      body=json_set(body,'$.status','unknown_candidate','$.version','stonkfun-classifier-v2');`);
    previous.close();
    const readonly = new SqliteRewardsStore(path, { readOnly: true });
    expect(buildReport(readonly, wallet).counts.unknown_candidate).toBe(1); readonly.close();
    const writable = open(path);
    expect(writable.pendingClassifications('mainnet-beta', wallet).walletSignatures).toBe(1);
    drain(writable); expect(buildReport(writable, wallet).counts.confirmed).toBe(1);
    writable.close(); const reopened = open(path);
    expect(reopened.pendingClassifications('mainnet-beta', wallet).walletSignatures).toBe(0);
    expect(buildReport(reopened, wallet).details[0]!.version).toBe('stonkfun-classifier-v4');
  });
  it('fences concurrent invocations and allows crash recovery after lease expiry', () => {
    const path = database(); const a = open(path); const b = open(path);
    a.acquire('mainnet-beta', wallet, 'a', 1000);
    expect(() => b.acquire('mainnet-beta', wallet, 'b', 2000)).toThrow('wallet_job_busy');
    b.acquire('mainnet-beta', wallet, 'b', 122000);
    expect(() => a.renew('mainnet-beta', wallet, 'a', 122001)).toThrow('wallet_lease_lost');
  });
  it('lets an uninterrupted slow page renew its own lease without admitting a duplicate job', () => {
    const path = database(); const a = open(path); const b = open(path);
    a.acquire('mainnet-beta', wallet, 'a', 1000); a.renew('mainnet-beta', wallet, 'a', 122000);
    expect(() => b.acquire('mainnet-beta', wallet, 'b', 122001)).toThrow('wallet_job_busy');
  });
});

describe('actual orchestration, clients, database and reports', () => {
  it('uses method-specific synthetic transaction shapes', async () => {
    const data = demoData(); const fetcher = demoFetch(data, () => cutoff * 1000);
    const signature = data.official[0]!.transaction.signatures[0]!;
    const hydrated = await fetcher('https://mainnet.helius-rpc.com/', { method: 'POST', body: JSON.stringify({ id: 'scanner', method: 'getTransaction', params: [signature] }) });
    const history = await fetcher('https://mainnet.helius-rpc.com/', { method: 'POST', body: JSON.stringify({ id: 'history', method: 'getTransactionsForAddress', params: [wallet, { limit: 100, filters: { blockTime: { gte: cutoff - 864000, lte: cutoff - 1 } } }] }) });
    const hydratedBody: unknown = await hydrated.json();
    const historyBody: unknown = await history.json();
    expect((hydratedBody as { result: FullTransaction }).result.transactionIndex).toBeUndefined();
    expect((historyBody as { result: { data: FullTransaction[] } }).result.data.some(tx => tx.transactionIndex === 1)).toBe(true);
  });
  it('runs a seven-day first scan and one Load earlier batch, then restarts three days later with positive, negative and unknown evidence', async () => {
    const result = await runDemo(database());
    expect(result.initial.counts).toEqual({ confirmed: 3, attributed: 0, excluded: 1, unknown_candidate: 1 });
    expect(result.initial.trackingStart).toBe(cutoff - 14 * 86400);
    expect(result.initial.rolling168h.startTime).toBe(cutoff - 604800);
    expect(result.afterRestart.counts.confirmed).toBe(4);
    expect(result.afterRestart.job?.requests.pages).toBe(4);
    expect(result.afterRestart.cumulative.assets[0]!.raw).toBe('12345678908234567');
    expect(result.initial.cumulative.unpriced).toHaveLength(1);
    expect(result.afterRestart.coverage.gaps).toEqual([]);
  });
  it('plans every missing day after a months-long absence without rescan of completed days', () => {
    const planned = planRanges(cutoff + 100 * 86400, [{ startTime: HISTORY_FLOOR, endTime: cutoff }]);
    expect(planned[0]!.startTime).toBe(cutoff - 60);
    expect(planned.at(-1)!.endTime).toBe(cutoff + 100 * 86400);
    expect(planned.reduce((sum, range) => sum + range.endTime - range.startTime, 0)).toBe(100 * 86400 + 60);
  });
  it('deduplicates repeated/overlapping evidence and reprices without changing earned amounts', async () => {
    const store = open(); const h = harness(store); await h.scan();
    const first = buildReport(store, wallet); h.setTime((cutoff + 1) * 1000 + 4000_000); h.data.prices[mint] = '2.50';
    await h.scan(); const second = buildReport(store, wallet);
    expect(second.counts).toEqual(first.counts);
    expect(second.cumulative.assets[0]!.raw).toBe(first.cumulative.assets[0]!.raw);
    expect(second.cumulative.currentUsd).not.toBe(first.cumulative.currentUsd);
    const counts = structuredClone(h.data.calls); buildReport(store, wallet); expect(h.data.calls).toEqual(counts);
  });
  it('keeps a mid-page gap visible while newer ranges finish, then resumes the exact saved cursor', async () => {
    const path = database(); const store = open(path); const data = demoData();
    const a = demoTransaction('A', cutoff - 5 * 86400 + 1); const b = demoTransaction('B', cutoff - 5 * 86400 + 2);
    data.transactions = [...data.transactions.slice(0, 2), a, b]; data.failCursor = '1';
    const h = harness(store, data); const job = await h.scan({ pageSize: 1 });
    expect(job.status).toBe('paused');
    const pending = store.ranges(job.id).filter(range => range.status === 'pending');
    expect(pending.length).toBeGreaterThan(0); expect(pending[0]!.cursor).toBe('1');
    expect(buildReport(store, wallet).coverage.gaps.length).toBeGreaterThan(0);
    expect(store.coverage('mainnet-beta', wallet).at(-1)!.endTime).toBe(cutoff);
    const used = job.used.helius; store.close(); delete data.failCursor;
    const reopened = open(path); const h2 = harness(reopened, data); h2.setTime(h.now()); const resumed = await h2.scan({ resume: job.id });
    expect(resumed.status, JSON.stringify({ resumed, ranges: reopened.ranges(job.id) })).toBe('complete'); expect(resumed.used.helius).toBeGreaterThan(used);
    expect(buildReport(reopened, wallet).coverage.gaps).toEqual([]);
  });
  it('never resets budgets or deadlines on resume', () => {
    const store = open(); const h = harness(store);
    const input: ScanInput = { wallet, cutoff, jobId: 'bounded', owner: 'owner', limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 2, deadline: h.now() + 100000 } };
    const job = admitJob(store, input, h.now()); store.reserveRequest(job.id, 'helius', h.now());
    const resumed = admitJob(store, { ...input, limits: { ...input.limits, helius: 999 }, resume: job.id }, h.now());
    expect(resumed.limits.helius).toBe(1); expect(resumed.used.helius).toBe(1);
    expect(() => store.reserveRequest(job.id, 'helius', h.now())).toThrow('request_budget_or_deadline');
    expect(admitJob(store, { ...input, resume: job.id }, h.now()).status).toBe('exhausted');
  });
  it('restarts a stale cursor once under the same cumulative job budgets', async () => {
    const store = open(); const data = demoData(); data.transactions = [demoTransaction('A', cutoff - 7 * 86400 + 1), demoTransaction('B', cutoff - 7 * 86400 + 2)]; data.official = []; data.failCursor = '1';
    const h = harness(store, data); const first = await h.scan({ pageSize: 1 });
    delete data.failCursor; data.staleCursor = '1';
    const second = await h.scan({ resume: first.id });
    expect(store.ranges(first.id)[0]).toMatchObject({ cursor: null, restarts: 1, status: 'pending' });
    expect(second.used.helius).toBeGreaterThan(first.used.helius);
    delete data.staleCursor;
    const third = await h.scan({ resume: first.id });
    expect(third.status).toBe('complete'); expect(third.limits).toEqual(first.limits);
    expect(store.evidence('mainnet-beta', 'A'.repeat(88)).transactions).toHaveLength(1);
  });
  it('rolls back a failed page consumer and safely replays the whole page on resume', async () => {
    const store = open();
    const a = demoTransaction('A', cutoff - 7 * 86400 + 1); const b = demoTransaction('B', cutoff - 7 * 86400 + 2);
    const data = { ...demoData(), transactions: [a, b], official: [] };
    const original = store.addTransaction.bind(store); let delivered = 0;
    store.addTransaction = (...args) => { delivered++; if (delivered === 2) throw new Error('synthetic_mid_page_failure'); return original(...args); };
    const h = harness(store, data); const job = await h.scan();
    expect(job.status).toBe('paused'); expect(store.ranges(job.id)[0]).toMatchObject({ cursor: null, pages: 0, status: 'pending' });
    expect(store.hasTransaction('mainnet-beta', a.transaction.signatures[0]!)).toBe(false);
    store.addTransaction = original;
    const resumed = await h.scan({ resume: job.id }); expect(resumed.status).toBe('complete');
    expect(store.evidence('mainnet-beta', a.transaction.signatures[0]!).transactions).toHaveLength(1);
  });
  it('retains acknowledged progress on cancellation and resumes without a new allowance', async () => {
    const store = open(); const data = demoData(); const controller = new AbortController();
    let clock = cutoff * 1000; const now = () => { clock += 1000; return clock; };
    const job = await runScan(store, { wallet, cutoff, jobId: 'cancelled-test', owner: 'cancel-owner',
      limits: { stonkfun: 30, helius: 100, pages: 100, resumes: 5, deadline: now() + 86400000 } },
      item => createRealProviders({ store, job: item, apiKey: 'synthetic-key', now, fetch: demoFetch(data, now), signal: controller.signal }),
      { now, signal: controller.signal, progress: event => { if (event.stage === 'page_saved') controller.abort(); } });
    // The acknowledged page is kept; its range was read to the end and awaits its check.
    expect(job.status).toBe('paused'); expect(job.used.pages).toBe(1); expect(store.ranges(job.id)[0]).toMatchObject({ status: 'pending', read: true, pages: 1 });
    const h = harness(store, data); h.setTime(now()); const resumed = await h.scan({ resume: job.id });
    expect(resumed.status).toBe('complete'); expect(resumed.used.resumes).toBe(2);
  });
  it('keeps arbitrary old holes in coverage planning', () => {
    expect(missingRanges(10, 100, [{ startTime: 10, endTime: 20 }, { startTime: 30, endTime: 100 }])).toEqual([{ startTime: 20, endTime: 30 }]);
  });
  it('uses exact half-open 168h/24h boundaries and UTC day buckets', () => {
    const store = open(); seed(store, [demoTransaction('3', cutoff - 604801), demoTransaction('4', cutoff - 604800), demoTransaction('5', cutoff - 86400), demoTransaction('6', cutoff)]);
    const report = buildReport(store, wallet);
    expect(report.cumulative.assets[0]!.raw).toBe('3000000'); expect(report.rolling168h.assets[0]!.raw).toBe('2000000'); expect(report.latest24h.assets[0]!.raw).toBe('1000000');
    expect(report.utcDays).toHaveLength(2); expect(report.cumulative.currentUsd).toBeNull(); expect(report.coverage.verifiedZero).toBe(false);
  });
  it('runs the real CLI demo and views its saved report with network and credential loading disabled', () => {
    const path = database();
    const output = execFileSync(process.execPath, ['dist/cli/main.js', 'demo', '--db', path, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect((JSON.parse(output) as { afterRestart: { counts: { confirmed: number } } }).afterRestart.counts.confirmed).toBe(4);
    const report = execFileSync(process.execPath, ['--import', './tests/fixtures/no-network.mjs', 'dist/cli/main.js', 'report', wallet, '--db', path, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect((JSON.parse(report) as { counts: { confirmed: number } }).counts.confirmed).toBe(4);
  });
});

describe('exact decimal valuation', () => {
  it('never rounds raw quantities through Number or signed-64 storage', () => {
    expect(rounded(valueOf('18446744073709551615', 6, '1.000001'))).toBe('18446762520453.625325');
    expect(rounded(decimal('1'), 6, 7n)).toBe('0.142857'); expect(rounded(decimal('0.0000005'))).toBe('0.000001');
  });
  it.each(['NaN', 'Infinity', '-1', '1e99999', 'hello'])('rejects unsafe decimal %s', value => { expect(() => decimal(value)).toThrow(); });
});
