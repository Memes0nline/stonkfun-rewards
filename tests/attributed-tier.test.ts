import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { buildReport } from '../src/scanner/report.js';
import { reportView } from '../src/web/view.js';
import { runScan } from '../src/scanner/engine.js';
import type { Providers } from '../src/scanner/types.js';
import type { HistoryResult } from '../src/helius/types.js';
import { attributionContext, distributorPattern, nativeDistributorPattern } from '../src/scanner/distributor-pattern.js';
import { associatedTokenAddress } from '../src/scanner/ata.js';
import { withdrawalSnapshots } from '../src/scanner/withdrawal-snapshots.js';
import { normalizeTransaction, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/normalization/normalizer.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import type { Classification } from '../src/scanner/types.js';
import {
  ata, configurationFeed, createIdempotent, CUTOFF, DELEGATE, DISTRIBUTOR, FEE_PAYER, iso, lookAlike, MINT, nativePayout, officialFeed, OTHER_DISTRIBUTOR,
  payout, recipient, SECOND_MINT, syntheticKey, toWallet, WALLET, WALLET_ACCOUNT,
} from './fixtures/distributor.js';
import type { NativeShape, PayoutShape } from './fixtures/distributor.js';

const network = 'mainnet-beta';
const WITNESS_TIME = CUTOFF - 1000;
const CREDIT_TIME = WITNESS_TIME - 88_082;
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-attribution', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
const GATE_CODES = ['distributor_credit_unreconciled', 'distributor_trust_unestablished', 'distributor_source_not_ata',
  'distributor_signer_shape_unsupported', 'wallet_in_account_keys', 'distributor_identity_conflicted', 'distributor_attribution_revoked',
  'published_authority_rotation_ambiguous', 'published_authority_snapshot_pending'];
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const sig = (tx: FullTransaction) => tx.transaction.signatures[0]!;
const batch = (from: number, count: number, owner?: string, mint?: string) => Array.from({ length: count }, (_, i) => ({
  ...recipient(from + i), amount: String(10_000 + from + i), ...owner ? { owner } : {}, ...mint ? { mint } : {} }));
/** A reconciling official payout by `owner` from its own derived account: a qualifying feed witness. */
const witnessTx = (label: string, time = WITNESS_TIME, shape: Partial<PayoutShape> = {}) => payout({ label, time, legs: batch(100, 3), ...shape });
const candidateTx = (shape: Partial<PayoutShape> = {}) => payout({ label: 'candidate', time: CREDIT_TIME, legs: [toWallet(), ...batch(1, 4)], ...shape });
/** A payout batch that creates the searched wallet's own associated account in the same transaction. */
const createdForWallet = (shape: Partial<PayoutShape> = {}) => candidateTx({ label: 'wallet-seed',
  missingPre: [WALLET_ACCOUNT], creations: [{ account: WALLET_ACCOUNT, owner: WALLET }], ...shape });

class Scenario {
  readonly path: string;
  readonly store: SqliteRewardsStore;
  constructor() {
    const directory = mkdtempSync(join(tmpdir(), 'rewards-attributed-')); directories.push(directory);
    this.path = join(directory, 'attributed.sqlite');
    this.store = new SqliteRewardsStore(this.path); stores.push(this.store);
    this.store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    this.quote(MINT); this.quote(SECOND_MINT);
  }
  quote(mint: string, membership = true, launchMint = syntheticKey('launch')) {
    this.store.saveQuote(network, { mint, retrievedAt: iso(CUTOFF), membershipEvidence: membership
      ? [{ kind: 'distribution', launchMint, endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) }] : [] });
    return this;
  }
  official(tx: FullTransaction, feed = officialFeed(tx)) { this.store.atomic(() => { this.store.addTransaction(network, tx, provenance); this.store.addFeed(feed); }); return this; }
  watched(...txs: FullTransaction[]) {
    this.store.atomic(() => { for (const tx of txs) { this.store.addTransaction(network, tx, provenance); this.store.watch(network, sig(tx), WALLET); } });
    return this;
  }
  snapshot(authority: string, observed: number, label?: string) { this.store.saveWithdrawalSnapshots(configurationFeed(authority, observed, label)); return this; }
  drain() {
    for (let i = 0; i < 50 && this.store.dirty(network, 1).length; i++) processDirty(this.store, network, 100);
    expect(this.store.dirty(network, 1)).toEqual([]);
    return this;
  }
  rows(tx: FullTransaction) { return buildReport(this.store, WALLET).details.filter(row => row.signature === sig(tx)); }
  row(tx: FullTransaction, destination = WALLET_ACCOUNT) { return this.rows(tx).find(row => row.recipient === destination)!; }
}
const gates = (row: Classification) => row.reasons.filter(reason => GATE_CODES.includes(reason));
function expectUnknown(row: Classification, gate: string | null) {
  expect(row.status).toBe('unknown_candidate');
  expect(row.attributionEvidence).toBeNull();
  expect(gates(row)).toEqual(gate === null ? [] : [gate]);
}
const witnessed = () => new Scenario().official(witnessTx('witness-1'));

