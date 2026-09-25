import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { buildReport, humanReport, STALE_PRICE_SECONDS } from '../src/scanner/report.js';
import { add, rounded, valueOf } from '../src/scanner/decimal.js';
import type { Decimal } from '../src/scanner/decimal.js';
import { runScan } from '../src/scanner/engine.js';
import { reportView } from '../src/web/view.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import type { HistoryResult } from '../src/helius/types.js';
import type { Job, Price, Providers } from '../src/scanner/types.js';
import { CUTOFF, DISTRIBUTOR, iso, MINT, officialFeed, OTHER_DISTRIBUTOR, payout, recipient, SECOND_MINT, syntheticKey, toWallet, WALLET } from './fixtures/distributor.js';

const network = 'mainnet-beta';
const THIRD_MINT = syntheticKey('third-quote-mint');
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-report-v2', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database() { const directory = mkdtempSync(join(tmpdir(), 'rewards-report-v2-')); directories.push(directory); return join(directory, 'report.sqlite'); }
function open(path: string, readOnly = false) { const store = new SqliteRewardsStore(path, { readOnly }); stores.push(store); return store; }
const legs = (start: number) => [0, 1, 2].map(i => ({ ...recipient(start + i), amount: String(20_000 + start + i) }));
const transactions = {
  witness: payout({ label: 'report-witness', time: CUTOFF - 1000, legs: legs(100) }),
  verified: payout({ label: 'verified-priced', time: CUTOFF - 3600, legs: [toWallet('3000000')] }),
  verifiedUnpriced: payout({ label: 'verified-unpriced', time: CUTOFF - 4000, legs: [toWallet('6000000', { mint: THIRD_MINT, destination: syntheticKey('wallet-third') })] }),
  attributed: payout({ label: 'attributed-priced', time: CUTOFF - 2 * 86400, legs: [toWallet('2000000'), ...legs(1)] }),
  attributedUnpriced: payout({ label: 'attributed-unpriced', time: CUTOFF - 9 * 86400, legs: [toWallet('7000000', { mint: SECOND_MINT, destination: syntheticKey('wallet-second') })] }),
  unknown: payout({ label: 'unknown-proven', time: CUTOFF - 5000, legs: [toWallet('11', { owner: OTHER_DISTRIBUTOR })] }),
};
/** Verified, attributed, unknown and unpriced receipts in one wallet, with MINT present in both reward groups. MINT's one saved
 * price, $2.00 at the cutoff, expires at `priceExpiresAt`. */
function seeded(path = database(), priceExpiresAt = Number.MAX_SAFE_INTEGER) {
  const store = open(path);
  const official = (tx: FullTransaction) => { store.addTransaction(network, tx, provenance); store.addFeed(officialFeed(tx)); };
  const watch = (tx: FullTransaction) => { store.addTransaction(network, tx, provenance); store.watch(network, tx.transaction.signatures[0]!, WALLET); };
  store.atomic(() => {
    store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    for (const [mint, symbol] of [[MINT, 'QUOTE'], [SECOND_MINT, 'SECOND'], [THIRD_MINT, 'THIRD']] as const) {
      store.saveQuote(network, { mint, symbol, retrievedAt: iso(CUTOFF),
        membershipEvidence: [{ kind: 'distribution', launchMint: syntheticKey('launch'), endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) }] });
    }
    store.savePrice(network, { mint: MINT, currency: 'USD', value: '2.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF),
      expiresAt: priceExpiresAt, reason: null });
    official(transactions.witness); official(transactions.verified); official(transactions.verifiedUnpriced);
    for (const tx of [transactions.verified, transactions.verifiedUnpriced, transactions.attributed, transactions.attributedUnpriced, transactions.unknown]) watch(tx);
  });
  while (processDirty(store, network, 100) > 0) { /* drain */ }
  return store;
}

