import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { admitJob, runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import { walletHoldings } from '../src/scanner/holdings.js';
import type { SnapshotHolding } from '../src/scanner/holdings.js';
import { createRealProviders } from '../src/providers/real.js';
import { DashboardService } from '../src/web/service.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoData, demoFetch } from '../src/cli/demo.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import { CUTOFF, iso, MINT, officialFeed, payout, recipient, syntheticKey, toWallet, WALLET } from './fixtures/distributor.js';

// SYNTHETIC holdings: every key is a hash of a label, every provider response is a fixture. No request leaves the process.
const network = 'mainnet-beta';
const FAST = { perSecond: 100, burst: 10 };
const NO_RETRY = { retries: 0, baseMs: 1000, maxMs: 30_000, jitter: 0 };
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function path() { const directory = mkdtempSync(join(tmpdir(), 'rewards-holdings-')); directories.push(directory); return join(directory, 'holdings.sqlite'); }
function open(file = path(), readOnly = false) { const store = new SqliteRewardsStore(file, { readOnly }); stores.push(store); return store; }
const rpc = (id: unknown, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });

/** A fungible `getAssetsByOwner` item. A balance given as digits is sent as a bare JSON number, however large. */
const fungible = (mint: string, balance: string, decimals: number, name?: string, symbol?: string) => ({ interface: 'FungibleToken', id: mint,
  content: { metadata: { ...name ? { name } : {}, ...symbol ? { symbol } : {} }, links: { image: 'https://images.example/token.png?token=unrelated' } },
  token_info: { balance: `@@${balance}@@`, decimals, token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } });
const numbers = (text: string) => text.replace(/"@@(\d+)@@"/g, '$1');
/** Answers `getAssetsByOwner` from `items`, `limit` per page as the request asks; every other request goes to `rest`. */
function ownerAssets(items: unknown[], calls: { page: number; limit: number; owner: string }[], rest?: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { id: unknown; method: string; params: { ownerAddress: string; page: number; limit: number; options: unknown } } : null;
    if (body?.method === 'getAssetsByOwner') {
      calls.push({ page: body.params.page, limit: body.params.limit, owner: body.params.ownerAddress });
      expect(body.params.options).toEqual({ showFungible: true, showZeroBalance: false });
      const page = items.slice((body.params.page - 1) * body.params.limit, body.params.page * body.params.limit);
      return new Response(numbers(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { total: page.length, limit: body.params.limit, page: body.params.page, items: page } })), { status: 200 });
    }
    if (!rest) throw new Error('unexpected_request');
    return rest(input, init);
  };
}

const PRE = syntheticKey('holdings-pre-tracking-launch');
const HELD = syntheticKey('holdings-held-launch');
const SOLD = syntheticKey('holdings-sold-launch');
const STILL = syntheticKey('holdings-history-still-launch');
const ZERO = syntheticKey('holdings-zero-launch');
const NEVER = syntheticKey('holdings-never-held-launch');
const BIG = syntheticKey('holdings-big-balance');
const SELLER = syntheticKey('holdings-seller');
const walletAccount = (label: string) => syntheticKey(`holdings-wallet-account-${label}`);
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-holdings', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
const buy = (label: string, launch: string, amount: string, time: number) => payout({ label: `holdings-buy-${label}`, time,
  legs: [{ owner: SELLER, mint: launch, destination: walletAccount(label), destinationOwner: WALLET, amount }] });
const signatureOf = (tx: FullTransaction) => tx.transaction.signatures[0]!;
const summary = (launchMint: string) => ({ kind: 'rewardSummary' as const, launchMint, endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) });

/** One attributed $QUOTE receipt. Summaries name six launches paying in $QUOTE. The wallet's retained transactions show it buying
 * HELD, buying and selling all of SOLD, and buying STILL; it never trades PRE, ZERO or NEVER inside the tracked window. */
