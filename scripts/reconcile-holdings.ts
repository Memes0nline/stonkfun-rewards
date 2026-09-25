// Offline diagnostic: reconciles a wallet's latest holdings snapshot with the saved transactions that changed its balance of a
// mint, from saved data only. It opens a COPY of the database read-only and refuses the live one. Run after pnpm build:
//   node --import ./scripts/offline-guard.mjs scripts/reconcile-holdings.ts <db copy> <wallet> <mint>
//   node --import ./scripts/offline-guard.mjs scripts/reconcile-holdings.ts <db copy> <wallet> --attributed
//   node --import ./scripts/offline-guard.mjs scripts/reconcile-holdings.ts <db copy> <wallet> --unknown-senders
// Every figure it prints is measured from the copy; where the saved data cannot show a movement it says "not retained".
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../dist/storage/sqlite.js';
import { buildReport } from '../dist/scanner/report.js';
import { HISTORY_FLOOR } from '../dist/scanner/ranges.js';
import { add, rounded, valueOf } from '../dist/scanner/decimal.js';
import { batchShape, dayStatuses, isLiveDatabasePath, isOutlier, mintMovements, reconcile, signedAmount, tierOf } from '../dist/scanner/reconcile.js';
import type { AccountObservation, Tier, TieredMovement } from '../dist/scanner/reconcile.js';
import type { Classification, WalletState } from '../dist/scanner/types.js';
import type { SolanaNetwork } from '../dist/normalization/types.js';

const NETWORK: SolanaNetwork = 'mainnet-beta';
const utc = (seconds: number | null) => seconds === null ? 'no block time' : new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
/** The day the implied balance refers to: the start of the loaded range, the history floor or later. */
const loadedDay = (trackingStart: number) => new Date(Math.max(HISTORY_FLOOR, trackingStart) * 1000).toISOString().slice(0, 10);
const TIER_TEXT: Record<Tier, string> = { confirmed: 'verified', attributed: 'attributed', unknown: 'unknown', excluded: 'excluded', 'not classified': 'not classified' };

/** Read-only access to the copy: the store for holdings, coverage, prices and the report, and direct SQL over the retained
 * transaction bodies for the wallet's own token-account balances and transfer counterparties. */
