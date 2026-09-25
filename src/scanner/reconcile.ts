import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HISTORY_FLOOR, mergeRanges } from './ranges.js';
import type { Classification, Range } from './types.js';

const DAY = 86400;
const digits = (value: string | null | undefined): value is string => typeof value === 'string' && /^\d+$/.test(value);

/** One retained observation of a token account the wallet owns, for one mint, in one saved transaction: the balances the
 * transaction reported, the change the normalizer computed from two unambiguous balances, and whether the account was
 * provably created in the transaction (so it started at zero). */
export interface AccountObservation {
  signature: string; slot: number; position: number | null; time: number | null; account: string;
  preRaw: string | null; postRaw: string | null; balanceChangeRaw: string | null; createdInTransaction: boolean;
}
/** What one saved transaction did to the wallet's balance of one mint, summed over its accounts. `raw` is null when no
 * account's movement is retained; `notRetained` counts accounts whose movement the saved data cannot show. */
export interface Movement { signature: string; slot: number; position: number | null; time: number | null; raw: bigint | null; retained: number; notRetained: number }

/** One account's retained movement: the normalizer's balance change, else post minus pre when both were reported, else the
 * post balance of an account provably created in the transaction. Anything else is not retained, never estimated. */
export function accountMovement(row: AccountObservation): bigint | null {
  if (digits(row.balanceChangeRaw) || (typeof row.balanceChangeRaw === 'string' && /^-\d+$/.test(row.balanceChangeRaw))) return BigInt(row.balanceChangeRaw);
  if (digits(row.preRaw) && digits(row.postRaw)) return BigInt(row.postRaw) - BigInt(row.preRaw);
  if (row.createdInTransaction && row.preRaw === null && digits(row.postRaw)) return BigInt(row.postRaw);
  return null;
}
/** The saved transactions that changed the wallet's balance of the mint, one per signature in chain order: those with a
 * non-zero retained movement or with an account whose movement is not retained. */
export function mintMovements(rows: readonly AccountObservation[]): Movement[] {
  const bySignature = new Map<string, Movement>();
  for (const row of rows) {
    const entry = bySignature.get(row.signature) ?? { signature: row.signature, slot: row.slot, position: row.position, time: row.time, raw: null, retained: 0, notRetained: 0 };
    const movement = accountMovement(row);
    if (movement === null) entry.notRetained += 1;
    else { entry.raw = (entry.raw ?? 0n) + movement; entry.retained += 1; }
    bySignature.set(row.signature, entry);
  }
  return [...bySignature.values()].filter(entry => entry.notRetained > 0 || (entry.raw !== null && entry.raw !== 0n))
    .sort((a, b) => a.slot - b.slot || (a.position ?? -1) - (b.position ?? -1) || a.signature.localeCompare(b.signature));
}

export type Tier = 'confirmed' | 'attributed' | 'unknown' | 'excluded' | 'not classified';
export type TierRow = Pick<Classification, 'status' | 'mint' | 'reasons' | 'sourceOwner'>;
/** The attributed tier's gates, in the order the classifier checks them, keyed by the code an unknown row records; the
 * reasons a row keeps when it never reaches the tier are listed after them. */
