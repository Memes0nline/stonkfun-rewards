// Explicitly synthetic browser-test server. Never imports the real runtime entrypoint or reads credentials.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval, clearInterval } from 'node:timers';
import { parseArgs } from 'node:util';
import { SqliteRewardsStore } from '../dist/storage/sqlite.js';
import { createRealProviders, WITHDRAW_AUTHORITY_CONFIGURATION_MINT } from '../dist/providers/real.js';
import { demoData, demoFetch, demoTransaction, DEMO_WALLET, DEMO_CUTOFF } from '../dist/cli/demo.js';
import { associatedTokenAddress, base58Encode } from '../dist/scanner/ata.js';
import { SPL_TOKEN_PROGRAM } from '../dist/normalization/normalizer.js';
import { COMPUTE_BUDGET_PROGRAM } from '../dist/payout-evidence/compute-budget.js';
import { DashboardService } from '../dist/web/service.js';
import { earlierRefusal } from '../dist/scanner/engine.js';
import { processDirty } from '../dist/scanner/classifier.js';
import { walletHoldings } from '../dist/scanner/holdings.js';
import { HISTORY_FLOOR } from '../dist/scanner/ranges.js';
import { createDashboardServer } from '../dist/web/server.js';

const store = new SqliteRewardsStore(join(mkdtempSync(join(tmpdir(), 'rewards-browser-fixture-')), 'fixture.sqlite'));
const data = demoData();
data.transactions[0] = demoTransaction('3', DEMO_CUTOFF - 3600, '125432000');
data.official[0] = data.transactions[0];
for (const [index, char] of [...'ABCDE'].entries()) {
  const transaction = demoTransaction(char, DEMO_CUTOFF - (index + 1) * 86400, String((index + 1) * 12340000));
  data.transactions.push(transaction); data.official.push(transaction);
}