class Copy {
  readonly db: DatabaseSync;
  readonly store: SqliteRewardsStore;
  readonly wallet: string;
  constructor(path: string, wallet: string) {
    this.db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    this.store = new SqliteRewardsStore(path, { readOnly: true });
    this.wallet = wallet;
  }
  close() { this.db.close(); this.store.close(); }
  state(): WalletState | undefined {
    const row = this.db.prepare('SELECT body FROM wallets WHERE network=? AND wallet=?').get(NETWORK, this.wallet);
    return row ? JSON.parse(String(row.body)) as WalletState : undefined;
  }
  /** Every retained observation of a token account the wallet owns, one body per signature, optionally for one mint. */
  observations(mint?: string): (AccountObservation & { mint: string; decimals: number })[] {
    return this.db.prepare(`SELECT t.signature AS signature, json_extract(t.body,'$.evidence.slot') AS slot, json_extract(t.body,'$.evidence.transactionIndex') AS position,
        json_extract(t.body,'$.evidence.blockTime') AS time, json_extract(a.value,'$.address') AS account, json_extract(a.value,'$.mint.value') AS mint,
        json_extract(a.value,'$.decimals.value') AS decimals, json_extract(a.value,'$.pre[0].uiTokenAmount.amount') AS pre,
        json_extract(a.value,'$.post[0].uiTokenAmount.amount') AS post, json_extract(a.value,'$.balanceChangeRaw') AS change, json_extract(a.value,'$.createdInTransaction') AS created
      FROM watchers w JOIN transactions t ON t.network=w.network AND t.signature=w.signature, json_each(t.body,'$.accounts') a
      WHERE w.network=? AND w.wallet=? AND t.id=(SELECT MIN(x.id) FROM transactions x WHERE x.network=t.network AND x.signature=t.signature)
        AND json_extract(a.value,'$.owner.status')='resolved' AND json_extract(a.value,'$.owner.value')=?
        AND json_extract(a.value,'$.mint.status')='resolved' AND json_extract(a.value,'$.decimals.status')='resolved'
        AND (? IS NULL OR json_extract(a.value,'$.mint.value')=?)`).all(NETWORK, this.wallet, this.wallet, mint ?? null, mint ?? null).map(row => ({
      signature: String(row.signature), slot: Number(row.slot), position: row.position === null ? null : Number(row.position), time: row.time === null ? null : Number(row.time),
      account: String(row.account), mint: String(row.mint), decimals: Number(row.decimals), preRaw: row.pre === null ? null : String(row.pre),
      postRaw: row.post === null ? null : String(row.post), balanceChangeRaw: row.change === null ? null : String(row.change), createdInTransaction: Number(row.created) === 1 }));
  }
  /** The wallet's saved classification rows by signature. */
  classifications(): Map<string, Classification[]> {
    const rows = new Map<string, Classification[]>();
    for (const row of this.db.prepare('SELECT signature, body FROM classifications WHERE network=? AND wallet=? ORDER BY identity').all(NETWORK, this.wallet)) {
      const list = rows.get(String(row.signature)) ?? []; list.push(JSON.parse(String(row.body)) as Classification); rows.set(String(row.signature), list);
    }
    return rows;
  }
  /** Per signature, the other owners of the mint's transfers into and out of the wallet. */
  counterparties(mint: string): Map<string, { senders: Set<string>; recipients: Set<string> }> {
    const result = new Map<string, { senders: Set<string>; recipients: Set<string> }>();
    for (const row of this.db.prepare(`SELECT t.signature AS signature, json_extract(x.value,'$.sourceOwner.value') AS so, json_extract(x.value,'$.destinationOwner.value') AS dso
      FROM watchers w JOIN transactions t ON t.network=w.network AND t.signature=w.signature, json_each(t.body,'$.transfers') x
      WHERE w.network=? AND w.wallet=? AND t.id=(SELECT MIN(x2.id) FROM transactions x2 WHERE x2.network=t.network AND x2.signature=t.signature)
        AND json_extract(x.value,'$.mint.value')=? AND (json_extract(x.value,'$.sourceOwner.value')=? OR json_extract(x.value,'$.destinationOwner.value')=?)`)
      .all(NETWORK, this.wallet, mint, this.wallet, this.wallet)) {
      const entry = result.get(String(row.signature)) ?? { senders: new Set<string>(), recipients: new Set<string>() };
      if (row.dso === this.wallet && typeof row.so === 'string' && row.so !== this.wallet) entry.senders.add(row.so);
      if (row.so === this.wallet && typeof row.dso === 'string' && row.dso !== this.wallet) entry.recipients.add(row.dso);
      result.set(String(row.signature), entry);
    }
    return result;
  }
  /** How many transfers one owner made in a transaction, and to how many distinct owners. */
  transfersFrom(signature: string, owner: string): { transfers: number; recipients: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS transfers, COUNT(DISTINCT json_extract(x.value,'$.destinationOwner.value')) AS recipients
      FROM transactions t, json_each(t.body,'$.transfers') x WHERE t.network=? AND t.signature=? AND t.id=(SELECT MIN(x2.id) FROM transactions x2 WHERE x2.network=t.network AND x2.signature=t.signature)
        AND json_extract(x.value,'$.sourceOwner.value')=?`).get(NETWORK, signature, owner);
    return { transfers: Number(row?.transfers ?? 0), recipients: Number(row?.recipients ?? 0) };
  }
}

function tiered(mint: string, observations: readonly AccountObservation[], classifications: Map<string, Classification[]>): (TieredMovement & { reasons: string[]; gate: string | null })[] {
  return mintMovements(observations).map(movement => {
    const { tier, reasons, gate } = tierOf(classifications.get(movement.signature) ?? [], mint);
    return { ...movement, tier, reasons, gate };
  });
}
const counterpartyText = (parties: { senders: Set<string>; recipients: Set<string> } | undefined) => {
  const senders = [...parties?.senders ?? []]; const recipients = [...parties?.recipients ?? []];
  if (!senders.length && !recipients.length) return 'no supported transfer names the wallet';
  return [...senders.map(item => `from ${item}`), ...recipients.map(item => `to ${item}`)].join('; ');
};

function fullReport(copy: Copy, mint: string) {
  const state = copy.state();
  if (!state) throw new Error('wallet_not_saved');
  const report = buildReport(copy.store, copy.wallet, NETWORK);
  const asset = report.totals.attributed.cumulative?.assets.find(item => item.mint === mint) ?? null;
  const holdings = copy.store.holdings(NETWORK, copy.wallet);
  const snapshot = holdings?.snapshot ?? null;
  const held = snapshot?.tokens.find(token => token.mint === mint) ?? null;
  const observations = copy.observations(mint);
  const decimals = held?.decimals ?? observations[0]?.decimals ?? asset?.decimals ?? copy.store.quote(NETWORK, mint)?.decimals ?? 0;
  const symbol = asset?.symbol ?? held?.symbol ?? copy.store.quote(NETWORK, mint)?.symbol ?? 'TOKEN';
  const movements = tiered(mint, observations, copy.classifications());
  const parties = copy.counterparties(mint);
  const snapshotTime = snapshot ? Math.floor(Date.parse(snapshot.takenAt) / 1000) : null;
  const sums = reconcile(movements, held && snapshotTime !== null ? { raw: BigInt(held.raw), time: snapshotTime } : null, HISTORY_FLOOR);
  const amount = (raw: bigint) => signedAmount(raw, decimals);
  const lines: string[] = [];
  lines.push(`# Reconciliation of ${symbol} (${mint}) for wallet ${copy.wallet}`, '',
    `Measured from the database copy, read-only. Loaded range ${utc(state.trackingStart)} to ${utc(state.cutoff)} (cutoff); history floor ${utc(HISTORY_FLOOR)}.`, '',
    '## a) Latest holdings snapshot', '');
  if (!snapshot) lines.push('- No holdings snapshot is stored for this wallet.');
  else if (!held) lines.push(`- The snapshot taken ${snapshot.takenAt} holds no balance of this mint (zero balances are never kept).`);
  else lines.push(`- Snapshot taken ${snapshot.takenAt}: **${amount(BigInt(held.raw))} ${symbol}** (raw ${held.raw}, ${held.decimals} decimals).`,
    `- Snapshot metadata: name "${held.name ?? 'none'}", symbol "${held.symbol ?? 'none'}"; report token list symbol "${asset?.symbol ?? 'not in the attributed list'}"`
    + `${asset ? `, ${asset.receipts} attributed receipts, ${asset.amount} ${asset.symbol} attributed, ${asset.currentUsd === null ? 'unpriced' : `$${asset.currentUsd} at the saved price`}` : ''}.`);
  lines.push('', '## b) Saved transactions that changed the balance', '', `${movements.length} signatures in chain order; every movement is the retained balance change of the wallet's own token accounts for this mint.`, '',
    `| # | Time | Signature | Tier | Sender or counterparty | Movement (${symbol}) | Failing gate or reason |`, '| --- | --- | --- | --- | --- | ---: | --- |');
  movements.forEach((movement, index) => {
    const note = movement.tier === 'unknown' ? (movement.gate ?? movement.reasons.join(', ')) : movement.tier === 'excluded' ? movement.reasons.join(', ')
      : movement.tier === 'not classified' ? 'no saved classification row' : '';
    const raw = movement.raw === null ? 'not retained' : `${movement.raw > 0n ? '+' : ''}${amount(movement.raw)}${movement.notRetained ? ' (one account not retained)' : ''}`;
    lines.push(`| ${index + 1} | ${utc(movement.time)} | ${movement.signature} | ${TIER_TEXT[movement.tier]} | ${counterpartyText(parties.get(movement.signature))} | ${raw} | ${note} |`);
  });
  lines.push('', '## c) Sums', '', `| Attributed in | Unknown in | Excluded in | Verified in | Not classified in | All out | Not retained |`, '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${amount(sums.attributedIn)} | ${amount(sums.unknownIn)} | ${amount(sums.excludedIn)} | ${amount(sums.confirmedIn)} | ${amount(sums.notClassifiedIn)} | ${amount(sums.allOut)} | ${sums.notRetained} signatures |`,
    '', `## d) Implied balance on ${loadedDay(state.trackingStart)}`, '',
    `- Net retained movement from the floor to the snapshot time: ${amount(sums.netSinceFloor)} ${symbol}`
    + ` (${sums.afterSnapshot} movements after the snapshot left out, ${sums.beforeFloor} before the floor left out, ${sums.undated} undated counted).`,
    sums.impliedAtFloor === null ? '- Implied balance: not computable without a snapshot balance.'
      : `- Implied balance on ${loadedDay(state.trackingStart)} = snapshot ${amount(BigInt(held!.raw))} minus net movement ${amount(sums.netSinceFloor)} = **${amount(sums.impliedAtFloor)} ${symbol}**.`,
    state.trackingStart > HISTORY_FLOOR ? `- The loaded range starts ${utc(state.trackingStart)}, after the floor: the figure is the implied balance at that day, not at the floor.` : '- The loaded range starts at the floor.',
    sums.notRetained ? `- ${sums.notRetained} signatures have an account whose movement is not retained; their movement is not in the net.` : '- Every movement is retained.');
  const days = dayStatuses(Math.max(HISTORY_FLOOR, state.trackingStart), state.cutoff, copy.store.coverage(NETWORK, copy.wallet));
  const counts = { complete: 0, partial: 0, gap: 0 };
  for (const day of days) counts[day.status] += 1;
  lines.push('', '## e) Retrieval status by day', '', `${days.length} days: ${counts.complete} complete, ${counts.partial} partial, ${counts.gap} gap. The cutoff's day ends at the cutoff.`, '',
    '| Day | Status | Covered |', '| --- | --- | --- |');
  for (const day of days) lines.push(`| ${day.day} | ${day.status} | ${day.coveredSeconds} of ${day.daySeconds} s |`);
  return lines.join('\n');
}