describe('distributor-pattern tier: passing trust sources', () => {
  it('attributes a pre-witness credit via feed_witnessed_identity with full provenance and no verified total', () => {
    const candidate = candidateTx();
    const s = witnessed().watched(candidate).drain();
    const row = s.row(candidate);
    const source = associatedTokenAddress(DISTRIBUTOR, MINT, SPL_TOKEN_PROGRAM)!;
    expect(row).toMatchObject({ status: 'attributed', basis: 'distributor_pattern', reasons: ['trusted_distributor_pattern_and_proven_credit'],
      temporalScope: 'identity_attributed', version: 'stonkfun-classifier-v4', netRaw: '1000000', authorityEvidence: null,
      supportingSignatures: [sig(witnessTx('witness-1'))] });
    expect(row.attributionEvidence).toMatchObject({ basis: 'distributor_pattern', modelVersion: 'distributor-pattern-v1', classifierVersion: 'stonkfun-classifier-v4',
      trustSources: ['feed_witnessed_identity'], primaryTrustSource: 'feed_witnessed_identity', publishedSnapshots: [], secondsToNearestSnapshot: null,
      sourceOwner: DISTRIBUTOR, sourceAta: source.address, ataBump: source.bump, mint: MINT, tokenProgram: SPL_TOKEN_PROGRAM,
      signerShape: { kind: 'owner_is_fee_payer', feePayer: DISTRIBUTOR, signers: [DISTRIBUTOR] },
      batch: { outerTransfersFromSource: 5, transfersFromSource: 5, distinctRecipientOwners: 5 }, creditedMintAlsoRetainedLaunch: false });
    expect(row.attributionEvidence!.identityId).toBe(createHash('sha256').update(JSON.stringify(['distributor-pattern-v1', network, DISTRIBUTOR])).digest('hex'));
    expect(row.attributionEvidence!.witnesses).toMatchObject({ count: 1, relation: 'before_first_witness', secondsToNearestWitness: 88_082,
      first: { signature: sig(witnessTx('witness-1')), blockTime: WITNESS_TIME }, last: { blockTime: WITNESS_TIME }, signatures: [sig(witnessTx('witness-1'))] });
    expect(row.attributionEvidence!.witnesses!.digest).toMatch(/^[0-9a-f]{64}$/);
    const report = buildReport(s.store, WALLET);
    expect(report.counts).toMatchObject({ confirmed: 0, attributed: 1 });
    expect(report.confirmationBasisCounts).toEqual({ official_feed: 0, same_slot_pattern: 0, verified_historical_authority: 0 });
    expect(report.cumulative.assets).toEqual([]);
  });

  it('attributes via published_withdraw_authority from a snapshot taken after the credit', () => {
    const candidate = candidateTx();
    const s = new Scenario().watched(candidate).snapshot(DISTRIBUTOR, CUTOFF - 100).drain();
    const evidence = s.row(candidate).attributionEvidence!;
    expect(s.row(candidate)).toMatchObject({ status: 'attributed', supportingSignatures: [] });
    expect(evidence).toMatchObject({ trustSources: ['published_withdraw_authority'], primaryTrustSource: 'published_withdraw_authority', witnesses: null,
      secondsToNearestSnapshot: CUTOFF - 100 - CREDIT_TIME });
    expect(evidence.publishedSnapshots).toMatchObject([{ role: 'nearest_at_or_after', authority: DISTRIBUTOR, retrievedAt: iso(CUTOFF - 100),
      generatedAt: null, evidenceId: `configuration-${CUTOFF - 100}` }]);
  });

  it('records both trust sources with feed_witnessed_identity primary, the nearest snapshot before, and a separate fee payer', () => {
    const candidate = candidateTx({ feePayer: FEE_PAYER });
    const s = witnessed().watched(candidate).snapshot(DISTRIBUTOR, CREDIT_TIME - 50, 'before').snapshot(DISTRIBUTOR, CREDIT_TIME + 20, 'after').drain();
    const evidence = s.row(candidate).attributionEvidence!;
    expect(evidence).toMatchObject({ trustSources: ['feed_witnessed_identity', 'published_withdraw_authority'], primaryTrustSource: 'feed_witnessed_identity',
      secondsToNearestSnapshot: 20, signerShape: { kind: 'owner_and_separate_fee_payer', feePayer: FEE_PAYER, signers: [DISTRIBUTOR, FEE_PAYER].sort() } });
    expect(evidence.publishedSnapshots.map(item => [item.role, item.retrievedAt])).toEqual([['nearest_at_or_after', iso(CREDIT_TIME + 20)], ['nearest_before', iso(CREDIT_TIME - 50)]]);
  });

  it('records batch size without gating, dual-role mints, witness relations and a Token-2022 source', () => {
    const single = candidateTx({ label: 'single', legs: [toWallet()] });
    const within = candidateTx({ label: 'within', time: WITNESS_TIME - 10, legs: [toWallet(), ...batch(1, 2)] });
    const after = candidateTx({ label: 'after', time: WITNESS_TIME + 30, legs: [toWallet('5', { mint: SECOND_MINT, program: TOKEN_2022_PROGRAM, destination: syntheticKey('wallet-2022') })] });
    // Witnesses in another quote mint bracket `within`; the historical rule is mint-specific and does not apply.
    const s = new Scenario().official(witnessTx('w-early', WITNESS_TIME - 20, { legs: batch(100, 3, DISTRIBUTOR, SECOND_MINT) }))
      .official(witnessTx('w-late', WITNESS_TIME, { legs: batch(200, 3, DISTRIBUTOR, SECOND_MINT) }))
      .quote(MINT, true, MINT).watched(single, within, after).drain();
    expect(s.row(single).attributionEvidence).toMatchObject({ batch: { outerTransfersFromSource: 1, transfersFromSource: 1, distinctRecipientOwners: 1 },
      creditedMintAlsoRetainedLaunch: true });
    expect(s.row(within).attributionEvidence!.witnesses).toMatchObject({ count: 2, relation: 'within_witness_span', secondsToNearestWitness: 10 });
    const late = s.row(after, syntheticKey('wallet-2022'));
    expect(late.attributionEvidence).toMatchObject({ tokenProgram: TOKEN_2022_PROGRAM, sourceAta: ata(DISTRIBUTOR, SECOND_MINT, TOKEN_2022_PROGRAM) });
    expect(late.attributionEvidence!.witnesses).toMatchObject({ relation: 'after_last_witness', secondsToNearestWitness: 30 });
  });
});