describe('report schema v2 groups', () => {
  it('keeps verified, attributed, unknown and unpriced separate with no combined field', () => {
    const report = buildReport(seeded(), WALLET);
    expect(report.schemaVersion).toBe(3);
    expect(report.counts).toEqual({ confirmed: 2, attributed: 2, excluded: 0, unknown_candidate: 1 });
    expect(report.uniqueSignatures).toEqual({ all: 5, confirmed: 2, attributed: 2, excluded: 0, unknown_candidate: 1 });
    expect(report.attribution).toMatchObject({ evaluated: true, modelVersion: 'distributor-pattern-v1' });
    expect(report.attributionBasisCounts).toEqual({ feed_witnessed_identity: 2, published_withdraw_authority: 0, withBothTrustSources: 0 });
    // Top-level windows keep their verified-only meaning and equal the verified group.
    expect(report.totals.verified).toMatchObject({ label: 'Verified', rows: 2, signatures: 2,
      rolling168h: report.rolling168h, latest24h: report.latest24h, cumulative: report.cumulative, utcDays: report.utcDays });
    expect(report.cumulative.assets.map(asset => [asset.mint, asset.raw, asset.currentUsd])).toEqual([
      [MINT, '3000000', '6.000000'], [THIRD_MINT, '6000000', null]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(report.cumulative.currentUsd).toBe('6.000000');
    const attributed = report.totals.attributed;
    expect(attributed).toMatchObject({ label: 'Attributed · not verified', rows: 2, signatures: 2 });
    expect(attributed.cumulative!.assets.map(asset => [asset.mint, asset.raw, asset.currentUsd])).toEqual([
      [MINT, '2000000', '4.000000'], [SECOND_MINT, '7000000', null]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(attributed.cumulative!.currentUsd).toBe('4.000000');
    expect(attributed.rolling168h!.assets.map(asset => asset.raw)).toEqual(['2000000']);
    expect(attributed.latest24h).toMatchObject({ currentUsd: null, assets: [] });
    expect(attributed.utcDays!.map(day => day.day)).toEqual([iso(CUTOFF - 9 * 86400).slice(0, 10), iso(CUTOFF - 2 * 86400).slice(0, 10)]);
    expect(report.totals.unknown).toEqual({ label: 'Unknown · not counted', explanation: expect.stringContaining('not a verified zero') as unknown,
      rows: 1, signatures: 1, provenCredits: { credits: 1, mints: 1, assets: [{ mint: MINT, symbol: 'QUOTE', decimals: 6, raw: '11', amount: '0.000011', credits: 1 }] } });
    expect(report.totals.unpriced).toMatchObject({ verified: [{ mint: THIRD_MINT, raw: '6000000', amount: '6.000000' }],
      attributed: [{ mint: SECOND_MINT, raw: '7000000', amount: '7.000000' }] });
    expect(report.cumulative.pricingCoverage).toEqual({ pricedWalletCreditGroups: 1, totalWalletCreditGroups: 2, pricedMints: 1, totalMints: 2 });
    expect(attributed.cumulative!.pricingCoverage).toEqual({ pricedWalletCreditGroups: 1, totalWalletCreditGroups: 2, pricedMints: 1, totalMints: 2 });
    // MINT is in both groups: its combined raw amount or USD never appears in any field.
    const json = JSON.stringify(report);
    expect(json).not.toContain('"raw":"5000000"');
    expect(json).not.toContain('10.000000');
    const view = reportView(report);
    expect(view.counts).toEqual({ confirmed: 2, excluded: 0, unknown_candidate: 1 });
    expect(view.attribution).toMatchObject({ evaluated: true, rows: 2, signatures: 2, cumulative: { currentUsd: '4.000000', unpricedCount: 1 } });
    expect(view.pricingCoverage).toMatchObject({ verified: { pricedMints: 1 }, attributed: { pricedMints: 1 } });
    expect(view.unknownTotals.provenCredits).toMatchObject({ credits: 1, assets: [{ raw: '11' }] });
    expect(view.attributedEvidence[0]!.attribution).toMatchObject({ sourceOwner: DISTRIBUTOR, primaryTrustSource: 'feed_witnessed_identity' });
    expect(JSON.stringify(view)).not.toContain('10.000000');
  });

  it.each(['v5 rows before reclassification', 'schema v4', 'schema v4 with classifier v1 rows'])('reports attributed totals as null, never zero, when unevaluated: %s', variant => {
    const path = database(); seeded(path).close();
    const db = new DatabaseSync(path);
    db.exec(`UPDATE classifications SET status=CASE WHEN status='attributed' THEN 'unknown_candidate' ELSE status END,
      body=json_set(body,'$.version','stonkfun-classifier-v2','$.status',CASE WHEN status='attributed' THEN 'unknown_candidate' ELSE status END);
      DELETE FROM classification_versions WHERE version='stonkfun-classifier-v3';`);
    if (variant !== 'v5 rows before reclassification') db.exec('DROP TABLE withdrawal_authority_snapshots; DROP TABLE identity_conflicts; PRAGMA user_version=4;');
    // Classifier v1 rows carry no destination owner: their unknown credits are not determinable, never 0.
    const v1 = variant === 'schema v4 with classifier v1 rows';
    if (v1) db.exec(`UPDATE classifications SET body=json_remove(json_set(body,'$.version','stonkfun-classifier-v1'),'$.destinationOwner')`);
    db.close();
    const report = buildReport(open(path, true), WALLET);
    expect(report.attribution.evaluated).toBe(false);
    expect(report.counts).toEqual({ confirmed: 2, attributed: null, excluded: 0, unknown_candidate: 3 });
    expect(report.uniqueSignatures.attributed).toBeNull();
    expect(report.attributionBasisCounts).toBeNull();
    expect(report.totals.attributed).toMatchObject({ rows: null, signatures: null, rolling168h: null, latest24h: null, cumulative: null, utcDays: null });
    expect(report.totals.unpriced.attributed).toBeNull();
    expect(report.totals.verified.cumulative.currentUsd).toBe('6.000000');
    expect(reportView(report).attribution).toMatchObject({ evaluated: false, rows: null, cumulative: null, assets: null });
    const text = humanReport(report);
    expect(text).toContain('Attributed — distributor pattern, not verified: not evaluated');
    expect(text).toContain('Unpriced — excluded from USD, not zero: verified 1; attributed not evaluated');
    if (v1) {
      expect(report.totals.unknown.provenCredits).toBeNull(); expect(reportView(report).unknownTotals.provenCredits).toBeNull();
      expect(text).toContain('Unknown — not counted: 3 rows / 3 signatures; proven credits not determinable');
    } else expect(report.totals.unknown.provenCredits).toMatchObject({ credits: 3, mints: 2 });
  });

  it('prices verified mints first and attributed mints only with the remaining budget', async () => {
    for (const limit of [20, 1]) {
      const store = seeded(); const priced: string[] = []; let clock = CUTOFF * 1000;
      const providers = (job: { id: string }): Providers => ({
        registry: () => Promise.resolve({ feeds: [], quotes: [], retrievedAt: iso(CUTOFF), complete: true, detail: 'synthetic' }),
        hydrate: () => Promise.resolve(null),
        history: () => Promise.resolve({ continuation: { restartRequired: false } } as unknown as HistoryResult),
        price: mint => {
          priced.push(mint);
          // Each lookup consumes both providers, as a StonkFun miss followed by a DAS fallback would.
          store.reserveRequest(job.id, 'stonkfun', clock); store.reserveRequest(job.id, 'helius', clock);
          return Promise.resolve({ mint, currency: 'USD', value: '1.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF), expiresAt: 0, reason: null });
        },
      });
      await runScan(store, { wallet: WALLET, cutoff: CUTOFF, jobId: `pricing-${limit}`, owner: 'owner',
        limits: { stonkfun: limit, helius: limit, pages: 10, resumes: 2, deadline: CUTOFF * 1000 + 3600_000 } }, providers, { now: () => (clock += 1000) });
      // MINT has a saved price; THIRD_MINT (verified) precedes SECOND_MINT (attributed) and MINT is never repeated.
      expect(priced).toEqual(limit === 20 ? [THIRD_MINT, SECOND_MINT] : [THIRD_MINT]);
    }
  });

  it('prints separate CLI groups and full attribution detail addresses', () => {
    const path = database(); const store = seeded(path);
    const text = humanReport(buildReport(store, WALLET));
    expect(text).toMatchSnapshot();
    expect(text).not.toMatch(/\b\w{4}…\w{4}\b/);
    store.close();
    const cli = execFileSync(process.execPath, ['--import', './tests/fixtures/no-network.mjs', 'dist/cli/main.js', 'report', WALLET, '--db', path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(cli).toBe(`${text}\n`);
  });
});

describe('report prices: the latest saved USD observation per mint', () => {
  /** A saved observation at `time`: valued when `value` is given, otherwise the no-price result a missed lookup saves. */
  const observation = (mint: string, value: string | null, time: number, extra: Partial<Price> = {}): Price => ({ mint, currency: 'USD', value,
    provider: value === null ? 'helius' : 'fixture', observedAt: value === null ? null : iso(time), retrievedAt: iso(time), expiresAt: 0,
    reason: value === null ? 'no_valid_usd_price' : null, ...extra });
  const assetOf = (window: { assets: { mint: string }[] } | null | undefined, mint: string) => window!.assets.find(asset => asset.mint === mint)!;

  it('keeps each mint at its last saved price when a capped pass saves only observations without one', async () => {
    // MINT's $2.00 from the cutoff has expired when the pass starts, so the pass looks it up again.
    const store = seeded(database(), CUTOFF * 1000);
    // The wallet is already loaded from its tracking start, so this pass is a refresh of that range rather than a first scan.
    const loaded: Job = { id: 'loaded', network, wallet: WALLET, cutoff: CUTOFF, createdAt: CUTOFF * 1000, status: 'complete',
      limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: CUTOFF * 1000 }, used: { stonkfun: 0, helius: 0, pages: 0, resumes: 1 },
      pageSize: 100, error: null, registryDone: true, hydrationDone: true };
    store.atomic(() => { store.saveJob(loaded); store.createRanges(loaded, [{ startTime: CUTOFF - 864000, endTime: CUTOFF }]); store.completeRange(loaded, store.ranges('loaded')[0]!); });
    let clock = CUTOFF * 1000; const looked: string[] = [];
    const providers = (job: { id: string }): Providers => ({
      registry: () => Promise.resolve({ feeds: [], quotes: [], retrievedAt: iso(CUTOFF), complete: true, detail: 'synthetic' }),
      hydrate: () => Promise.resolve(null),
      history: () => Promise.resolve({ continuation: { restartRequired: false } } as unknown as HistoryResult),
      // The StonkFun budget is spent, so every lookup falls back to DAS, which has no price for any of them.
      price: mint => { looked.push(mint); store.reserveRequest(job.id, 'helius', clock); return Promise.resolve(observation(mint, null, clock / 1000)); },
    });
    await runScan(store, { wallet: WALLET, cutoff: CUTOFF, jobId: 'capped-pass', owner: 'owner',
      limits: { stonkfun: 1, helius: 20, pages: 10, resumes: 2, deadline: CUTOFF * 1000 + 3600_000 } }, providers, { now: () => (clock += 1000) });
    expect(looked.toSorted()).toEqual([MINT, SECOND_MINT, THIRD_MINT].toSorted());
    // The newest observation of MINT carries no value; the report still values MINT at the $2.00 it last saw.
    expect(store.price(network, MINT)).toMatchObject({ value: null, reason: 'no_valid_usd_price' });
    const report = buildReport(store, WALLET);
    expect(assetOf(report.cumulative, MINT)).toMatchObject({ currentUsd: '6.000000', priceAt: iso(CUTOFF), priceAgeSeconds: 0, priceStale: false,
      price: { value: '2.00', retrievedAt: iso(CUTOFF) } });
    expect(assetOf(report.totals.attributed.cumulative, MINT)).toMatchObject({ currentUsd: '4.000000', priceAt: iso(CUTOFF), priceStale: false });
    expect([report.cumulative.currentUsd, report.totals.attributed.cumulative!.currentUsd]).toEqual(['6.000000', '4.000000']);
    // Mints that never had a valued observation stay unpriced, with the latest miss and its reason.
    expect(assetOf(report.totals.attributed.cumulative, SECOND_MINT)).toMatchObject({ currentUsd: null, priceAt: null, priceStale: null,
      price: { value: null, reason: 'no_valid_usd_price' } });
    expect(reportView(report).attribution.assets!.find(asset => asset.mint === MINT)).toMatchObject({ currentUsd: '4.000000', priceAt: iso(CUTOFF), priceStale: false });
  });

  it('flags a price taken more than 24 hours before the cutoff as stale, by its observation time, and exactly 24 hours as not', () => {
    const store = seeded();
    store.savePrice(network, observation(SECOND_MINT, '0.50', CUTOFF - STALE_PRICE_SECONDS - 1));
    // Retrieved ten seconds before the cutoff, but observed exactly 24 hours before it.
    store.savePrice(network, observation(THIRD_MINT, '0.10', CUTOFF - 10, { observedAt: iso(CUTOFF - STALE_PRICE_SECONDS) }));
    const report = buildReport(store, WALLET);
    expect(assetOf(report.totals.attributed.cumulative, SECOND_MINT)).toMatchObject({ currentUsd: '3.500000', priceAt: iso(CUTOFF - 86401), priceAgeSeconds: 86401, priceStale: true });
    expect(assetOf(report.cumulative, THIRD_MINT)).toMatchObject({ currentUsd: '0.600000', priceAt: iso(CUTOFF - 86400), priceAgeSeconds: 86400, priceStale: false });
    expect(assetOf(report.cumulative, MINT)).toMatchObject({ priceAgeSeconds: 0, priceStale: false });
    // Stale prices stay in the figures at their saved value; each window names its price span and stale count.
    expect(report.totals.attributed.cumulative).toMatchObject({ currentUsd: '7.500000',
      priceAges: { oldestPriceAt: iso(CUTOFF - 86401), newestPriceAt: iso(CUTOFF), stalePricedMints: 1 } });
    expect(report.cumulative).toMatchObject({ currentUsd: '6.600000', priceAges: { oldestPriceAt: iso(CUTOFF - 86400), newestPriceAt: iso(CUTOFF), stalePricedMints: 0 } });
    expect(report.totals.attributed.utcDays!.find(day => day.assets.some(asset => asset.mint === SECOND_MINT))!.priceAges.stalePricedMints).toBe(1);
    expect(report).toMatchObject({ schemaVersion: 3, stalePriceSeconds: 86400, priceRule: expect.stringContaining('most recent saved USD observation') as unknown });
    expect(humanReport(report)).toContain(`Attributed (not verified) SECOND [${SECOND_MINT}]: 7.000000 — $3.500000 at ${iso(CUTOFF - 86401)} — STALE, 86401 s before the cutoff`);
    expect(humanReport(report)).toContain(`Verified THIRD [${THIRD_MINT}]: 6.000000 — $0.600000 at ${iso(CUTOFF - 86400)}\n`);
    const view = reportView(report);
    expect(view.attribution.assets!.find(asset => asset.mint === SECOND_MINT)).toMatchObject({ priceAt: iso(CUTOFF - 86401), priceAgeSeconds: 86401, priceStale: true });
    expect(view.assets.find(asset => asset.mint === THIRD_MINT)).toMatchObject({ priceStale: false, priceAgeSeconds: 86400 });
    expect(view.attribution.dayTokens!.flatMap(day => day.tokens).find(token => token.mint === SECOND_MINT)).toMatchObject({ priceStale: true, priceAgeSeconds: 86401 });
    expect(view.attribution.cumulative!.priceAges).toEqual({ oldestPriceAt: iso(CUTOFF - 86401), newestPriceAt: iso(CUTOFF), stalePricedMints: 1 });
  });

  it('leaves a mint with no valued observation unpriced, listed apart and never counted as zero', () => {
    const store = seeded();
    for (const time of [CUTOFF - 7200, CUTOFF - 60]) store.savePrice(network, observation(SECOND_MINT, null, time));
    const report = buildReport(store, WALLET);
    const attributed = report.totals.attributed.cumulative!;
    expect(assetOf(attributed, SECOND_MINT)).toMatchObject({ currentUsd: null, priceAt: null, priceAgeSeconds: null, priceStale: null,
      price: { value: null, retrievedAt: iso(CUTOFF - 60) } });
    expect(report.totals.unpriced.attributed).toEqual([{ mint: SECOND_MINT, symbol: 'SECOND', decimals: 6, raw: '7000000', amount: '7.000000' }]);
    expect(attributed).toMatchObject({ currentUsd: '4.000000', pricingCoverage: { pricedMints: 1, totalMints: 2 }, priceAges: { stalePricedMints: 0 } });
    // A window with no priced mint has no price span.
    expect(report.totals.attributed.utcDays!.find(day => day.assets.every(asset => asset.mint === SECOND_MINT))).toMatchObject({ currentUsd: null,
      priceAges: { oldestPriceAt: null, newestPriceAt: null, stalePricedMints: 0 } });
    expect(reportView(report).attribution.assets!.find(asset => asset.mint === SECOND_MINT)).toMatchObject({ currentUsd: null, priceAt: null, priceStale: null });
  });

  it('totals every window as the exact sum of its assets at their own saved prices', () => {
    const store = seeded();
    store.savePrice(network, observation(SECOND_MINT, '0.333333333', CUTOFF - 5 * 86400));
    store.savePrice(network, observation(THIRD_MINT, '1.1e-3', CUTOFF - 3600));
    // A later miss for MINT never replaces its valued observation.
    store.savePrice(network, observation(MINT, null, CUTOFF + 30));
    const report = buildReport(store, WALLET);
    const attributed = report.totals.attributed;
    const windows = [report.cumulative, report.rolling168h, report.latest24h, ...report.utcDays,
      attributed.cumulative!, attributed.rolling168h!, attributed.latest24h!, ...attributed.utcDays!];
    for (const window of windows) {
      const exact = window.assets.reduce<Decimal>((sum, asset) => asset.price?.value && asset.currentUsd !== null ? add(sum, valueOf(asset.raw, asset.decimals, asset.price.value)) : sum,
        { coefficient: 0n, scale: 0 });
      expect(window.currentUsd).toBe(window.assets.some(asset => asset.currentUsd !== null) ? rounded(exact) : null);
    }
    // 2 × $2.00 + 7 × $0.333333333, and 3 × $2.00 + 6 × $0.0011, each rounded once after exact addition.
    expect([attributed.cumulative!.currentUsd, report.cumulative.currentUsd]).toEqual(['6.333333', '6.006600']);
  });
});