function seeded(file = path()) {
  const store = open(file);
  const witness = payout({ label: 'holdings-witness', time: CUTOFF - 1000, legs: [0, 1, 2].map(index => ({ ...recipient(800 + index), amount: String(40_000 + index) })) });
  const history = [
    payout({ label: 'holdings-attributed', time: CUTOFF - 2 * 86400, legs: [toWallet('2000000'), ...[0, 1].map(index => ({ ...recipient(810 + index), amount: '1000' }))] }),
    buy('held', HELD, '5000000', CUTOFF - 5 * 86400),
    buy('sold', SOLD, '2000000', CUTOFF - 6 * 86400),
    payout({ label: 'holdings-sell-sold', time: CUTOFF - 4 * 86400, feePayer: WALLET,
      legs: [{ owner: WALLET, mint: SOLD, source: walletAccount('sold'), destination: syntheticKey('holdings-buyer-account'), destinationOwner: syntheticKey('holdings-buyer'), amount: '10000000000' }] }),
    buy('still', STILL, '3000000', CUTOFF - 5 * 86400),
  ];
  store.atomic(() => {
    store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    store.saveQuote(network, { mint: MINT, symbol: 'QUOTE', retrievedAt: iso(CUTOFF), membershipEvidence: [HELD, SOLD, STILL, PRE, ZERO, NEVER].map(summary) });
    store.saveQuote(network, { mint: HELD, symbol: 'HELDL', name: 'Synthetic held launch', retrievedAt: iso(CUTOFF) });
    store.savePrice(network, { mint: MINT, currency: 'USD', value: '2.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF), expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    store.addTransaction(network, witness, provenance); store.addFeed(officialFeed(witness));
    for (const tx of history) { store.addTransaction(network, tx, provenance); store.watch(network, signatureOf(tx), WALLET); }
  });
  while (processDirty(store, network, 100) > 0) { /* drain */ }
  return { store, history };
}
/** What a refresh stores for the seeded wallet: its history-derived holdings, and a snapshot taken at the cutoff that holds HELD
 * (more than the transactions show), PRE (held since before tracking) and a zero ZERO balance, and no longer holds STILL. */
function refreshed(store: SqliteRewardsStore, tokens: SnapshotHolding[] = [
  { mint: HELD, raw: '7000000', decimals: 6, name: 'On-chain held name', symbol: 'ONCHAIN' },
  { mint: PRE, raw: '42000000', decimals: 6, name: 'Pre-tracking launch', symbol: 'PRE' },
  { mint: ZERO, raw: '0', decimals: 6, name: 'Zero launch', symbol: 'ZERO' },
]) {
  store.saveHoldings(network, WALLET, { takenAt: iso(CUTOFF), fingerprint: store.retainedFingerprint(network, WALLET),
    history: [...walletHoldings(store.walletTokenBalances(network, WALLET)).values()], snapshot: { takenAt: iso(CUTOFF), tokens } });
}
const serviceFor = (store: SqliteRewardsStore) => new DashboardService({ store: () => store, prepareProviders: () => { throw new Error('offline'); } });
const quoteOf = (store: SqliteRewardsStore) => {
  const result = serviceFor(store).sources(WALLET).sources!;
  return { result, quote: result.tokens.find(token => token.mint === MINT)! };
};

describe('holdings snapshot at refresh', () => {
  it('reads every getAssetsByOwner page through the Helius budget, keeping exact positive fungible balances only', async () => {
    const store = open();
    const job = admitJob(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: 'holdings-pages', owner: 'test',
      limits: { stonkfun: 5, helius: 10, pages: 5, resumes: 1, deadline: Date.now() + 3_600_000 } }, Date.now());
    const calls: { page: number; limit: number; owner: string }[] = [];
    const items = [fungible(HELD, '5000000', 6, 'Held', 'HELD'), fungible(BIG, '123456789012345678901', 9), fungible(ZERO, '0', 6, 'Zero', 'ZERO'),
      { interface: 'V1_NFT', id: syntheticKey('holdings-nft'), content: { metadata: { name: 'An NFT' } } }, fungible(PRE, '7', 0, 'Pre', 'PRE')];
    const provider = createRealProviders({ store, job, apiKey: 'synthetic-holdings-key', retry: NO_RETRY, dasLimit: FAST, holdingsPageLimit: 2, fetch: ownerAssets(items, calls) });
    const snapshot = (await provider.holdings!(DEMO_WALLET))!;
    // Five items at two a page: three pages, the last one short.
    expect(calls).toEqual([1, 2, 3].map(page => ({ page, limit: 2, owner: DEMO_WALLET })));
    expect(store.job(job.id, network)!.used).toMatchObject({ helius: 3, stonkfun: 0 });
    // The zero balance and the NFT are left out; a balance past 2^53 keeps every digit.
    expect(snapshot.tokens).toEqual([
      { mint: BIG, raw: '123456789012345678901', decimals: 9, name: null, symbol: null },
      { mint: HELD, raw: '5000000', decimals: 6, name: 'Held', symbol: 'HELD' },
      { mint: PRE, raw: '7', decimals: 0, name: 'Pre', symbol: 'PRE' },
    ].sort((a, b) => a.mint.localeCompare(b.mint)));
    // An unreadable page abandons the snapshot rather than storing part of it.
    const broken = createRealProviders({ store, job, apiKey: 'synthetic-holdings-key', retry: NO_RETRY, dasLimit: FAST, holdingsPageLimit: 2,
      fetch: async (input, init) => { const body = JSON.parse(init?.body as string) as { id: unknown; params: { page: number } };
        return body.params.page === 1 ? ownerAssets(items, [])(input, init) : rpc(body.id, { items: 'not-a-list' }); } });
    expect(await broken.holdings!(DEMO_WALLET)).toBeNull();
  });

  it('stores holdings after a complete refresh and makes no DAS call after a failed one', async () => {
    const run = async (fail: boolean) => {
      const store = open();
      let clock = DEMO_CUTOFF * 1000; const now = () => (clock += 1000);
      const methods: string[] = [];
      const base = demoFetch(demoData(), now);
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const method = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method: string }).method : null;
        if (method) methods.push(method);
        if (fail && method === 'getTransactionsForAddress') return new Response('{}', { status: 503 });
        return ownerAssets([fungible(PRE, '42', 0, 'Pre', 'PRE')], [], base)(input, init);
      };
      const job = await runScan(store, { wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, jobId: `holdings-${fail ? 'failed' : 'complete'}`, owner: 'owner', snapshotHoldings: true,
        limits: { stonkfun: 30, helius: 100, pages: 100, resumes: 5, deadline: now() + 86_400_000 } },
      job => createRealProviders({ store, job, apiKey: 'synthetic-holdings-key', fetch, now, retry: NO_RETRY, dasLimit: FAST, limits: { helius: FAST, stonkfun: FAST } }), { now });
      return { store, job, methods };
    };
    const complete = await run(false);
    expect(complete.job.status).toBe('complete');
    expect(complete.methods.filter(method => method === 'getAssetsByOwner')).toHaveLength(1);
    const stored = complete.store.holdings(network, DEMO_WALLET)!;
    expect(stored.snapshot?.tokens).toEqual([{ mint: PRE, raw: '42', decimals: 0, name: 'Pre', symbol: 'PRE' }]);
    expect(stored.history?.fingerprint).toBe(complete.store.retainedFingerprint(network, DEMO_WALLET));
    const failed = await run(true);
    expect(failed.job.status).not.toBe('complete');
    expect(failed.methods).toContain('getTransactionsForAddress');
    expect(failed.methods).not.toContain('getAssetsByOwner');
    expect(failed.store.holdings(network, DEMO_WALLET)).toBeUndefined();
  });
});