describe('distributor-pattern tier: gate matrix in fixed order', () => {
  it('G1 exact credit: sibling null net, balance change unequal to incoming nets, missing membership', () => {
    const nullNet = candidateTx({ label: 'null-net', legs: [toWallet(), toWallet('7', { destination: syntheticKey('wallet-second') })], missingPre: [syntheticKey('wallet-second')] });
    const unequal = candidateTx({ label: 'unequal', legs: [toWallet('100'),
      { owner: WALLET, source: WALLET_ACCOUNT, authority: DELEGATE, ...recipient(9), amount: '30' }] });
    const otherMint = candidateTx({ label: 'other-mint', legs: [toWallet(), ...batch(1, 1, DISTRIBUTOR, syntheticKey('unregistered'))] });
    const s = witnessed().quote(syntheticKey('unregistered'), false).watched(nullNet, unequal, otherMint).drain();
    expect(s.row(nullNet, syntheticKey('wallet-second')).reasons).toContain('positive_credit_unproven');
    expectUnknown(s.row(nullNet), 'distributor_credit_unreconciled');
    expectUnknown(s.row(unequal), 'distributor_credit_unreconciled');
    expect(s.rows(unequal).find(row => row.status === 'excluded')!.reasons).toEqual(['self_or_outgoing_transfer']);
    expectUnknown(s.row(otherMint), 'distributor_credit_unreconciled');
    const noMembership = new Scenario().quote(MINT, false).official(witnessTx('witness-1')).watched(candidateTx()).drain();
    expectUnknown(noMembership.row(candidateTx()), 'distributor_credit_unreconciled');
  });

  it('G1 missing block time never reaches or passes the tier', () => {
    const tx = candidateTx({ time: null });
    const s = witnessed().watched(tx).drain();
    expect(s.row(tx).reasons).toEqual(['timestamp_missing']);
    const normalized = normalizeTransaction({ transaction: tx, wallet: WALLET, network, provenance });
    const context = attributionContext({ network, authorityHistory: [], snapshots: [] });
    expect(distributorPattern(normalized, normalized.transfers[0]!, WALLET, new Set([MINT]), context)).toEqual({ reasons: ['distributor_credit_unreconciled'] });
  });

  it('G2 trust: none, delegate-authority or non-ATA witnesses, another published address, and a look-alike owner', () => {
    expectUnknown(new Scenario().watched(candidateTx()).drain().row(candidateTx()), 'distributor_trust_unestablished');
    const delegateWitness = new Scenario().official(witnessTx('delegate-witness', WITNESS_TIME, { legs: batch(100, 3).map(leg => ({ ...leg, authority: DELEGATE })) }))
      .watched(candidateTx()).drain();
    expectUnknown(delegateWitness.row(candidateTx()), 'distributor_trust_unestablished');
    const keypairWitness = new Scenario().official(witnessTx('keypair-witness', WITNESS_TIME, { legs: batch(100, 3).map(leg => ({ ...leg, source: syntheticKey('keypair-account') })) }))
      .watched(candidateTx()).drain();
    expectUnknown(keypairWitness.row(candidateTx()), 'distributor_trust_unestablished');
    expectUnknown(new Scenario().watched(candidateTx()).snapshot(OTHER_DISTRIBUTOR, CUTOFF - 100).drain().row(candidateTx()), 'distributor_trust_unestablished');
    const twin = lookAlike(DISTRIBUTOR);
    expect([twin.slice(0, 4), twin.slice(-4)]).toEqual([DISTRIBUTOR.slice(0, 4), DISTRIBUTOR.slice(-4)]);
    const impostor = candidateTx({ label: 'impostor', legs: [toWallet('1000', { owner: twin })] });
    expectUnknown(witnessed().snapshot(DISTRIBUTOR, CUTOFF - 100).watched(impostor).drain().row(impostor), 'distributor_trust_unestablished');
  });

  it('G3 own ATA: keypair source, wrong token program, and a second source owner', () => {
    const keypair = candidateTx({ label: 'keypair', legs: [toWallet('1000', { source: syntheticKey('distributor-keypair-account') })] });
    const wrongProgram = candidateTx({ label: 'wrong-program', legs: [toWallet('1000', { program: TOKEN_2022_PROGRAM, source: ata(DISTRIBUTOR, MINT, SPL_TOKEN_PROGRAM) })] });
    const mixed = candidateTx({ label: 'mixed', legs: [toWallet(), { ...recipient(1), amount: '5', owner: OTHER_DISTRIBUTOR }] });
    const s = witnessed().watched(keypair, wrongProgram, mixed).drain();
    for (const tx of [keypair, wrongProgram, mixed]) expectUnknown(s.row(tx), 'distributor_source_not_ata');
  });

  it('G4 signer shape: owner not signing, delegate, multisig, extra signer, and wallet in account keys', () => {
    const unsigned = candidateTx({ label: 'unsigned', feePayer: FEE_PAYER, legs: [toWallet('1000', { signs: false }), ...batch(1, 2).map(leg => ({ ...leg, signs: false }))] });
    const delegate = candidateTx({ label: 'delegate', legs: [toWallet('1000', { authority: DELEGATE })] });
    const multisig = candidateTx({ label: 'multisig', feePayer: FEE_PAYER, legs: [toWallet('1000', { authority: DISTRIBUTOR, multisigSigners: [syntheticKey('cosigner')] })] });
    const extra = candidateTx({ label: 'extra-signer', extraSigners: [syntheticKey('third-signer')] });
    const walletKey = candidateTx({ label: 'wallet-key', extraKeys: [{ pubkey: WALLET }] });
    const s = witnessed().watched(unsigned, delegate, multisig, extra, walletKey).drain();
    for (const tx of [unsigned, delegate, multisig, extra]) expectUnknown(s.row(tx), 'distributor_signer_shape_unsupported');
    expectUnknown(s.row(walletKey), 'wallet_in_account_keys');
  });

  it('G4 allows the wallet key solely as the owner seed of a recognized creation of its own account', () => {
    const candidate = createdForWallet();
    const s = witnessed().watched(candidate).drain();
    const row = s.row(candidate);
    expect(row).toMatchObject({ status: 'attributed', basis: 'distributor_pattern', netRaw: '1000000',
      reasons: ['trusted_distributor_pattern_and_proven_credit'] });
    const keys = candidate.transaction.message.accountKeys.find(item => item.pubkey === WALLET)!;
    expect(keys).toMatchObject({ signer: false, writable: false });
  });

  it.each([
    ['a writable wallet key', { extraKeys: [{ pubkey: WALLET, writable: true }] }],
    ['a wallet referenced by another instruction', { extraInstructions: [{ programId: syntheticKey('wrapper'), accounts: [WALLET], data: '2' }] }],
    ['a creation unit for another owner', { creations: [{ account: syntheticKey('other-account'), owner: OTHER_DISTRIBUTOR }],
      extraKeys: [{ pubkey: WALLET }], missingPre: [] }],
  ])('G4 still refuses %s', (_label, shape: Partial<PayoutShape>) => {
    const candidate = createdForWallet({ label: `wallet-seed-${_label}`, ...shape });
    const s = witnessed().watched(candidate).drain();
    expectUnknown(s.row(candidate), 'wallet_in_account_keys');
  });

  it('reports the signer shape before the account-key allowance when the wallet also signs', () => {
    const candidate = createdForWallet({ label: 'wallet-signs', extraSigners: [WALLET] });
    const tx = normalizeTransaction({ transaction: candidate, wallet: WALLET, network, provenance });
    const context = attributionContext({ network, authorityHistory: [],
      snapshots: withdrawalSnapshots(configurationFeed(DISTRIBUTOR, CUTOFF)) });
    expect(distributorPattern(tx, tx.transfers[0]!, WALLET, new Set([MINT]), context).reasons)
      .toEqual(['distributor_signer_shape_unsupported']);
  });

  it('G5 payout structure: undecoded instruction and unexplained native movement; compute budget alone passes', () => {
    const undecoded = candidateTx({ label: 'undecoded', extraInstructions: [{ programId: syntheticKey('unknown-program'), accounts: [], data: '2' }] });
    const native = candidateTx({ label: 'native', nativeLeak: true });
    const plain = candidateTx({ label: 'no-compute', computeBudget: false });
    const s = witnessed().watched(undecoded, native, plain).drain();
    expectUnknown(s.row(undecoded), null); expect(s.row(undecoded).reasons).toEqual(expect.arrayContaining(['uninterpreted_activity', 'unresolved_normalization']));
    expectUnknown(s.row(native), null); expect(s.row(native).reasons).toContain('unexplained_native_movement');
    expect(s.row(plain).status).toBe('attributed');
  });

  it('G6 conflicts: contested witness and official-row contradiction of another identity transaction', () => {
    const contested = witnessTx('contested-witness', WITNESS_TIME - 500);
    const s = witnessed().official(contested).official(contested, officialFeed(contested, { evidenceId: 'conflicting-feed', amountRaw: '1' }))
      .watched(candidateTx()).drain();
    expectUnknown(s.row(candidateTx()), 'distributor_identity_conflicted');
    expect(s.store.identityConflicts(network)).toMatchObject([{ signature: sig(contested), owner: DISTRIBUTOR, reasons: ['conflicting_feed_rows'] }]);
    const contradiction = witnessTx('contradicted', WITNESS_TIME - 700);
    const t = witnessed().official(contradiction, officialFeed(contradiction, { amountRaw: '1' })).watched(candidateTx()).drain();
    expectUnknown(t.row(candidateTx()), 'distributor_identity_conflicted');
    expect(t.store.identityConflicts(network)).toMatchObject([{ owner: DISTRIBUTOR, reasons: ['amount_mismatch'] }]);
  });

  it('G6 published timeline: rotation gap, pending snapshot and same-second disagreement', () => {
    const t1 = CUTOFF - 5000; const t2 = CUTOFF - 1000;
    const aBefore = candidateTx({ label: 'a-before', time: t1 - 10 });
    const aGap = candidateTx({ label: 'a-gap', time: t1 + 10 });
    const aAt = candidateTx({ label: 'a-at', time: t1 });
    const bBefore = candidateTx({ label: 'b-before', time: t1 - 20, legs: [toWallet('1000', { owner: OTHER_DISTRIBUTOR })] });
    const bGap = candidateTx({ label: 'b-gap', time: t2, legs: [toWallet('1000', { owner: OTHER_DISTRIBUTOR })] });
    const bAfter = candidateTx({ label: 'b-after', time: t2 + 10, legs: [toWallet('1000', { owner: OTHER_DISTRIBUTOR })] });
    const s = new Scenario().watched(aBefore, aGap, aAt, bBefore, bGap, bAfter).snapshot(DISTRIBUTOR, t1).snapshot(OTHER_DISTRIBUTOR, t2).drain();
    expect(s.row(aBefore).status).toBe('attributed'); expect(s.row(aAt).status).toBe('attributed');
    expectUnknown(s.row(aGap), 'published_authority_rotation_ambiguous');
    expectUnknown(s.row(bBefore), 'published_authority_rotation_ambiguous');
    expectUnknown(s.row(bGap), 'published_authority_rotation_ambiguous');
    expectUnknown(s.row(bAfter), 'published_authority_snapshot_pending');
    const same = new Scenario().watched(candidateTx()).snapshot(DISTRIBUTOR, CUTOFF - 100, 'a').snapshot(OTHER_DISTRIBUTOR, CUTOFF - 100, 'b').drain();
    expectUnknown(same.row(candidateTx()), 'published_authority_rotation_ambiguous');
    // Feed-witnessed trust is independent evidence: a published rotation does not remove it.
    const witnessedGap = witnessed().watched(aGap).snapshot(DISTRIBUTOR, t1).snapshot(OTHER_DISTRIBUTOR, t2).drain();
    expect(witnessedGap.row(aGap).attributionEvidence!.trustSources).toEqual(['feed_witnessed_identity']);
  });

  it('G6 quarantined signature variants never reach the tier', () => {
    const indexed = candidateTx({ transactionIndex: 3 });
    const contradictory = structuredClone(indexed); contradictory.transactionIndex = 4;
    const s = witnessed().watched(indexed, contradictory).drain();
    expect(s.row(indexed)).toMatchObject({ status: 'unknown_candidate', reasons: ['conflicting_evidence_quarantined'] });
  });

  it('keeps address-poisoning dust unknown with G2 recorded first', () => {
    const twin = lookAlike(DISTRIBUTOR);
    const dust = payout({ label: 'dust', time: CREDIT_TIME, feePayer: twin, legs: [toWallet('100', { owner: twin })],
      extraInstructions: [createIdempotent(twin, WALLET_ACCOUNT, WALLET, MINT)] });
    const s = witnessed().snapshot(DISTRIBUTOR, CUTOFF - 100).watched(dust).drain();
    expect(dust.transaction.message.accountKeys.some(item => item.pubkey === WALLET)).toBe(true);
    expectUnknown(s.row(dust), 'distributor_trust_unestablished');
    expect(s.row(dust).reasons).toEqual(expect.arrayContaining(['uninterpreted_activity', 'payout_origin_unverified']));
  });
});