// Attributed tier: two synthetic distributors pay the wallet from their own derived token accounts, and no official row
// names those payouts. One is witnessed by three official distributions; the other is the published withdraw authority.
// Keys and signatures are hashes of labels, never captured addresses.
const key = label => base58Encode(createHash('sha256').update(`synthetic-browser-fixture:${label}`).digest());
const signature = label => base58Encode(createHash('sha512').update(`synthetic-browser-fixture:${label}`).digest());
const FEED_DISTRIBUTOR = key('feed-witnessed-distributor');
const PUBLISHED_AUTHORITY = key('published-withdraw-authority');
const QUOTE_A = key('attributed-quote-a');
const QUOTE_B = key('attributed-quote-b');
const DUAL = key('dual-role-mint'); // A reward quote mint that one retained witness row also names as its launch.
const recipient = index => ({ destination: key(`recipient-account-${index}`), owner: key(`recipient-${index}`) });
const wallet = mint => ({ destination: key(`wallet-account-${mint}`), owner: DEMO_WALLET });
const leg = (target, mint, amount) => ({ ...target, mint, amount });
/** jsonParsed payout signed by `owner` from its derived token accounts: fee-only SOL movement and exact token balances. */
function payout(label, time, owner, legs) {
  const source = mint => associatedTokenAddress(owner, mint, SPL_TOKEN_PROGRAM).address;
  const accounts = new Map();
  for (const item of legs) {
    const from = accounts.get(source(item.mint)) ?? { owner, mint: item.mint, pre: 10_000_000_000n, post: 10_000_000_000n };
    from.post -= BigInt(item.amount); accounts.set(source(item.mint), from);
    const to = accounts.get(item.destination) ?? { owner: item.owner, mint: item.mint, pre: 0n, post: 0n };
    to.post += BigInt(item.amount); accounts.set(item.destination, to);
  }
  const keys = [owner, ...accounts.keys(), ...new Set(legs.map(item => item.mint)), SPL_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM];
  const balances = phase => [...accounts].map(([address, account]) => ({ accountIndex: keys.indexOf(address), mint: account.mint, owner: account.owner,
    programId: SPL_TOKEN_PROGRAM, uiTokenAmount: { amount: account[phase].toString(), decimals: 6, uiAmount: null } }));
  return { slot: time, transactionIndex: 1, blockTime: time, version: 0,
    transaction: { signatures: [signature(label)], message: {
      accountKeys: keys.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: index <= accounts.size })),
      instructions: [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: 'Fj2Eoy' }, ...legs.map(item => ({ programId: SPL_TOKEN_PROGRAM, program: 'spl-token',
        parsed: { type: 'transferChecked', info: { source: source(item.mint), destination: item.destination, authority: owner, mint: item.mint,
          tokenAmount: { amount: item.amount, decimals: 6, uiAmount: null } } } }))] } },
    meta: { err: null, fee: 5000, preBalances: keys.map(() => 2039280), postBalances: keys.map((_, index) => index === 0 ? 2034280 : 2039280),
      preTokenBalances: balances('pre'), postTokenBalances: balances('post'), innerInstructions: [], logMessages: [] } };
}
// Official distributions witnessing FEED_DISTRIBUTOR; they are hydrated like any feed signature.
const witnesses = [
  { tx: payout('witness-1', DEMO_CUTOFF - 1800, FEED_DISTRIBUTOR, [leg(recipient(1), QUOTE_A, '1000000'), leg(recipient(2), QUOTE_A, '1100000')]), launch: DUAL },
  { tx: payout('witness-2', DEMO_CUTOFF - 1700, FEED_DISTRIBUTOR, [leg(recipient(3), DUAL, '300000'), leg(recipient(4), DUAL, '400000')]), launch: key('launch-2') },
  { tx: payout('witness-3', DEMO_CUTOFF - 1600, FEED_DISTRIBUTOR, [leg(recipient(5), QUOTE_B, '500000'), leg(recipient(6), QUOTE_B, '600000')]), launch: key('launch-3') },
];
// Wallet credits that no official row names: feed-witnessed (one dual-role) and published authority (one unpriced).
data.transactions.push(
  payout('attributed-feed-batch', DEMO_CUTOFF - 2 * 86400 - 1400, FEED_DISTRIBUTOR,
    [leg(wallet(QUOTE_A), QUOTE_A, '40000000'), leg(recipient(7), QUOTE_A, '1500000'), leg(recipient(8), QUOTE_A, '2250000')]),
  payout('attributed-feed-dual-role', DEMO_CUTOFF - 3 * 86400 - 1234, FEED_DISTRIBUTOR, [leg(wallet(DUAL), DUAL, '3250000')]),
  payout('attributed-feed-after-witnesses', DEMO_CUTOFF - 600, FEED_DISTRIBUTOR, [leg(wallet(QUOTE_A), QUOTE_A, '2000000'), leg(recipient(9), QUOTE_A, '500000')]),
  payout('attributed-published', DEMO_CUTOFF - 86400 - 5000, PUBLISHED_AUTHORITY,
    [leg(wallet(QUOTE_A), QUOTE_A, '12500000'), ...[10, 11, 12].map(index => leg(recipient(index), QUOTE_A, '750000'))]),
  payout('attributed-published-unpriced', DEMO_CUTOFF - 4 * 86400 - 777, PUBLISHED_AUTHORITY, [leg(wallet(QUOTE_B), QUOTE_B, '7000000')]),
);
Object.assign(data.prices, { [QUOTE_A]: '0.50', [DUAL]: '2.00', [QUOTE_B]: null });
const json = value => new globalThis.Response(JSON.stringify(value), { status: 200 });
/** Extends the deterministic demo responses with the synthetic witness rows, pairs, witness hydration and configuration read. */
const fixtureFetch = base => async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname;
  if (url.hostname === 'www.stonkfun.xyz' && (path.endsWith('/rewards') || path.endsWith('/pairs') || path.endsWith('/launchlab/pricing'))) {
    const body = await (await base(input, init)).json();
    if (path.endsWith('/rewards')) body.data.recentDistributions.push(...witnesses.map(({ tx, launch }) => ({ signature: tx.transaction.signatures[0], mint: launch,
      quoteMint: tx.meta.preTokenBalances[0].mint, holderCount: tx.transaction.message.instructions.length - 1, distributedAt: new Date(tx.blockTime * 1000).toISOString(),
      amountRaw: tx.transaction.message.instructions.slice(1).reduce((sum, item) => sum + BigInt(item.parsed.info.tokenAmount.amount), 0n).toString() })));
    else if (path.endsWith('/pairs')) body.data.pairs.push(...[[QUOTE_A, 'ATTRA', 'Synthetic attributed asset'], [QUOTE_B, 'ATTRB', 'Synthetic unpriced attributed asset'],
      [DUAL, 'DUAL', 'Synthetic dual-role asset']].map(([mint, symbol, name]) => ({ mint, symbol, name, decimals: 6, category: 'fixture', tokenProgram: SPL_TOKEN_PROGRAM, launchable: false })));
    else if (url.searchParams.get('quoteMint') === WITHDRAW_AUTHORITY_CONFIGURATION_MINT) body.data.modes.reward.withdrawWithheldAuthority = PUBLISHED_AUTHORITY;
    return json(body);
  }
  if (url.hostname === 'mainnet.helius-rpc.com' && typeof init?.body === 'string') {
    const request = JSON.parse(init.body);
    if (request.method === 'getTransactionsForAddress' && request.params[0] === LATER_DAY_WALLET) return demoFetch(laterDayHistory, now)(input, init);
    if (request.method === 'getTransactionsForAddress' && request.params[0] === READ_ONCE_WALLET) return demoFetch(readOnceHistory, now)(input, init);
    const witness = request.method === 'getTransaction' ? witnesses.find(({ tx }) => tx.transaction.signatures[0] === request.params[0]) : undefined;
    if (witness) {
      data.calls.helius++;
      const result = JSON.parse(JSON.stringify(witness.tx)); delete result.transactionIndex;
      return json({ jsonrpc: '2.0', id: request.id, result });
    }
  }
  return base(input, init);
};

