import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  accountMovement, batchShape, dayStatuses, defaultDatabasePath, failingGate, isLiveDatabasePath, isOutlier, mintMovements, reconcile, signedAmount, tierOf,
} from '../src/scanner/reconcile.js';
import type { AccountObservation, TieredMovement, TierRow } from '../src/scanner/reconcile.js';
import { HISTORY_FLOOR } from '../src/scanner/ranges.js';

// SYNTHETIC fixtures: signatures and accounts are labels, amounts are small raw integers. Nothing here comes from a saved wallet.
const MINT = 'MintA'; const OTHER = 'MintB';
const observation = (partial: Partial<AccountObservation> & { signature: string }): AccountObservation => ({
  slot: 1, position: null, time: HISTORY_FLOOR + 3600, account: 'acct', preRaw: null, postRaw: null, balanceChangeRaw: null, createdInTransaction: false, ...partial,
});
const movement = (partial: Partial<TieredMovement> & { signature: string; tier: TieredMovement['tier'] }): TieredMovement => ({
  slot: 1, position: null, time: HISTORY_FLOOR + 3600, raw: 0n, retained: 1, notRetained: 0, ...partial,
});
const row = (partial: Partial<TierRow> & { status: TierRow['status'] }): TierRow => ({ mint: MINT, reasons: [], sourceOwner: null, ...partial });

describe('account movements from saved balances', () => {
  it('takes the normalizer balance change, either sign, before anything else', () => {
    expect(accountMovement(observation({ signature: 'a', balanceChangeRaw: '150', preRaw: '1', postRaw: '999' }))).toBe(150n);
    expect(accountMovement(observation({ signature: 'a', balanceChangeRaw: '-40', preRaw: '50', postRaw: '10' }))).toBe(-40n);
  });
  it('falls back to post minus pre only when both balances were reported', () => {
    expect(accountMovement(observation({ signature: 'a', preRaw: '100', postRaw: '130' }))).toBe(30n);
    expect(accountMovement(observation({ signature: 'a', preRaw: '100', postRaw: '70' }))).toBe(-30n);
    expect(accountMovement(observation({ signature: 'a', preRaw: '100', postRaw: null }))).toBeNull();
    expect(accountMovement(observation({ signature: 'a', preRaw: null, postRaw: '100' }))).toBeNull();
  });
  it('credits the post balance of an account provably created in the transaction, and never infers zero otherwise', () => {
    expect(accountMovement(observation({ signature: 'a', postRaw: '25', createdInTransaction: true }))).toBe(25n);
    expect(accountMovement(observation({ signature: 'a', postRaw: '25', createdInTransaction: false }))).toBeNull();
    expect(accountMovement(observation({ signature: 'a', preRaw: '5', postRaw: '25', createdInTransaction: true }))).toBe(20n);
  });
  it('sums the accounts of one signature, keeps not-retained ones visible, drops unchanged signatures and orders by slot', () => {
    const rows = [
      observation({ signature: 'later', slot: 9, account: 'x', balanceChangeRaw: '7' }),
      observation({ signature: 'two-accounts', slot: 3, account: 'x', balanceChangeRaw: '10' }),
      observation({ signature: 'two-accounts', slot: 3, account: 'y', balanceChangeRaw: '-4' }),
      observation({ signature: 'unchanged', slot: 4, account: 'x', balanceChangeRaw: '0' }),
      observation({ signature: 'unchanged-pair', slot: 5, account: 'x', preRaw: '8', postRaw: '8' }),
      observation({ signature: 'mixed', slot: 6, account: 'x', balanceChangeRaw: '3' }),
      observation({ signature: 'mixed', slot: 6, account: 'y', preRaw: null, postRaw: '9' }),
      observation({ signature: 'unretained', slot: 7, account: 'x', preRaw: '1', postRaw: null }),
      observation({ signature: 'same-slot-b', slot: 8, position: 2, account: 'x', balanceChangeRaw: '1' }),
      observation({ signature: 'same-slot-a', slot: 8, position: 1, account: 'x', balanceChangeRaw: '1' }),
    ];
    expect(mintMovements(rows).map(item => [item.signature, item.raw, item.retained, item.notRetained])).toEqual([
      ['two-accounts', 6n, 2, 0], ['mixed', 3n, 1, 1], ['unretained', null, 0, 1], ['same-slot-a', 1n, 1, 0], ['same-slot-b', 1n, 1, 0], ['later', 7n, 1, 0]]);
  });
});