describe('distributor-pattern tier: precedence', () => {
  it('never attributes excluded rows or signatures an official row names', () => {
    const signed = candidateTx({ label: 'wallet-signs', extraSigners: [WALLET] });
    const failed = candidateTx({ label: 'failed', failed: true });
    const unreconciled = candidateTx({ label: 'unreconciled' });
    const s = witnessed().watched(signed, failed).official(unreconciled, officialFeed(unreconciled, { amountRaw: '1' })).watched(unreconciled).drain();
    expect(s.row(signed)).toMatchObject({ status: 'excluded', reasons: ['wallet_participation'] });
    expect(s.row(failed)).toMatchObject({ status: 'excluded', reasons: ['failed_transaction'] });
    const official = s.row(unreconciled);
    expectUnknown(official, null); expect(official.reasons).toContain('amount_mismatch');
  });

  it('keeps exact-feed confirmation for a trusted distributor credit named by an official row', () => {
    const named = candidateTx({ label: 'named' });
    const s = witnessed().official(named).watched(named).drain();
    expect(s.row(named)).toMatchObject({ status: 'confirmed', basis: 'official_feed', attributionEvidence: null });
    expect(buildReport(s.store, WALLET).counts).toMatchObject({ confirmed: 1, attributed: 0 });
  });

  it('ATA derivation matches known answers and rejects the wrong token program', () => {
    const HUB = 'HuBMeYW3aDn8BH65fo8xxbP4oiexyup8udzKyccgi8Ga';
    expect(associatedTokenAddress(HUB, 'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua', TOKEN_2022_PROGRAM)).toEqual({ address: '42Ygu2TKMDkiWArhxg8Q7cskA3jGoBGhiWzvBujZNeBy', bump: 255 });
    expect(associatedTokenAddress(HUB, 'DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow', TOKEN_2022_PROGRAM)).toEqual({ address: '299ghPkA7jpN7Waz6dyDLMaWZp5NLnGdNucakc6aUorB', bump: 254 });
    expect(associatedTokenAddress(HUB, 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', TOKEN_2022_PROGRAM)).toEqual({ address: 'DmfR8XnUrCGydyzbF7ygN8EF78grdr9dHAaDsLh7SvgB', bump: 250 });
    expect(associatedTokenAddress(HUB, 'DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow', SPL_TOKEN_PROGRAM)?.address).not.toBe('299ghPkA7jpN7Waz6dyDLMaWZp5NLnGdNucakc6aUorB');
    expect(associatedTokenAddress('8'.repeat(32), MINT, SPL_TOKEN_PROGRAM)).toBeNull();
  });
});

describe('distributor-pattern tier: invalidation, revocation and repeatability', () => {
  it('a newer snapshot demotes attributed rows and queues every signature in the same transaction, before processDirty', () => {
    const candidate = candidateTx();
    const s = new Scenario().watched(candidate).snapshot(DISTRIBUTOR, CUTOFF - 100).drain();
    expect(s.row(candidate).status).toBe('attributed');
    s.snapshot(DISTRIBUTOR, CUTOFF - 50, 'later');
    expect(s.row(candidate)).toMatchObject({ status: 'unknown_candidate', reasons: ['attribution_recheck_pending'] });
    // Awaiting recheck is not evaluated: the demoted row is never counted and the total is null, not 0.
    expect(buildReport(s.store, WALLET)).toMatchObject({ counts: { attributed: null }, attribution: { evaluated: false } });
    expect(s.store.dirty(network, 100)).toEqual([sig(candidate)]);
    s.drain(); expect(s.row(candidate).status).toBe('attributed');
    expect(buildReport(s.store, WALLET)).toMatchObject({ counts: { attributed: 1 }, attribution: { evaluated: true } });
    // A rotation snapshot before the credit's nearest snapshot leaves it covered; one between turns it ambiguous.
    s.snapshot(OTHER_DISTRIBUTOR, CREDIT_TIME + 1, 'rotation').drain();
    expectUnknown(s.row(candidate), 'published_authority_rotation_ambiguous');
  });

  it('witness contest and changed witness evidence demote before reclassification', () => {
    const candidate = candidateTx(); const witness = witnessTx('witness-1');
    const contest = witnessed().watched(candidate).drain();
    expect(contest.row(candidate).status).toBe('attributed');
    contest.store.addFeed(officialFeed(witness, { evidenceId: 'contesting-feed', amountRaw: '1' }));
    expect(contest.row(candidate)).toMatchObject({ status: 'unknown_candidate', reasons: ['attribution_recheck_pending'] });
    contest.drain(); expect(contest.row(candidate).status).toBe('unknown_candidate');
    const changed = witnessed().watched(candidate).drain();
    const variant = structuredClone(witness); variant.meta.postTokenBalances[1]!.uiTokenAmount.amount = '1';
    changed.store.addTransaction(network, variant, provenance);
    expect(changed.row(candidate)).toMatchObject({ status: 'unknown_candidate', reasons: ['attribution_recheck_pending'] });
    changed.drain(); expectUnknown(changed.row(candidate), 'distributor_trust_unestablished');
  });

  it('an identity conflict recorded during processing demotes and blocks attribution', () => {
    const candidate = candidateTx();
    const s = witnessed().watched(candidate).drain();
    expect(s.row(candidate).status).toBe('attributed');
    const contradiction = witnessTx('contradicted', WITNESS_TIME - 700);
    s.official(contradiction, officialFeed(contradiction, { amountRaw: '1' }));
    processDirty(s.store, network, 1);
    expect(s.row(candidate).status).toBe('unknown_candidate');
    s.drain(); expectUnknown(s.row(candidate), 'distributor_identity_conflicted');
  });

  it('local revocation is validated, idempotent, and restores only when the gates pass again', () => {
    const candidate = candidateTx();
    const s = witnessed().watched(candidate).drain();
    expect(() => s.store.saveAttributionRevocation(network, OTHER_DISTRIBUTOR, 0, 'unverified')).toThrow('unverified_attribution_revocation');
    expect(() => s.store.saveAttributionRevocation(network, DISTRIBUTOR, -1, 'negative')).toThrow('invalid_attribution_revocation');
    expect(() => s.store.saveAttributionRevocation(network, DISTRIBUTOR, 0, 'bad id!')).toThrow('invalid_attribution_revocation');
    s.store.saveAttributionRevocation(network, DISTRIBUTOR, CREDIT_TIME + 1, 'after-credit');
    expect(s.row(candidate).reasons).toEqual(['attribution_recheck_pending']);
    s.drain(); expect(s.row(candidate).status).toBe('attributed');
    s.store.saveAttributionRevocation(network, DISTRIBUTOR, CREDIT_TIME + 1, 'after-credit');
    expect(s.store.dirty(network, 100)).toEqual([]);
    expect(() => s.store.saveAttributionRevocation(network, DISTRIBUTOR, CREDIT_TIME, 'after-credit')).toThrow('conflicting_attribution_revocation');
    s.store.saveAttributionRevocation(network, DISTRIBUTOR, CREDIT_TIME, 'at-credit'); s.drain();
    expectUnknown(s.row(candidate), 'distributor_attribution_revoked');
    expect(s.store.attributionRevocations(network).map(item => [item.decisionId, item.effectiveFrom, item.trustSources, item.scope])).toEqual([
      ['at-credit', CREDIT_TIME, ['feed_witnessed_identity'], 'local_safety_revocation'],
      ['after-credit', CREDIT_TIME + 1, ['feed_witnessed_identity'], 'local_safety_revocation']]);
    const before = witnessed().watched(candidate).drain();
    before.store.saveAttributionRevocation(network, DISTRIBUTOR, 0, 'all'); before.drain();
    expectUnknown(before.row(candidate), 'distributor_attribution_revoked');
  });

  it('reclassification is byte-identical after requeueing everything', () => {
    const s = witnessed().watched(candidateTx(), candidateTx({ label: 'unknown', legs: [toWallet('9', { owner: OTHER_DISTRIBUTOR })] }))
      .snapshot(DISTRIBUTOR, CUTOFF - 100).drain();
    const snapshot = () => {
      const db = new DatabaseSync(s.path, { readOnly: true });
      try {
        const bodies = db.prepare('SELECT body FROM classifications ORDER BY network,wallet,identity').all().map(row => String(row.body)).join('\n');
        return createHash('sha256').update(bodies).update(JSON.stringify(buildReport(s.store, WALLET))).digest('hex');
      } finally { db.close(); }
    };
    const first = snapshot();
    expect(buildReport(s.store, WALLET).counts).toMatchObject({ attributed: 1, unknown_candidate: 1 });
    const db = new DatabaseSync(s.path); db.exec('INSERT OR IGNORE INTO dirty SELECT DISTINCT network,signature FROM transactions'); db.close();
    expect(s.store.dirty(network, 100).length).toBeGreaterThan(1);
    s.drain();
    expect(snapshot()).toBe(first);
  });
});

describe('native-SOL lane: lamport payouts from a trusted distributor', () => {
  const lamports = 875_611_896;
  const nativeTx = (shape: Partial<NativeShape> = {}) => nativePayout({ label: 'native', time: CREDIT_TIME,
    credits: [{ destination: WALLET, lamports }, { destination: syntheticKey('other-recipient'), lamports: 1000 }], ...shape });

  it('attributes a distributor-funded lamport batch under its own lane and native mint', () => {
    const candidate = nativeTx();
    const s = witnessed().watched(candidate).drain();
    const row = s.rows(candidate)[0]!;
    expect(row).toMatchObject({ status: 'attributed', basis: 'distributor_pattern', temporalScope: 'identity_attributed',
      reasons: ['trusted_distributor_pattern_and_proven_credit'], mint: 'native-sol', decimals: 9,
      netRaw: String(lamports), grossRaw: String(lamports), recipient: WALLET, destinationOwner: WALLET,
      sourceAccount: DISTRIBUTOR, sourceOwner: DISTRIBUTOR, authority: DISTRIBUTOR, program: '11111111111111111111111111111111' });
    expect(row.attributionEvidence).toMatchObject({ lane: 'native_sol', mint: 'native-sol', sourceOwner: DISTRIBUTOR,
      sourceAta: DISTRIBUTOR, ataBump: null, tokenProgram: '11111111111111111111111111111111',
      trustSources: ['feed_witnessed_identity'], creditedMintAlsoRetainedLaunch: false,
      batch: { outerTransfersFromSource: 2, transfersFromSource: 2, distinctRecipientOwners: 2 } });
    // Reported under Attributed as its own asset, and never summed into the verified totals.
    const report = buildReport(s.store, WALLET);
    expect(report.totals.attributed.cumulative?.assets).toMatchObject([{ mint: 'native-sol', symbol: 'SOL', amount: '0.875611896' }]);
    expect(report.totals.verified.cumulative.assets).toEqual([]);
  });

  it('excludes the same shape from a sender no trusted identity names', () => {
    const candidate = nativeTx({ label: 'untrusted', source: syntheticKey('untrusted-sender') });
    const s = witnessed().watched(candidate).drain();
    expect(s.rows(candidate)[0]).toMatchObject({ status: 'excluded', reasons: ['no_token_credit_to_wallet'],
      mint: null, netRaw: null, attributionEvidence: null });
  });

  it.each([
    ['a token movement in the same transaction', { tokenAccount: { address: syntheticKey('third-party-account'),
      owner: OTHER_DISTRIBUTOR, pre: '1000', post: '900' } }, 'distributor_credit_unreconciled'],
    ['a lamport delta the System transfers do not explain', { unexplainedLamports: { destination: WALLET, lamports: 7 } }, 'distributor_credit_unreconciled'],
    ['a second funding source', { extraInstructions: [{ program: 'system', programId: '11111111111111111111111111111111',
      parsed: { type: 'transfer', info: { source: FEE_PAYER, destination: syntheticKey('other-recipient'), lamports: 0 } } }] }, 'distributor_native_source_unsupported'],
    ['an undecoded wrapper around the batch', { wrapper: syntheticKey('lamport-wrapper') }, 'uninterpreted_activity'],
  ])('keeps a distributor-funded batch with %s unknown and never excluded', (label, shape: Partial<NativeShape>, reason) => {
    const candidate = nativeTx({ label: `native-${label}`, ...shape });
    const s = witnessed().watched(candidate).drain();
    const row = s.rows(candidate)[0]!;
    expect(row.status).toBe('unknown_candidate');
    expect(row.reasons[0]).toBe('native_credit_from_distributor_unproven');
    expect(row.reasons).toContain(reason);
    expect(row).toMatchObject({ mint: null, netRaw: null, attributionEvidence: null });
  });

  it('prices native SOL under the mint both sources quote it with, and saves it under the sentinel', async () => {
    const s = witnessed().watched(nativeTx({ label: 'native-priced' })).drain();
    const priced: string[] = [];
    let clock = CUTOFF * 1000;
    const providers = (): Providers => ({
      registry: () => Promise.resolve({ feeds: [], quotes: [], retrievedAt: iso(CUTOFF), complete: true, detail: 'synthetic' }),
      hydrate: () => Promise.resolve(null),
      history: () => Promise.resolve({ continuation: { restartRequired: false } } as unknown as HistoryResult),
      price: mint => { priced.push(mint); return Promise.resolve({ mint, currency: 'USD', value: '200.00',
        provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF), expiresAt: 0, reason: null }); },
    });
    await runScan(s.store, { wallet: WALLET, cutoff: CUTOFF, jobId: 'native-pricing', owner: 'owner',
      limits: { stonkfun: 20, helius: 20, pages: 10, resumes: 2, deadline: CUTOFF * 1000 + 3600_000 } },
    providers, { now: () => (clock += 1000) });
    expect(priced).toEqual(['So11111111111111111111111111111111111111112']);
    expect(s.store.price(network, 'native-sol')).toMatchObject({ mint: 'native-sol', value: '200.00' });
    expect(buildReport(s.store, WALLET).totals.attributed.cumulative?.currentUsd).toBe('175.122379');
  });

  it('excludes a signing wallet as participation, and G4n refuses it independently', () => {
    const candidate = nativeTx({ label: 'wallet-signs', extraSigners: [WALLET] });
    const s = witnessed().watched(candidate).drain();
    expect(s.rows(candidate)[0]).toMatchObject({ status: 'excluded', reasons: ['wallet_participation'] });
    const tx = normalizeTransaction({ transaction: candidate, wallet: WALLET, network, provenance });
    const context = attributionContext({ network, authorityHistory: [],
      snapshots: withdrawalSnapshots(configurationFeed(DISTRIBUTOR, CUTOFF)) });
    expect(nativeDistributorPattern(tx, WALLET, context)?.outcome.reasons).toEqual(['distributor_signer_shape_unsupported']);
  });
});

describe('transactions with no supported transfer: X1, X2 and X3', () => {
  const noTransfer = (shape: Partial<PayoutShape> = {}) => payout({ label: 'no-transfer', time: CREDIT_TIME,
    legs: [], feePayer: OTHER_DISTRIBUTOR, ...shape });
  const classify = (tx: FullTransaction) => new Scenario().watched(tx).drain().rows(tx)[0]!;

  it('excludes a zero-value credit into an account this transaction provably created', () => {
    const tx = noTransfer({ label: 'zero-value', creations: [{ account: WALLET_ACCOUNT, owner: WALLET }],
      extraBalances: [{ address: WALLET_ACCOUNT, owner: WALLET, post: '0' }] });
    expect(classify(tx)).toMatchObject({ status: 'excluded', reasons: ['zero_value_token_credit'], mint: null, netRaw: null });
  });

  it('keeps a wallet-owned credit with no supported transfer instruction unknown, never excluded', () => {
    const tx = noTransfer({ label: 'minted', extraBalances: [{ address: WALLET_ACCOUNT, owner: WALLET, pre: '0', post: '10000000' }],
      extraInstructions: [{ program: 'spl-token', programId: TOKEN_2022_PROGRAM,
        parsed: { type: 'mintTo', info: { mint: MINT, account: WALLET_ACCOUNT, mintAuthority: OTHER_DISTRIBUTOR, amount: '10000000' } } }] });
    expect(classify(tx)).toMatchObject({ status: 'unknown_candidate',
      reasons: ['credit_without_supported_transfer_instruction'], mint: null, netRaw: null });
  });

  it('keeps an existing account holding zero unknown, because nothing proves it was created here', () => {
    const tx = noTransfer({ label: 'existing-zero', extraBalances: [{ address: WALLET_ACCOUNT, owner: WALLET, pre: '0', post: '0' }] });
    expect(classify(tx)).toMatchObject({ status: 'unknown_candidate', reasons: ['credit_without_supported_transfer_instruction'] });
  });

  it('never excludes a wallet-owned row whose owner consensus is contradicted', () => {
    // A `setAuthority`-style transaction can name one owner in the instruction and another in the
    // balance row. That is an unresolved observation, not evidence that nothing was credited.
    const tx = noTransfer({ label: 'contradicted-owner',
      extraBalances: [{ address: WALLET_ACCOUNT, owner: WALLET, pre: '0', post: '10000000' }],
      extraInstructions: [{ program: 'spl-token', programId: SPL_TOKEN_PROGRAM, parsed: { type: 'initializeAccount3',
        info: { account: WALLET_ACCOUNT, mint: MINT, owner: OTHER_DISTRIBUTOR } } }] });
    const row = classify(tx);
    expect(row).toMatchObject({ status: 'unknown_candidate', reasons: ['credit_without_supported_transfer_instruction'] });
  });

  it.each([
    ['a failed transaction', { failed: true }, 'failed_transaction'],
    ['a wallet-signed transaction', { extraKeys: [{ pubkey: WALLET, signer: true }] }, 'wallet_participation'],
  ])('reports %s before any of the new reasons', (_label, shape: Partial<PayoutShape>, reason) => {
    expect(classify(noTransfer({ label: `precedence-${reason}`, ...shape })))
      .toMatchObject({ status: 'excluded', reasons: [reason] });
  });
});

describe('attributed receipts survive selling', () => {
  it('keeps the receipt, the receipt count and its USD after the wallet swaps and transfers the token out', () => {
    const candidate = candidateTx();
    const s = witnessed().watched(candidate).drain();
    s.store.savePrice(network, { mint: MINT, currency: 'USD', value: '2.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF),
      expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    const before = buildReport(s.store, WALLET);
    const receipt = s.row(candidate);
    expect(receipt).toMatchObject({ status: 'attributed', netRaw: '1000000' });
    expect(before.counts.attributed).toBe(1);
    expect(before.totals.attributed.cumulative).toMatchObject({ currentUsd: '2.000000', assets: [{ mint: MINT, amount: '1.000000', receipts: 1 }] });
    const beforeView = reportView(before).attribution.receipts;
    expect(beforeView?.map(item => [item.id, item.currentUsd])).toEqual([[expect.any(String), '2.000000']]);

    // Later the wallet swaps most of the token for another through a pool whose program-owned account does not sign, then sends
    // the rest to another wallet. It signs both, as the fee payer and the source authority.
    const POOL = syntheticKey('swap-pool'); const OUTPUT = syntheticKey('swap-output-mint'); const FRIEND = syntheticKey('friend-wallet');
    const swap = payout({ label: 'wallet-swap', time: CREDIT_TIME + 3600, feePayer: WALLET, legs: [
      { owner: WALLET, source: WALLET_ACCOUNT, authority: WALLET, destination: ata(POOL, MINT), destinationOwner: POOL, amount: '600000' },
      { owner: POOL, signs: false, destination: ata(WALLET, OUTPUT), destinationOwner: WALLET, amount: '1200000', mint: OUTPUT }] });
    const transfer = payout({ label: 'wallet-transfer', time: CREDIT_TIME + 7200, feePayer: WALLET, legs: [
      { owner: WALLET, source: WALLET_ACCOUNT, authority: WALLET, destination: ata(FRIEND, MINT), destinationOwner: FRIEND, amount: '400000' }] });
    s.watched(swap, transfer).drain();

    // Neither sale is a payout, and the receipt, its count and its USD are exactly as they were.
    for (const tx of [swap, transfer]) expect(s.rows(tx).filter(row => row.status === 'attributed' || row.status === 'confirmed')).toEqual([]);
    expect([swap, transfer].map(tx => s.rows(tx).map(row => [row.status, row.mint, row.netRaw, row.reasons]))).toEqual([
      [['excluded', MINT, '600000', ['self_or_outgoing_transfer']], ['excluded', OUTPUT, '1200000', ['wallet_participation']]],
      [['excluded', MINT, '400000', ['self_or_outgoing_transfer']]]]);
    const after = buildReport(s.store, WALLET);
    expect(s.row(candidate)).toEqual(receipt);
    expect(after.counts.attributed).toBe(1);
    expect(after.totals.attributed).toEqual(before.totals.attributed);
    expect(after.totals.attributed.cumulative).toMatchObject({ currentUsd: '2.000000', assets: [{ mint: MINT, amount: '1.000000', receipts: 1 }] });
    expect(reportView(after).attribution.receipts).toEqual(beforeView);
  });
});