// Not-evaluated variant: a second synthetic wallet whose rows were saved before classifier v3. Its own mint and
// signatures are outside every fixture scan, so its attributed tier stays unevaluated while scans run.
const NOT_EVALUATED_WALLET = key('not-evaluated-wallet');
function seedNotEvaluated() {
  const mint = key('not-evaluated-quote'); const sender = key('not-evaluated-sender');
  const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const row = (label, time, raw, confirmed) => ({ identity: JSON.stringify(['synthetic-browser-fixture', label]), signature: signature(`not-evaluated-${label}`),
    network: 'mainnet-beta', wallet: NOT_EVALUATED_WALLET, blockTime: time, mint, decimals: 6, grossRaw: raw, netRaw: raw,
    status: confirmed ? 'confirmed' : 'unknown_candidate', reasons: confirmed ? ['exact_feed_and_proven_credit'] : ['missing_official_distribution', 'payout_origin_unverified'],
    basis: confirmed ? 'official_feed' : null, version: 'stonkfun-classifier-v2', evidenceIds: ['synthetic-browser-fixture'],
    supportingSignatures: confirmed ? [signature(`not-evaluated-${label}`)] : [], sourceAccount: associatedTokenAddress(sender, mint, SPL_TOKEN_PROGRAM).address,
    sourceOwner: sender, authority: sender, recipient: key('not-evaluated-wallet-account'), program: SPL_TOKEN_PROGRAM, signers: [sender],
    destinationOwner: NOT_EVALUATED_WALLET, feePayer: sender, authorityEvidence: null, temporalScope: confirmed ? 'exact_transaction' : 'unestablished' });
  // Saved wallets list in address order; the demo wallet must stay first for the default view.
  if (!(NOT_EVALUATED_WALLET > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  store.atomic(() => {
    store.saveWallet({ ...store.wallet('mainnet-beta', DEMO_WALLET), wallet: NOT_EVALUATED_WALLET });
    store.saveQuote('mainnet-beta', { mint, symbol: 'LEGACY', name: 'Synthetic pre-v3 asset', decimals: 6, retrievedAt,
      membershipEvidence: [{ kind: 'distribution', launchMint: key('not-evaluated-launch'), endpoint: '/rewards?limit=100', retrievedAt }] });
    store.savePrice('mainnet-beta', { mint, currency: 'USD', value: '1.25', provider: 'fixture', observedAt: retrievedAt, retrievedAt, expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    for (const item of [row('confirmed-1', DEMO_CUTOFF - 7200, '10000000', true), row('confirmed-2', DEMO_CUTOFF - 2 * 86400 - 300, '6500000', true),
      row('unknown-1', DEMO_CUTOFF - 86400 - 900, '2500000', false), row('unknown-2', DEMO_CUTOFF - 3 * 86400 - 60, '4000000', false)]) {
      store.saveClassifications('mainnet-beta', item.signature, NOT_EVALUATED_WALLET, [item]);
    }
    store.saveCache(`dataset:mainnet-beta:${NOT_EVALUATED_WALLET}`, { value: 'SYNTHETIC DEMO — rows saved before classifier v3', expiresAt: Number.MAX_SAFE_INTEGER });
  });
}

// Verified-empty variant: a third synthetic wallet whose only retained rows are attributed, as a wallet with no exact
// feed confirmation looks. Its verified chart and token table collapse into one compact note. Row and evidence fields
// mirror what classifier v4 writes; every key and signature is a hash of a label.
const ATTRIBUTED_ONLY_WALLET = key('attributed-only-wallet');
function seedAttributedOnly() {
  const mint = key('attributed-only-quote'); const sender = key('attributed-only-distributor');
  const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const source = associatedTokenAddress(sender, mint, SPL_TOKEN_PROGRAM);
  const witness = { signature: signature('attributed-only-witness'), blockTime: DEMO_CUTOFF - 1800, evidenceIds: ['synthetic-browser-fixture'] };
  const attribution = time => ({ basis: 'distributor_pattern', modelVersion: 'distributor-pattern-v1', classifierVersion: 'stonkfun-classifier-v4',
    identityId: 'synthetic-browser-fixture-identity', trustSources: ['feed_witnessed_identity'], primaryTrustSource: 'feed_witnessed_identity',
    publishedSnapshots: [], secondsToNearestSnapshot: null,
    witnesses: { count: 1, digest: 'synthetic-browser-fixture-digest', first: witness, last: witness, signatures: [witness.signature],
      relation: 'before_first_witness', secondsToNearestWitness: witness.blockTime - time },
    sourceOwner: sender, sourceAta: source.address, ataBump: source.bump, mint, tokenProgram: SPL_TOKEN_PROGRAM,
    signerShape: { kind: 'owner_is_fee_payer', feePayer: sender, signers: [sender] },
    batch: { outerTransfersFromSource: 2, transfersFromSource: 2, distinctRecipientOwners: 2 }, creditedMintAlsoRetainedLaunch: false });
  const row = (label, time, raw) => ({ identity: JSON.stringify(['synthetic-browser-fixture', label]), signature: signature(`attributed-only-${label}`),
    network: 'mainnet-beta', wallet: ATTRIBUTED_ONLY_WALLET, blockTime: time, mint, decimals: 6, grossRaw: raw, netRaw: raw,
    status: 'attributed', reasons: ['trusted_distributor_pattern_and_proven_credit'], basis: 'distributor_pattern', version: 'stonkfun-classifier-v4',
    evidenceIds: ['synthetic-browser-fixture'], supportingSignatures: [witness.signature], sourceAccount: source.address, sourceOwner: sender,
    authority: sender, recipient: key('attributed-only-wallet-account'), destinationOwner: ATTRIBUTED_ONLY_WALLET, feePayer: sender,
    program: SPL_TOKEN_PROGRAM, signers: [sender], authorityEvidence: null, attributionEvidence: attribution(time), temporalScope: 'identity_attributed' });
  // Saved wallets list in address order; the demo wallet must stay first for the default view.
  if (!(ATTRIBUTED_ONLY_WALLET > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  store.atomic(() => {
    store.saveWallet({ ...store.wallet('mainnet-beta', DEMO_WALLET), wallet: ATTRIBUTED_ONLY_WALLET });
    store.saveQuote('mainnet-beta', { mint, symbol: 'ONLYA', name: 'Synthetic attributed-only asset', decimals: 6, retrievedAt,
      membershipEvidence: [{ kind: 'distribution', launchMint: key('attributed-only-launch'), endpoint: '/rewards?limit=100', retrievedAt }] });
    store.savePrice('mainnet-beta', { mint, currency: 'USD', value: '0.25', provider: 'fixture', observedAt: retrievedAt, retrievedAt, expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    for (const item of [row('one', DEMO_CUTOFF - 3600, '8000000'), row('two', DEMO_CUTOFF - 86400 - 1200, '4000000'),
      row('three', DEMO_CUTOFF - 3 * 86400 - 400, '12000000')]) {
      store.saveClassifications('mainnet-beta', item.signature, ATTRIBUTED_ONLY_WALLET, [item]);
    }
    store.saveCache(`dataset:mainnet-beta:${ATTRIBUTED_ONLY_WALLET}`, { value: 'SYNTHETIC DEMO — attributed rows with no verified receipt', expiresAt: Number.MAX_SAFE_INTEGER });
  });
}

/** A synthetic wallet whose only retained rows are attributed receipts of one priced quote mint from one feed-witnessed
 * distributor, seeded like the attributed-only wallet. `receipts` holds [label, blockTime, raw]; keys and signatures derive
 * from `label`. Tracking starts where the demo wallet's does unless `trackingStart` says otherwise. */
function seedAttributedWallet(label, { symbol, name, price, dataset, receipts, trackingStart }) {
  const wallet = key(`${label}-wallet`); const mint = key(`${label}-quote`); const sender = key(`${label}-distributor`);
  const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const source = associatedTokenAddress(sender, mint, SPL_TOKEN_PROGRAM);
  const witness = { signature: signature(`${label}-witness`), blockTime: DEMO_CUTOFF - 1800, evidenceIds: ['synthetic-browser-fixture'] };
  const attribution = time => ({ basis: 'distributor_pattern', modelVersion: 'distributor-pattern-v1', classifierVersion: 'stonkfun-classifier-v4',
    identityId: `synthetic-browser-fixture-${label}`, trustSources: ['feed_witnessed_identity'], primaryTrustSource: 'feed_witnessed_identity',
    publishedSnapshots: [], secondsToNearestSnapshot: null,
    witnesses: { count: 1, digest: `synthetic-browser-fixture-${label}-digest`, first: witness, last: witness, signatures: [witness.signature],
      relation: time <= witness.blockTime ? 'before_first_witness' : 'after_last_witness', secondsToNearestWitness: Math.abs(witness.blockTime - time) },
    sourceOwner: sender, sourceAta: source.address, ataBump: source.bump, mint, tokenProgram: SPL_TOKEN_PROGRAM,
    signerShape: { kind: 'owner_is_fee_payer', feePayer: sender, signers: [sender] },
    batch: { outerTransfersFromSource: 1, transfersFromSource: 1, distinctRecipientOwners: 1 }, creditedMintAlsoRetainedLaunch: false });
  const row = ([item, time, raw]) => ({ identity: JSON.stringify(['synthetic-browser-fixture', `${label}-${item}`]), signature: signature(`${label}-${item}`),
    network: 'mainnet-beta', wallet, blockTime: time, mint, decimals: 6, grossRaw: raw, netRaw: raw,
    status: 'attributed', reasons: ['trusted_distributor_pattern_and_proven_credit'], basis: 'distributor_pattern', version: 'stonkfun-classifier-v4',
    evidenceIds: ['synthetic-browser-fixture'], supportingSignatures: [witness.signature], sourceAccount: source.address, sourceOwner: sender,
    authority: sender, recipient: key(`${label}-wallet-account`), destinationOwner: wallet, feePayer: sender,
    program: SPL_TOKEN_PROGRAM, signers: [sender], authorityEvidence: null, attributionEvidence: attribution(time), temporalScope: 'identity_attributed' });
  // Saved wallets list in address order; the demo wallet must stay first for the default view.
  if (!(wallet > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  store.atomic(() => {
    const demo = store.wallet('mainnet-beta', DEMO_WALLET);
    store.saveWallet({ ...demo, wallet, trackingStart: trackingStart ?? demo.trackingStart });
    store.saveQuote('mainnet-beta', { mint, symbol, name, decimals: 6, retrievedAt,
      membershipEvidence: [{ kind: 'distribution', launchMint: key(`${label}-launch`), endpoint: '/rewards?limit=100', retrievedAt }] });
    store.savePrice('mainnet-beta', { mint, currency: 'USD', value: price, provider: 'fixture', observedAt: retrievedAt, retrievedAt, expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    for (const item of receipts.map(row)) store.saveClassifications('mainnet-beta', item.signature, wallet, [item]);
    store.saveCache(`dataset:mainnet-beta:${wallet}`, { value: dataset, expiresAt: Number.MAX_SAFE_INTEGER });
  });
}
// Day-boundary variant: receipts on two adjacent UTC days, three on the first from its first to its last second and two on the
// second from midnight. A chart day's tooltip and its day-filtered payouts must count the same receipts.
const MIDNIGHT = Math.floor(DEMO_CUTOFF / 86400) * 86400 - 86400; // 2026-09-20T00:00:00Z
function seedTwoDay() {
  seedAttributedWallet('two-day-boundary', { symbol: 'BOUND', name: 'Synthetic day-boundary asset', price: '0.50',
    dataset: 'SYNTHETIC DEMO — attributed receipts on two adjacent UTC days', receipts: [
      ['day-one-first-second', MIDNIGHT - 86400, '1000000'], ['day-one-morning', MIDNIGHT - 52200, '2000000'], ['day-one-last-second', MIDNIGHT - 1, '3000000'],
      ['day-two-first-second', MIDNIGHT, '4000000'], ['day-two-morning', MIDNIGHT + 21600, '5000000']] });
}
// Long-history variant: 100 days of tracked history, so every fixed period is available, and one receipt at noon inside each
// period but none shorter: $1 on 2026-09-20, $2 on 09-10, $4 on 08-30, $8 on 08-01, $16 on 07-01 and $32 on 06-15. Each longer
// period adds exactly one receipt, so 7D, 14D, 30D, 60D, 90D and ALL read $1, $3, $7, $15, $31 and $63.
function seedLongHistory() {
  const noon = daysBack => MIDNIGHT + 86400 - daysBack * 86400 + 43200;
  seedAttributedWallet('long-history', { symbol: 'LONGH', name: 'Synthetic long-history asset', price: '1.00', trackingStart: DEMO_CUTOFF - 100 * 86400,
    dataset: 'SYNTHETIC DEMO — attributed receipts across 100 days of tracked history', receipts: [
      ['seven-day', noon(1), '1000000'], ['fourteen-day', noon(11), '2000000'], ['thirty-day', noon(22), '4000000'],
      ['sixty-day', noon(51), '8000000'], ['ninety-day', noon(82), '16000000'], ['all-days', noon(98), '32000000']] });
}

// Stacked variant: fifteen reward quote mints paid by one feed-witnessed distributor on 2026-09-19 and 2026-09-20. Fourteen
// are priced at $1 a token, so token i is worth 15 − i dollars a day and the chart colors twelve, folds two into Other and
// leaves the unpriced fifteenth out of the bar.
const STACKED_SYMBOLS = ['XBTC', 'BONK', 'DOGE', 'NEET', 'XMR', 'SPCX', 'STNK', 'USDC', 'WIF', 'JUP', 'PYTH', 'RAY', 'LATE', 'TAIL', 'NOPR'];
// Likely source launches: retained /rewards summaries name launches A, B and C for $XBTC, D for $BONK and E for $NEET; none names
// $DOGE or any other stacked token.
const STACKED_LAUNCHES = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(letter => [letter, key(`stacked-source-launch-${letter}`)]));
const STACKED_SUMMARIES = { XBTC: ['A', 'B', 'C'], BONK: ['D'], NEET: ['E'] };
function seedStacked() {
  const label = 'stacked';
  const wallet = key(`${label}-wallet`); const sender = key(`${label}-distributor`);
  const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const witness = { signature: signature(`${label}-witness`), blockTime: DEMO_CUTOFF - 1800, evidenceIds: ['synthetic-browser-fixture'] };
  if (!(wallet > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  store.atomic(() => {
    store.saveWallet({ ...store.wallet('mainnet-beta', DEMO_WALLET), wallet });
    STACKED_SYMBOLS.forEach((symbol, index) => {
      const mint = key(`${label}-quote-${symbol}`);
      const source = associatedTokenAddress(sender, mint, SPL_TOKEN_PROGRAM);
      // Summaries are saved with the quote, before any row names it: a later membership change would send its rows to a recheck.
      store.saveQuote('mainnet-beta', { mint, symbol, name: `Synthetic stacked asset ${symbol}`, decimals: 6, retrievedAt,
        membershipEvidence: [{ kind: 'distribution', launchMint: key(`${label}-launch-${symbol}`), endpoint: '/rewards?limit=100', retrievedAt },
          ...(STACKED_SUMMARIES[symbol] ?? []).map(letter => ({ kind: 'rewardSummary', launchMint: STACKED_LAUNCHES[letter], endpoint: '/rewards?limit=100', retrievedAt }))] });
      if (symbol === 'PYTH') {
        // Priced three days and an hour before the cutoff; a later lookup found no price. The report keeps $1.00, flagged stale.
        const stale = new Date((DEMO_CUTOFF - 3 * 86400 - 3600) * 1000).toISOString();
        store.savePrice('mainnet-beta', { mint, currency: 'USD', value: '1.00', provider: 'fixture', observedAt: stale, retrievedAt: stale, expiresAt: 0, reason: null });
        store.savePrice('mainnet-beta', { mint, currency: 'USD', value: null, provider: 'helius', observedAt: null, retrievedAt, expiresAt: 0, reason: 'no_valid_usd_price' });
      } else if (symbol !== 'NOPR') store.savePrice('mainnet-beta', { mint, currency: 'USD', value: '1.00', provider: 'fixture', observedAt: retrievedAt, retrievedAt, expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
      for (const [day, time] of [['one', MIDNIGHT - 43200], ['two', MIDNIGHT + 43200]]) {
        const raw = String((15 - index) * 1_000_000);
        const item = `${symbol}-${day}`;
        const row = { identity: JSON.stringify(['synthetic-browser-fixture', `${label}-${item}`]), signature: signature(`${label}-${item}`),
          network: 'mainnet-beta', wallet, blockTime: time, mint, decimals: 6, grossRaw: raw, netRaw: raw,
          status: 'attributed', reasons: ['trusted_distributor_pattern_and_proven_credit'], basis: 'distributor_pattern', version: 'stonkfun-classifier-v4',
          evidenceIds: ['synthetic-browser-fixture'], supportingSignatures: [witness.signature], sourceAccount: source.address, sourceOwner: sender,
          authority: sender, recipient: key(`${label}-wallet-account-${symbol}`), destinationOwner: wallet, feePayer: sender,
          program: SPL_TOKEN_PROGRAM, signers: [sender], authorityEvidence: null, temporalScope: 'identity_attributed',
          attributionEvidence: { basis: 'distributor_pattern', modelVersion: 'distributor-pattern-v1', classifierVersion: 'stonkfun-classifier-v4',
            identityId: `synthetic-browser-fixture-${label}`, trustSources: ['feed_witnessed_identity'], primaryTrustSource: 'feed_witnessed_identity',
            publishedSnapshots: [], secondsToNearestSnapshot: null,
            witnesses: { count: 1, digest: `synthetic-browser-fixture-${label}-digest`, first: witness, last: witness, signatures: [witness.signature],
              relation: 'before_first_witness', secondsToNearestWitness: Math.abs(witness.blockTime - time) },
            sourceOwner: sender, sourceAta: source.address, ataBump: source.bump, mint, tokenProgram: SPL_TOKEN_PROGRAM,
            signerShape: { kind: 'owner_is_fee_payer', feePayer: sender, signers: [sender] },
            batch: { outerTransfersFromSource: 1, transfersFromSource: 1, distinctRecipientOwners: 1 }, creditedMintAlsoRetainedLaunch: false } };
        store.saveClassifications('mainnet-beta', row.signature, wallet, [row]);
      }
    });
    store.saveCache(`dataset:mainnet-beta:${wallet}`, { value: 'SYNTHETIC DEMO — fifteen attributed tokens on two UTC days', expiresAt: Number.MAX_SAFE_INTEGER });
  });
  seedStackedSources(wallet);
}
// The wallet's retained transactions show it buying launches A and D, and buying B then selling all of it; it never trades C or
// E. Launch A has retained metadata; the others have none. The refresh stored at the cutoff holds A, D, and C, held since before
// tracking started and named only by its on-chain metadata, and a zero balance of E, which is never stored.
function seedStackedSources(wallet) {
  const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const seller = key('stacked-source-seller');
  const account = mint => associatedTokenAddress(wallet, mint, SPL_TOKEN_PROGRAM).address;
  const provenance = { source: 'fixture', evidenceId: 'synthetic-browser-fixture-sources', retrievedAt, commitment: 'finalized' };
  const history = [
    payout('stacked-source-buy-a', DEMO_CUTOFF - 5 * 86400 + 101, seller, [leg({ destination: account(STACKED_LAUNCHES.A), owner: wallet }, STACKED_LAUNCHES.A, '125000000')]),
    payout('stacked-source-buy-b', DEMO_CUTOFF - 6 * 86400 + 103, seller, [leg({ destination: account(STACKED_LAUNCHES.B), owner: wallet }, STACKED_LAUNCHES.B, '2000000')]),
    payout('stacked-source-sell-b', DEMO_CUTOFF - 4 * 86400 + 107, wallet, [leg({ destination: key('stacked-source-buyer-account'), owner: key('stacked-source-buyer') }, STACKED_LAUNCHES.B, '10000000000')]),
    payout('stacked-source-buy-d', DEMO_CUTOFF - 3 * 86400 + 109, seller, [leg({ destination: account(STACKED_LAUNCHES.D), owner: wallet }, STACKED_LAUNCHES.D, '42000000')]),
  ];
  store.atomic(() => {
    store.saveQuote('mainnet-beta', { mint: STACKED_LAUNCHES.A, symbol: 'LNCHA', name: 'Synthetic held launch A', decimals: 6, retrievedAt });
    for (const tx of history) { store.addTransaction('mainnet-beta', tx, provenance); store.watch('mainnet-beta', tx.transaction.signatures[0], wallet); }
  });
  while (processDirty(store, 'mainnet-beta', 100) > 0) { /* classify the wallet's retained trades */ }
  store.saveHoldings('mainnet-beta', wallet, { takenAt: retrievedAt, fingerprint: store.retainedFingerprint('mainnet-beta', wallet),
    history: [...walletHoldings(store.walletTokenBalances('mainnet-beta', wallet)).values()],
    snapshot: { takenAt: retrievedAt, tokens: [
      { mint: STACKED_LAUNCHES.A, raw: '125000000', decimals: 6, name: 'Synthetic held launch A', symbol: 'LNCHA' },
      { mint: STACKED_LAUNCHES.C, raw: '9500000', decimals: 6, name: 'Synthetic launch C held before tracking', symbol: 'LNCHC' },
      { mint: STACKED_LAUNCHES.D, raw: '42000000', decimals: 6, name: null, symbol: null },
      { mint: STACKED_LAUNCHES.E, raw: '0', decimals: 6, name: 'Synthetic zero launch E', symbol: 'LNCHE' },
    ] } });
}

// Later-day variant: a wallet first scanned under the old ten-day rule, tracked and covered only from ten days before the cutoff.
// Its retained receipt lies inside that coverage. Its fixture history also holds a receipt two days after the history floor, which
// only a refresh reads, when it plans the days before the first covered day.
const LATER_DAY_WALLET = key('later-day-wallet');
const laterDayPayout = (label, time, raw) => payout(label, time, FEED_DISTRIBUTOR, [leg({ destination: key('later-day-wallet-account'), owner: LATER_DAY_WALLET }, QUOTE_A, raw)]);
const laterDayHistory = { transactions: [laterDayPayout('later-day-early', HISTORY_FLOOR + 2 * 86400 + 43200, '6000000'),
  laterDayPayout('later-day-late', DEMO_CUTOFF - 2 * 86400 - 43200, '4000000')], official: [], prices: data.prices, calls: data.calls };
function seedLaterDay() {
  if (!(LATER_DAY_WALLET > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  const start = DEMO_CUTOFF - 864000; const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const job = { id: 'later-day-ten-day-job', network: 'mainnet-beta', wallet: LATER_DAY_WALLET, cutoff: DEMO_CUTOFF, createdAt: DEMO_CUTOFF * 1000, status: 'complete',
    limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: DEMO_CUTOFF * 1000 }, used: { stonkfun: 0, helius: 1, pages: 1, resumes: 1 },
    pageSize: 100, error: null, registryDone: true, hydrationDone: true };
  const late = laterDayHistory.transactions[1];
  store.atomic(() => {
    store.saveWallet({ network: 'mainnet-beta', wallet: LATER_DAY_WALLET, trackingStart: start, cutoff: DEMO_CUTOFF, lastSync: retrievedAt });
    store.saveJob(job); store.createRanges(job, [{ startTime: start, endTime: DEMO_CUTOFF }]); store.completeRange(job, store.ranges(job.id)[0]);
    store.addTransaction('mainnet-beta', late, { source: 'fixture', evidenceId: 'synthetic-browser-fixture-later-day', retrievedAt, commitment: 'finalized' });
    store.watch('mainnet-beta', late.transaction.signatures[0], LATER_DAY_WALLET);
    store.saveCache(`dataset:mainnet-beta:${LATER_DAY_WALLET}`, { value: 'SYNTHETIC DEMO — first scanned under the ten-day rule', expiresAt: Number.MAX_SAFE_INTEGER });
  });
  while (processDirty(store, 'mainnet-beta', 100) > 0) { /* classify the retained receipt */ }
}

// Empty variant: a wallet whose first scan loaded the last seven days and found no StonkFun payout. The overview shows its empty
// state with Load earlier instead of an empty chart.
// Scan more: a wallet whose seven days were read once, before the range check existed. Its history holds two payouts from the
// feed-witnessed distributor; the saved read missed the second, which a rescan of its week finds and saves.
const READ_ONCE_WALLET = key('read-once-wallet');
const readOncePayout = (label, time, raw) => payout(label, time, FEED_DISTRIBUTOR, [leg({ destination: key('read-once-wallet-account'), owner: READ_ONCE_WALLET }, QUOTE_A, raw)]);
const readOnceHistory = { transactions: [readOncePayout('read-once-saved', DEMO_CUTOFF - 5 * 86400 + 3600, '3000000'),
  readOncePayout('read-once-missed', DEMO_CUTOFF - 2 * 86400 + 7200, '5000000')], official: [], prices: data.prices, calls: data.calls };
function seedReadOnce() {
  if (!(READ_ONCE_WALLET > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  const start = DEMO_CUTOFF - 7 * 86400; const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const job = { id: 'read-once-first-scan', network: 'mainnet-beta', wallet: READ_ONCE_WALLET, cutoff: DEMO_CUTOFF, createdAt: DEMO_CUTOFF * 1000, status: 'complete',
    limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: DEMO_CUTOFF * 1000 }, used: { stonkfun: 0, helius: 7, pages: 7, resumes: 1 },
    pageSize: 100, error: null, registryDone: true, hydrationDone: true };
  const saved = readOnceHistory.transactions[0];
  store.atomic(() => {
    store.saveWallet({ network: 'mainnet-beta', wallet: READ_ONCE_WALLET, trackingStart: start, cutoff: DEMO_CUTOFF, lastSync: retrievedAt });
    store.saveJob(job); store.createRanges(job, [{ startTime: start, endTime: DEMO_CUTOFF }]); store.completeRange(job, store.ranges(job.id)[0]);
    store.addTransaction('mainnet-beta', saved, { source: 'fixture', evidenceId: 'synthetic-browser-fixture-read-once', retrievedAt, commitment: 'finalized' });
    store.watch('mainnet-beta', saved.transaction.signatures[0], READ_ONCE_WALLET);
    store.saveCache(`dataset:mainnet-beta:${READ_ONCE_WALLET}`, { value: 'SYNTHETIC DEMO — seven days read once, one payout missed', expiresAt: Number.MAX_SAFE_INTEGER });
  });
  while (processDirty(store, 'mainnet-beta', 100) > 0) { /* classify the retained receipt */ }
}

const EMPTY_WALLET = key('empty-history-wallet');
function seedEmpty() {
  if (!(EMPTY_WALLET > DEMO_WALLET)) throw new Error('fixture_wallet_order');
  const start = DEMO_CUTOFF - 7 * 86400; const retrievedAt = new Date(DEMO_CUTOFF * 1000).toISOString();
  const job = { id: 'empty-history-first-scan', network: 'mainnet-beta', wallet: EMPTY_WALLET, cutoff: DEMO_CUTOFF, createdAt: DEMO_CUTOFF * 1000, status: 'complete',
    limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: DEMO_CUTOFF * 1000 }, used: { stonkfun: 0, helius: 1, pages: 1, resumes: 1 },
    pageSize: 100, error: null, registryDone: true, hydrationDone: true };
  store.atomic(() => {
    store.saveWallet({ network: 'mainnet-beta', wallet: EMPTY_WALLET, trackingStart: start, cutoff: DEMO_CUTOFF, lastSync: retrievedAt });
    store.saveJob(job); store.createRanges(job, [{ startTime: start, endTime: DEMO_CUTOFF }]); store.completeRange(job, store.ranges(job.id)[0]);
    store.saveCache(`dataset:mainnet-beta:${EMPTY_WALLET}`, { value: 'SYNTHETIC DEMO — seven loaded days with no payout', expiresAt: Number.MAX_SAFE_INTEGER });
  });
}

let clock = DEMO_CUTOFF * 1000;
const now = () => { clock += 1000; return clock; };
let seeded = false;
// --unconfigured: no provider until the page posts a key, which this synthetic server keeps in memory and never writes
// anywhere, whatever Remember says. --offline: saved viewing only. Both seed the same synthetic data first.
const { values: mode } = parseArgs({ options: { port: { type: 'string' }, unconfigured: { type: 'boolean' }, offline: { type: 'boolean' }, 'idle-seconds': { type: 'string' } } });
let fixtureKey;
const providerFactory = (job, signal) => {
  const providers = createRealProviders({ store, job, apiKey: 'synthetic-browser-fixture', fetch: fixtureFetch(demoFetch(data, now)), now, signal });
  if (seeded) {
    const registry = providers.registry;
    providers.registry = async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 7000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
      });
      return registry();
    };
  }
  return providers;
};
const seeder = new DashboardService({ store: () => store, now, prepareProviders: () => providerFactory });
store.saveCache(`dataset:mainnet-beta:${DEMO_WALLET}`, { value: 'SYNTHETIC DEMO — deterministic browser fixtures', expiresAt: Number.MAX_SAFE_INTEGER });
// The demo wallet's first scan loads seven days; Load earlier batches then reach the floor, so it shows the full history.
seeder.start(DEMO_WALLET); await seeder.settle();
while (earlierRefusal(store, 'mainnet-beta', DEMO_WALLET) === null) { seeder.start(DEMO_WALLET, undefined, 'earlier'); await seeder.settle(); }
seeded = true;
seedNotEvaluated();
seedAttributedOnly();
seedTwoDay();
seedLongHistory();
seedStacked();
seedLaterDay();
seedReadOnce();
seedEmpty();
const service = mode.offline ? new DashboardService({ store: () => store, now, offline: true, prepareProviders: () => { throw new Error('offline_mode'); } })
  : mode.unconfigured ? new DashboardService({ store: () => store, now,
    prepareProviders: () => { if (fixtureKey === undefined) throw new Error('provider_not_configured'); return providerFactory; },
    acceptProviderKey: key => { fixtureKey = key; } })
    : seeder;
const app = createDashboardServer(service, join(import.meta.dirname, '../dist/dashboard'));
// On Windows the Playwright webServer shell can survive runner teardown. The isolated
// fixture exits after browser traffic ends so test runs do not leave a local server.
let lastRequestAt = Date.now();
app.server.on('request', () => { lastRequestAt = Date.now(); });
console.log(`Fixture dashboard: ${await app.listen(Number(mode.port ?? 4318))}`);
const idleMs = Number(mode['idle-seconds'] ?? 15) * 1000;
const idle = setInterval(() => { if (Date.now() - lastRequestAt > idleMs) stop(); }, 1000);
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; clearInterval(idle); void app.close().then(() => { store.close(); }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