export const GATE_LABELS: Readonly<Record<string, string>> = {
  distributor_credit_unreconciled: 'G1 exact credit: the credit is not reconciled',
  positive_credit_unproven: 'G1 exact credit: no proven positive credit',
  reward_quote_unverified: 'G1 exact credit: the mint has no retained reward-quote membership evidence',
  distributor_trust_unestablished: 'G2 trusted distributor: no trust source names the sender (no retained withdraw-authority snapshot and no retained feed witness)',
  distributor_source_not_ata: 'G3 own associated token account',
  distributor_signer_shape_unsupported: 'G4 signer shape',
  wallet_in_account_keys: 'G4 signer shape: the wallet is in the account keys',
  unexplained_native_movement: 'G5 payout structure: unexplained native movement',
  uninterpreted_activity: 'G5 payout structure: uninterpreted instruction',
  unresolved_normalization: 'G5 payout structure: unresolved normalization',
  unsupported_authority_pattern: 'G5 payout structure: unsupported authority pattern',
  no_supported_transfers: 'G5 payout structure: no supported transfer',
  distributor_identity_conflicted: 'G6 no unresolved conflict: contested identity',
  distributor_attribution_revoked: 'G6 no unresolved conflict: local revocation',
  published_authority_rotation_ambiguous: 'G6 no unresolved conflict: published authority rotation gap',
  published_authority_snapshot_pending: 'G6 no unresolved conflict: published authority snapshot pending',
  credit_without_supported_transfer_instruction: 'tier not entered: the credit has no supported transfer instruction (mint issuance)',
  native_credit_from_distributor_unproven: 'native lane: the credit is unproven',
  conflicting_evidence_quarantined: 'quarantined: conflicting evidence',
};
const GATE_ORDER = Object.keys(GATE_LABELS);
/** The failing gate an unknown row records, as its label; the earliest gate when a row carries several codes; null when
 * none of its reasons is a gate code. */
export function failingGate(reasons: readonly string[]): string | null {
  const code = GATE_ORDER.find(candidate => reasons.includes(candidate));
  return code === undefined ? null : GATE_LABELS[code]!;
}
/** The tier of a signature for one mint from its saved classification rows: the rows naming the mint, or, when none does,
 * the rows with no mint (a transaction with no supported transfer). A confirmed row outranks attributed, then unknown,
 * then excluded; no row at all is not classified. */
export function tierOf(rows: readonly TierRow[], mint: string): { tier: Tier; reasons: string[]; gate: string | null } {
  const named = rows.filter(row => row.mint === mint);
  const relevant = named.length ? named : rows.filter(row => row.mint === null);
  const pick = (status: Classification['status']) => relevant.filter(row => row.status === status);
  const chosen = pick('confirmed').length ? { tier: 'confirmed' as const, rows: pick('confirmed') }
    : pick('attributed').length ? { tier: 'attributed' as const, rows: pick('attributed') }
      : pick('unknown_candidate').length ? { tier: 'unknown' as const, rows: pick('unknown_candidate') }
        : pick('excluded').length ? { tier: 'excluded' as const, rows: pick('excluded') } : null;
  if (!chosen) return { tier: 'not classified', reasons: [], gate: null };
  const reasons = [...new Set(chosen.rows.flatMap(row => row.reasons))];
  return { tier: chosen.tier, reasons, gate: chosen.tier === 'unknown' ? failingGate(reasons) : null };
}

export interface TieredMovement extends Movement { tier: Tier }
export interface Reconciliation {
  /** Retained inflow by tier and all retained outflow, in raw units; inflow of unretained movements is unknown. */
  attributedIn: bigint; confirmedIn: bigint; unknownIn: bigint; excludedIn: bigint; notClassifiedIn: bigint; allOut: bigint;
  /** Signatures with an account whose movement is not retained. */
  notRetained: number;
  /** Retained net movement from the floor to the snapshot time, and the movements it leaves out. */
  netSinceFloor: bigint; beforeFloor: number; afterSnapshot: number; undated: number;
  /** Snapshot balance minus the net movement since the floor; null without a snapshot balance. */
  impliedAtFloor: bigint | null;
}
/** The sums behind the reconciliation. Movements before the floor are left out; movements after the snapshot's time are
 * left out of the net movement (the snapshot predates them) but still counted in the tier sums; undated movements count. */