describe('likely sources from stored holdings', () => {
  it('lists a launch held since before tracking, labels sold launches, and leaves out zero balances and launches never held', () => {
    const { store, history } = seeded();
    refreshed(store);
    const { result, quote } = quoteOf(store);
    expect(result.holdingsAt).toBe(iso(CUTOFF));
    expect(result.holdingsSource).toBe('snapshot');
    const byMint = new Map(quote.likely.map(launch => [launch.mint, launch]));
    expect([...byMint.keys()].sort()).toEqual([HELD, PRE, SOLD, STILL].sort());
    // Holding now: the snapshot's amounts and names, retained StonkFun metadata first.
    expect(byMint.get(PRE)).toMatchObject({ symbol: 'PRE', name: 'Pre-tracking launch', held: { holding: true, source: 'snapshot', raw: '42000000', amount: '42.000000', lastSeen: CUTOFF, evidenceLink: null } });
    expect(byMint.get(HELD)).toMatchObject({ symbol: 'HELDL', name: 'Synthetic held launch', held: { holding: true, source: 'snapshot', raw: '7000000' } });
    // Held earlier, sold: sold inside the window, or held in the transactions but absent from the later snapshot.
    expect(byMint.get(SOLD)).toMatchObject({ held: { holding: false, source: 'history', raw: '0', lastSeen: CUTOFF - 4 * 86400, evidenceLink: `https://solscan.io/tx/${signatureOf(history[3]!)}` } });
    expect(byMint.get(STILL)).toMatchObject({ held: { holding: false, source: 'history', raw: '0', lastSeen: CUTOFF - 5 * 86400 } });
    expect(quote.likely.slice(0, 2).every(launch => launch.held.holding)).toBe(true);
    // Every summary launch is kept for the full list, named ones first; a zero balance's snapshot name was never stored.
    expect(quote.launches.map(launch => launch.mint).slice(0, 2).sort()).toEqual([HELD, PRE].sort());
    expect(quote.launches.find(launch => launch.mint === ZERO)).toEqual({ mint: ZERO });
    expect(quote.launches.find(launch => launch.mint === NEVER)).toEqual({ mint: NEVER });
    expect(quote.launches).toHaveLength(6);
  });

  it('reads the stored rows instead of the retained transactions, and computes again once retained data changes', () => {
    const { store } = seeded();
    refreshed(store);
    const reads = vi.spyOn(store, 'walletTokenBalances');
    const service = serviceFor(store);
    service.sources(WALLET); service.sources(WALLET);
    expect(reads).not.toHaveBeenCalled();
    // A later, failed scan retained a new trade: the stored history is out of date, so it is computed from the transactions.
    store.atomic(() => { const later = buy('later', NEVER, '1000000', CUTOFF + 600); store.addTransaction(network, later, provenance); store.watch(network, signatureOf(later), WALLET); });
    const quote = service.sources(WALLET).sources!.tokens.find(token => token.mint === MINT)!;
    expect(reads).toHaveBeenCalledTimes(1);
    // Bought after the snapshot, so it is held now.
    expect(quote.likely.find(launch => launch.mint === NEVER)?.held).toMatchObject({ holding: true, source: 'history', raw: '1000000' });
  });

  it('keeps the last complete snapshot when a later one fails, and stores no zero balance', () => {
    const { store } = seeded();
    refreshed(store);
    store.saveHoldings(network, WALLET, { takenAt: iso(CUTOFF + 60), fingerprint: store.retainedFingerprint(network, WALLET),
      history: [...walletHoldings(store.walletTokenBalances(network, WALLET)).values()], snapshot: null });
    const stored = store.holdings(network, WALLET)!;
    expect(stored.history?.takenAt).toBe(iso(CUTOFF + 60));
    expect(stored.snapshot?.takenAt).toBe(iso(CUTOFF));
    expect(stored.snapshot?.tokens.map(token => token.mint).sort()).toEqual([HELD, PRE].sort());
  });
});