function attributedSummary(copy: Copy) {
  const state = copy.state();
  if (!state) throw new Error('wallet_not_saved');
  const report = buildReport(copy.store, copy.wallet, NETWORK);
  const assets = report.totals.attributed.cumulative?.assets ?? [];
  const snapshot = copy.store.holdings(NETWORK, copy.wallet)?.snapshot ?? null;
  const snapshotTime = snapshot ? Math.floor(Date.parse(snapshot.takenAt) / 1000) : null;
  const held = new Map(snapshot?.tokens.map(token => [token.mint, token]) ?? []);
  const classifications = copy.classifications();
  const byMint = new Map<string, (AccountObservation & { mint: string; decimals: number })[]>();
  for (const row of copy.observations()) { const list = byMint.get(row.mint) ?? []; list.push(row); byMint.set(row.mint, list); }
  const lines = [`# Every attributed mint of wallet ${copy.wallet}`, '', `Measured from the database copy, read-only; snapshot ${snapshot?.takenAt ?? 'none'}; loaded range ${utc(state.trackingStart)} to ${utc(state.cutoff)}.`, '',
    `| Symbol | Mint | Snapshot balance | Attributed in | Unknown in | All out | Net since floor | Implied ${loadedDay(state.trackingStart)} | Not retained | Outlier |`, '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  const outliers: string[] = [];
  for (const asset of [...assets].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.mint.localeCompare(b.mint))) {
    const token = held.get(asset.mint) ?? null;
    const decimals = token?.decimals ?? asset.decimals;
    const movements = tiered(asset.mint, byMint.get(asset.mint) ?? [], classifications);
    const sums = reconcile(movements, token && snapshotTime !== null ? { raw: BigInt(token.raw), time: snapshotTime } : null, HISTORY_FLOOR);
    const snapshotRaw = token ? BigInt(token.raw) : 0n;
    const outlier = isOutlier(snapshotRaw, sums.impliedAtFloor, sums.unknownIn);
    const amount = (raw: bigint | null) => raw === null ? 'no snapshot' : signedAmount(raw, decimals);
    lines.push(`| ${asset.symbol} | ${asset.mint} | ${token ? amount(snapshotRaw) : 'none'} | ${amount(sums.attributedIn)} | ${amount(sums.unknownIn)} | ${amount(sums.allOut)} | ${amount(sums.netSinceFloor)} | ${amount(sums.impliedAtFloor)} | ${sums.notRetained} | ${outlier ? 'yes' : ''} |`);
    if (outlier) outliers.push(`- ${asset.symbol} (${asset.mint}): snapshot ${token ? amount(snapshotRaw) : 'none'}, implied ${loadedDay(state.trackingStart)} ${amount(sums.impliedAtFloor)}, unknown in ${amount(sums.unknownIn)}.`);
  }
  lines.push('', `## Outliers: implied ${loadedDay(state.trackingStart)} balance or unknown inflow above 25% of the snapshot balance (${outliers.length} of ${assets.length} mints)`, '', ...outliers.length ? outliers : ['- none']);
  return lines.join('\n');
}

