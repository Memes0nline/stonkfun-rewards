import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { DashboardService } from '../src/web/service.js';
import { createDashboardServer } from '../src/web/server.js';
import { walletHoldings } from '../src/web/view.js';
import type { WalletTokenBalance } from '../src/web/view.js';
import { allLaunchesLabel, launchesPage, LAUNCHES_PAGE, short, SOURCES_EMPTY_WHY, SOURCES_LOADING, sourcesEmpty, sourcesHeading, sourcesSentence, stonkfunTokenLink, utc } from '../web/model.js';
import { stonkfunTokenLink as serverLink } from '../src/web/view.js';
import { AllLaunches, SourceLaunches, TokensTab } from '../web/Tokens.js';
import type { SourcesState, SourceToken } from '../web/Tokens.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import { CUTOFF, iso, MINT, officialFeed, payout, recipient, SECOND_MINT, syntheticKey, syntheticSignature, toWallet, WALLET } from './fixtures/distributor.js';

// SYNTHETIC wallet holdings and /rewards summaries. Every key is a hash of a label.
const network = 'mainnet-beta';
const THIRD_MINT = syntheticKey('sources-third-quote');
const SELLER = syntheticKey('sources-seller');
const BUYER = syntheticKey('sources-buyer');
const launchOf = (label: string) => syntheticKey(`sources-launch-${label}`);
const HELD = launchOf('held'); const SOLD = launchOf('sold'); const NEVER_HELD = launchOf('never-held'); const UNNAMED = launchOf('unnamed');
const EMPTY = launchOf('empty-account'); const EXACT = launchOf('exact'); const EXACT_OTHER = launchOf('exact-other-never-held');
const walletAccount = (label: string) => syntheticKey(`sources-wallet-account-${label}`);
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-sources', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'rewards-sources-')); directories.push(directory);
  const store = new SqliteRewardsStore(join(directory, 'sources.sqlite')); stores.push(store); return store;
}
/** A buy of `amount` of a launch into the wallet's own account for it, from a seller. */
const buy = (label: string, launch: string, amount: string, time: number) => payout({ label: `sources-buy-${label}`, time,
  legs: [{ owner: SELLER, mint: launch, destination: walletAccount(label), destinationOwner: WALLET, amount }] });
const summary = (launchMint: string, retrievedAt: string) => ({ kind: 'rewardSummary' as const, launchMint, endpoint: '/rewards?limit=100', retrievedAt });
const txs = {
  witness: payout({ label: 'sources-witness', time: CUTOFF - 1000, legs: [0, 1, 2].map(index => ({ ...recipient(700 + index), amount: String(40_000 + index) })) }),
  attributed: payout({ label: 'sources-attributed', time: CUTOFF - 2 * 86400, legs: [toWallet('2000000'), ...[0, 1].map(index => ({ ...recipient(710 + index), amount: '1000' }))] }),
  uncovered: payout({ label: 'sources-uncovered', time: CUTOFF - 3 * 86400, legs: [toWallet('7000000', { mint: SECOND_MINT, destination: syntheticKey('sources-wallet-second') })] }),
  verified: payout({ label: 'sources-verified', time: CUTOFF - 3600, legs: [toWallet('3000000', { mint: THIRD_MINT, destination: syntheticKey('sources-wallet-third') })] }),
  held: buy('held', HELD, '5000000', CUTOFF - 5 * 86400),
  soldBuy: buy('sold', SOLD, '2000000', CUTOFF - 6 * 86400),
  // The wallet later sends its whole balance away: its account holds 0 when last seen.
  sold: payout({ label: 'sources-sell-sold', time: CUTOFF - 4 * 86400, feePayer: WALLET,
    legs: [{ owner: WALLET, mint: SOLD, source: walletAccount('sold'), destination: syntheticKey('sources-buyer-account'), destinationOwner: BUYER, amount: '10000000000' }] }),
  unnamed: buy('unnamed', UNNAMED, '9000000', CUTOFF - 5 * 86400),
  exact: buy('exact', EXACT, '1000000', CUTOFF - 7 * 86400),
  // An account of a named launch that the wallet only ever shows empty.
  empty: payout({ label: 'sources-empty', time: CUTOFF - 5 * 86400 + 60, legs: [toWallet('5', { owner: SELLER, mint: syntheticKey('sources-dust'), destination: syntheticKey('sources-dust-account') })],
    extraBalances: [{ address: walletAccount('empty'), owner: WALLET, mint: EMPTY, pre: '0', post: '0' }] }),
};
const signatureOf = (tx: FullTransaction) => tx.transaction.signatures[0]!;
/** One wallet: an attributed QUOTE receipt, an attributed SECOND receipt no summary covers, and a THIRD receipt the official feed
 * confirms and names the EXACT launch for. The wallet has bought HELD and EXACT, bought and then sold SOLD, bought UNNAMED that no
 * summary names, and shows an empty EMPTY account. */