describe('tiers and gates from saved classification rows', () => {
  it('reads the rows naming the mint, confirmed over attributed over unknown over excluded', () => {
    expect(tierOf([row({ status: 'excluded', reasons: ['self_or_outgoing_transfer'] }), row({ status: 'attributed', reasons: ['trusted_distributor_pattern_and_proven_credit'] })], MINT))
      .toEqual({ tier: 'attributed', reasons: ['trusted_distributor_pattern_and_proven_credit'], gate: null });
    expect(tierOf([row({ status: 'confirmed' }), row({ status: 'attributed' })], MINT).tier).toBe('confirmed');
    expect(tierOf([row({ status: 'excluded', reasons: ['wallet_participation'] }), row({ status: 'excluded', reasons: ['self_or_outgoing_transfer'] })], MINT))
      .toEqual({ tier: 'excluded', reasons: ['wallet_participation', 'self_or_outgoing_transfer'], gate: null });
  });
  it('ignores rows of other mints, falls back to the no-mint placeholder row, and reports no row as not classified', () => {
    expect(tierOf([row({ status: 'attributed', mint: OTHER })], MINT).tier).toBe('not classified');
    expect(tierOf([row({ status: 'attributed', mint: OTHER }), row({ status: 'excluded', mint: null, reasons: ['no_token_credit_to_wallet'] })], MINT).tier).toBe('excluded');
    expect(tierOf([], MINT)).toEqual({ tier: 'not classified', reasons: [], gate: null });
  });
  it('names the failing gate of an unknown row, the earliest gate when several codes are present, and none for unmapped reasons', () => {
    const unknown = row({ status: 'unknown_candidate', reasons: ['missing_official_distribution', 'payout_origin_unverified', 'distributor_trust_unestablished'] });
    expect(tierOf([unknown], MINT).gate).toMatch(/^G2 trusted distributor/);
    expect(failingGate(['wallet_in_account_keys', 'distributor_trust_unestablished'])).toMatch(/^G2/);
    expect(failingGate(['missing_official_distribution', 'unexplained_native_movement', 'payout_origin_unverified'])).toMatch(/^G5 payout structure: unexplained native movement/);
    expect(failingGate(['reward_quote_unverified'])).toMatch(/^G1/);
    expect(failingGate(['credit_without_supported_transfer_instruction'])).toMatch(/^tier not entered/);
    expect(failingGate(['missing_official_distribution', 'payout_origin_unverified'])).toBeNull();
  });
});

describe('reconciliation sums and the implied floor balance', () => {
  const snapshot = { raw: 1_000n, time: HISTORY_FLOOR + 10 * 86400 };
  it('sums inflow by tier and all outflow, and implies the floor balance from the snapshot', () => {
    const movements = [
      movement({ signature: 'a1', tier: 'attributed', raw: 300n }), movement({ signature: 'a2', tier: 'attributed', raw: 200n }),
      movement({ signature: 'u1', tier: 'unknown', raw: 50n }), movement({ signature: 'c1', tier: 'confirmed', raw: 10n }),
      movement({ signature: 'x1', tier: 'excluded', raw: 40n }), movement({ signature: 'n1', tier: 'not classified', raw: 5n }),
      movement({ signature: 'out1', tier: 'excluded', raw: -120n }), movement({ signature: 'out2', tier: 'attributed', raw: -30n }),
    ];
    const result = reconcile(movements, snapshot);
    expect(result).toMatchObject({ attributedIn: 500n, unknownIn: 50n, confirmedIn: 10n, excludedIn: 40n, notClassifiedIn: 5n, allOut: 150n, notRetained: 0,
      beforeFloor: 0, afterSnapshot: 0, undated: 0 });
    // 300 + 200 + 50 + 10 + 40 + 5 - 120 - 30 = 455 net in; the snapshot holds 1,000, so 545 was already there at the floor.
    expect(result.netSinceFloor).toBe(455n);
    expect(result.impliedAtFloor).toBe(545n);
  });
  it('leaves movements before the floor out, keeps movements after the snapshot out of the net, counts undated ones, and counts not-retained signatures', () => {
    const movements = [
      movement({ signature: 'old', tier: 'attributed', raw: 999n, time: HISTORY_FLOOR - 1 }),
      movement({ signature: 'in', tier: 'attributed', raw: 100n }),
      movement({ signature: 'late', tier: 'attributed', raw: 70n, time: snapshot.time + 1 }),
      movement({ signature: 'undated', tier: 'unknown', raw: 20n, time: null }),
      movement({ signature: 'partial', tier: 'excluded', raw: -10n, retained: 1, notRetained: 1 }),
      movement({ signature: 'none', tier: 'excluded', raw: null, retained: 0, notRetained: 2 }),
    ];
    const result = reconcile(movements, snapshot);
    expect(result).toMatchObject({ attributedIn: 170n, unknownIn: 20n, allOut: 10n, notRetained: 2, beforeFloor: 1, afterSnapshot: 1, undated: 1 });
    expect(result.netSinceFloor).toBe(110n);
    expect(result.impliedAtFloor).toBe(890n);
    expect(reconcile(movements, null).impliedAtFloor).toBeNull();
  });
  it('flags a mint when its implied floor balance or unknown inflow passes a quarter of the snapshot, either sign', () => {
    expect(isOutlier(1_000n, 250n, 0n)).toBe(false);
    expect(isOutlier(1_000n, 251n, 0n)).toBe(true);
    expect(isOutlier(1_000n, -251n, 0n)).toBe(true);
    expect(isOutlier(1_000n, 0n, 250n)).toBe(false);
    expect(isOutlier(1_000n, 0n, 251n)).toBe(true);
    expect(isOutlier(1_000n, null, 0n)).toBe(false);
    expect(isOutlier(0n, 0n, 0n)).toBe(false);
    expect(isOutlier(0n, 1n, 0n)).toBe(true);
    expect(isOutlier(0n, null, 1n)).toBe(true);
  });
  it('prints raw amounts exactly with their sign', () => {
    expect(signedAmount(977958821808n, 8)).toBe('9779.58821808');
    expect(signedAmount(-5n, 6)).toBe('-0.000005');
    expect(signedAmount(42n, 0)).toBe('42');
    expect(signedAmount(0n, 2)).toBe('0.00');
  });
});