function unknownSenders(copy: Copy) {
  const state = copy.state();
  if (!state) throw new Error('wallet_not_saved');
  const rows = [...copy.classifications().values()].flat();
  const trusted = new Map<string, number[]>();
  for (const row of rows) {
    if (row.status !== 'attributed' || !row.attributionEvidence) continue;
    const list = trusted.get(row.attributionEvidence.sourceOwner) ?? []; list.push(row.attributionEvidence.batch.transfersFromSource); trusted.set(row.attributionEvidence.sourceOwner, list);
  }
  const senders = new Map<string, { rows: number; signatures: Set<string>; mints: Set<string>; usd: { coefficient: bigint; scale: number }; priced: number; unpriced: number; sizes: number[]; gates: Map<string, number> }>();
  const prices = new Map<string, string | null>();
  for (const row of rows) {
    if (row.status !== 'unknown_candidate') continue;
    const key = row.sourceOwner ?? 'no sender (no supported transfer)';
    const entry = senders.get(key) ?? { rows: 0, signatures: new Set<string>(), mints: new Set<string>(), usd: { coefficient: 0n, scale: 0 }, priced: 0, unpriced: 0, sizes: [], gates: new Map<string, number>() };
    entry.rows += 1; entry.signatures.add(row.signature);
    if (row.mint) entry.mints.add(row.mint);
    const raw = row.netRaw ?? row.grossRaw;
    if (row.mint && raw !== null && row.decimals !== null) {
      if (!prices.has(row.mint)) prices.set(row.mint, copy.store.latestPrice(NETWORK, row.mint)?.value ?? null);
      const price = prices.get(row.mint) ?? null;
      if (price === null) entry.unpriced += 1; else { entry.usd = add(entry.usd, valueOf(raw, row.decimals, price)); entry.priced += 1; }
    } else entry.unpriced += 1;
    if (row.sourceOwner) entry.sizes.push(copy.transfersFrom(row.signature, row.sourceOwner).transfers);
    const gate = tierOf([row], row.mint ?? '').gate ?? `no gate code: ${row.reasons.join(', ')}`;
    entry.gates.set(gate, (entry.gates.get(gate) ?? 0) + 1);
    senders.set(key, entry);
  }
  const lines = [`# Unknown-tier senders of wallet ${copy.wallet}, whole loaded range`, '',
    `Measured from the database copy, read-only; loaded range ${utc(state.trackingStart)} to ${utc(state.cutoff)}. USD is each row's proven net credit (or gross amount when no net is proven) at the mint's latest saved USD price.`, '',
    '## Trusted distributors, for comparison', '', '| Identity | Attributed rows | Transfers from the sender per transaction (median, min to max) |', '| --- | ---: | --- |'];
  for (const [owner, sizes] of [...trusted].sort((a, b) => b[1].length - a[1].length)) {
    const shape = batchShape(sizes);
    lines.push(`| ${owner} | ${shape.rows} | ${shape.median} (${shape.minimum} to ${shape.maximum}) |`);
  }
  lines.push('', '## Unknown senders', '', '| Sender | Rows | Signatures | Distinct mints | USD at saved prices | Priced / unpriced rows | Transfers from the sender per transaction | Batched like the distributors | Failing gate or missing trust source |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |');
  for (const [sender, entry] of [...senders].sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]))) {
    const shape = batchShape(entry.sizes);
    const batched = shape.rows === 0 ? 'no transfer from the sender' : shape.batched === shape.rows && (shape.median ?? 0) >= 2 ? `yes: every transaction batches (${shape.batched} of ${shape.rows})`
      : shape.batched === 0 ? 'no: single transfers only' : `partly: ${shape.batched} of ${shape.rows} transactions batch`;
    const gates = [...entry.gates].sort((a, b) => b[1] - a[1]).map(([gate, count]) => `${count} × ${gate}`).join('; ');
    lines.push(`| ${sender} | ${entry.rows} | ${entry.signatures.size} | ${entry.mints.size} | ${entry.priced ? `$${rounded(entry.usd)}` : 'none priced'} | ${entry.priced} / ${entry.unpriced} | ${shape.rows ? `${shape.median} (${shape.minimum} to ${shape.maximum})` : 'none'} | ${batched} | ${gates} |`);
  }
  return lines.join('\n');
}

function main() {
  const [path, wallet, target] = process.argv.slice(2);
  if (!path || !wallet || !target) { console.error('usage: reconcile-holdings.ts <db copy> <wallet> <mint | --attributed | --unknown-senders>'); process.exit(2); }
  const full = resolve(path);
  if (isLiveDatabasePath(full)) { console.error('Refusing the live database. Copy it (main file plus -wal, merged) and run against the copy.'); process.exit(2); }
  if (!existsSync(full)) { console.error(`No database at ${full}`); process.exit(2); }
  const copy = new Copy(full, wallet);
  try {
    console.log(target === '--attributed' ? attributedSummary(copy) : target === '--unknown-senders' ? unknownSenders(copy) : fullReport(copy, target));
  } finally { copy.close(); }
}
main();