describe('schema v7', () => {
  it('migrates v6 to v7 by adding the holdings tables, keeping every existing row, and views v6 read-only without holdings', () => {
    const file = path();
    const { store } = seeded(file);
    const before = buildReport(store, WALLET); store.close();
    const counts = (db: DatabaseSync) => Object.fromEntries(['transactions', 'classifications', 'quotes', 'metadata_observations', 'watchers', 'feeds', 'prices']
      .map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)]));
    const legacy = new DatabaseSync(file);
    legacy.exec('DROP TABLE holdings; DROP TABLE holding_sets; PRAGMA user_version=6;');
    const rows = counts(legacy); legacy.close();
    const viewer = open(file, true);
    expect(viewer.holdings(network, WALLET)).toBeUndefined();
    expect(serviceFor(viewer).sources(WALLET).sources?.holdingsSource).toBe('history');
    viewer.close();
    const migrated = open(file);
    expect(buildReport(migrated, WALLET).totals).toEqual(before.totals);
    expect(migrated.holdings(network, WALLET)).toBeUndefined();
    refreshed(migrated);
    expect(migrated.holdings(network, WALLET)?.snapshot?.tokens).toHaveLength(2);
    migrated.close();
    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
    expect(counts(check)).toEqual(rows);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('holdings','holding_sets') ORDER BY name").all().map(row => row.name))
      .toEqual(['holding_sets', 'holdings']);
    check.close();
  });
});