describe('day retrieval status and batch shape', () => {
  it('marks each UTC day complete, partial or gap against merged coverage, ending the last day at the cutoff', () => {
    const cutoff = HISTORY_FLOOR + 3 * 86400 + 3600;
    const coverage = [{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 86400 }, { startTime: HISTORY_FLOOR + 86400 + 60, endTime: HISTORY_FLOOR + 2 * 86400 },
      { startTime: HISTORY_FLOOR + 3 * 86400, endTime: cutoff }];
    expect(dayStatuses(HISTORY_FLOOR, cutoff, coverage).map(item => [item.day, item.status, item.coveredSeconds, item.daySeconds])).toEqual([
      ['2026-08-01', 'complete', 86400, 86400], ['2026-08-02', 'partial', 86340, 86400], ['2026-08-03', 'gap', 0, 86400], ['2026-08-04', 'complete', 3600, 3600]]);
    // Two ranges that together span a day make it complete; a start inside a day counts only from that start.
    const split = [{ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 40000 }, { startTime: HISTORY_FLOOR + 40000, endTime: HISTORY_FLOOR + 86400 }];
    expect(dayStatuses(HISTORY_FLOOR, HISTORY_FLOOR + 86400, split)[0]!.status).toBe('complete');
    expect(dayStatuses(HISTORY_FLOOR + 43200, HISTORY_FLOOR + 86400, split)).toEqual([{ day: '2026-08-01', status: 'complete', coveredSeconds: 43200, daySeconds: 43200 }]);
  });
  it('describes transfer batches by median, range and the share of batched transactions', () => {
    expect(batchShape([1, 1, 20, 18, 14])).toEqual({ rows: 5, median: 14, minimum: 1, maximum: 20, batched: 3 });
    expect(batchShape([2, 4])).toEqual({ rows: 2, median: 3, minimum: 2, maximum: 4, batched: 2 });
    expect(batchShape([])).toEqual({ rows: 0, median: null, minimum: null, maximum: null, batched: 0 });
  });
});

describe('the live database is refused', () => {
  const env = { LOCALAPPDATA: join('C:', 'Users', 'someone', 'AppData', 'Local') };
  const home = join('C:', 'Users', 'someone');
  it('refuses the default path, its journal files and any scanner.sqlite inside a stonkfun-rewards folder', () => {
    const live = defaultDatabasePath(env, home);
    expect(live).toBe(join(env.LOCALAPPDATA, 'stonkfun-rewards', 'scanner.sqlite'));
    expect(isLiveDatabasePath(live, env, home)).toBe(true);
    expect(isLiveDatabasePath(`${live}-wal`, env, home)).toBe(true);
    expect(isLiveDatabasePath(join('D:', 'elsewhere', 'stonkfun-rewards', 'scanner.sqlite'), env, home)).toBe(true);
    expect(isLiveDatabasePath(join(home, '.local', 'share', 'stonkfun-rewards', 'scanner.sqlite'), {}, home)).toBe(true);
  });
  it('accepts a copy under another name or folder', () => {
    expect(isLiveDatabasePath(join('D:', 'scratch', 'copy.sqlite'), env, home)).toBe(false);
    expect(isLiveDatabasePath(join('D:', 'scratch', 'scanner.sqlite'), env, home)).toBe(false);
    expect(isLiveDatabasePath(join(env.LOCALAPPDATA, 'stonkfun-rewards', 'copy.sqlite'), env, home)).toBe(false);
  });
});