export function reconcile(movements: readonly TieredMovement[], snapshot: { raw: bigint; time: number } | null, floor = HISTORY_FLOOR): Reconciliation {
  const sums = { attributedIn: 0n, confirmedIn: 0n, unknownIn: 0n, excludedIn: 0n, notClassifiedIn: 0n, allOut: 0n };
  let notRetained = 0; let netSinceFloor = 0n; let beforeFloor = 0; let afterSnapshot = 0; let undated = 0;
  const inKey: Record<Tier, keyof typeof sums> = { attributed: 'attributedIn', confirmed: 'confirmedIn', unknown: 'unknownIn', excluded: 'excludedIn', 'not classified': 'notClassifiedIn' };
  for (const movement of movements) {
    if (movement.time !== null && movement.time < floor) { beforeFloor += 1; continue; }
    if (movement.notRetained > 0) notRetained += 1;
    if (movement.raw === null) continue;
    if (movement.raw > 0n) sums[inKey[movement.tier]] += movement.raw; else sums.allOut += -movement.raw;
    if (movement.time === null) undated += 1;
    if (snapshot && movement.time !== null && movement.time > snapshot.time) { afterSnapshot += 1; continue; }
    netSinceFloor += movement.raw;
  }
  return { ...sums, notRetained, netSinceFloor, beforeFloor, afterSnapshot, undated, impliedAtFloor: snapshot ? snapshot.raw - netSinceFloor : null };
}
/** A mint stands out when its implied floor balance (either sign) or its unknown-tier inflow exceeds a quarter of its
 * snapshot balance; with no snapshot balance, when either is non-zero. */
export function isOutlier(snapshotRaw: bigint, impliedAtFloor: bigint | null, unknownIn: bigint): boolean {
  const implied = impliedAtFloor === null ? 0n : impliedAtFloor < 0n ? -impliedAtFloor : impliedAtFloor;
  if (snapshotRaw <= 0n) return implied !== 0n || unknownIn > 0n;
  return implied * 4n > snapshotRaw || unknownIn * 4n > snapshotRaw;
}

export type DayStatus = 'complete' | 'partial' | 'gap';
/** Each UTC day from `start` to the cutoff: complete when saved coverage spans the whole day (the cutoff's day ends at the
 * cutoff), gap when none of it is covered, partial otherwise. */
export function dayStatuses(start: number, cutoff: number, coverage: readonly Range[]): { day: string; status: DayStatus; coveredSeconds: number; daySeconds: number }[] {
  const merged = mergeRanges(coverage);
  const days: { day: string; status: DayStatus; coveredSeconds: number; daySeconds: number }[] = [];
  for (let at = Math.floor(start / DAY) * DAY; at < cutoff; at += DAY) {
    const from = Math.max(at, start); const to = Math.min(at + DAY, cutoff);
    let covered = 0;
    for (const range of merged) covered += Math.max(0, Math.min(to, range.endTime) - Math.max(from, range.startTime));
    days.push({ day: new Date(at * 1000).toISOString().slice(0, 10), status: covered >= to - from ? 'complete' : covered === 0 ? 'gap' : 'partial',
      coveredSeconds: covered, daySeconds: to - from });
  }
  return days;
}

/** The shape of a sender's transfers: how many transfers each of its transactions made from that sender, against the
 * trusted distributors, which pay in outer-instruction batches. */
export function batchShape(sizes: readonly number[]): { rows: number; median: number | null; minimum: number | null; maximum: number | null; batched: number } {
  const sorted = [...sizes].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { rows: sorted.length, median, minimum: sorted[0] ?? null, maximum: sorted.at(-1) ?? null, batched: sorted.filter(size => size >= 2).length };
}

/** The scanner's default database: the one the CLI and the dashboard open and write. */
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return join(env.LOCALAPPDATA ?? join(home, '.local', 'share'), 'stonkfun-rewards', 'scanner.sqlite');
}
/** True when the path is the live database: the default path, or any `scanner.sqlite` (with or without a `-wal` or `-shm`
 * suffix) inside a `stonkfun-rewards` folder. Diagnostics run only against a copy. */
export function isLiveDatabasePath(path: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const full = resolve(path);
  if (fold(full) === fold(resolve(defaultDatabasePath(env, home)))) return true;
  const name = basename(full).replace(/-(wal|shm|journal)$/, '');
  return fold(name) === 'scanner.sqlite' && fold(basename(dirname(full))) === 'stonkfun-rewards';
}
/** A raw amount in token units, with its sign, exactly. */
export function signedAmount(raw: bigint, decimals: number): string {
  const magnitude = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = magnitude.slice(0, magnitude.length - decimals); const fraction = magnitude.slice(magnitude.length - decimals);
  return `${raw < 0n ? '-' : ''}${whole}${decimals ? `.${fraction}` : ''}`;
}
