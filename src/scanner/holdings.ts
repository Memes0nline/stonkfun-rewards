/** One observation of a token account the wallet owns, from one retained transaction. */
export interface WalletTokenBalance {
  signature: string; slot: number; position: number | null; time: number | null; account: string; mint: string; decimals: number;
  preRaw: string | null; postRaw: string | null;
}
/** Per mint, what the wallet's retained transactions show: whether any of its accounts ever held a positive balance, the sum of
 * each account's last observed balance, and the latest observation. */
export interface HistoryHolding { mint: string; decimals: number; everHeld: boolean; raw: bigint; time: number | null; slot: number; signature: string }
/** One fungible token the wallet held when the snapshot was taken; zero balances are never kept. */
export interface SnapshotHolding { mint: string; raw: string; decimals: number; name: string | null; symbol: string | null }
/** The wallet's token holdings read with Helius DAS `getAssetsByOwner`, every page, at `takenAt`. */
export interface HoldingsSnapshot { takenAt: string; tokens: SnapshotHolding[] }
/** What one successful refresh stores: the history-derived holdings, with the retained-data fingerprint they were computed
 * from, and the DAS snapshot when it was read in full. */
export interface HoldingsSet {
  takenAt: string; fingerprint: string;
  history: HistoryHolding[];
  snapshot: HoldingsSnapshot | null;
}
/** The stored holdings a reader uses: the latest history set, and the latest complete snapshot (possibly an earlier one). */
export interface StoredHoldings {
  history: { takenAt: string; fingerprint: string; holdings: HistoryHolding[] } | null;
  snapshot: HoldingsSnapshot | null;
}

const positive = (raw: string | null) => raw !== null && /^\d+$/.test(raw) && BigInt(raw) > 0n;
/** Per mint, what the wallet's retained transactions show it holding: whether any of its accounts ever held a positive balance,
 * and the sum of each account's last observed balance with the time of the latest observation. An account a transaction
 * closes (a balance before, none after) last held 0. */
export function walletHoldings(balances: readonly WalletTokenBalance[]) {
  const order = (a: WalletTokenBalance, b: WalletTokenBalance) => a.slot - b.slot || (a.position ?? -1) - (b.position ?? -1) || a.signature.localeCompare(b.signature);
  const accounts = new Map<string, WalletTokenBalance[]>();
  for (const row of balances) { const list = accounts.get(row.account) ?? []; list.push(row); accounts.set(row.account, list); }
  const mints = new Map<string, HistoryHolding>();
  for (const rows of accounts.values()) {
    rows.sort(order);
    const last = rows.at(-1)!;
    const lastRaw = last.postRaw !== null ? last.postRaw : last.preRaw !== null ? '0' : null;
    if (lastRaw === null || !/^\d+$/.test(lastRaw)) continue;
    const entry = mints.get(last.mint) ?? { mint: last.mint, decimals: last.decimals, everHeld: false, raw: 0n, time: null, slot: -1, signature: '' };
    entry.everHeld ||= rows.some(row => positive(row.preRaw) || positive(row.postRaw));
    entry.raw += BigInt(lastRaw);
    if (last.slot > entry.slot || (last.slot === entry.slot && last.signature > entry.signature)) { entry.slot = last.slot; entry.time = last.time; entry.signature = last.signature; }
    mints.set(last.mint, entry);
  }
  return mints;
}