function seeded() {
  const store = open();
  store.atomic(() => {
    store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    // Two /rewards reads: the later one no longer names SOLD, which stays retained from the first.
    store.saveQuote(network, { mint: MINT, symbol: 'QUOTE', retrievedAt: iso(CUTOFF - 86400),
      membershipEvidence: [summary(HELD, iso(CUTOFF - 86400)), summary(SOLD, iso(CUTOFF - 86400)), summary(NEVER_HELD, iso(CUTOFF - 86400)), summary(EMPTY, iso(CUTOFF - 86400))] });
    store.saveQuote(network, { mint: MINT, symbol: 'QUOTE', retrievedAt: iso(CUTOFF), membershipEvidence: [summary(HELD, iso(CUTOFF)), summary(NEVER_HELD, iso(CUTOFF)), summary(EMPTY, iso(CUTOFF))] });
    store.saveQuote(network, { mint: SECOND_MINT, symbol: 'SECOND', retrievedAt: iso(CUTOFF),
      membershipEvidence: [{ kind: 'distribution', launchMint: syntheticKey('launch'), endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) }] });
    store.saveQuote(network, { mint: THIRD_MINT, symbol: 'THIRD', retrievedAt: iso(CUTOFF),
      membershipEvidence: [summary(EXACT, iso(CUTOFF)), summary(EXACT_OTHER, iso(CUTOFF))] });
    // Retained metadata for one launch mint; the others have none.
    store.saveQuote(network, { mint: HELD, symbol: 'HELDL', name: 'Synthetic held launch', retrievedAt: iso(CUTOFF) });
    store.savePrice(network, { mint: MINT, currency: 'USD', value: '2.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF), expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    for (const tx of [txs.witness, txs.verified]) store.addTransaction(network, tx, provenance);
    store.addFeed(officialFeed(txs.witness)); store.addFeed(officialFeed(txs.verified, { launch: EXACT }));
    for (const tx of [txs.attributed, txs.uncovered, txs.verified, txs.held, txs.soldBuy, txs.sold, txs.unnamed, txs.exact, txs.empty]) {
      store.addTransaction(network, tx, provenance); store.watch(network, signatureOf(tx), WALLET);
    }
  });
  while (processDirty(store, network, 100) > 0) { /* drain */ }
  return store;
}
const serviceFor = (store: SqliteRewardsStore) => new DashboardService({ store: () => store, prepareProviders: () => { throw new Error('offline'); } });
const tokenOf = (tokens: SourceToken[], mint: string) => tokens.find(token => token.mint === mint)!;
const ready = (result: ReturnType<DashboardService['sources']>): SourcesState => ({ status: 'ready', data: result.sources });
const visible = (html: string) => html.replace(/<[^>]*>/g, ' ').replaceAll('&#x27;', "'").replace(/\s+/g, ' ').trim();

describe('likely source launches per token', () => {
  it('names launches whose retained /rewards summary pays in the token and that the wallet has held, and no others', () => {
    const store = seeded();
    const result = serviceFor(store).sources(WALLET);
    expect(result.wallet).toBe(WALLET);
    const quote = tokenOf(result.sources!.tokens, MINT);
    // Every retained summary counts, including the earlier read that alone still names SOLD.
    expect(quote).toMatchObject({ key: `${MINT}:6`, symbol: 'QUOTE', group: 'attributed', covered: true, summaryLaunches: 4, summaryRetrievedAt: iso(CUTOFF), exact: [] });
    // Still held first, then by when the wallet last showed it; never-held, empty-only and unnamed launches are left out.
    expect(quote.likely.map(launch => launch.mint)).toEqual([HELD, SOLD]);
    expect(quote.likely[0]).toEqual({ mint: HELD, symbol: 'HELDL', name: 'Synthetic held launch', summaryRetrievedAt: iso(CUTOFF),
      stonkfunLink: `https://www.stonkfun.xyz/token/${HELD}`, tokenLink: `https://solscan.io/token/${HELD}`,
      held: { raw: '5000000', decimals: 6, amount: '5.000000', holding: true, source: 'history', lastSeen: CUTOFF - 5 * 86400, evidenceLink: `https://solscan.io/tx/${signatureOf(txs.held)}` } });
    expect(quote.likely[1]).toMatchObject({ mint: SOLD, symbol: null, name: null, summaryRetrievedAt: iso(CUTOFF - 86400),
      held: { raw: '0', amount: '0.000000', holding: false, lastSeen: CUTOFF - 4 * 86400, evidenceLink: `https://solscan.io/tx/${signatureOf(txs.sold)}` } });
  });

  it('lists a verified token\'s feed-named launch apart as exact, and says when nothing held matches or summaries do not cover a token', () => {
    const store = seeded();
    const result = serviceFor(store).sources(WALLET);
    const tokens = result.sources!.tokens;
    const third = tokenOf(tokens, THIRD_MINT);
    // The feed names EXACT for the confirmed receipt; it is exact and never repeated among the likely ones, and the other
    // summary launch was never held.
    expect(third).toMatchObject({ group: 'verified', covered: true, summaryLaunches: 2, likely: [] });
    expect(third.exact).toEqual([{ mint: EXACT, symbol: null, name: null, receipts: 1, stonkfunLink: `https://www.stonkfun.xyz/token/${EXACT}`,
      tokenLink: `https://solscan.io/token/${EXACT}` }]);
    const exactText = visible(renderToStaticMarkup(createElement(SourceLaunches, { symbol: '$THIRD', token: third, sources: ready(result) })));
    // An unnamed launch reads as its short address, with Copy CA.
    expect(exactText).toContain(`Named by the official feed · exact ${short(EXACT)} Copy CA StonkFun ↗ Solscan ↗ Named by the official feed for 1 confirmed receipt`);
    expect(exactText).toContain(`${sourcesEmpty('$THIRD')} ${SOURCES_EMPTY_WHY} ${allLaunchesLabel(2, '$THIRD')}`);
    // No retained summary names SECOND at all: the same empty state, and no full list to show.
    const second = tokenOf(tokens, SECOND_MINT);
    expect(second).toMatchObject({ group: 'attributed', covered: false, summaryLaunches: 0, summaryRetrievedAt: null, likely: [], exact: [], launches: [] });
    const secondText = visible(renderToStaticMarkup(createElement(SourceLaunches, { symbol: '$SECOND', token: second, sources: ready(result) })));
    expect(secondText).toContain(`No launch you hold was found that pays in $SECOND. ${SOURCES_EMPTY_WHY} No retained StonkFun /rewards summary names $SECOND as the token a launch pays in.`);
    expect(secondText).not.toContain('Show all');
  });

  it('words the empty state, and says why nothing may match', () => {
    expect(sourcesEmpty('$X')).toBe('No launch you hold was found that pays in $X.');
    expect(SOURCES_EMPTY_WHY).toBe('This can happen when a launch was held and sold before tracking started, or when the paying launch is not in StonkFun\'s summaries.');
    expect(allLaunchesLabel(1409, '$STONK')).toBe('Show all 1,409 launches that pay in $STONK');
    expect(allLaunchesLabel(1, '$X')).toBe('Show the one launch that pays in $X');
  });

  it('opens every StonkFun launch link on the launch\'s token page, from the server rows and the full list alike', () => {
    expect(stonkfunTokenLink(HELD)).toBe(`https://www.stonkfun.xyz/token/${HELD}`);
    expect(serverLink(HELD)).toBe(stonkfunTokenLink(HELD));
    const result = serviceFor(seeded()).sources(WALLET);
    const quote = tokenOf(result.sources!.tokens, MINT);
    const html = renderToStaticMarkup(createElement(SourceLaunches, { symbol: '$QUOTE', token: quote, sources: ready(result), showAll: true }));
    const links = [...html.matchAll(/href="([^"]*stonkfun[^"]*)"/g)].map(match => match[1]!);
    expect(links.length).toBe(quote.likely.length + quote.launches.length);
    for (const link of links) expect(link).toMatch(/^https:\/\/www\.stonkfun\.xyz\/token\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(html).not.toContain('/api/public/v1');
  });

  it('pages the full launch list 25 at a time, the name when known, a short address, Copy CA and the StonkFun link on each', () => {
    const many = Array.from({ length: 60 }, (_, index) => syntheticKey(`sources-many-${index}`));
    expect(LAUNCHES_PAGE).toBe(25);
    expect(launchesPage(many, 0)).toMatchObject({ page: 0, pages: 3, first: 1, last: 25 });
    expect(launchesPage(many, 2)).toMatchObject({ page: 2, pages: 3, first: 51, last: 60 });
    expect(launchesPage(many, 2).items).toEqual(many.slice(50));
    expect(launchesPage(many, 9)).toMatchObject({ page: 2 });
    expect(launchesPage([], 0)).toMatchObject({ page: 0, pages: 1, first: 0, last: 0, items: [] });
    const token = { ...tokenOf(serviceFor(seeded()).sources(WALLET).sources!.tokens, MINT),
      launches: many.map((mint, index) => index === 0 ? { mint, symbol: 'NAMED', name: 'A named launch' } : { mint }) };
    const first = renderToStaticMarkup(createElement(AllLaunches, { symbol: '$QUOTE', token }));
    expect(first.match(/<li /g)).toHaveLength(25);
    expect(visible(first)).toContain(`1–25 of 60. $NAMED A named launch ${short(many[0]!)} Copy CA StonkFun ↗ ${short(many[1]!)} Copy CA StonkFun ↗`);
    expect(visible(first)).toContain('← Previous 25 Page 1 of 3 Next 25 →');
    expect(first).toContain(`href="https://www.stonkfun.xyz/token/${many[1]!}"`);
    expect(first).toContain(`aria-label="Copy ${short(many[1]!)} launch contract address"`);
    const last = renderToStaticMarkup(createElement(AllLaunches, { symbol: '$QUOTE', token, initialPage: 2 }));
    expect(last.match(/<li /g)).toHaveLength(10);
    expect(last).toContain('<ol class="source-list all-launch-list" start="51">');
    expect(visible(last)).toContain('51–60 of 60.');
    expect(last).toContain(`href="https://www.stonkfun.xyz/token/${many[59]!}"`);
  });

  it('leads every expansion with its heading, the time of its holdings and the fixed sentence, and labels held and sold launches', () => {
    expect(sourcesHeading('$QUOTE')).toBe('Launches you hold that pay in $QUOTE');
    expect(sourcesSentence('$QUOTE')).toBe('The payout itself does not name its launch. These are launches this wallet holds, or held earlier, whose rewards are paid in $QUOTE.');
    const result = serviceFor(seeded()).sources(WALLET);
    const quote = tokenOf(result.sources!.tokens, MINT);
    const html = renderToStaticMarkup(createElement(SourceLaunches, { symbol: '$QUOTE', token: quote, sources: ready(result) }));
    const text = visible(html);
    // Without a stored snapshot the holdings are as of the latest retained transaction behind them.
    expect(text.startsWith(`Launches you hold that pay in $QUOTE Holdings as of ${utc(CUTOFF - 3600)} · from retained transactions; Refresh rewards to check current holdings `
      + 'The payout itself does not name its launch.')).toBe(true);
    expect(text).toContain(`$HELDL Synthetic held launch Holding now ${short(HELD)} Copy CA StonkFun ↗ Solscan ↗ Holds 5.000000 · last traded ${utc(CUTOFF - 5 * 86400)} Transaction ↗`);
    expect(text).toContain(`${short(SOLD)} Held earlier, sold Copy CA StonkFun ↗ Solscan ↗ None held now · last traded ${utc(CUTOFF - 4 * 86400)}`);
    expect(text).toContain(allLaunchesLabel(4, '$QUOTE'));
    expect(html).toContain(`href="https://www.stonkfun.xyz/token/${HELD}" target="_blank" rel="noreferrer"`);
    expect(html).toContain(`aria-label="Copy ${short(HELD)} launch contract address"`);
    // Loading, a timeout, an error and a store without the retained reads each say so instead of listing nothing.
    const render = (sources: SourcesState) => visible(renderToStaticMarkup(createElement(SourceLaunches, { symbol: '$QUOTE', token: undefined, sources })));
    expect(render({ status: 'loading', data: null })).toContain(SOURCES_LOADING);
    expect(SOURCES_LOADING).toBe('Checking launches you hold…');
    expect(render({ status: 'failed', data: null, reason: 'timeout' })).toContain('Checking launches is taking longer than 15 seconds. Saved evidence is unchanged. Retry');
    expect(render({ status: 'failed', data: null, reason: 'error' })).toContain('Launches could not be checked. Saved evidence is unchanged. Retry');
    expect(render({ status: 'ready', data: null })).toContain('Launch sources are unavailable from this saved data.');
  });

  it('gives every token row a chevron that names its launches, closed until opened', () => {
    const store = seeded();
    const report = serviceFor(store).report(WALLET);
    const html = renderToStaticMarkup(createElement(TokensTab, { report, open: () => undefined, close: () => undefined }));
    expect(html.match(/<button type="button" class="chevron" aria-expanded="false" aria-controls="sources-attributed-[A-Za-z0-9-]+" aria-label="Launches you hold that pay in \$[A-Z]+">/g))
      .toHaveLength(2);
    expect(html).toContain('aria-label="Launches you hold that pay in $THIRD"');
    expect(html).not.toContain('class="sources-row"');
  });

  it('reads holdings from the last observation of each wallet account: a closed account last held 0, and empty ones never count', () => {
    const row = (account: string, slot: number, preRaw: string | null, postRaw: string | null, mint = 'M'): WalletTokenBalance => ({ signature: syntheticSignature(`${account}-${slot}`),
      slot, position: 1, time: slot, account, mint, decimals: 2, preRaw, postRaw });
    const holdings = walletHoldings([row('a', 10, '0', '500'), row('a', 20, '500', '700'), row('b', 15, '0', '300'), row('b', 30, '300', null),
      row('c', 5, '0', '0', 'Z'), row('d', 40, '0', '100', 'N'), row('d', 41, '100', '0', 'N')]);
    // Account a last shows 700; b closes at slot 30, so it last held 0: the mint holds 7.00, last seen at slot 30.
    expect(holdings.get('M')).toMatchObject({ everHeld: true, raw: 700n, time: 30, slot: 30 });
    expect(holdings.get('Z')).toMatchObject({ everHeld: false, raw: 0n });
    expect(holdings.get('N')).toMatchObject({ everHeld: true, raw: 0n, time: 41 });
  });

  it('reads the wallet\'s retained transactions once until the retained data changes, and serves the list over HTTP', async () => {
    const store = seeded();
    const service = serviceFor(store);
    const reads = vi.spyOn(store, 'walletTokenBalances');
    const first = service.sources(WALLET);
    expect(service.sources(WALLET)).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(1);
    // A newly watched transaction changes the retained data: HELD's later purchase is read on the next request.
    store.atomic(() => { const later = buy('held-later', HELD, '1500000', CUTOFF - 86400); store.addTransaction(network, later, provenance); store.watch(network, signatureOf(later), WALLET); });
    const refreshed = tokenOf(service.sources(WALLET).sources!.tokens, MINT).likely[0]!;
    expect(reads).toHaveBeenCalledTimes(2);
    expect(refreshed.held).toMatchObject({ amount: '6.500000', lastSeen: CUTOFF - 86400 });
    const app = createDashboardServer(service); const origin = await app.listen(0); closers.push(() => app.close());
    const get = (path: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const call = request(origin, { path }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { text += part; });
        response.on('end', () => { resolve({ status: response.statusCode!, text }); }); });
      call.on('error', reject); call.end();
    });
    const ok = await get(`/api/v1/wallets/${WALLET}/sources`);
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.text) as { sources: { tokens: SourceToken[] } }).sources.tokens.map(token => token.symbol).sort()).toEqual(['QUOTE', 'SECOND', 'THIRD']);
    expect((await get('/api/v1/wallets/not-a-wallet/sources')).status).toBe(400);
    // A store without the retained reads has no launch sources, never an empty list.
    const bare = seeded();
    Object.defineProperty(bare, 'walletTokenBalances', { value: undefined });
    expect(serviceFor(bare).sources(WALLET)).toEqual({ wallet: WALLET, sources: null });
  });
});
