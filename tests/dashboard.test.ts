import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { OutgoingHttpHeaders, IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { DashboardService } from '../src/web/service.js';
import { createDashboardServer } from '../src/web/server.js';
import { KNOWN_REASONS, reportView } from '../src/web/view.js';
import type { DashboardReport } from '../src/web/view.js';
import { runScan } from '../src/scanner/engine.js';
import { buildReport } from '../src/scanner/report.js';
import { processDirty } from '../src/scanner/classifier.js';
import { createRealProviders } from '../src/providers/real.js';
import { demoData, demoFetch, DEMO_CUTOFF, DEMO_WALLET, runDemo } from '../src/cli/demo.js';
import {
  addDecimal, ATTRIBUTION_STATES, attributedChartDays, attributedCount, attributedUsd, attributionState, byUsd, chartDays, compareDecimal, copyText, customPeriod,
  dayFilterBanner, defaultPeriod, divideDecimal, duration, EMPTY_MESSAGE, filterReceipts, filterTokens, isCalendarDay, lastSyncText, PAGE_SIZE, parseRoute, periodCaption,
  periodOptions, periodParams, periodSummary, progressAge, progressPercent, progressState, REASON_TEXT, resolvePeriod, routeHash, secondsText, short, sortTokens, staleText,
  TABS, trackedDays, trustSourceRows, usd, avatarHue, utc, verifiedHidden, tokenPalette, tokenColor, TOKEN_COLORS, OTHER_COLOR, daySegments,
  DEFAULT_RECEIPT_SORT, parseReceiptSort, receiptSortParam, receiptSortText, sortReceipts, sortUsdRows, FIRST_SCAN_NOTE, isFirstScan, coverageTarget,
  tokenRanking, chartTicks, tickText, usdExact, historyStatus, batchLabel, batchTimeText, runTimeText, LOAD_EARLIER_REASON, failureNotice, rateLimited,
  RATE_LIMITED_TEXT, noPayouts, emptyHistoryText, walletInputError, hasSavedCoverage, NOT_SCANNED, primaryLabel, progressTitle, UNSCANNED_NOTE, walletStatusText,
  runningElsewhere, runningElsewhereText, spanText, firstScanRangeText, refreshRangeText, runningRangeText, readingText, daysDoneText, workingText, newPayouts,
  doneText,
} from '../web/model.js';
import { primaryText, RefreshControl, UnscannedPanel } from '../web/Refresh.js';
import { Progress } from '../web/Progress.js';
import type { DayBucket, Period, Receipt, ReceiptFilters, ReceiptSort, TokenPalette, TokenSort } from '../web/model.js';
import { EvidenceModal, PayoutsTab } from '../web/Payouts.js';
import { Coverage } from '../web/Coverage.js';
import { Trust } from '../web/Trust.js';
import { AttributedDetails, ChipDetails, chipLabel, chipValue, PeriodHero } from '../web/Hero.js';
import { StatusDetails, StatusMenu } from '../web/Status.js';
import type { Health } from '../web/model.js';
import type { ChipId } from '../web/Hero.js';
import { Overview } from '../web/Overview.js';
import { TabBar } from '../web/Tabs.js';
import { TokenDrawer, TokensTab, TokenTable } from '../web/Tokens.js';
import { CopyButton } from '../web/Sheet.js';
import { Chart, clampTop, DayTooltip, distanceTo, geometry, HEIGHT, PeriodControl, TokenRanking, TOOLTIP_GAP, tooltipPlacement, towardTooltip } from '../web/Chart.js';
import type { Geometry } from '../web/Chart.js';
import { CLASSIFIER_VERSION } from '../src/scanner/types.js';
import { HISTORY_FLOOR, planEarlier, planRanges } from '../src/scanner/ranges.js';
import type { Classification, Providers } from '../src/scanner/types.js';
import type { FullTransaction } from '../src/helius/schemas.js';
import {
  ata, configurationFeed, CUTOFF, DISTRIBUTOR, iso, MINT, officialFeed, OTHER_DISTRIBUTOR, payout, recipient, SECOND_MINT, syntheticKey, toWallet, WALLET,
} from './fixtures/distributor.js';
import { removeTempFolder } from './temp-folder.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function database() { const dir = mkdtempSync(join(tmpdir(), 'dashboard-test-')); cleanups.push(() => removeTempFolder(dir)); return join(dir, 'test.sqlite'); }
function open(path = database()) { const store = new SqliteRewardsStore(path); cleanups.push(() => { try { store.close(); } catch { /* closed by restart test */ } }); return store; }
function harness(store = open(), provider?: (signal: AbortSignal) => Providers) {
  let clock = DEMO_CUTOFF * 1000;
  const now = () => { clock += 1000; return clock; };
  const data = demoData();
  const prepare = vi.fn(() => (job: Parameters<typeof createRealProviders>[0]['job'], signal: AbortSignal) => provider ? provider(signal) : createRealProviders({ store, job, apiKey: 'synthetic-dashboard-key', fetch: demoFetch(data, now), signal, now }));
  const service = new DashboardService({ store: () => store, now, prepareProviders: prepare });
  cleanups.push(() => service.shutdown());
  return { store, service, prepare, data, advance(seconds: number) { clock += seconds * 1000; },
    /** One Load earlier batch through the engine, with the same fixture providers. */
    earlier: () => runScan(store, { wallet: DEMO_WALLET, cutoff: Math.floor(clock / 1000), jobId: `earlier-${clock}`, owner: 'earlier-owner', kind: 'earlier',
      limits: { stonkfun: 30, helius: 200, pages: 200, resumes: 5, deadline: clock + 3_600_000 } },
    job => createRealProviders({ store, job, apiKey: 'synthetic-dashboard-key', fetch: demoFetch(data, now), now }), { now }) };
}
async function http(service: DashboardService) {
  const app = createDashboardServer(service); const origin = await app.listen(0); cleanups.push(() => app.close());
  return { origin, call(path: string, options: { method?: string; body?: string; headers?: OutgoingHttpHeaders } = {}) {
    return new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request(origin, { path, method: options.method ?? 'GET', headers: options.headers ?? {} }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { text += part; });
        response.on('end', () => { resolve({ status: response.statusCode!, text, headers: response.headers }); });
      }); req.on('error', reject); if (options.body) req.write(options.body); req.end();
    });
  } };
}
const blocked = (signal: AbortSignal): Providers => ({
  registry: () => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('cancelled')); }, { once: true }); }),
  hydrate: () => Promise.resolve(null), history: () => { throw new Error('unexpected'); }, price: () => { throw new Error('unexpected'); },
});

describe('local dashboard engine adapter', () => {
  it('views saved reports offline without providers, credentials, or network', async () => {
    const path = database(); await runDemo(path); const before = readFileSync(path);
    const store = new SqliteRewardsStore(path, { readOnly: true }); cleanups.push(() => { store.close(); });
    const prepare = vi.fn(() => { throw new Error('must_not_load_credentials'); });
    const service = new DashboardService({ store: () => store, prepareProviders: prepare });
    const api = await http(service); const result = await api.call(`/api/v1/wallets/${DEMO_WALLET}/report`);
    expect(result.status).toBe(200); expect(JSON.parse(result.text)).toMatchObject({ counts: { confirmed: 4, unknown_candidate: 1 } });
    expect(service.wallets()).toEqual([DEMO_WALLET]); expect(prepare).not.toHaveBeenCalled(); // Global test setup rejects environment-file loading.
    expect(readFileSync(path)).toEqual(before);
  });
  it('POST scan uses injected real fixture adapters; the first scan plans seven days, later plans only new/overlap ranges', async () => {
    const h = harness(); const api = await http(h.service);
    const response = await api.call('/api/v1/scans', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: DEMO_WALLET }) });
    expect(response.status).toBe(202); await h.service.settle();
    const first = h.service.job(DEMO_WALLET)!; expect(first.status).toBe('complete');
    expect(first.ranges[0]!.startTime).toBe(first.cutoff - 7 * 86400); expect(first.ranges).toHaveLength(7);
    expect(first.ranges.at(-1)!.endTime).toBe(first.cutoff);
    // The receipt eight days back waits for Load earlier.
    expect(h.service.report(DEMO_WALLET).counts).toEqual({ confirmed: 2, excluded: 1, unknown_candidate: 1 });
    h.advance(3 * 86400); const second = h.service.start(DEMO_WALLET); await h.service.settle();
    expect(second.id).not.toBe(first.id); expect(second.ranges[0]!.startTime).toBe(first.cutoff - 60);
    expect(second.ranges.length).toBeLessThan(6); expect(h.data.calls.helius).toBeGreaterThan(0);
    // Global test setup rejects environment-file loading.
  });
  it('duplicates return the active job, GET/dismiss/disconnect do not cancel, explicit cancellation is prompt', async () => {
    const h = harness(open(), blocked); const api = await http(h.service);
    const job = h.service.start(DEMO_WALLET); const again = h.service.start(DEMO_WALLET);
    expect(again.id).toBe(job.id); expect(again.used.resumes).toBe(1); expect(h.prepare).toHaveBeenCalledTimes(1);
    await api.call(`/api/v1/jobs/${job.id}`); expect(h.service.job(job.id)?.runningLocally).toBe(true);
    expect((await api.call('/api/v1/dismiss', { method: 'POST' })).status).toBe(405);
    expect(h.service.job(job.id)?.runningLocally).toBe(true);
    const start = Date.now();
    await api.call(`/api/v1/jobs/${job.id}/cancel`, { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: '{}' });
    await h.service.settle(); expect(Date.now() - start).toBeLessThan(1000);
    expect(h.service.job(job.id)).toMatchObject({ status: 'paused', cancelled: true, canResume: true });
  });
  it('reports genuine activity timestamps, server elapsed time and quiet provider waits', async () => {
    const h = harness(open(), blocked); const initial = h.service.start(DEMO_WALLET);
    expect(initial.progress.phase).toBe('registry');
    expect(initial.progress.awaitingProvider).toBe(true);
    expect(initial.progress.lastActivityAt).toBeGreaterThanOrEqual(initial.progress.startedAt);
    expect(progressState(initial, initial.progress.serverNow)).toContain('registry');
    const activityAt = initial.progress.lastActivityAt;
    h.advance(161);
    const waiting = h.service.job(initial.id)!;
    expect(waiting.progress.lastActivityAt).toBe(activityAt);
    expect(duration(waiting.progress.serverNow - waiting.progress.startedAt)).toMatch(/^02:/);
    expect(progressState(waiting, waiting.progress.serverNow)).toBe('Waiting for provider response — scan still active.');
    expect(progressAge(waiting.progress.lastActivityAt, waiting.progress.serverNow, null)).toMatch(/\ds ago/);
    expect(progressPercent(waiting.progress.phaseProgress)).toBeNull();
    h.service.cancel(initial.id); await h.service.settle();
    const cancelled = h.service.job(initial.id)!;
    expect(cancelled.cancelled).toBe(true); expect(cancelled.progress.finishedAt).not.toBeNull();
    expect(progressState(cancelled, cancelled.progress.serverNow)).toContain('Cancelled');
  });
  it('records real completed phases, known range work, and report completion once', async () => {
    const h = harness(); const started = h.service.start(DEMO_WALLET); await h.service.settle();
    const complete = h.service.job(started.id)!;
    expect(complete.status).toBe('complete');
    expect(complete.progress.completedPhases).toEqual(expect.arrayContaining(['registry', 'metadata', 'history', 'normalization', 'authority', 'classification', 'pricing', 'checkpoint', 'report', 'complete']));
    expect(complete.progress.events.filter(event => event.phase === 'report' && event.action.includes('calculated'))).toHaveLength(1);
    expect(complete.progress.finishedAt).not.toBeNull();
    expect(progressPercent({ completed: 5, total: 10, unit: 'days' })).toBe(50);
    expect(progressPercent({ completed: 0, total: 0, unit: 'days' })).toBeNull();
  });
  it('resume retains cutoff and budgets; exhausted jobs cannot reset limits', async () => {
    const h = harness(open(), blocked); const initial = h.service.start(DEMO_WALLET); h.service.cancel(initial.id); await h.service.settle();
    const duplicatePaused = h.service.start(DEMO_WALLET); expect(duplicatePaused.used.resumes).toBe(1);
    const resumed = h.service.start(DEMO_WALLET, initial.id); expect(resumed.cutoff).toBe(initial.cutoff); expect(resumed.used.resumes).toBe(2);
    expect(resumed.progress.startedAt).toBe(initial.progress.startedAt);
    expect(resumed.limits).toEqual(initial.limits); h.service.cancel(initial.id); await h.service.settle();
    const job = h.store.job(initial.id, 'mainnet-beta')!; job.status = 'exhausted'; job.used.helius = job.limits.helius; h.store.saveJob(job);
    expect(h.service.job(initial.id)).toMatchObject({ canResume: false, resumeBlocked: true });
    expect(() => h.service.start(DEMO_WALLET, initial.id)).toThrow('job_not_resumable');
  });
  it('server restart preserves interrupted job/report and explicit resume state', async () => {
    const path = database(); const store = open(path); const h = harness(store, blocked); const job = h.service.start(DEMO_WALLET);
    await h.service.shutdown(); const report = h.service.report(DEMO_WALLET); store.close();
    const reopened = harness(open(path)); expect(reopened.service.report(DEMO_WALLET)).toEqual(report);
    expect(reopened.service.job(job.id)).toMatchObject({ canResume: true, cutoff: job.cutoff });
    reopened.service.start(DEMO_WALLET, job.id); await reopened.service.settle(); expect(reopened.service.job(job.id)?.status).toBe('complete');
  });
  it('recovers a saved complete job terminal time without a running timer after service restart', async () => {
    const h = harness(); const first = h.service.start(DEMO_WALLET); await h.service.settle();
    const savedSync = h.store.wallet('mainnet-beta', DEMO_WALLET)?.lastSync;
    const reopened = new DashboardService({ store: () => h.store, now: () => first.progress.startedAt + 86400000,
      prepareProviders: () => { throw new Error('must_not_load_credentials'); } });
    const view = reopened.job(first.id)!;
    expect(view.progress.finishedAt).toBe(Date.parse(savedSync!));
    expect(view.runningLocally).toBe(false);
    expect(duration(view.progress.finishedAt! - view.progress.startedAt)).toBe(duration(Date.parse(savedSync!) - view.progress.startedAt));
  });
  it('local reclassification does not load providers or alter request counts', async () => {
    const h = harness(); h.service.start(DEMO_WALLET); await h.service.settle(); const used = h.service.job(DEMO_WALLET)!.used;
    h.prepare.mockClear(); await h.service.reclassify(DEMO_WALLET);
    expect(h.service.job(DEMO_WALLET)!.used).toEqual(used); expect(h.prepare).not.toHaveBeenCalled();
  });
  it('a new check retires expired paused work under the engine lease and starts an incremental job', async () => {
    const h = harness(open(), blocked); const first = h.service.start(DEMO_WALLET); h.service.cancel(first.id); await h.service.settle();
    h.advance(3601); const next = h.service.start(DEMO_WALLET);
    expect(next.id).not.toBe(first.id); expect(h.store.job(first.id, 'mainnet-beta')?.status).toBe('exhausted');
    expect(() => h.service.cancel(first.id)).toThrow('job_not_running_locally');
    expect(h.service.job(next.id)?.runningLocally).toBe(true); h.service.cancel(next.id); await h.service.settle();
  });
  it('reports unknowns separately and preserves unpriced null, exact raw units, UTC buckets and /7 average', async () => {
    const h = harness(); h.service.start(DEMO_WALLET); await h.service.settle();
    expect((await h.earlier()).status).toBe('complete'); const report = h.service.report(DEMO_WALLET);
    expect(report.cumulative.unpricedCount).toBe(1); expect(report.assets.find(asset => asset.currentUsd === null)?.amount).toBe('0.970000');
    expect(report.assets.find(asset => asset.currentUsd !== null)?.raw).toBe('12345678906234567');
    expect(report.rolling168h.dailyAverageUsd).toBe('2204585518.077601');
    expect(report.utcDays.map(day => day.day)).toEqual(['2026-09-13', '2026-09-21']);
    expect(chartDays(report, defaultPeriod(report)).map(day => day.day)).toEqual(['2026-09-21']);
    expect(chartDays(report, resolvePeriod(report, { period: 'all' }).period)).toHaveLength(2); expect(report.counts.unknown_candidate).toBe(1);
    expect(usd(null)).toBe('Unavailable'); expect(EMPTY_MESSAGE).toBe('No confirmed priced rewards yet.');
    expect(avatarHue(DEMO_WALLET)).toBe(avatarHue(DEMO_WALLET));
  });
  it('safe DTO drops raw provider errors, authenticated URLs and arbitrary reason strings', async () => {
    const h = harness(); h.service.start(DEMO_WALLET); await h.service.settle(); const report = buildReport(h.store, DEMO_WALLET);
    const secret = 'https://provider.invalid/?api-key=secret-key';
    report.job!.error = secret; report.dataLabel = secret; report.coverage.registry!.detail = secret;
    report.cumulative.assets[0]!.name = secret; report.cumulative.assets[0]!.price!.reason = secret;
    report.unknownReasonCounts['secret_key'] = 22;
    const json = JSON.stringify(reportView(report)); expect(json).not.toContain('secret'); expect(json).not.toContain('provider.invalid');
    expect(json).not.toContain('membershipEvidence'); expect(json).not.toContain('details');
  });
});

describe('local API boundary', () => {
  it.each([
    ['POST', '/api/v1/health', undefined, '{}', 405],
    ['GET', '/api/v1/scans', undefined, undefined, 405],
    ['POST', '/api/v1/scans', { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, '{}', 403],
    ['POST', '/api/v1/scans', { 'Content-Type': 'application/json' }, '{}', 403],
    ['GET', '/api/v1/health', { Host: 'evil.invalid' }, undefined, 403],
    ['GET', '/api/v1/health', { 'Sec-Fetch-Site': 'cross-site' }, undefined, 403],
    ['GET', '/api/v1/health?url=https://evil.invalid', undefined, undefined, 400],
    ['GET', '/api/v1/wallets/not-a-wallet/report', undefined, undefined, 400],
    ['GET', '/%2e%2e/.env', undefined, undefined, 400],
    ['GET', '/.env', undefined, undefined, 404],
  ])('validates %s %s', async (method, path, headers, body, expected) => {
    const api = await http(harness().service); const response = await api.call(path, { method, ...(headers ? { headers } : {}), ...(body ? { body } : {}) });
    expect(response.status).toBe(expected); expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
  it.each([
    ['text/plain', '{}', 415], ['application/json', 'a'.repeat(2050), 413], ['application/json', 'not json', 400],
    ['application/json', '{"wallet":"bad"}', 400], ['application/json', JSON.stringify({ wallet: DEMO_WALLET, apiKey: 'do-not-echo' }), 400],
  ])('rejects invalid bodies without echoing input', async (type, body, expected) => {
    const h = harness(); const api = await http(h.service);
    const response = await api.call('/api/v1/scans', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': type }, body });
    expect(response.status).toBe(expected); expect(response.text).not.toContain('do-not-echo'); expect(h.prepare).not.toHaveBeenCalled();
  });
  it('offline mode rejects scans before credential loading', () => {
    const prepare = vi.fn(() => { throw new Error('credentials'); }); const store = open();
    const service = new DashboardService({ store: () => store, prepareProviders: prepare, offline: true });
    expect(() => service.start(DEMO_WALLET)).toThrow('offline_mode'); expect(prepare).not.toHaveBeenCalled();
    expect(service.health()).toMatchObject({ providerConfigured: false, configurationChecked: false, offline: true });
  });
  it('keeps credential-factory errors out of the HTTP response', async () => {
    const store = open(); const service = new DashboardService({ store: () => store, prepareProviders() { throw new Error('https://provider.invalid/?api-key=fixture-secret'); } });
    const api = await http(service);
    const response = await api.call('/api/v1/scans', { method: 'POST', headers: { Origin: api.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: DEMO_WALLET }) });
    expect(response.status).toBe(409); expect(response.text).toBe('{"error":"provider_not_configured"}');
    expect(service.job(DEMO_WALLET)).toBeNull();
  });
});

const network = 'mainnet-beta';
const THIRD_MINT = syntheticKey('dashboard-third-mint');
const DUAL_MINT = syntheticKey('dashboard-dual-role-mint');
const legs = (start: number) => [0, 1, 2].map(i => ({ ...recipient(start + i), amount: String(30_000 + start + i) }));
const attributedTransactions = {
  witness: payout({ label: 'dashboard-witness', time: CUTOFF - 1000, legs: legs(100) }),
  verified: payout({ label: 'dashboard-verified', time: CUTOFF - 3600, legs: [toWallet('3000000')] }),
  verifiedUnpriced: payout({ label: 'dashboard-verified-unpriced', time: CUTOFF - 4000,
    legs: [toWallet('6000000', { mint: THIRD_MINT, destination: syntheticKey('dashboard-wallet-third') })] }),
  feed: payout({ label: 'dashboard-feed', time: CUTOFF - 2 * 86400, legs: [toWallet('2000000'), ...legs(1)] }),
  dual: payout({ label: 'dashboard-dual', time: CUTOFF - 86400 - 500,
    legs: [toWallet('1000000', { mint: DUAL_MINT, destination: syntheticKey('dashboard-wallet-dual') })] }),
  published: payout({ label: 'dashboard-published', time: CUTOFF - 3 * 86400,
    legs: [toWallet('7000000', { owner: OTHER_DISTRIBUTOR, mint: SECOND_MINT, destination: syntheticKey('dashboard-wallet-second') })] }),
  unknown: payout({ label: 'dashboard-unknown', time: CUTOFF - 5000, legs: [toWallet('11', { owner: syntheticKey('dashboard-untrusted-sender') })] }),
  // Optional: one payout crediting three mints on the feed payout's UTC day, and one the wallet signs (excluded).
  busy: payout({ label: 'dashboard-busy', time: CUTOFF - 2 * 86400 + 600, legs: [toWallet('1500000'),
    toWallet('500000', { mint: DUAL_MINT, destination: syntheticKey('dashboard-wallet-dual') }),
    toWallet('4000000', { mint: THIRD_MINT, destination: syntheticKey('dashboard-wallet-third') })] }),
  signed: payout({ label: 'dashboard-wallet-signs', time: CUTOFF - 6000, legs: [toWallet('9')], extraSigners: [WALLET] }),
};
const signatureOf = (tx: FullTransaction) => tx.transaction.signatures[0]!;
function drain(store: SqliteRewardsStore) { while (processDirty(store, network, 100) > 0) { /* drain */ } }
/** Verified, feed-witnessed, published-authority, dual-role, unpriced and unknown receipts. MINT is in both reward groups. */
function attributedStore(path = database(), options: { verified?: boolean; busy?: boolean } = {}) {
  const store = open(path); const txs = attributedTransactions;
  const verified = options.verified ?? true;
  const busy = options.busy ? [txs.busy, txs.signed] : [];
  const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-dashboard', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
  store.atomic(() => {
    store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    for (const [mint, symbol, launchMint] of [[MINT, 'QUOTE', syntheticKey('launch')], [SECOND_MINT, 'SECOND', syntheticKey('launch')],
      [THIRD_MINT, 'THIRD', syntheticKey('launch')], [DUAL_MINT, 'DUAL', DUAL_MINT]] as const) {
      store.saveQuote(network, { mint, symbol, retrievedAt: iso(CUTOFF),
        membershipEvidence: [{ kind: 'distribution', launchMint, endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) }] });
    }
    for (const [mint, value] of [[MINT, '2.00'], [DUAL_MINT, '1.50']] as const) {
      store.savePrice(network, { mint, currency: 'USD', value, provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF),
        expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    }
    for (const tx of verified ? [txs.witness, txs.verified, txs.verifiedUnpriced] : [txs.witness]) { store.addTransaction(network, tx, provenance); store.addFeed(officialFeed(tx)); }
    for (const tx of [...verified ? [txs.verified, txs.verifiedUnpriced] : [], txs.feed, txs.dual, txs.published, txs.unknown, ...busy]) {
      store.addTransaction(network, tx, provenance); store.watch(network, signatureOf(tx), WALLET);
    }
  });
  store.saveWithdrawalSnapshots(configurationFeed(OTHER_DISTRIBUTOR, CUTOFF - 100));
  drain(store);
  return store;
}
const decode = (text: string) => text.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
/** Visible text of server-rendered markup, with the entities React escapes decoded. */
function textOf(html: string) {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
/** Accessible names of the attributed chart's day controls. */
const labels = (html: string) => [...html.matchAll(/<g class="chart-day[^"]*"[^>]*aria-label="([^"]*)"/g)].map(match => decode(match[1]!));
const visible = (element: ReactElement) => textOf(renderToStaticMarkup(element));
/** The period figures for the period the hash parameters name, and the strip above the tabs. */
const hero = (report: DashboardReport, params: Record<string, string> = {}) => visible(createElement(PeriodHero, { report, period: resolvePeriod(report, params).period }));
/** The header status panel for a report. */
const statusHtml = (report: DashboardReport | null, health: Health | null = null, job: Parameters<typeof StatusDetails>[0]['job'] = null) =>
  renderToStaticMarkup(createElement(StatusDetails, { report, health, job, now: DEMO_CUTOFF * 1000, wallet: report?.wallet ?? WALLET,
    openProgress: () => undefined, openWallet: () => undefined }));
/** What the strip above the tabs used to show, read from the status panel: the last sync and each group's summary line. */
const strip = (report: DashboardReport) => {
  const html = statusHtml(report);
  return [`Last sync ${/<dt>Last sync<\/dt><dd>([^<]*)<\/dd>/.exec(html)![1]}`, ...[...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(match => textOf(match[1]!))].join(' ');
};
const chip = (report: DashboardReport, id: ChipId) => visible(createElement(ChipDetails, { report, chip: id }));
/** The chart SVGs alone, without the info icon's. */
const chartSvgs = (html: string) => html.match(/<svg class="(?:attributed-chart|reward-chart)"[\s\S]*?<\/svg>/g) ?? [];
/** The same wallet viewed read-only before classifier v3 evaluated it: v5 rows before reclassification, or a v4 schema. */
function unevaluatedView(variant: 'v5 rows before reclassification' | 'schema v4') {
  const path = database(); attributedStore(path).close();
  const db = new DatabaseSync(path);
  db.exec(`UPDATE classifications SET status=CASE WHEN status='attributed' THEN 'unknown_candidate' ELSE status END,
    body=json_set(body,'$.version','stonkfun-classifier-v2','$.status',CASE WHEN status='attributed' THEN 'unknown_candidate' ELSE status END,
      '$.attributionEvidence',json('null'));
    DELETE FROM classification_versions WHERE version='stonkfun-classifier-v3';`);
  if (variant === 'schema v4') db.exec('DROP TABLE withdrawal_authority_snapshots; DROP TABLE identity_conflicts; PRAGMA user_version=4;');
  db.close();
  const store = new SqliteRewardsStore(path, { readOnly: true }); cleanups.push(() => { store.close(); });
  return reportView(buildReport(store, WALLET));
}

describe('attributed tier dashboard: model, hero strip and chips', () => {
  it('projects the report groups separately and shows the hero strip and chips without a combined figure', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    expect(view.verifiedTotals).toEqual({ label: 'Verified', explanation: expect.stringContaining('exact official StonkFun distribution record') as unknown,
      rows: 2, signatures: 2 });
    expect(view.attribution).toMatchObject({ evaluated: true, recheckPending: 0, label: 'Attributed', rows: 3, signatures: 3,
      basisCounts: { feed_witnessed_identity: 2, published_withdraw_authority: 1, withBothTrustSources: 0 },
      cumulative: { currentUsd: '5.500000', unpricedCount: 1, pricedCount: 2 } });
    expect(view.cumulative).toMatchObject({ currentUsd: '6.000000', unpricedCount: 1 });
    expect(view.unknownTotals).toMatchObject({ label: 'Unknown · not counted', rows: 1, signatures: 1 });
    expect(view.unpriced.verified.map(asset => asset.mint)).toEqual([THIRD_MINT]);
    expect(view.unpriced.attributed?.map(asset => asset.mint)).toEqual([SECOND_MINT]);
    expect(attributionState(view)).toBe('evaluated');
    expect([attributedCount(view, view.attribution.rows), attributedUsd(view, view.attribution.cumulative?.currentUsd)]).toEqual(['3', '$5.50']);
    expect(trustSourceRows(view)).toEqual([{ source: 'feed_witnessed_identity', rows: 2 }, { source: 'published_withdraw_authority', rows: 1 }]);
    // The attributed figure for the selected period is the single large figure under the report's own label, with the period's
    // exact UTC range and its small figures; the strip above the tabs holds the last sync and one chip per other group.
    // Excluded rows have no report group, so their chip carries the status name.
    expect(hero(view)).toBe('Attributed $5.50 2026-09-16 → 2026-09-22 · 7 days Priced receipts only · UTC calendar days '
      + 'Payouts 3 Tokens 3 Daily average $0.79 Unpriced · excluded from USD 1 receipt');
    expect(strip(view)).toBe('Last sync Not completed Verified 2 rows Unknown · not counted 1 row Excluded 0 rows Unpriced · excluded from USD verified 1 · attributed 1');
    const html = renderToStaticMarkup(createElement(PeriodHero, { report: view, period: defaultPeriod(view) }));
    expect(html.match(/<strong class="hero-figure">/g)).toHaveLength(1);
    expect(html).toContain(`aria-label="About ${view.attribution.label}"`);
    // The group rows start closed: each opens onto its explanation on demand.
    const chips = statusHtml(view);
    expect(chips.match(/<details class="status-count">/g)).toHaveLength(4);
    expect(html + chips).not.toContain('role="dialog"');
    // MINT is verified (3.000000, $6.00) and attributed (2.000000, $4.00); the two groups are never added.
    const details = (['verified', 'unknown', 'excluded', 'unpriced'] as const).map(id => chip(view, id));
    for (const text of [hero(view), hero(view, { period: 'all' }), strip(view), ...details, JSON.stringify(view)]) {
      for (const combined of ['5.000000', '10.000000', '11.500000', '$11.50', '$10.00', '5 rows', '4 rows']) expect(text).not.toContain(combined);
    }
  });

  it('opens each chip onto the report\'s fixed explanation and exact counts', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    expect(chip(view, 'verified')).toBe(`${view.verifiedTotals.explanation} Rows 2 Signatures 2 Current value $6.00 Last 7 days $6.00 `
      + 'Daily average $0.86 Unpriced assets 1 Exact feed 2 · same-slot 0 · verified historical authority 0');
    expect(chip(view, 'unknown')).toBe(`${view.unknownTotals.explanation} Rows 1 Signatures 1 Proven credits 1 in 1 mint · token units only `
      + 'Unknown reasons and sample in Coverage →');
    expect(chip(view, 'excluded')).toBe(`Rows 1 Signatures 1 wallet participation 1 ${REASON_TEXT.wallet_participation}`);
    const attributedUnpriced = view.unpriced.attributed!.map(asset => `${asset.symbol} ${asset.amount}`).join(' · ');
    expect(attributedUnpriced.split(' · ').sort()).toEqual(['SECOND 7.000000', 'THIRD 4.000000']);
    expect(chip(view, 'unpriced')).toBe(`${view.unpriced.explanation} Verified assets 1 Attributed assets 2 `
      + `Verified: THIRD 6.000000 Attributed: ${attributedUnpriced}`);
    // The attributed info popover carries the fixed explanation, both trust sources and the valuation caveat.
    const html = renderToStaticMarkup(createElement(PeriodHero, { report: view, period: defaultPeriod(view) }));
    expect(html).toContain('Payouts</dt><dd>6</dd>');
    expect(view.attribution.trustSources.published_withdraw_authority.explanation).toContain('in a snapshot taken after the payouts it covers');
  });

  it('holds in the header status panel everything the strip and banners above the tabs showed, plus the job and its budgets', async () => {
    const h = harness(); h.service.start(DEMO_WALLET); await h.service.settle();
    const report = h.service.report(DEMO_WALLET); const job = h.service.job(DEMO_WALLET)!;
    expect(job.status).toBe('complete');
    const text = textOf(statusHtml(report, { providerConfigured: true, configurationChecked: true, offline: false, activeWallets: [] }, job));
    // The old status line: local read-only mode, the provider indicator and the fixed cutoff; the strip's last sync.
    for (const line of ['Mode Local · read only', 'Provider Configured', `Last sync ${lastSyncText(report)}`, `Fixed cutoff ${utc(report.cutoff)}`]) expect(text).toContain(line);
    // The four chips, each with its value and, behind it, the report's explanation and exact counts.
    for (const id of ['verified', 'unknown', 'excluded', 'unpriced'] as const) {
      expect(text).toContain(`${chipLabel(report, id)} ${chipValue(report, id)}`);
      expect(text).toContain(chip(report, id));
    }
    expect(text).toContain('Unpriced · excluded from USD verified');
    // The job chip's state, when the finished job finished, the way to the progress dialog, and what the job spent.
    expect(text).toContain('COMPLETE');
    expect(job.progress.finishedAt).not.toBeNull();
    expect(text).toContain(`Complete · finished ${utc(job.progress.finishedAt! / 1000)}`);
    expect(text).not.toContain('last activity');
    // A job still running says how long ago it last reported instead.
    const running = { ...job, status: 'running' as const, runningLocally: true, progress: { ...job.progress, finishedAt: null, lastActivityAt: DEMO_CUTOFF * 1000 - 5000 } };
    expect(textOf(statusHtml(report, null, running))).toContain('· last activity 5s ago');
    expect(text).toContain('View scan progress →');
    expect(text).toContain(`StonkFun requests ${job.used.stonkfun} of ${job.limits.stonkfun} Helius requests ${job.used.helius} of ${job.limits.helius} `
      + `History pages ${job.used.pages} of ${job.limits.pages}`);
    // The banners: offline viewing, an unchecked provider, another wallet's running scan, and a synthetic dataset.
    const other = syntheticKey('another-scanning-wallet');
    const offline = textOf(statusHtml(report, { providerConfigured: false, configurationChecked: false, offline: true, activeWallets: [DEMO_WALLET, other] }, job));
    for (const line of ['Mode Offline viewing · saved data only · scans disabled', 'Provider Not configured · checked only when scanning',
      `Scan running · ${short(other)} · view progress →`]) expect(offline).toContain(line);
    expect(offline).not.toContain(`Scan running · ${short(DEMO_WALLET)}`);
    expect(textOf(statusHtml({ ...report, synthetic: true }))).toContain('Data Synthetic fixture · deterministic test data · no real rewards');
    // Without a job the panel says so instead of showing budgets.
    expect(textOf(statusHtml(report))).toContain('No scan saved for this wallet.');
  });

  it('gives every reason code the projection accepts a plain one-line explanation', () => {
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...KNOWN_REASONS].sort());
    for (const text of Object.values(REASON_TEXT)) expect(text).toMatch(/^[A-Z].{10,110}\.$/);
  });

  it.each(['v5 rows before reclassification', 'schema v4'] as const)('shows Not evaluated, never 0, for every attributed figure: %s', variant => {
    const view = unevaluatedView(variant);
    expect(view.attribution).toMatchObject({ evaluated: false, recheckPending: 0, rows: null, signatures: null, basisCounts: null,
      cumulative: null, rolling168h: null, latest24h: null, utcDays: null, assets: null });
    expect(view.unpriced.attributed).toBeNull(); expect(view.pricingCoverage.attributed).toBeNull();
    expect(view.verifiedTotals.rows).toBe(2); expect(view.cumulative.currentUsd).toBe('6.000000');
    expect(attributionState(view)).toBe('not_evaluated'); expect(trustSourceRows(view)).toEqual([]);
    expect([attributedCount(view, view.attribution.rows), attributedCount(view, 0), attributedUsd(view, '0'), attributedUsd(view, null)])
      .toEqual(Array<string>(4).fill(ATTRIBUTION_STATES.not_evaluated));
    // The state takes the period figure's place: the large figure is the state, its detail replaces the period and small figures.
    const figures = hero(view);
    expect(figures).toBe('Attributed Not evaluated Saved rows predate classifier v3 or await an attribution recheck. '
      + 'Reclassify locally to evaluate the attributed tier.');
    expect(hero(view, { period: 'all' })).toBe(figures);
    expect(periodSummary(view, defaultPeriod(view))).toBeNull();
    expect(strip(view)).toBe('Last sync Not completed Verified 2 rows Unknown · not counted 4 rows Excluded 0 rows Unpriced · excluded from USD verified 1 · attributed Not evaluated');
    expect(chip(view, 'unpriced')).toContain('Attributed assets Not evaluated');
    expect(chip(view, 'unpriced')).not.toContain('Attributed:');
    for (const text of [figures, strip(view), chip(view, 'unpriced')]) {
      expect(text).not.toMatch(/\$0\.00|Unavailable|not verified 0\b|attributed 0\b|Payouts|Tokens|Daily average|→/);
    }
  });

  it('shows Rechecking while new trust evidence holds attributed rows for reclassification, then restores them', () => {
    const store = attributedStore();
    store.saveWithdrawalSnapshots(configurationFeed(OTHER_DISTRIBUTOR, CUTOFF - 50, 'later'));
    const pending = reportView(buildReport(store, WALLET));
    expect(pending.attribution).toMatchObject({ evaluated: false, recheckPending: 3, rows: null, cumulative: null, basisCounts: null });
    expect(attributionState(pending)).toBe('rechecking');
    expect(attributedUsd(pending, pending.attribution.cumulative?.currentUsd)).toBe(ATTRIBUTION_STATES.rechecking);
    expect(hero(pending)).toBe('Attributed Rechecking 3 rows await an attribution recheck after new trust evidence. '
      + 'A running scan or local reclassification completes it.');
    expect(strip(pending)).toContain('Verified 2 rows Unknown · not counted 4 rows Excluded 0 rows Unpriced · excluded from USD verified 1 · attributed Rechecking');
    for (const text of [hero(pending), strip(pending)]) expect(text).not.toMatch(/\$0\.00|Payouts|Tokens/);
    drain(store);
    expect(reportView(buildReport(store, WALLET)).attribution).toMatchObject({ evaluated: true, recheckPending: 0, rows: 3, cumulative: { currentUsd: '5.500000' } });
  });
});

const link = (tx: FullTransaction) => `https://solscan.io/tx/${signatureOf(tx)}`;
/** Each body row's visible text, less the chevron glyph that opens the row's launches. */
const tableRows = (html: string) => html.split('<tbody>')[1]!.split('</tbody>')[0]!.split('</tr>').filter(Boolean).map(row => textOf(row).replace(/^[▸▾] /, ''));
// MINT is verified (3.000000, $6.00) and attributed (2.000000, $4.00); verified $6.00 and attributed $5.50 in total.
const COMBINED = ['5.000000', '$10.00', '$11.50', '10.000000', '11.500000'];

describe('attributed tier dashboard: token tables, chart and evidence', () => {
  it('projects every attributed row with per-mint trust sources, evidence links and batch provenance', () => {
    const view = reportView(buildReport(attributedStore(), WALLET)); const txs = attributedTransactions;
    expect(view.attribution.assets?.map(asset => ({ mint: asset.mint, amount: asset.amount, usd: asset.currentUsd, trust: asset.trustSources, link: asset.evidenceLink }))).toEqual([
      { mint: MINT, amount: '2.000000', usd: '4.000000', trust: ['feed_witnessed_identity'], link: link(txs.feed) },
      { mint: SECOND_MINT, amount: '7.000000', usd: null, trust: ['published_withdraw_authority'], link: link(txs.published) },
      { mint: DUAL_MINT, amount: '1.000000', usd: '1.500000', trust: ['feed_witnessed_identity'], link: link(txs.dual) },
    ].sort((a, b) => a.mint.localeCompare(b.mint)));
    expect(view.attributedEvidence.map(row => [row.symbol, row.amount, row.time, row.evidenceLink])).toEqual([
      ['DUAL', '1.000000', CUTOFF - 86_900, link(txs.dual)], ['QUOTE', '2.000000', CUTOFF - 172_800, link(txs.feed)],
      ['SECOND', '7.000000', CUTOFF - 259_200, link(txs.published)]]);
    const [dual, feed, published] = view.attributedEvidence;
    expect(feed!.attribution).toEqual({ modelVersion: 'distributor-pattern-v1', lane: 'token', primaryTrustSource: 'feed_witnessed_identity', trustSources: ['feed_witnessed_identity'],
      sourceOwner: DISTRIBUTOR, sourceAta: ata(DISTRIBUTOR, MINT), witnessCount: 3, firstWitnessTime: CUTOFF - 4000, lastWitnessTime: CUTOFF - 1000,
      witnessRelation: 'before_first_witness', secondsToNearestWitness: 168_800, snapshotRetrievedAt: null, secondsToNearestSnapshot: null,
      creditedMintAlsoRetainedLaunch: false, firstWitnessLink: link(txs.verifiedUnpriced), lastWitnessLink: link(txs.witness),
      batch: { outerTransfersFromSource: 4, transfersFromSource: 4, distinctRecipientOwners: 4 } });
    expect(dual!.attribution).toMatchObject({ sourceAta: ata(DISTRIBUTOR, DUAL_MINT), secondsToNearestWitness: 82_900, creditedMintAlsoRetainedLaunch: true,
      batch: { outerTransfersFromSource: 1, transfersFromSource: 1, distinctRecipientOwners: 1 } });
    expect(published!.attribution).toMatchObject({ trustSources: ['published_withdraw_authority'], primaryTrustSource: 'published_withdraw_authority',
      sourceOwner: OTHER_DISTRIBUTOR, sourceAta: ata(OTHER_DISTRIBUTOR, SECOND_MINT), witnessCount: 0, firstWitnessLink: null, lastWitnessLink: null,
      witnessRelation: null, snapshotRetrievedAt: iso(CUTOFF - 100), secondsToNearestSnapshot: 259_100 });
    expect([secondsText(30), secondsText(232), secondsText(88_082), secondsText(259_100)]).toEqual(['30 s', '232 s (4 min)', '88,082 s (24.5 h)', '259,100 s (3.0 d)']);
  });

  it('covers attributed rows past the first 500 detail records while the unknown and confirmed samples keep that bound', () => {
    const store = attributedStore();
    // Unknown rows whose identities sort before every real row, so the attributed rows fall outside the first 500 records.
    const filler = (index: number): Classification => ({ identity: `["solana-token-credit",0,"filler-${String(index).padStart(3, '0')}"]`,
      signature: `filler-${index}`, network, wallet: WALLET, blockTime: CUTOFF - 7000, mint: null, decimals: null, grossRaw: null, netRaw: null,
      status: 'unknown_candidate', reasons: ['no_supported_credit'], basis: null, version: CLASSIFIER_VERSION, evidenceIds: [], supportingSignatures: [],
      sourceAccount: null, sourceOwner: null, authority: null, recipient: null, program: null, signers: [], destinationOwner: null, feePayer: null,
      authorityEvidence: null, attributionEvidence: null, temporalScope: 'unestablished' });
    store.atomic(() => { for (let index = 0; index < 600; index++) store.saveClassifications(network, `filler-${index}`, WALLET, [filler(index)]); });
    const bounded = reportView(buildReport(store, WALLET));
    expect(bounded.attributedEvidence).toEqual([]);
    expect(bounded.attribution.assets?.map(asset => asset.trustSources)).toEqual([null, null, null]);
    // The dashboard projections say they are incomplete instead of presenting a partial list as whole.
    expect(bounded.attribution).toMatchObject({ receipts: [], receiptsComplete: false, identities: null, conflicts: { rows: 0, revokedRows: 0, owners: null } });
    expect(bounded.attribution.tokenDetails?.map(item => [item.receipts, item.receiptIds])).toEqual([[1, []], [1, []], [1, []]]);
    expect(bounded.excludedReasons).toBeNull();
    expect(bounded.attribution.dayTokens?.map(day => day.day)).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
    const service = new DashboardService({ store: () => store, prepareProviders: () => { throw new Error('must_not_load_credentials'); } });
    const view = service.report(WALLET);
    expect(view.attribution).toMatchObject({ evaluated: true, rows: 3, receiptsComplete: true });
    expect(view.attribution.receipts?.map(row => row.symbol)).toEqual(['DUAL', 'QUOTE', 'SECOND']);
    expect(view.attributedEvidence.map(row => row.symbol)).toEqual(['DUAL', 'QUOTE', 'SECOND']);
    expect(view.attribution.assets?.every(asset => asset.trustSources?.length === 1)).toBe(true);
    expect(view.counts).toMatchObject({ confirmed: 2, unknown_candidate: 601 });
    expect(view.unknownCandidates).toHaveLength(20);
    expect(view.unknownCandidates.every(row => row.reasons.join() === 'no_supported_credit')).toBe(true);
    expect(view.confirmedEvidence).toEqual([]);
  });

  it('renders verified and attributed tokens in separate tables with a trust column and no combined total row', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    const verified = renderToStaticMarkup(createElement(TokenTable, { report: view }));
    const tab = renderToStaticMarkup(createElement(TokensTab, { report: view, open: () => undefined, close: () => undefined }));
    const attributed = tab.split('<table class="token-table">')[1]!.split('</table>')[0]!;
    const verifiedRows = tableRows(verified); const attributedRows = tableRows(attributed);
    expect(verifiedRows).toHaveLength(2); expect(attributedRows).toHaveLength(3);
    expect(verifiedRows.find(row => row.startsWith('$QUOTE'))).toMatch(/ 3\.000000 \$6\.00 3\.000000 \$6\.00 1 .* PRICED Evidence ↗$/);
    expect(verifiedRows.join(' ')).not.toMatch(/\$SECOND|\$DUAL|2\.000000|7\.000000|Feed-witnessed|Published withdraw/);
    // Highest USD first by default, unpriced last.
    expect(attributedRows).toEqual([`$QUOTE ${MINT} 2.000000 $4.00 1 2026-09-20 18:00 Feed-witnessed distributor PRICED`,
      `$DUAL ${DUAL_MINT} 1.000000 $1.50 1 2026-09-21 17:51 Feed-witnessed distributor PRICED`,
      `$SECOND ${SECOND_MINT} 7.000000 Unpriced 1 2026-09-19 18:00 Published withdraw authority UNPRICED`]);
    expect(textOf(tab.split('<thead>')[1]!.split('</thead>')[0]!)).toBe('Token ↕ Quantity ↕ USD ▼ Receipts ↕ Last receipt · UTC ↕ Trust Price');
    expect(verified).not.toContain('Trust');
    // The verified table follows the attributed one, and nothing adds the two groups, per mint or overall.
    expect(tab.indexOf('token-table')).toBeLessThan(tab.indexOf('id="token-title"'));
    for (const html of [verified, tab]) {
      expect(html).not.toMatch(/<tfoot|>\s*Total\b/);
      for (const combined of COMBINED) expect(html).not.toContain(combined);
    }
    const text = textOf(tab);
    expect(text).toContain(`Attributed Attributed tokens 3 Search tokens ${view.attribution.explanation}`);
    expect(text).toContain(`Published withdraw authority ${view.attribution.trustSources.published_withdraw_authority.explanation}`);
    expect(text).toContain('3 of 3 tokens · Exact token quantities');
  });

  it('prints every evidence address in full with its own copy button and never abbreviated', () => {
    const view = reportView(buildReport(attributedStore(), WALLET)); const txs = attributedTransactions;
    const modal = (receipt: Receipt) => renderToStaticMarkup(createElement(EvidenceModal, { report: view, receipt, onClose: () => undefined }));
    const [dual, feed, published] = view.attribution.receipts!.map(modal);
    const addresses = [[dual!, signatureOf(txs.dual), DUAL_MINT, DISTRIBUTOR, ata(DISTRIBUTOR, DUAL_MINT)],
      [feed!, signatureOf(txs.feed), MINT, DISTRIBUTOR, ata(DISTRIBUTOR, MINT)],
      [published!, signatureOf(txs.published), SECOND_MINT, OTHER_DISTRIBUTOR, ata(OTHER_DISTRIBUTOR, SECOND_MINT)]] as const;
    for (const [html, signature, mint, owner, source] of addresses) {
      for (const address of [signature, mint, owner, source]) { expect(html).toContain(`<code class="address">${address}</code>`); expect(html).not.toContain(short(address)); }
      expect(html).not.toContain('…');
      expect([...html.matchAll(/aria-label="(Copy [^"]+)"/g)].map(match => match[1])).toEqual(['Copy signature', 'Copy mint address', 'Copy source owner', 'Copy source ATA']);
      for (const target of [`tx/${signature}`, `token/${mint}`, `account/${owner}`, `account/${source}`]) {
        expect(html).toContain(`href="https://solscan.io/${target}" target="_blank" rel="noreferrer">Solscan ↗</a>`);
      }
      expect(html).toContain('<dialog class="sheet modal" aria-labelledby="evidence-title">');
    }
    const [dualText, feedText, publishedText] = [dual!, feed!, published!].map(textOf);
    expect(dualText).toMatch(/^Attributed · receipt evidence \$DUAL 1\.000000 2026-09-21 17:51 UTC Feed-witnessed distributor DUAL-ROLE MINT × /);
    expect(dualText).toContain('Amount 1.000000 Current USD $1.50 Lane Token transfer Model distributor-pattern-v1');
    expect(dualText).toContain('Nearest witness 82,900 s (23.0 h) before the first witness');
    expect(dualText).toContain('Dual-role mint Yes · credited mint is also a retained launch mint');
    expect(feedText).toContain(`Trust sources Feed-witnessed distributor ${view.attribution.trustSources.feed_witnessed_identity.explanation} Primary trust source`);
    expect(feedText).toContain(`Feed witnesses 3 official distributions first ${utc(CUTOFF - 4000)} ↗ last ${utc(CUTOFF - 1000)} ↗`);
    expect(feed).toContain(`href="${link(txs.verifiedUnpriced)}"`); expect(feed).toContain(`href="${link(txs.witness)}"`);
    expect(feedText).toContain('Nearest witness 168,800 s (46.9 h) before the first witness Nearest snapshot —');
    expect(feedText).toContain('Batch 4 outer transfers from source · 4 transfers from source · 4 recipient owners Dual-role mint No');
    expect(publishedText).toContain('Amount 7.000000 Current USD Unpriced');
    expect(publishedText).toContain(`Trust sources Published withdraw authority ${view.attribution.trustSources.published_withdraw_authority.explanation} Primary trust source`);
    expect(publishedText).toContain('Feed witnesses None Nearest witness —');
    expect(publishedText).toContain(`Nearest snapshot Published authority snapshot ${utc(CUTOFF - 100)} taken after this payout · 259,100 s (3.0 d) away`);
    expect(publishedText).toContain('Batch 1 outer transfer from source · 1 transfer from source · 1 recipient owner');
    expect(publishedText).toMatch(/Compare every character\. The USD figure is this amount at the saved current price, not a payout-time value, and it is never added to verified totals\.$/);
  });

  it('draws the attributed daily series as its own chart, never stacked on or summed with the verified chart', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    // Every SVG title is one string, so server rendering raises no warning at all.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = renderToStaticMarkup(createElement(Chart, { report: view }));
    expect(errors).not.toHaveBeenCalled();
    const [attributed, verified, ...rest] = chartSvgs(html);
    expect(rest).toEqual([]);
    expect(verified).toContain('class="reward-chart"'); expect(verified).not.toContain('attributed');
    expect(verified!.match(/class="reward-bar"/g)).toHaveLength(1);
    expect(textOf(verified!)).toContain('2026-09-22 UTC: $6.00; 1 unpriced assets');
    expect(attributed).toContain('class="attributed-chart"'); expect(attributed).not.toContain('reward-bar');
    // Each priced day is split by token (here one token a day); the unpriced day keeps its marker and no segment.
    expect(attributed!.match(/class="bar-segment"/g)).toHaveLength(2); expect(attributed!.match(/class="unpriced-bar"/g)).toHaveLength(1);
    // Each attributed day is one focusable control named with its own report bucket; nothing verified appears in it.
    expect(labels(attributed!)).toEqual([
      "2026-09-19 UTC · Attributed: no priced receipts; 1 receipt; 1 unpriced asset. Open to list this day's payouts.",
      "2026-09-20 UTC · Attributed: $4.00; 1 receipt; 0 unpriced assets. Open to list this day's payouts.",
      "2026-09-21 UTC · Attributed: $1.50; 1 receipt; 0 unpriced assets. Open to list this day's payouts."]);
    expect(attributed!.match(/<g class="chart-day" tabindex="0" role="button"/g)).toHaveLength(3);
    expect(attributed).not.toContain('$6.00');
    // The tooltip opens only on hover, focus or tap.
    expect(html).not.toContain('day-tooltip');
    for (const combined of COMBINED) expect(html).not.toContain(combined);
    expect(attributedChartDays(view, defaultPeriod(view))?.map(day => [day.day, day.currentUsd])).toEqual([['2026-09-19', null], ['2026-09-20', '4.000000'], ['2026-09-21', '1.500000']]);
    expect(html.indexOf('attributed-plot')).toBeLessThan(html.indexOf('verified-plot'));
    const [attributedTable, verifiedTable] = html.split('<details class="chart-data">').slice(1).map(part => textOf(part.split('</details>')[0]!));
    expect(verifiedTable).toBe('View exact chart data UTC day Current USD Unpriced assets 2026-09-22 $6.00 1');
    expect(attributedTable).toBe('View exact attributed chart data UTC day Current USD Unpriced assets By token 2026-09-19 Unavailable 1 — '
      + '2026-09-20 $4.00 0 $QUOTE 100.0% $4.00 2026-09-21 $1.50 0 $DUAL 100.0% $1.50');
  });

  it('shows Not evaluated in the attributed table, chart and payouts instead of rows or zeros', () => {
    const view = unevaluatedView('v5 rows before reclassification');
    // A drawer link for a token never opens while the tier is not evaluated.
    const table = renderToStaticMarkup(createElement(TokensTab, { report: view, selected: `${MINT}:6`, open: () => undefined, close: () => undefined }));
    expect(table).not.toContain('<dialog');
    const evidence = renderToStaticMarkup(createElement(PayoutsTab, { report: view, filters: { day: '2026-09-20' }, setFilters: () => undefined, openReceipt: () => undefined }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const chart = renderToStaticMarkup(createElement(Chart, { report: view }));
    expect(errors).not.toHaveBeenCalled();
    expect(textOf(table)).toContain(`Attributed tokens ${view.attribution.explanation} Not evaluated Saved rows predate classifier v3`);
    // No attributed table at all; the verified table below keeps its own rows.
    expect(table).not.toContain('token-table');
    expect(table).toContain('id="token-title"');
    expect(textOf(evidence)).toMatch(/^Attributed Payouts Not evaluated Saved rows predate classifier v3/);
    expect(evidence).not.toContain('receipt-table'); expect(evidence).not.toContain('Payout filters');
    expect(chartSvgs(chart)).toHaveLength(1);
    expect(textOf(chart)).toContain(`Daily attributed receipts / USD by token · own scale Not evaluated Saved rows predate classifier v3`);
    // The tier explanation lives in the (i) popover above the chart, not under its heading.
    expect(chart).not.toContain(view.attribution.explanation);
    expect(chart).not.toContain('View exact attributed chart data');
    expect(chart).not.toContain('chart-day');
    expect(attributedChartDays(view, defaultPeriod(view))).toBeNull();
    // The overview has no Top tokens list under the panel, so the unevaluated state is not repeated there.
    const overview = renderToStaticMarkup(createElement(Overview, { report: view }));
    expect(overview).not.toContain('top-tokens');
    expect(overview).not.toContain('Top tokens');
    for (const html of [table, evidence, chart, overview]) expect(textOf(html)).not.toMatch(/\b0 rows\b|of 0 attributed|attributed, not verified: \$0|\$0\.00/);
  });
});

const MIDNIGHT = Math.floor(CUTOFF / 86_400) * 86_400 - 86_400; // 2026-09-21T00:00:00Z
/** Two adjacent UTC days of attributed receipts: 2026-09-20 from its first to its last second, then 2026-09-21 from midnight. */
function twoDayView() {
  const store = open();
  const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-dashboard', retrievedAt: iso(CUTOFF), commitment: 'finalized' as const };
  const witness = payout({ label: 'two-day-witness', time: CUTOFF - 1000, legs: legs(300) });
  const credits = ([[-86_400, '1000000'], [-43_200, '2000000'], [-1, '3000000'], [0, '4000000'], [21_600, '5000000']] as const)
    .map(([offset, amount], index) => payout({ label: `two-day-credit-${index}`, time: MIDNIGHT + offset, legs: [toWallet(amount)] }));
  store.atomic(() => {
    store.saveWallet({ wallet: WALLET, network, trackingStart: CUTOFF - 864000, cutoff: CUTOFF, lastSync: null });
    store.saveQuote(network, { mint: MINT, symbol: 'QUOTE', retrievedAt: iso(CUTOFF),
      membershipEvidence: [{ kind: 'distribution', launchMint: syntheticKey('launch'), endpoint: '/rewards?limit=100', retrievedAt: iso(CUTOFF) }] });
    store.savePrice(network, { mint: MINT, currency: 'USD', value: '2.00', provider: 'fixture', observedAt: iso(CUTOFF), retrievedAt: iso(CUTOFF),
      expiresAt: Number.MAX_SAFE_INTEGER, reason: null });
    store.addTransaction(network, witness, provenance); store.addFeed(officialFeed(witness));
    for (const tx of credits) { store.addTransaction(network, tx, provenance); store.watch(network, signatureOf(tx), WALLET); }
  });
  drain(store);
  return reportView(buildReport(store, WALLET));
}

describe('overview: day tooltip and click-to-filter', () => {
  const token = (symbol: string, currentUsd: string | null, index: number) => ({ key: `${syntheticKey(symbol)}:6`, mint: syntheticKey(symbol), mintAddress: syntheticKey(symbol), symbol,
    decimals: 6, raw: String(1_000_000 * (index + 1)), amount: `${index + 1}.000000`, currentUsd, receipts: 1,
    priceAt: currentUsd === null ? null : iso(CUTOFF), priceAgeSeconds: currentUsd === null ? null : 0, priceStale: currentUsd === null ? null : false });
  const HINT = 'Click the day to pin it · a ticker lists its payouts that day';
  it('shows a day\'s report total and a row per token with its color, ticker, share, USD, amount and Copy CA, and counts what stays out of the bar', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const busy = view.attribution.dayTokens!.find(day => day.day === '2026-09-20')!;
    const palette = tokenPalette(view, defaultPeriod(view));
    const tooltip = (bucket: DayBucket, colors = palette, pinned = false) => visible(createElement(DayTooltip, { report: view, bucket, palette: colors, pinned }));
    expect(tooltip(busy)).toBe('2026-09-20 UTC Attributed $7.75 4 receipts · 1 unpriced receipt in 1 token, not in the bar Token · share USD ▼ '
      + `$QUOTE 90.3% $7.00 3.500000 Copy CA $DUAL 9.7% $0.75 0.500000 Copy CA ${HINT}`);
    const html = renderToStaticMarkup(createElement(DayTooltip, { report: view, bucket: busy, palette, onToken: () => undefined, onDay: () => undefined }));
    // Each row keys its token with the same color the bar and every other list use.
    expect([...html.matchAll(/class="token-key" style="background:(#[0-9a-f]{6})"/g)].map(match => match[1])).toEqual([tokenColor(palette, `${MINT}:6`), tokenColor(palette, `${DUAL_MINT}:6`)]);
    // A ticker lists that token's payouts on the day, the day link all of them, and Copy CA copies the full mint.
    expect(html).toContain('<button type="button" class="ticker" aria-label="$QUOTE: list its payouts on 2026-09-20">$QUOTE</button>');
    expect(html).toContain('<button type="button" class="copy-button idle" aria-label="Copy $QUOTE contract address">Copy CA</button>');
    expect(html).toContain('<button type="button" class="tooltip-day link-button">All 4 payouts that day →</button>');
    expect(textOf(html)).not.toContain('No mint address');
    // A pinned day says how it closes.
    expect(tooltip(busy, palette, true)).toMatch(/Pinned · Esc or a click outside closes it$/);
    // Tokens beyond the palette share one Other segment whose value is the day total less the named ones; it expands to them.
    const crowded: DayBucket = { day: '2026-09-18', currentUsd: '9.250000', unpricedCount: 1, receipts: 5,
      tokens: [token('ALPHA', '5.000000', 0), token('BETA', '3.000000', 1), token('GAMMA', '1.250000', 2), token('DELTA', '0.000001', 3), token('OMEGA', null, 4)] };
    const two: TokenPalette = { keys: [crowded.tokens[0]!.key, crowded.tokens[1]!.key], colors: new Map([[crowded.tokens[0]!.key, TOKEN_COLORS[0]], [crowded.tokens[1]!.key, TOKEN_COLORS[1]]]) };
    expect(tooltip(crowded, two)).toBe('2026-09-18 UTC Attributed $9.25 5 receipts · 1 unpriced receipt in 1 token, not in the bar Token · share USD ▼ '
      + `$ALPHA 54.1% $5.00 1.000000 Copy CA $BETA 32.4% $3.00 2.000000 Copy CA Other · 2 tokens ▸ 13.5% $1.25 2 receipts ${HINT}`);
    expect(renderToStaticMarkup(createElement(DayTooltip, { report: view, bucket: crowded, palette: two })))
      .toContain('<button type="button" class="other-toggle" aria-expanded="false" aria-controls="other-tokens-2026-09-18">');
    const { others } = daySegments(crowded, two);
    expect(others.map(item => [item.symbol, item.usd, item.tenths, item.color, item.mintAddress])).toEqual([
      ['$GAMMA', '1.250000', 135, OTHER_COLOR, syntheticKey('GAMMA')], ['$DELTA', '0.000001', 0, OTHER_COLOR, syntheticKey('DELTA')]]);
    const unpricedOnly: DayBucket = { ...crowded, currentUsd: null, receipts: 1, tokens: [token('OMEGA', null, 0)] };
    expect(tooltip(unpricedOnly)).toBe(`2026-09-18 UTC Attributed No priced receipts 1 receipt · 1 unpriced receipt in 1 token, not in the bar ${HINT}`);
    // The native-SOL sentinel has no mint address to copy.
    const native: DayBucket = { ...crowded, tokens: [{ ...crowded.tokens[0]!, mintAddress: null }] };
    expect(tooltip(native, two)).toContain('$ALPHA 100.0% $5.00 1.000000 No mint address');
  });

  it('lists the tooltip\'s tokens by USD, highest first or lowest first from its USD header, Other after them and unpriced last', () => {
    const rows = [{ key: 'b', symbol: '$B', usd: '2.5', other: false }, { key: 'x', symbol: '$X', usd: null, other: false }, { key: 'other', symbol: 'Other', usd: '90', other: true },
      { key: 'a', symbol: '$A', usd: '10', other: false }, { key: 'c2', symbol: '$C', usd: '2.50', other: false }, { key: 'c1', symbol: '$C', usd: '2.5', other: false },
      { key: 'w', symbol: '$W', usd: null, other: false }, { key: 'd', symbol: '$D', usd: '0.000001', other: false }, { key: 'e', symbol: '$E', usd: '9.99', other: false }];
    // Exact decimal order; equal USD falls back to symbol, then key, the same way in both directions.
    expect(sortUsdRows(rows, 'descending').map(row => row.key)).toEqual(['a', 'e', 'b', 'c1', 'c2', 'd', 'other', 'w', 'x']);
    expect(sortUsdRows(rows, 'ascending').map(row => row.key)).toEqual(['d', 'b', 'c1', 'c2', 'e', 'a', 'other', 'w', 'x']);
    expect(rows[0]!.key).toBe('b');
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const crowded: DayBucket = { day: '2026-09-18', currentUsd: '9.250000', unpricedCount: 1, receipts: 5,
      tokens: [token('ALPHA', '5.000000', 0), token('BETA', '3.000000', 1), token('GAMMA', '1.250000', 2), token('DELTA', '0.000001', 3), token('OMEGA', null, 4)] };
    // A palette led by the smaller token: the tooltip still lists highest USD first, not in palette order.
    const two: TokenPalette = { keys: [crowded.tokens[1]!.key, crowded.tokens[0]!.key], colors: new Map([[crowded.tokens[1]!.key, TOKEN_COLORS[0]], [crowded.tokens[0]!.key, TOKEN_COLORS[1]]]) };
    const render = (order?: 'ascending' | 'descending') => renderToStaticMarkup(createElement(DayTooltip, { report: view, bucket: crowded, palette: two, ...order ? { order } : {} }));
    expect(textOf(render())).toContain('Token · share USD ▼ $ALPHA 54.1% $5.00 1.000000 Copy CA $BETA 32.4% $3.00 2.000000 Copy CA Other · 2 tokens ▸ 13.5% $1.25');
    expect(textOf(render('ascending'))).toContain('Token · share USD ▲ $BETA 32.4% $3.00 2.000000 Copy CA $ALPHA 54.1% $5.00 1.000000 Copy CA Other · 2 tokens ▸ 13.5% $1.25');
    expect(render()).toContain('<button type="button" class="sort" aria-label="USD, highest first. Sort lowest first">USD <span aria-hidden="true">▼</span></button>');
    expect(render('ascending')).toContain('aria-label="USD, lowest first. Sort highest first"');
  });

  it('places the tooltip 8px from its day\'s bar, right unless that overflows the chart, and clamps it inside the viewport', () => {
    const period: Period = { id: '7d', start: '2026-09-16', end: '2026-09-22', days: 7 };
    const g = geometry(1400, period);
    const bar = (geo: Geometry, day: string) => ({ left: geo.x(day) - geo.bar / 2, right: geo.x(day) + geo.bar / 2 });
    // The first, a middle and the last day: right, right, then left, where the right would pass the chart's edge.
    const [first, middle, last] = ['2026-09-16', '2026-09-19', '2026-09-22'].map(day => ({ day, place: tooltipPlacement(g, day), bar: bar(g, day) }));
    for (const { place, bar: edges } of [first!, middle!]) {
      expect(place).toMatchObject({ side: 'right', left: edges.right + TOOLTIP_GAP, width: 300, top: 0, maxHeight: HEIGHT - 26, bar: edges });
    }
    expect(last!.place).toMatchObject({ side: 'left', width: 300, bar: last!.bar });
    expect(last!.place.left + last!.place.width).toBe(last!.bar.left - TOOLTIP_GAP);
    expect(last!.bar.right + TOOLTIP_GAP + 300).toBeGreaterThan(g.width);
    for (const { place } of [first!, middle!, last!]) { expect(place.left).toBeGreaterThanOrEqual(0); expect(place.left + place.width).toBeLessThanOrEqual(g.width); }
    // It may cover the neighbouring day: the middle day's tooltip lies over the next day's bar.
    expect(middle!.place.left + middle!.place.width).toBeGreaterThan(bar(g, '2026-09-20').left);
    // Ninety narrow columns: the same 8px from the bar, on either side.
    const long = geometry(1400, { id: '90d', start: '2026-06-25', end: '2026-09-22', days: 90 });
    expect(tooltipPlacement(long, '2026-06-25')).toMatchObject({ side: 'right', left: bar(long, '2026-06-25').right + 8 });
    expect(tooltipPlacement(long, '2026-08-09')).toMatchObject({ side: 'right', left: bar(long, '2026-08-09').right + 8 });
    expect(tooltipPlacement(long, '2026-09-22')).toMatchObject({ side: 'left', left: bar(long, '2026-09-22').left - 8 - 300 });
    // With room on neither side it takes the roomier one, at least 220px wide, inside the chart.
    const tight = tooltipPlacement(geometry(560, period), '2026-09-19');
    expect(tight.width).toBeGreaterThanOrEqual(220);
    expect(tight.left).toBeGreaterThanOrEqual(0); expect(tight.left + tight.width).toBeLessThanOrEqual(560);
    // On the way in: the gap, and beside the bar under the tooltip; not the bar, the other side or past the tooltip.
    const place = first!.place;
    expect([place.bar.right + 4, place.left + 150, place.bar.right - 1, place.bar.left - 4, place.left + 301].map(x => towardTooltip(place, x)))
      .toEqual([true, true, false, false, false]);
    expect([last!.bar.left - 4, last!.place.left + 1, last!.bar.left + 1, last!.bar.right + 4, last!.place.left - 1].map(x => towardTooltip(last!.place, x)))
      .toEqual([true, true, false, false, false]);
    const box = { left: 100, right: 400, top: 50, bottom: 250 };
    expect([distanceTo(box, 200, 100), distanceTo(box, 92, 100), distanceTo(box, 97, 254)]).toEqual([0, 8, 5]);
    // Vertically: unchanged while it fits in the viewport; moved down under a sticky header, or up off the bottom edge, only as far as needed.
    expect(clampTop(0, 200, 300, 80, 992)).toBe(0);
    expect(clampTop(0, 200, 20, 80, 992)).toBe(60);
    expect(clampTop(0, 200, 900, 80, 992)).toBe(-108);
    // Taller than the band: its top edge stays visible.
    expect(clampTop(0, 900, 900, 80, 700)).toBe(-820);
  });

  it('colors the period\'s top twelve tokens by USD in a fixed order, folds the rest into Other, and keeps colors stable within a period', () => {
    const base = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const bucket = base.attribution.dayTokens!.find(day => day.day === '2026-09-20')!;
    // Fourteen priced tokens on one day, $14 down to $1, and one unpriced token.
    const tokens = [...Array.from({ length: 14 }, (_, index) => token(`T${index}`, `${14 - index}.000000`, index)), token('NOPRICE', null, 14)];
    const view: DashboardReport = { ...base, attribution: { ...base.attribution, dayTokens: [{ ...bucket, currentUsd: '105.000000', receipts: 15, unpricedCount: 1, tokens }] } };
    const period = defaultPeriod(view);
    const palette = tokenPalette(view, period);
    expect(palette.keys).toEqual(tokens.slice(0, 12).map(item => item.key));
    expect(palette.keys.map(key => tokenColor(palette, key))).toEqual([...TOKEN_COLORS]);
    expect([tokenColor(palette, tokens[12]!.key), tokenColor(palette, tokens[14]!.key)]).toEqual([OTHER_COLOR, OTHER_COLOR]);
    expect(new Set([...TOKEN_COLORS, OTHER_COLOR]).size).toBe(13);
    // The same period gives the same colors every time it is asked, whichever tab asks.
    expect(tokenPalette(view, period)).toEqual(palette);
    expect(tokenPalette(view, resolvePeriod(view, periodParams(period)).period)).toEqual(palette);
    const { segments, others, unpriced } = daySegments(view.attribution.dayTokens![0]!, palette);
    expect(segments.map(segment => segment.symbol)).toEqual([...Array.from({ length: 12 }, (_, index) => `$T${index}`), 'Other']);
    expect(segments.at(-1)).toMatchObject({ other: true, tokens: 2, usd: '3.000000', receipts: 2, color: OTHER_COLOR, mintAddress: null });
    expect(unpriced).toEqual({ receipts: 1, tokens: 1 });
    // Shares sum to exactly 100.0%, and the segments' USD to exactly the day's total; Other's tokens share exactly Other's.
    expect(segments.reduce((sum, segment) => sum + segment.tenths, 0)).toBe(1000);
    expect(segments.reduce((sum, segment) => addDecimal(sum, segment.usd), '0')).toBe('105.000000');
    expect(others.map(item => item.symbol)).toEqual(['$T12', '$T13']);
    expect(others.reduce((sum, item) => sum + item.tenths, 0)).toBe(segments.at(-1)!.tenths);
    // A token that leads only outside the period is not colored in it, and leads in a period that holds its day.
    const outside: DashboardReport = { ...view, attribution: { ...view.attribution, dayTokens: [{ ...bucket, day: '2026-09-13', currentUsd: '1000.000000',
      tokens: [token('OLD', '1000.000000', 0)] }, ...view.attribution.dayTokens!] } };
    expect(tokenPalette(outside, period).keys).toEqual(palette.keys);
    expect(tokenPalette(outside, periodOptions(outside).at(-1)!.period).keys[0]).toBe(token('OLD', null, 0).key);
  });

  describe('tokens you were paid in', () => {
    /** Fourteen priced tokens worth $14 down to $1 and one unpriced token on 2026-09-20; on 2026-09-21, $T13 again at $20, $T0 at
     * $0.50 and the unpriced token. Over both days $T13 leads with $21 and $T0 follows with $14.50, of $125.50 in all. */
    const rankedView = () => {
      const base = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
      const bucket = base.attribution.dayTokens!.find(day => day.day === '2026-09-20')!;
      const first = [...Array.from({ length: 14 }, (_, index) => token(`T${index}`, `${14 - index}.000000`, index)), token('NOPRICE', null, 14)];
      const second = [token('T13', '20.000000', 13), token('T0', '0.500000', 0), token('NOPRICE', null, 14)];
      return { ...base, attribution: { ...base.attribution, dayTokens: [{ ...bucket, currentUsd: '105.000000', receipts: 15, unpricedCount: 1, tokens: first },
        { ...bucket, day: '2026-09-21', currentUsd: '20.500000', receipts: 3, unpricedCount: 1, tokens: second }] } } satisfies DashboardReport;
    };
    const symbols = (count: number) => Array.from({ length: count }, (_, index) => `$T${index}`);

    it('ranks the period\'s tokens by exact USD summed over its days, the top twelve in their chart colors and the rest as Other', () => {
      const view = rankedView(); const period = defaultPeriod(view); const palette = tokenPalette(view, period);
      expect(period.id).toBe('7d');
      const ranking = tokenRanking(view, period, palette)!;
      expect(ranking.rows.map(row => row.symbol)).toEqual(['$T13', ...symbols(11), 'Other']);
      expect(ranking.rows.slice(0, 2).map(row => [row.usd, row.receipts])).toEqual([['21.000000', 2], ['14.500000', 2]]);
      // The same order assigns the palette, so each ranked token keeps its daily-chart color; Other is the chart's gray.
      expect(ranking.rows.slice(0, 12).map(row => row.key)).toEqual(palette.keys);
      expect(ranking.rows.map(row => row.color)).toEqual([...TOKEN_COLORS, OTHER_COLOR]);
      expect(ranking.rows.at(-1)).toMatchObject({ key: 'other', other: true, tokens: 2, usd: '5.000000', receipts: 2, mintAddress: null });
      expect(ranking.rows[0]!.mintAddress).toBe(syntheticKey('T13'));
      expect([ranking.total, ranking.tokens, ranking.foldable]).toEqual(['125.500000', 15, true]);
      // Every listed row, all of them: the fourteen priced tokens, the two past the twelfth in Other's gray, and no Other row.
      const all = tokenRanking(view, period, palette, true)!;
      expect(all.rows.map(row => row.symbol)).toEqual(['$T13', ...symbols(13)]);
      expect(all.rows.slice(12).map(row => [row.symbol, row.usd, row.color])).toEqual([['$T11', '3.000000', OTHER_COLOR], ['$T12', '2.000000', OTHER_COLOR]]);
      expect(all.foldable).toBe(true);
      // A period holding one day ranks that day alone; with no more than twelve tokens nothing folds.
      const day = tokenRanking(view, customPeriod(view, '2026-09-21', '2026-09-21').period!, palette)!;
      expect(day.rows.map(row => [row.symbol, row.usd, row.receipts])).toEqual([['$T13', '20.000000', 1], ['$T0', '0.500000', 1]]);
      expect([day.total, day.tokens, day.foldable]).toEqual(['20.500000', 3, false]);
    });

    it('gives shares that sum to exactly 100.0% of the listed rows and never ranks or values an unpriced token', () => {
      const view = rankedView(); const period = defaultPeriod(view); const palette = tokenPalette(view, period);
      const ranking = tokenRanking(view, period, palette)!;
      // $21 of $125.50 is 16.73%; largest remainders round the thirteen shares to exactly 1000 tenths.
      expect(ranking.rows.map(row => row.tenths)).toEqual([167, 115, 103, 95, 88, 80, 72, 64, 56, 48, 40, 32, 40]);
      for (const shown of [ranking, tokenRanking(view, period, palette, true)!, tokenRanking(view, customPeriod(view, '2026-09-21', '2026-09-21').period!, palette)!]) {
        expect(shown.rows.reduce((sum, row) => sum + row.tenths, 0)).toBe(1000);
        expect(shown.rows.reduce((sum, row) => addDecimal(sum, row.usd), '0')).toBe(shown.total);
      }
      expect(tokenRanking(view, customPeriod(view, '2026-09-21', '2026-09-21').period!, palette)!.rows.map(row => row.tenths)).toEqual([976, 24]);
      // The unpriced token is listed apart with both days' receipts, and is in no row, share or total.
      const unpriced = token('NOPRICE', null, 14).key;
      expect(ranking.unpriced).toEqual([{ key: unpriced, symbol: '$NOPRICE', receipts: 2, mintAddress: syntheticKey('NOPRICE') }]);
      expect(ranking.rows.some(row => row.key === unpriced)).toBe(false);
      // Only unpriced receipts: nothing to rank, the token still listed.
      const bucket = view.attribution.dayTokens[0]!;
      const onlyUnpriced: DashboardReport = { ...view, attribution: { ...view.attribution, dayTokens: [{ ...bucket, currentUsd: null, receipts: 1, tokens: [token('NOPRICE', null, 14)] }] } };
      expect(tokenRanking(onlyUnpriced, period, palette)).toMatchObject({ rows: [], total: null, tokens: 1, foldable: false, unpriced: [{ symbol: '$NOPRICE', receipts: 1 }] });
      // A period without receipts, and a tier that is not evaluated, which never reads as zero.
      expect(tokenRanking(view, customPeriod(view, '2026-09-17', '2026-09-18').period!, palette)).toMatchObject({ rows: [], unpriced: [], total: null, tokens: 0 });
      expect(tokenRanking({ ...view, attribution: { ...view.attribution, evaluated: false } }, period, palette)).toBeNull();
      expect(renderToStaticMarkup(createElement(TokenRanking, { report: { ...view, attribution: { ...view.attribution, evaluated: false } }, period, palette }))).toBe('');
    });

    it('lists highest USD first or, from its USD header, lowest first, with Other after the tokens and unpriced tokens after the bars', () => {
      const view = rankedView(); const period = defaultPeriod(view); const palette = tokenPalette(view, period);
      const ranking = tokenRanking(view, period, palette)!;
      expect(sortUsdRows(ranking.rows, 'descending').map(row => row.symbol)).toEqual(['$T13', ...symbols(11), 'Other']);
      expect(sortUsdRows(ranking.rows, 'ascending').map(row => row.symbol)).toEqual([...symbols(11).reverse(), '$T13', 'Other']);
      const render = (order?: 'ascending' | 'descending', all = false) => renderToStaticMarkup(createElement(TokenRanking, { report: view, period, palette, all, ...order ? { order } : {} }));
      const html = render();
      expect(textOf(html)).toMatch(new RegExp(`^Attributed Tokens you were paid in / 7D · ${period.start} → ${period.end} Ranked by USD at current prices\\. `
        + 'A payout does not name the launch it came from, so this ranks reward tokens, not launches\\. Token Bar USD ▼ Share Receipts Contract address '
        + '\\$T13 \\$21\\.00 16\\.7% 2 receipts Copy CA \\$T0 \\$14\\.50 11\\.5% 2 receipts Copy CA '));
      expect(textOf(html)).toContain('$T10 $4.00 3.2% 1 receipt Copy CA Other · 2 tokens $5.00 4.0% 2 receipts $NOPRICE UNPRICED — 2 receipts Copy CA Show all 15 tokens');
      expect(html).toContain('<th class="numeric" aria-sort="descending"><button type="button" class="sort" aria-label="USD, highest first. Sort lowest first">USD <span aria-hidden="true">▼</span></button></th>');
      expect(html).toContain('<button type="button" class="ticker" aria-label="$T13: list its payouts, highest USD first">$T13</button>');
      expect(html).toContain('<button type="button" class="copy-button idle" aria-label="Copy $T13 contract address">Copy CA</button>');
      // Each bar in its token's color, the longest the leader's; the unpriced token has none.
      expect([...html.matchAll(/<span class="ranking-bar"><i style="width:([\d.]+)%;background:(#[0-9a-f]{6})"/g)].map(match => match[2])).toEqual([...TOKEN_COLORS, OTHER_COLOR]);
      expect(html.match(/<span class="ranking-bar"><i style="width:100%/g)).toHaveLength(1);
      const ascending = render('ascending');
      expect(ascending).toContain('<th class="numeric" aria-sort="ascending"><button type="button" class="sort" aria-label="USD, lowest first. Sort highest first">USD <span aria-hidden="true">▲</span></button></th>');
      expect(textOf(ascending)).toContain('Contract address $T10 $4.00 3.2% 1 receipt Copy CA $T9 $5.00');
      expect(textOf(ascending)).toMatch(/\$T13 \$21\.00 16\.7% 2 receipts Copy CA Other · 2 tokens \$5\.00 4\.0% 2 receipts \$NOPRICE UNPRICED/);
      expect(textOf(render(undefined, true))).toContain('$T11 $3.00 2.4% 1 receipt Copy CA $T12 $2.00 1.6% 1 receipt Copy CA $NOPRICE UNPRICED — 2 receipts Copy CA Show the top 12 and Other');
      expect(render(undefined, true)).toContain('aria-expanded="true"');
    });
  });

  it('gives every day\'s shares a sum of exactly 100.0% and stacks each bar exactly to the day total', () => {
    const view = twoDayView();
    const busy = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    for (const report of [view, busy]) {
      const period = periodOptions(report).at(-1)!.period;
      const palette = tokenPalette(report, period);
      for (const bucket of report.attribution.dayTokens!) {
        const { segments } = daySegments(bucket, palette);
        if (bucket.currentUsd === null) { expect(segments).toEqual([]); continue; }
        expect(segments.reduce((sum, segment) => sum + segment.tenths, 0)).toBe(1000);
        expect(segments.every(segment => segment.color === tokenColor(palette, segment.key) || segment.other)).toBe(true);
      }
      // In the rendered chart every day's top segment ends exactly at the height of that day's total.
      const html = renderToStaticMarkup(createElement(Chart, { report, period, palette }));
      for (const group of html.match(/<g class="chart-day[\s\S]*?<\/g>/g)!) {
        const rects = [...group.matchAll(/<rect data-token="([^"]*)" class="bar-segment[^"]*" x="[^"]*" y="([^"]*)" width="[^"]*" height="([^"]*)" fill="([^"]*)"/g)];
        if (!rects.length) continue;
        const top = Math.min(...rects.map(match => Number(match[2])));
        const bottom = Math.max(...rects.map(match => Number(match[2]) + Number(match[3])));
        const day = /aria-label="(\d{4}-\d{2}-\d{2}) UTC/.exec(group)![1]!;
        const total = Number(report.attribution.dayTokens!.find(bucket => bucket.day === day)!.currentUsd);
        // Against the scale's top tick, a round step at or above the period's highest day.
        const scale = chartTicks(Math.max(1, ...report.attribution.dayTokens!.filter(bucket => bucket.currentUsd !== null).map(bucket => Number(bucket.currentUsd)))).at(-1)!;
        expect(bottom - top).toBeCloseTo(total / scale * (HEIGHT - 12 - 26), 6);
        for (const match of rects) expect(match[4]).toBe(match[1] === 'other' ? OTHER_COLOR : tokenColor(palette, match[1]!));
      }
    }
  });

  it('names the day and the token above a segment\'s payouts, counted as the tooltip counts them', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const bucket = view.attribution.dayTokens!.find(day => day.day === '2026-09-20')!;
    const quote = bucket.tokens.find(item => item.symbol === 'QUOTE')!;
    const banner = dayFilterBanner(view, { day: '2026-09-20', token: quote.key })!;
    expect(banner).toMatchObject({ day: '2026-09-20', token: quote.key, symbol: '$QUOTE', listed: quote.receipts, reportReceipts: quote.receipts, partial: false });
    expect(banner.text).toBe(`Showing 2026-09-20 · $QUOTE · ${quote.receipts} ${quote.receipts === 1 ? 'payout' : 'payouts'}`);
    expect(filterReceipts(view.attribution.receipts!, { day: '2026-09-20', token: quote.key }).every(receipt => receipt.day === '2026-09-20' && receipt.asset === quote.key)).toBe(true);
    expect(parseRoute(routeHash({ tab: 'payouts', params: { day: '2026-09-20', token: quote.key } }))).toEqual({ tab: 'payouts', params: { day: '2026-09-20', token: quote.key } });
    const html = renderToStaticMarkup(createElement(PayoutsTab, { report: view, filters: { day: '2026-09-20', token: quote.key }, setFilters: () => undefined, openReceipt: () => undefined,
      palette: tokenPalette(view, defaultPeriod(view)) }));
    expect(textOf(html)).toContain(`${banner.text} Clear ×`);
    expect(html).toContain('aria-label="Clear the 2026-09-20 $QUOTE filter"');
    // Rows carry the token's color too.
    expect(html).toContain(`class="token-swatch" style="background:${tokenColor(tokenPalette(view, defaultPeriod(view)), quote.key)}"`);
  });

  it('compares USD by exact decimal rather than text or floating point, unpriced last', () => {
    expect([compareDecimal('10.5', '9.99'), compareDecimal('0.000001', '0'), compareDecimal('007.10', '7.1'), compareDecimal('2', '10')]).toEqual([1, 1, 0, -1]);
    expect(['1.5', null, '20', null, '3'].sort(byUsd)).toEqual(['20', '3', '1.5', null, null]);
  });

  it('keeps the overview to the attributed chart and its ranking, with no Top tokens list and no verified section while verified has no rows', () => {
    const view = reportView(buildReport(attributedStore(database(), { verified: false }), WALLET));
    const html = renderToStaticMarkup(createElement(Overview, { report: view }));
    expect(html).toContain('attributed-plot');
    expect(html).toContain('token-ranking');
    expect(html).not.toContain('top-tokens');
    expect(html).not.toContain('Top tokens');
    expect(html).not.toContain('verified-plot');
  });

  it('opens the payouts tab on the clicked day, listing only that day\'s attributed receipts', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    expect(routeHash({ tab: 'payouts', params: { day: '2026-09-20' } })).toBe('#payouts?day=2026-09-20');
    const day = renderToStaticMarkup(createElement(PayoutsTab, { report: view, filters: { day: '2026-09-20' }, setFilters: () => undefined, openReceipt: () => undefined }));
    expect(textOf(day)).toContain('Showing 1–4 of 4 receipts · filtered from 6');
    expect(tableRows(day.split('<table class="receipt-table">')[1]!).map(row => row.split(' ').slice(0, 4).join(' '))).toEqual([
      '2026-09-20 18:10 UTC $QUOTE', '2026-09-20 18:10 UTC $DUAL', '2026-09-20 18:10 UTC $THIRD', '2026-09-20 18:00 UTC $QUOTE']);
    // The day's receipts are exactly the chart bucket's receipts.
    expect(view.attribution.dayTokens!.find(bucket => bucket.day === '2026-09-20')!.receipts).toBe(4);
  });

  it('names the clicked UTC day above its payouts, counted as its chart bucket counts them, on both sides of midnight', () => {
    // Regression: the list was filtered, but the heading still counted every payout and nothing named the day on screen.
    const view = twoDayView();
    const buckets = view.attribution.dayTokens!;
    expect(buckets.map(bucket => [bucket.day, bucket.currentUsd, bucket.receipts])).toEqual([['2026-09-20', '12.000000', 3], ['2026-09-21', '18.000000', 2]]);
    const receipts = view.attribution.receipts!;
    for (const bucket of buckets) {
      // The tooltip's count, the banner's and the list's are one number, and every listed receipt lies inside that UTC day.
      const listed = filterReceipts(receipts, { day: bucket.day });
      const start = Date.parse(`${bucket.day}T00:00:00Z`) / 1000;
      expect(listed).toHaveLength(bucket.receipts);
      expect(listed.every(receipt => receipt.time !== null && receipt.time >= start && receipt.time < start + 86_400)).toBe(true);
      expect(dayFilterBanner(view, { day: bucket.day })).toMatchObject({ day: bucket.day, listed: bucket.receipts, reportReceipts: bucket.receipts, partial: false });
    }
    // The last second of 2026-09-20 stays on its day; the first second of 2026-09-21 opens the next one.
    expect(filterReceipts(receipts, { day: '2026-09-20' }).map(receipt => [receipt.time! - MIDNIGHT, receipt.amount])).toEqual([
      [-1, '3.000000'], [-43_200, '2.000000'], [-86_400, '1.000000']]);
    expect(filterReceipts(receipts, { day: '2026-09-21' }).map(receipt => [receipt.time! - MIDNIGHT, receipt.amount])).toEqual([[21_600, '5.000000'], [0, '4.000000']]);
    expect(labels(renderToStaticMarkup(createElement(Chart, { report: view })))).toEqual([
      "2026-09-20 UTC · Attributed: $12.00; 3 receipts; 0 unpriced assets. Open to list this day's payouts.",
      "2026-09-21 UTC · Attributed: $18.00; 2 receipts; 0 unpriced assets. Open to list this day's payouts."]);
    expect(parseRoute(routeHash({ tab: 'payouts', params: { day: '2026-09-20' } }))).toEqual({ tab: 'payouts', params: { day: '2026-09-20' } });
    const render = (filters: ReceiptFilters, report = view) => renderToStaticMarkup(createElement(PayoutsTab, { report, filters, setFilters: () => undefined, openReceipt: () => undefined }));
    const day = render({ day: '2026-09-20' });
    expect(textOf(day)).toMatch(/^Attributed Payouts 3 NEWEST FIRST · EACH OPENS ITS EVIDENCE Showing 2026-09-20 · 3 payouts Clear × Day · UTC /);
    expect(day).toContain('<span class="count-label" title="3 of 5 receipts match these filters">3</span>');
    expect(day).toContain('<button type="button" aria-label="Clear the 2026-09-20 day filter">Clear ×</button>');
    expect(textOf(day)).toContain('Showing 1–3 of 3 receipts · filtered from 5');
    expect(tableRows(day.split('<table class="receipt-table">')[1]!).map(row => row.slice(0, 20))).toEqual(['2026-09-20 23:59 UTC', '2026-09-20 12:00 UTC', '2026-09-20 00:00 UTC']);
    // Unfiltered, the heading counts every listed payout and no banner appears.
    const all = render({});
    expect(textOf(all)).toMatch(/^Attributed Payouts 5 NEWEST FIRST/);
    expect(all).not.toContain('day-banner');
    // A list holding only the newest receipts says how many of the day's it shows; other filters count what they leave.
    const truncated = { ...view, attribution: { ...view.attribution, receipts: receipts.slice(0, 1), receiptsComplete: false } };
    expect(dayFilterBanner(truncated, { day: '2026-09-21' })?.text).toBe('Showing 2026-09-21 · 1 of 2 payouts');
    expect(textOf(render({ day: '2026-09-21' }, truncated))).toContain('Showing 2026-09-21 · 1 of 2 payouts · the list holds only the newest receipts Clear ×');
    expect(dayFilterBanner(truncated, { day: '2026-09-21', price: 'priced' })?.text).toBe('Showing 2026-09-21 · 1 payout');
    // An unevaluated tier never reads as 0 payouts on a day.
    const unevaluated = unevaluatedView('schema v4');
    expect(dayFilterBanner(unevaluated, { day: '2026-09-20' })).toBeNull();
    expect(render({ day: '2026-09-20' }, unevaluated)).not.toContain('day-banner');
  });
});

describe('overview period: the hero figures and the chart share one period', () => {
  const custom = (report: DashboardReport, from: string, to: string) => customPeriod(report, from, to).period!;
  const micro = (value: string) => BigInt(value.replace('.', ''));
  /** The chart panel's attributed day controls and calendar axis for one period. */
  const panel = (report: DashboardReport, period: Period) => {
    const html = renderToStaticMarkup(createElement(Chart, { report, period }));
    const [attributed] = chartSvgs(html);
    const axis = [...(attributed ?? '').split(/<g class="day-axis[^"]*" aria-hidden="true">/)[1]!.split('</g>')[0]!.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
    return { html, hero: textOf(html.split('<div class="period-hero">')[1]!.split('<div class="period-control">')[0]!), days: labels(attributed ?? '').map(label => label.slice(0, 10)), axis };
  };

  it('shows USD to two decimals, rounded half up from the exact string with thousands separators, and <$0.01 under a cent', () => {
    // Rounding half up at the third place, exactly, whatever the string's own precision.
    expect(['1.321429', '0.785714', '394.415', '394.414999', '2.005', '2.004999', '0.995', '9.999999', '1.2', '7', '12.000000'].map(usd))
      .toEqual(['$1.32', '$0.79', '$394.42', '$394.41', '$2.01', '$2.00', '$1.00', '$10.00', '$1.20', '$7.00', '$12.00']);
    // Thousands separators, including where rounding carries into a new group.
    expect(['1234.5', '5432.105998', '1000000', '999.995', '12345678906234567.891', '2204585518.077601'].map(usd))
      .toEqual(['$1,234.50', '$5,432.11', '$1,000,000.00', '$1,000.00', '$12,345,678,906,234,567.89', '$2,204,585,518.08']);
    // Any positive value under one cent, even one that would round up to a cent, and zero, which is not below a cent.
    expect(['0.000001', '0.004', '0.005', '0.009999', '0.01', '0.010001', '0', '0.000000', '0.00'].map(usd))
      .toEqual(['<$0.01', '<$0.01', '<$0.01', '<$0.01', '$0.01', '$0.01', '$0.00', '$0.00', '$0.00']);
    expect([usd(null), usd(undefined)]).toEqual(['Unavailable', 'Unavailable']);
    // The evidence modal and the exact chart data tables keep full precision.
    expect(['1.321429', '394.415', '0.000001', '5432.105998', '12.000000', '7'].map(usdExact)).toEqual(['$1.321429', '$394.415', '$0.000001', '$5,432.105998', '$12.00', '$7.00']);
  });

  it('steps the daily chart\'s scale in round values from zero, the top tick at or above the highest day', () => {
    expect(chartTicks(1500)).toEqual([0, 400, 800, 1200, 1600]);
    expect(chartTicks(1500).map(tickText)).toEqual(['0', '400', '800', '1.2K', '1.6K']);
    expect(chartTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
    expect(chartTicks(507.096545)).toEqual([0, 200, 400, 600]);
    expect(chartTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(chartTicks(63)).toEqual([0, 20, 40, 60, 80]);
    expect(chartTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(chartTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(chartTicks(12_345)).toEqual([0, 4000, 8000, 12_000, 16_000]);
    expect(chartTicks(12_345).map(tickText)).toEqual(['0', '4K', '8K', '12K', '16K']);
    expect(chartTicks(1).map(tickText)).toEqual(['0', '0.25', '0.5', '0.75', '1']);
    // Every step is 1, 2, 2.5, 4 or 5 times a power of ten, at most four steps reach the maximum, and none is wasted.
    for (const maximum of [0.07, 1, 3.3, 17, 99.99, 100, 101, 432.742173, 999, 5432.105998, 250_000]) {
      const ticks = chartTicks(maximum); const step = ticks[1]!;
      expect(ticks[0]).toBe(0);
      expect(ticks.length - 1).toBeLessThanOrEqual(4);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(maximum);
      expect(ticks.at(-2)!).toBeLessThan(maximum);
      expect([1, 2, 2.5, 4, 5, 10].some(multiple => Math.abs(step / 10 ** Math.floor(Math.log10(step)) - multiple) < 1e-9)).toBe(true);
      ticks.forEach((tick, index) => { expect(tick).toBeCloseTo(index * step, 9); });
    }
    // No priced day has nothing to scale.
    expect([chartTicks(0), chartTicks(Number.NaN)]).toEqual([[0, 1], [0, 1]]);
  });

  it('adds the report\'s UTC day buckets in exact decimals, never floating point', () => {
    expect([addDecimal('0.1', '0.2'), addDecimal('1.5', '2.25'), addDecimal('999999.999999', '0.000001'), addDecimal('7', '0.000100')])
      .toEqual(['0.3', '3.75', '1000000.000000', '7.000100']);
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addDecimal('9007199254740993.000001', '0.000001')).toBe('9007199254740993.000002');
    expect(() => addDecimal('1e3', '1')).toThrow('invalid_decimal');
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const buckets = view.attribution.dayTokens!;
    expect(buckets.map(bucket => [bucket.day, bucket.currentUsd, bucket.receipts])).toEqual([['2026-09-19', null, 1], ['2026-09-20', '7.750000', 4], ['2026-09-21', '1.500000', 1]]);
    // Every period's USD is exactly the sum of its priced day buckets; its payouts and tokens are the buckets' own.
    for (const period of [...periodOptions(view).map(option => option.period), custom(view, '2026-09-20', '2026-09-21'), custom(view, '2026-09-20', '2026-09-20')]) {
      const inside = buckets.filter(bucket => bucket.day >= period.start && bucket.day <= period.end);
      const summary = periodSummary(view, period)!;
      const priced = inside.flatMap(bucket => bucket.currentUsd === null ? [] : [micro(bucket.currentUsd)]);
      expect(summary.usd === null ? null : micro(summary.usd)).toBe(priced.length ? priced.reduce((sum, value) => sum + value) : null);
      expect(summary.receipts).toBe(inside.reduce((sum, bucket) => sum + bucket.receipts, 0));
      expect(summary.tokens).toBe(new Set(inside.flatMap(bucket => bucket.tokens.map(token => token.key))).size);
    }
    expect(periodSummary(view, defaultPeriod(view))).toEqual({ usd: '9.250000', averageUsd: '1.321429', receipts: 6, tokens: 4, unpricedReceipts: 2, unpricedTokens: 2, activeDays: 3 });
    // Unpriced receipts are counted apart and never valued: a day holding only them reads as having no priced receipts.
    expect(periodSummary(view, custom(view, '2026-09-19', '2026-09-19'))).toEqual({ usd: null, averageUsd: null, receipts: 1, tokens: 1, unpricedReceipts: 1, unpricedTokens: 1, activeDays: 1 });
    expect(periodSummary(view, custom(view, '2026-09-13', '2026-09-15'))).toEqual({ usd: null, averageUsd: null, receipts: 0, tokens: 0, unpricedReceipts: 0, unpricedTokens: 0, activeDays: 0 });
    expect(hero(view, { period: 'custom', from: '2026-09-19', to: '2026-09-19' })).toMatch(/^Attributed No priced receipts 2026-09-19 → 2026-09-19 · 1 day /);
    expect(hero(view, { period: 'custom', from: '2026-09-13', to: '2026-09-15' })).toMatch(/^Attributed No attributed receipts 2026-09-13 → 2026-09-15 · 3 days /);
  });

  it('counts whole UTC days at the edges: the cutoff\'s day, the first tracked day, and either side of midnight', () => {
    const two = twoDayView();
    expect(trackedDays(two)).toEqual({ first: '2026-09-12', last: '2026-09-22', count: 11 });
    // 7D ends on the cutoff's UTC day and holds seven whole calendar days.
    expect(defaultPeriod(two)).toEqual({ id: '7d', start: '2026-09-16', end: '2026-09-22', days: 7 });
    expect(periodCaption(defaultPeriod(two))).toBe('2026-09-16 → 2026-09-22 · 7 days');
    expect(periodSummary(two, defaultPeriod(two))).toMatchObject({ usd: '30.000000', receipts: 5, averageUsd: '4.285714' });
    // The last second of 2026-09-20 belongs to its own day; midnight opens 2026-09-21.
    expect(periodSummary(two, custom(two, '2026-09-21', '2026-09-22'))).toMatchObject({ usd: '18.000000', receipts: 2, activeDays: 1 });
    expect(periodSummary(two, custom(two, '2026-09-20', '2026-09-20'))).toMatchObject({ usd: '12.000000', receipts: 3, activeDays: 1 });
    // A cutoff at midnight ends the day before it; tracking that starts a second before midnight still counts that day.
    const edges = { ...two, trackingStart: MIDNIGHT - 1, cutoff: MIDNIGHT + 2 * 86_400 };
    expect(trackedDays(edges)).toEqual({ first: '2026-09-20', last: '2026-09-22', count: 3 });
    expect(resolvePeriod(edges, {})).toEqual({ period: { id: 'all', start: '2026-09-20', end: '2026-09-22', days: 3 }, notice: null });
    // Earlier history remains, and the days back to the floor would cover 7D.
    expect(resolvePeriod(edges, { period: '7d' }).notice).toBe('7D needs earlier history; load earlier history to enable it; showing ALL.');
    expect(periodSummary(edges, resolvePeriod(edges, {}).period)).toMatchObject({ usd: '30.000000', receipts: 5, averageUsd: '10.000000' });
  });

  it('disables each fixed period until tracked history covers it, saying how many days it needs or to load earlier history', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    expect(periodOptions(view).map(option => [option.label, option.period.start, option.period.end, option.period.days, option.reason])).toEqual([
      ['7D', '2026-09-16', '2026-09-22', 7, null], ['14D', '2026-09-09', '2026-09-22', 14, LOAD_EARLIER_REASON],
      ['30D', '2026-08-24', '2026-09-22', 30, LOAD_EARLIER_REASON], ['60D', '2026-07-25', '2026-09-22', 60, 'needs 60 days of tracked history'],
      ['90D', '2026-06-25', '2026-09-22', 90, 'needs 90 days of tracked history'], ['ALL', '2026-09-12', '2026-09-22', 11, null]]);
    // Exactly as many tracked days as a period needs enables it; one fewer does not.
    const since = (day: string) => ({ ...view, trackingStart: Date.parse(`${day}T12:00:00Z`) / 1000 });
    expect(periodOptions(since('2026-09-09'))[1]!.reason).toBeNull();
    expect(periodOptions(since('2026-09-10'))[1]!.reason).toBe(LOAD_EARLIER_REASON);
    const long = { ...view, trackingStart: CUTOFF - 100 * 86_400 };
    expect(periodOptions(long).map(option => [option.label, option.period.days, option.reason])).toEqual([['7D', 7, null], ['14D', 14, null], ['30D', 30, null],
      ['60D', 60, null], ['90D', 90, null], ['ALL', 101, null]]);
    // Disabled options stay focusable, pressed state is exposed, and each disabled one describes its reason in a tooltip.
    const control = (report: DashboardReport) => renderToStaticMarkup(createElement(PeriodControl, { report, period: defaultPeriod(report), onPeriod: () => undefined }));
    const short = control(view);
    expect(short).toContain('<button type="button" aria-pressed="true">7D</button>');
    expect(short).toContain('<button type="button" aria-pressed="false" aria-disabled="true" aria-describedby="period-reason-60d">60D</button>'
      + '<span class="period-tip" role="tooltip" id="period-reason-60d">needs 60 days of tracked history</span>');
    expect(short.match(/aria-disabled="true"/g)).toHaveLength(4);
    expect(short).not.toContain(' disabled=""');
    expect(textOf(short)).toBe('7D 14D Load earlier history to enable 30D Load earlier history to enable 60D needs 60 days of tracked history '
      + '90D needs 90 days of tracked history ALL CUSTOM');
    expect(control(long)).not.toContain('aria-disabled');
    expect(textOf(control(long))).toBe('7D 14D 30D 60D 90D ALL CUSTOM');
  });

  it('accepts a custom range only of real UTC days inside tracked history, the start on or before the end', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    expect(customPeriod(view, '2026-09-14', '2026-09-18')).toEqual({ period: { id: 'custom', start: '2026-09-14', end: '2026-09-18', days: 5 }, error: null });
    expect(customPeriod(view, '2026-09-22', '2026-09-22')).toEqual({ period: { id: 'custom', start: '2026-09-22', end: '2026-09-22', days: 1 }, error: null });
    expect(customPeriod(view, '2026-09-12', '2026-09-22').period?.days).toBe(11);
    expect(customPeriod(view, '2026-09-18', '2026-09-14')).toEqual({ period: null, error: 'The start must be on or before the end.' });
    for (const [from, to] of [['2026-09-11', '2026-09-14'], ['2026-09-14', '2026-09-23']]) {
      expect(customPeriod(view, from!, to!)).toEqual({ period: null, error: 'Choose days within tracked history, 2026-09-12 → 2026-09-22.' });
    }
    for (const [from, to] of [['', '2026-09-14'], ['2026-09-14', ''], ['2026-02-30', '2026-09-14'], ['2026-9-14', '2026-09-18'], ['2026-09-14', 'soon']]) {
      expect(customPeriod(view, from!, to!)).toEqual({ period: null, error: 'Enter both days as real UTC dates.' });
    }
    expect(['2028-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-9-01'].map(isCalendarDay)).toEqual([true, false, false, false, false, false]);
    // A custom range lives in the hash, reads back unchanged, and a malformed one never passes parsing.
    const range = customPeriod(view, '2026-09-14', '2026-09-18').period!;
    expect(routeHash({ tab: 'overview', params: periodParams(range) })).toBe('#overview?period=custom&from=2026-09-14&to=2026-09-18');
    expect(resolvePeriod(view, parseRoute('#overview?period=custom&from=2026-09-14&to=2026-09-18').params)).toEqual({ period: range, notice: null });
    expect(parseRoute('#overview?period=week&from=14-09-2026&to=<b>')).toEqual({ tab: 'overview', params: {} });
    // One that parses but cannot apply falls back to the default and says why.
    expect(resolvePeriod(view, { period: 'custom', from: '2026-09-18', to: '2026-09-14' }))
      .toEqual({ period: defaultPeriod(view), notice: 'Custom range set aside: The start must be on or before the end. Showing 7D.' });
    expect(resolvePeriod(view, { period: 'custom', to: '2026-09-14' }).notice).toBe('Custom range set aside: Enter both days as real UTC dates. Showing 7D.');
    // The custom inputs are bounded to tracked history and open with the applied range.
    const html = renderToStaticMarkup(createElement(PeriodControl, { report: view, period: range, onPeriod: () => undefined }));
    expect(html).toContain('<input type="date" min="2026-09-12" max="2026-09-22" value="2026-09-14"/>');
    expect(html).toContain('<input type="date" min="2026-09-12" max="2026-09-22" value="2026-09-18"/>');
    expect(html).toContain('<button type="button" aria-pressed="true">CUSTOM</button>');
    expect(textOf(html)).toContain('From · UTC To · UTC Tracked history 2026-09-12 → 2026-09-22');
  });

  it('divides the daily average by every calendar day of the period, active or not', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const average = (period: Period) => periodSummary(view, period)!.averageUsd;
    const all = resolvePeriod(view, { period: 'all' }).period;
    expect([defaultPeriod(view).days, all.days, custom(view, '2026-09-20', '2026-09-21').days]).toEqual([7, 11, 2]);
    // The same 9.25 over 7, 11 and 2 days; three of those days hold receipts.
    expect([average(defaultPeriod(view)), average(all), average(custom(view, '2026-09-20', '2026-09-21'))]).toEqual(['1.321429', '0.840909', '4.625000']);
    expect(periodSummary(view, all)!.activeDays).toBe(3);
    // Here 7D and the report's rolling 168 hours hold the same receipts, so the exact averages agree.
    expect(average(defaultPeriod(view))).toBe(view.attribution.rolling168h!.dailyAverageUsd);
    // Round half up at the sixth place, exactly: floating point would lose these.
    expect([divideDecimal('0.000005', 10), divideDecimal('0.000004', 10), divideDecimal('12.000006', 12), divideDecimal('100', 3), divideDecimal('200', 3)])
      .toEqual(['0.000001', '0.000000', '1.000001', '33.333333', '66.666667']);
    expect(() => divideDecimal('1', 0)).toThrow('invalid_divisor');
  });

  it('reads the period from the hash and sets aside one that tracked history cannot cover', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    expect(resolvePeriod(view, {})).toEqual({ period: { id: '7d', start: '2026-09-16', end: '2026-09-22', days: 7 }, notice: null });
    expect(resolvePeriod(view, { period: 'all' })).toEqual({ period: { id: 'all', start: '2026-09-12', end: '2026-09-22', days: 11 }, notice: null });
    expect(resolvePeriod(view, { period: '30d' })).toEqual({ period: defaultPeriod(view), notice: '30D needs earlier history; load earlier history to enable it; showing 7D.' });
    expect(routeHash({ tab: 'overview', params: periodParams(defaultPeriod(view)) })).toBe('#overview?period=7d');
    expect(parseRoute('#overview?period=90d')).toEqual({ tab: 'overview', params: { period: '90d' } });
    const long = { ...view, trackingStart: CUTOFF - 100 * 86_400 };
    expect(resolvePeriod(long, { period: '90d' })).toEqual({ period: { id: '90d', start: '2026-06-25', end: '2026-09-22', days: 90 }, notice: null });
    // The overview shows why it set a linked period aside.
    const overview = renderToStaticMarkup(createElement(Overview, { report: view, params: { period: '60d' } }));
    expect(overview).toContain('<p class="period-notice" role="status">60D needs 60 days of tracked history; showing 7D.</p>');
  });

  it('recomputes the hero figures and redraws the chart together for the selected period', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const week = panel(view, defaultPeriod(view));
    expect(week.hero).toBe('Attributed $9.25 2026-09-16 → 2026-09-22 · 7 days Priced receipts only · UTC calendar days '
      + 'Payouts 6 Tokens 4 Daily average $1.32 Unpriced · excluded from USD 2 receipts');
    expect(week.days).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
    expect(week.axis).toEqual(['09-16', '09-17', '09-18', '09-19', '09-20', '09-21', '09-22']);
    const day = panel(view, custom(view, '2026-09-20', '2026-09-20'));
    expect(day.hero).toBe('Attributed $7.75 2026-09-20 → 2026-09-20 · 1 day Priced receipts only · UTC calendar days '
      + 'Payouts 4 Tokens 3 Daily average $7.75 Unpriced · excluded from USD 1 receipt');
    expect(day.days).toEqual(['2026-09-20']);
    expect(day.axis).toEqual(['09-20']);
    const all = panel(view, resolvePeriod(view, { period: 'all' }).period);
    expect(all.hero).toContain('$9.25 2026-09-12 → 2026-09-22 · 11 days');
    expect(all.axis).toHaveLength(11);
    // Verified follows the same period on its own scale and is never added: verified $6.00 on 2026-09-22 stays out of $9.25.
    expect(textOf(chartSvgs(week.html)[1]!)).toContain('2026-09-22 UTC: $6.00');
    expect(chartSvgs(day.html)).toHaveLength(1);
    for (const html of [week.html, day.html, all.html]) for (const combined of ['$15.25', '15.250000', '$13.75']) expect(html).not.toContain(combined);
    // A long period labels every few days so the labels never overlap; an empty custom day keeps the panel and adds no list under it.
    const long = { ...view, trackingStart: CUTOFF - 100 * 86_400 };
    expect(panel(long, resolvePeriod(long, { period: '90d' }).period).axis.length).toBeLessThan(90);
    const empty = renderToStaticMarkup(createElement(Overview, { report: view, params: { period: 'custom', from: '2026-09-19', to: '2026-09-19' } }));
    expect(textOf(empty)).toContain('No priced receipts 2026-09-19 → 2026-09-19 · 1 day');
    expect(empty).not.toContain('Top tokens');
  });

  it('explains period figures behind the info button, beside the report\'s rolling 168-hour figure for reference', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const text = visible(createElement(AttributedDetails, { report: view, period: defaultPeriod(view) }));
    expect(text).toContain(`${view.attribution.explanation} Period figures are sums of the report's UTC calendar-day buckets, added exactly, each day as the report `
      + 'rounds it; the daily average divides by the period\'s 7 calendar days. The first tracked day starts at tracking start, 2026-09-12 18:00 UTC, and the last '
      + 'ends at the fixed cutoff, 2026-09-22 18:00 UTC.');
    expect(text).toContain('Report · rolling 168 hours $9.25 Its daily average · ÷ 7 $1.32 Report · since tracking start $9.25 Rows · all tracked days 6 '
      + 'Priced tokens 2 of 4');
    expect(visible(createElement(AttributedDetails, { report: view, period: custom(view, '2026-09-20', '2026-09-20') }))).toContain('divides by the period\'s 1 calendar day.');
    const unevaluated = visible(createElement(AttributedDetails, { report: unevaluatedView('schema v4'), period: defaultPeriod(view) }));
    expect(unevaluated).toContain('Saved rows predate classifier v3 or await an attribution recheck.');
    expect(unevaluated).not.toMatch(/Period figures|rolling 168|\$0/);
  });
});

describe('payouts tab: filters, pages and evidence', () => {
  it('filters receipts by day, token, trust source and price, combined', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const receipts = view.attribution.receipts!;
    const symbols = (filters: ReceiptFilters) => filterReceipts(receipts, filters).map(receipt => receipt.symbol);
    expect(symbols({})).toEqual(['DUAL', 'QUOTE', 'DUAL', 'THIRD', 'QUOTE', 'SECOND']);
    expect(symbols({ token: `${DUAL_MINT}:6` })).toEqual(['DUAL', 'DUAL']);
    expect(symbols({ trust: 'published_withdraw_authority' })).toEqual(['SECOND']);
    expect(symbols({ trust: 'feed_witnessed_identity', price: 'unpriced' })).toEqual(['THIRD']);
    expect(symbols({ price: 'priced' })).toEqual(['DUAL', 'QUOTE', 'DUAL', 'QUOTE']);
    expect(symbols({ day: '2026-09-20', token: `${MINT}:6` })).toEqual(['QUOTE', 'QUOTE']);
    expect(symbols({ day: '2026-09-18' })).toEqual([]);
  });

  it('lists receipts newest first with sender, trust and USD, and every filter option from the data', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const html = renderToStaticMarkup(createElement(PayoutsTab, { report: view, filters: {}, setFilters: () => undefined, openReceipt: () => undefined }));
    expect(textOf(html.split('<thead>')[1]!.split('</thead>')[0]!)).toBe('Date · UTC ▼ Token Amount USD ↕ Sender Trust');
    const rows = tableRows(html.split('<table class="receipt-table">')[1]!);
    expect(rows).toEqual([`2026-09-21 17:51 UTC $DUAL DUAL-ROLE 1.000000 $1.50 ${short(DISTRIBUTOR)} Feed-witnessed distributor`,
      `2026-09-20 18:10 UTC $QUOTE 1.500000 $3.00 ${short(DISTRIBUTOR)} Feed-witnessed distributor`,
      `2026-09-20 18:10 UTC $DUAL DUAL-ROLE 0.500000 $0.75 ${short(DISTRIBUTOR)} Feed-witnessed distributor`,
      `2026-09-20 18:10 UTC $THIRD 4.000000 Unpriced ${short(DISTRIBUTOR)} Feed-witnessed distributor`,
      `2026-09-20 18:00 UTC $QUOTE 2.000000 $4.00 ${short(DISTRIBUTOR)} Feed-witnessed distributor`,
      `2026-09-19 18:00 UTC $SECOND 7.000000 Unpriced ${short(OTHER_DISTRIBUTOR)} Published withdraw authority`]);
    expect(html).toContain(`<abbr class="sender" title="${OTHER_DISTRIBUTOR}">`);
    expect(html.match(/<button type="button" class="row-open" aria-label="[^"]+: open evidence">/g)).toHaveLength(6);
    const options = (name: string) => [...html.split(`<span>${name}</span>`)[1]!.split('</select>')[0]!.matchAll(/<option value="([^"]*)"(?: selected="")?>([^<]*)<\/option>/g)].map(match => match[2]);
    expect(options('Day · UTC')).toEqual(['All', '2026-09-21', '2026-09-20', '2026-09-19']);
    expect(options('Token')).toEqual(['All', `$DUAL · ${short(DUAL_MINT)}`, `$QUOTE · ${short(MINT)}`, `$SECOND · ${short(SECOND_MINT)}`, `$THIRD · ${short(THIRD_MINT)}`]);
    expect(options('Trust source')).toEqual(['All', 'Feed-witnessed distributor', 'Published withdraw authority']);
    expect(options('Price')).toEqual(['All', 'Priced', 'Unpriced']);
    expect(textOf(html)).toContain('Showing 1–6 of 6 receipts');
    expect(html).toContain('<button type="button" class="clear-filters" disabled="">Clear filters</button>');
    // Unknown, excluded and verified rows never enter the list, and nothing adds verified to attributed.
    for (const combined of ['5.000000', '$10.00', '$11.50', '10.000000']) expect(html).not.toContain(combined);
  });

  it('shows fifty receipts at a time, says how many match, and explains an empty filter', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const base = view.attribution.receipts![1]!;
    const many = Array.from({ length: 120 }, (_, index) => ({ ...base, id: `${base.signature!}:${index}` }));
    const crowded = { ...view, attribution: { ...view.attribution, receipts: many, receiptsComplete: false } };
    const html = renderToStaticMarkup(createElement(PayoutsTab, { report: crowded, filters: {}, setFilters: () => undefined, openReceipt: () => undefined }));
    expect(tableRows(html.split('<table class="receipt-table">')[1]!)).toHaveLength(PAGE_SIZE);
    expect(textOf(html)).toContain('Showing 1–50 of 120 receipts · the list holds the newest 120 of 6 attributed rows');
    expect(textOf(html)).toContain('Show 50 more');
    const empty = renderToStaticMarkup(createElement(PayoutsTab, { report: view, filters: { day: '2026-09-18' }, setFilters: () => undefined, openReceipt: () => undefined }));
    expect(textOf(empty)).toContain('No receipts match these filters. · filtered from 6');
    expect(empty).not.toContain('receipt-table');
    // The requested day stays selectable even with no receipts listed on it.
    expect(empty).toContain('<option value="2026-09-18" selected="">2026-09-18</option>');
  });

  it('sorts payouts by date or by exact USD, unpriced and unknown times last in either direction, and breaks ties newest first', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const receipts = view.attribution.receipts!;
    const base = receipts[1]!;
    // An equal-USD receipt an hour older, and an unpriced one with no block time.
    const all = [...receipts, { ...base, id: 'older-tie', time: base.time! - 3600 }, { ...base, id: 'no-time', symbol: 'NOTIME', time: null, currentUsd: null }];
    const order = (sort: ReceiptSort) => sortReceipts(all, sort).map(receipt => `${receipt.symbol} ${receipt.currentUsd === null ? 'unpriced' : usd(receipt.currentUsd)} ${receipt.time === null ? 'unknown' : utc(receipt.time).slice(5, 16)}`);
    expect(order(DEFAULT_RECEIPT_SORT)).toEqual(['DUAL $1.50 09-21 17:51', 'QUOTE $3.00 09-20 18:10', 'DUAL $0.75 09-20 18:10', 'THIRD unpriced 09-20 18:10',
      'QUOTE $4.00 09-20 18:00', 'QUOTE $3.00 09-20 17:10', 'SECOND unpriced 09-19 18:00', 'NOTIME unpriced unknown']);
    expect(order({ key: 'date', direction: 'ascending' })).toEqual(['SECOND unpriced 09-19 18:00', 'QUOTE $3.00 09-20 17:10', 'QUOTE $4.00 09-20 18:00',
      'QUOTE $3.00 09-20 18:10', 'DUAL $0.75 09-20 18:10', 'THIRD unpriced 09-20 18:10', 'DUAL $1.50 09-21 17:51', 'NOTIME unpriced unknown']);
    expect(order({ key: 'usd', direction: 'descending' })).toEqual(['QUOTE $4.00 09-20 18:00', 'QUOTE $3.00 09-20 18:10', 'QUOTE $3.00 09-20 17:10', 'DUAL $1.50 09-21 17:51',
      'DUAL $0.75 09-20 18:10', 'THIRD unpriced 09-20 18:10', 'SECOND unpriced 09-19 18:00', 'NOTIME unpriced unknown']);
    expect(order({ key: 'usd', direction: 'ascending' })).toEqual(['DUAL $0.75 09-20 18:10', 'DUAL $1.50 09-21 17:51', 'QUOTE $3.00 09-20 18:10', 'QUOTE $3.00 09-20 17:10',
      'QUOTE $4.00 09-20 18:00', 'THIRD unpriced 09-20 18:10', 'SECOND unpriced 09-19 18:00', 'NOTIME unpriced unknown']);
    // Exact decimal order, never text order: 10.5 above 9.99 and 2.
    const priced = ['9.99', '10.5', '2'].map((value, index) => ({ ...base, id: `p${index}`, currentUsd: value }));
    expect(sortReceipts(priced, { key: 'usd', direction: 'descending' }).map(receipt => receipt.currentUsd)).toEqual(['10.5', '9.99', '2']);
    expect(all.map(receipt => receipt.id).slice(-2)).toEqual(['older-tie', 'no-time']);
    // The hash keeps any sort but the default, and drops a malformed one.
    expect(receiptSortParam(DEFAULT_RECEIPT_SORT)).toBeNull();
    expect(receiptSortParam({ key: 'usd', direction: 'ascending' })).toBe('usd-asc');
    expect(parseRoute(routeHash({ tab: 'payouts', params: { day: '2026-09-20', sort: 'usd-asc' } }))).toEqual({ tab: 'payouts', params: { day: '2026-09-20', sort: 'usd-asc' } });
    expect(parseRoute('#payouts?sort=usd-sideways').params).toEqual({});
    expect([parseReceiptSort(undefined), parseReceiptSort('date-asc'), parseReceiptSort('usd-desc')]).toEqual([DEFAULT_RECEIPT_SORT,
      { key: 'date', direction: 'ascending' }, { key: 'usd', direction: 'descending' }]);
    expect(['date-desc', 'date-asc', 'usd-desc', 'usd-asc'].map(value => receiptSortText(parseReceiptSort(value)))).toEqual(['NEWEST FIRST', 'OLDEST FIRST',
      'HIGHEST USD FIRST · UNPRICED LAST', 'LOWEST USD FIRST · UNPRICED LAST']);
  });

  it('sorts all 120 filtered payouts before cutting the first page, and the caption and headers follow the sort', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const base = view.attribution.receipts![1]!;
    // Newest first, receipt i is worth $i, and every tenth is unpriced: the highest values are the oldest, far past the first page.
    const many = Array.from({ length: 120 }, (_, index) => ({ ...base, id: `${base.signature!}:${index}`, time: base.time! - index * 60,
      currentUsd: index % 10 === 0 ? null : `${index}.000000` }));
    const crowded = { ...view, attribution: { ...view.attribution, receipts: many, receiptsComplete: false } };
    const render = (sort: ReceiptSort) => renderToStaticMarkup(createElement(PayoutsTab, { report: crowded, filters: {}, setFilters: () => undefined, openReceipt: () => undefined, sort }));
    const usdColumn = (html: string) => tableRows(html.split('<table class="receipt-table">')[1]!).map(row => /(\$[\d,.]+|Unpriced)/.exec(row.split(' UTC ')[1]!)![1]);
    const highest = render({ key: 'usd', direction: 'descending' });
    expect(usdColumn(highest)).toHaveLength(PAGE_SIZE);
    expect(usdColumn(highest).slice(0, 3)).toEqual(['$119.00', '$118.00', '$117.00']);
    expect(usdColumn(highest)).not.toContain('Unpriced');
    expect(textOf(highest)).toContain('HIGHEST USD FIRST · UNPRICED LAST · EACH OPENS ITS EVIDENCE');
    expect(highest).toContain('<th class="numeric" aria-sort="descending"><button type="button" class="sort">USD<span aria-hidden="true"> ▼</span></button></th>');
    expect(highest).toContain('<th aria-sort="none"><button type="button" class="sort">Date · UTC<span aria-hidden="true"> ↕</span></button></th>');
    const lowest = render({ key: 'usd', direction: 'ascending' });
    expect(usdColumn(lowest).slice(0, 3)).toEqual(['$1.00', '$2.00', '$3.00']);
    expect(textOf(lowest)).toContain('LOWEST USD FIRST · UNPRICED LAST');
    const oldest = render({ key: 'date', direction: 'ascending' });
    expect(tableRows(oldest.split('<table class="receipt-table">')[1]!)[0]).toContain('$119.00');
    expect(textOf(oldest)).toContain('OLDEST FIRST · EACH OPENS ITS EVIDENCE');
  });
});

describe('dashboard projections: day-by-token buckets, receipts, token details and trust identities', () => {
  const busySig = signatureOf(attributedTransactions.busy);
  it('buckets each attributed UTC day by mint from the report, highest USD first and unpriced last', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const days = view.attribution.dayTokens!;
    expect(days.map(day => [day.day, day.currentUsd, day.unpricedCount, day.receipts])).toEqual([
      ['2026-09-19', null, 1, 1], ['2026-09-20', '7.750000', 1, 4], ['2026-09-21', '1.500000', 0, 1]]);
    // Each day's figures are the report's own bucket: the same USD the chart's day series carries.
    expect(days.map(day => day.currentUsd)).toEqual(view.attribution.utcDays!.map(day => day.currentUsd));
    expect(days[1]!.tokens.map(token => [token.symbol, token.amount, token.currentUsd, token.receipts])).toEqual([
      ['QUOTE', '3.500000', '7.000000', 2], ['DUAL', '0.500000', '0.750000', 1], ['THIRD', '4.000000', null, 1]]);
    expect(days[1]!.tokens.map(token => token.key)).toEqual([`${MINT}:6`, `${DUAL_MINT}:6`, `${THIRD_MINT}:6`]);
    expect(days[0]!.tokens).toEqual([{ key: `${SECOND_MINT}:6`, mint: SECOND_MINT, mintAddress: SECOND_MINT, symbol: 'SECOND', decimals: 6, raw: '7000000', amount: '7.000000', currentUsd: null, receipts: 1,
      priceAt: null, priceAgeSeconds: null, priceStale: null }]);
    expect(days[1]!.tokens[0]).toMatchObject({ priceAt: iso(CUTOFF), priceAgeSeconds: 0, priceStale: false });
    // The verified receipt of the same mint on 2026-09-22 never enters an attributed bucket.
    expect(days.map(day => day.day)).not.toContain('2026-09-22');
  });

  it('lists every attributed receipt newest first with its own current value and full evidence', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET)); const txs = attributedTransactions;
    const receipts = view.attribution.receipts!;
    expect(view.attribution.receiptsComplete).toBe(true);
    expect(receipts.map(row => [row.id, row.symbol, row.amount, row.currentUsd, row.day])).toEqual([
      [`${signatureOf(txs.dual)}:0`, 'DUAL', '1.000000', '1.500000', '2026-09-21'],
      [`${busySig}:0`, 'QUOTE', '1.500000', '3.000000', '2026-09-20'],
      [`${busySig}:1`, 'DUAL', '0.500000', '0.750000', '2026-09-20'],
      [`${busySig}:2`, 'THIRD', '4.000000', null, '2026-09-20'],
      [`${signatureOf(txs.feed)}:0`, 'QUOTE', '2.000000', '4.000000', '2026-09-20'],
      [`${signatureOf(txs.published)}:0`, 'SECOND', '7.000000', null, '2026-09-19']]);
    const busy = receipts[1]!;
    expect(busy).toMatchObject({ signature: busySig, evidenceLink: link(txs.busy), time: CUTOFF - 172_200, asset: `${MINT}:6`, mint: MINT, mintAddress: MINT,
      decimals: 6, netRaw: '1500000' });
    expect(busy.attribution).toMatchObject({ lane: 'token', trustSources: ['feed_witnessed_identity'], sourceOwner: DISTRIBUTOR, sourceAta: ata(DISTRIBUTOR, MINT),
      // Each mint leaves its own associated token account, so each source carries one transfer.
      witnessCount: 3, batch: { outerTransfersFromSource: 1, transfersFromSource: 1, distinctRecipientOwners: 1 } });
    // Receipts carry the same evidence as the bounded evidence panel, row for row.
    expect(receipts.map(row => row.attribution)).toEqual(view.attributedEvidence.map(row => row.attribution));
    expect(receipts.every(row => row.attribution?.sourceOwner && row.attribution.sourceAta)).toBe(true);
    // Unknown, excluded and verified rows never appear among the receipts.
    const listed = new Set(receipts.map(row => row.signature));
    for (const tx of [txs.unknown, txs.signed, txs.verified, txs.verifiedUnpriced]) expect(listed.has(signatureOf(tx))).toBe(false);
  });

  it('keeps each token detail list to that token, newest first, beside the report figures', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET)); const txs = attributedTransactions;
    const details = view.attribution.tokenDetails!;
    expect(details.map(item => item.key)).toEqual(view.attribution.assets!.map(asset => `${asset.mint}:${asset.decimals}`));
    const byKey = new Map(details.map(item => [item.mint, item]));
    expect(byKey.get(MINT)).toEqual({ key: `${MINT}:6`, mint: MINT, decimals: 6, mintAddress: MINT, tokenLink: `https://solscan.io/token/${MINT}`,
      receipts: 2, receiptIds: [`${busySig}:0`, `${signatureOf(txs.feed)}:0`], firstReceiptTime: CUTOFF - 172_800 });
    expect(byKey.get(DUAL_MINT)?.receiptIds).toEqual([`${signatureOf(txs.dual)}:0`, `${busySig}:1`]);
    expect(byKey.get(THIRD_MINT)).toMatchObject({ receipts: 1, receiptIds: [`${busySig}:2`], firstReceiptTime: CUTOFF - 172_200 });
    expect(byKey.get(SECOND_MINT)).toMatchObject({ receipts: 1, receiptIds: [`${signatureOf(txs.published)}:0`], firstReceiptTime: CUTOFF - 259_200 });
    for (const item of details) expect(item.receiptIds).toHaveLength(item.receipts);
  });

  it('groups attributed rows by sending identity with witnesses, snapshot times and full addresses', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET)); const txs = attributedTransactions;
    expect(view.attribution.identities).toEqual([
      { owner: DISTRIBUTOR, accountLink: `https://solscan.io/account/${DISTRIBUTOR}`, rows: 5, tokens: 3, trustSources: ['feed_witnessed_identity'],
        rowsBySource: { feed_witnessed_identity: 5, published_withdraw_authority: 0 }, firstReceiptTime: CUTOFF - 172_800, lastReceiptTime: CUTOFF - 86_900,
        witnesses: { countMin: 3, countMax: 3, firstTime: CUTOFF - 4000, firstLink: link(txs.verifiedUnpriced), lastTime: CUTOFF - 1000, lastLink: link(txs.witness) },
        snapshots: [] },
      { owner: OTHER_DISTRIBUTOR, accountLink: `https://solscan.io/account/${OTHER_DISTRIBUTOR}`, rows: 1, tokens: 1, trustSources: ['published_withdraw_authority'],
        rowsBySource: { feed_witnessed_identity: 0, published_withdraw_authority: 1 }, firstReceiptTime: CUTOFF - 259_200, lastReceiptTime: CUTOFF - 259_200,
        witnesses: null, snapshots: [{ retrievedAt: iso(CUTOFF - 100), rows: 1 }] },
    ]);
    // Identity row counts partition the attributed rows; the report's own basis counts agree.
    expect(view.attribution.identities!.reduce((sum, item) => sum + item.rows, 0)).toBe(view.attribution.rows);
    expect(view.attribution.basisCounts).toMatchObject({ feed_witnessed_identity: 5, published_withdraw_authority: 1 });
    expect(view.attribution.conflicts).toEqual({ rows: 0, revokedRows: 0, owners: [] });
    expect(view.excludedReasons).toEqual([{ reason: 'wallet_participation', count: 1 }]);
  });

  it('lists identity conflicts from the rows they refused, and drops the conflicted identity from the trusted list', () => {
    const store = attributedStore(); const txs = attributedTransactions;
    const contradicted = payout({ label: 'dashboard-contradicted', time: CUTOFF - 700, legs: legs(200) });
    store.addTransaction(network, contradicted, { source: 'fixture', evidenceId: 'synthetic-dashboard', retrievedAt: iso(CUTOFF), commitment: 'finalized' });
    store.addFeed(officialFeed(contradicted, { evidenceId: 'contradicting-feed', amountRaw: '1' }));
    drain(store);
    const view = reportView(buildReport(store, WALLET));
    expect(view.attribution).toMatchObject({ evaluated: true, rows: 1, conflicts: { rows: 2, revokedRows: 0,
      owners: [{ owner: DISTRIBUTOR, rows: 2, lastTime: CUTOFF - 86_900, evidenceLink: link(txs.dual) }] } });
    expect(view.attribution.identities?.map(item => item.owner)).toEqual([OTHER_DISTRIBUTOR]);
    expect(view.attribution.receipts?.map(row => row.symbol)).toEqual(['SECOND']);
  });

  it('is null, never empty or zero, while the attributed tier is not evaluated', () => {
    const view = unevaluatedView('v5 rows before reclassification');
    expect(view.attribution).toMatchObject({ dayTokens: null, receipts: null, receiptsComplete: null, tokenDetails: null, identities: null,
      conflicts: { rows: 0, revokedRows: 0, owners: [] } });
  });
});

describe('tokens tab: search, exact sorting, detail drawer and copy', () => {
  it('sorts every column exactly, keeping unpriced tokens after priced ones in both USD directions', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const assets = view.attribution.assets!;
    const order = (sort: TokenSort) => sortTokens(assets, sort).map(asset => asset.symbol);
    expect(order({ key: 'usd', direction: 'descending' })).toEqual(['QUOTE', 'DUAL', 'SECOND', 'THIRD']);
    expect(order({ key: 'usd', direction: 'ascending' })).toEqual(['DUAL', 'QUOTE', 'SECOND', 'THIRD']);
    // Quantities compare as exact decimals: 7.000000 > 4.000000 > 3.500000 > 1.500000.
    expect(order({ key: 'quantity', direction: 'descending' })).toEqual(['SECOND', 'THIRD', 'QUOTE', 'DUAL']);
    expect(order({ key: 'receipts', direction: 'descending' })).toEqual(['DUAL', 'QUOTE', 'SECOND', 'THIRD']);
    expect(order({ key: 'last', direction: 'descending' })).toEqual(['DUAL', 'QUOTE', 'THIRD', 'SECOND']);
    expect(order({ key: 'symbol', direction: 'ascending' })).toEqual(['DUAL', 'QUOTE', 'SECOND', 'THIRD']);
    const wide = [{ ...assets[0]!, symbol: 'A', amount: '10.000000' }, { ...assets[0]!, symbol: 'B', amount: '9.999999' }, { ...assets[0]!, symbol: 'C', amount: '100.0' }];
    expect(sortTokens(wide, { key: 'quantity', direction: 'ascending' }).map(asset => asset.symbol)).toEqual(['B', 'A', 'C']);
  });

  it('searches symbol, name and mint without regard to case', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    const assets = view.attribution.assets!;
    expect(filterTokens(assets, '').map(asset => asset.symbol).sort()).toEqual(['DUAL', 'QUOTE', 'SECOND']);
    expect(filterTokens(assets, '  dua ').map(asset => asset.symbol)).toEqual(['DUAL']);
    expect(filterTokens(assets, SECOND_MINT.slice(10, 20).toLowerCase()).map(asset => asset.symbol)).toEqual(['SECOND']);
    expect(filterTokens(assets, 'no such token')).toEqual([]);
  });

  it('marks the sorted column and opens the selected token as a drawer', () => {
    const view = reportView(buildReport(attributedStore(), WALLET));
    const closed = renderToStaticMarkup(createElement(TokensTab, { report: view, open: () => undefined, close: () => undefined }));
    const head = closed.split('<table class="token-table">')[1]!.split('</thead>')[0]!;
    expect([...head.matchAll(/<th( class="numeric")?( aria-sort="(\w+)")?>/g)].map(match => match[3] ?? null))
      .toEqual(['none', 'none', 'descending', 'none', 'none', null, null]);
    expect(closed).toContain('<span class="sr-only">Search tokens</span><input type="search"');
    expect(closed.match(/<button type="button" class="row-open" aria-label="[^"]+: open token detail">/g)).toHaveLength(3);
    expect(closed).not.toContain('<dialog');
    const open = renderToStaticMarkup(createElement(TokensTab, { report: view, selected: `${DUAL_MINT}:6`, open: () => undefined, close: () => undefined }));
    expect(open).toContain('<tr class="is-selected">');
    expect(open.match(/<dialog class="sheet drawer" aria-labelledby="token-drawer-title">/g)).toHaveLength(1);
    // An unknown or malformed selection opens nothing.
    expect(renderToStaticMarkup(createElement(TokensTab, { report: view, selected: `${syntheticKey('absent')}:6`, open: () => undefined, close: () => undefined })))
      .not.toContain('<dialog');
  });

  it('shows the full mint with copy and Solscan, the figures, trust wording and that token\'s receipts newest first', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET)); const txs = attributedTransactions;
    const asset = view.attribution.assets!.find(item => item.mint === MINT)!;
    const html = renderToStaticMarkup(createElement(TokenDrawer, { report: view, asset, onClose: () => undefined }));
    expect(html).toContain(`<code class="address">${MINT}</code>`);
    expect(html).toContain('<button type="button" class="copy-button idle" aria-label="Copy mint address">Copy</button>');
    expect(html).toContain(`href="https://solscan.io/token/${MINT}" target="_blank" rel="noreferrer">Solscan ↗</a>`);
    const text = textOf(html);
    expect(text).toMatch(new RegExp(`^Attributed \\$QUOTE ${MINT} × Mint address ${MINT} Copy Solscan ↗ Quantity 3\\.500000 Current USD \\$7\\.00 `
      + 'Receipts 2 First receipt 2026-09-20 18:00 UTC Last receipt 2026-09-20 18:10 UTC Saved price 2026-09-22 18:00 UTC Trust sources '));
    expect(text).toContain(`Feed-witnessed distributor ${view.attribution.trustSources.feed_witnessed_identity.explanation}`);
    const rows = html.split('<ol class="receipt-list">')[1]!.split('</ol>')[0]!.split('</li>').filter(Boolean);
    expect(rows.map(textOf)).toEqual([`2026-09-20 18:10 UTC 1.500000 $3.00 ${short(DISTRIBUTOR)} Evidence ↗`,
      `2026-09-20 18:00 UTC 2.000000 $4.00 ${short(DISTRIBUTOR)} Evidence ↗`]);
    // The sender is abbreviated in this list with its full address on hover; the evidence links go to each receipt.
    for (const row of rows) expect(row).toContain(`<abbr class="sender" title="${DISTRIBUTOR}">`);
    expect(rows[0]).toContain(link(txs.busy)); expect(rows[1]).toContain(link(txs.feed));
    expect(text).not.toContain('receipts listed');
    // Receipts can open their evidence when the caller offers it.
    expect(renderToStaticMarkup(createElement(TokenDrawer, { report: view, asset, onClose: () => undefined, onReceipt: () => undefined })))
      .toContain('<button type="button" class="link-button">2026-09-20 18:10 UTC</button>');
    // The native-SOL sentinel is not an address: no copy button and no Solscan link.
    const native = { ...view, attribution: { ...view.attribution, tokenDetails: view.attribution.tokenDetails!.map(item => item.mint === MINT ? { ...item, mintAddress: null, tokenLink: null } : item) } };
    const sentinel = renderToStaticMarkup(createElement(TokenDrawer, { report: native, asset, onClose: () => undefined }));
    expect(textOf(sentinel)).toContain('Mint address Native SOL · no mint address');
    expect(sentinel).not.toContain('Copy mint address');
  });

  it('marks a stale saved price with its age in the token table, the drawer and the period figure\'s popover', () => {
    const store = attributedStore(database(), { busy: true });
    const taken = CUTOFF - 3 * 86400;
    store.savePrice(network, { mint: SECOND_MINT, currency: 'USD', value: '0.25', provider: 'fixture', observedAt: iso(taken), retrievedAt: iso(taken), expiresAt: 0, reason: null });
    // A later lookup that found no price never hides the saved one.
    store.savePrice(network, { mint: SECOND_MINT, currency: 'USD', value: null, provider: 'helius', observedAt: null, retrievedAt: iso(CUTOFF - 60), expiresAt: 0, reason: 'no_valid_usd_price' });
    const view = reportView(buildReport(store, WALLET));
    const second = view.attribution.assets!.find(asset => asset.mint === SECOND_MINT)!;
    expect(second).toMatchObject({ currentUsd: '1.750000', priceAt: iso(taken), priceAgeSeconds: 259_200, priceStale: true });
    expect([staleText(second), staleText({ priceStale: true, priceAgeSeconds: 86_401 }), staleText({ priceStale: false, priceAgeSeconds: 0 })])
      .toEqual(['stale · 3.0 d', 'stale · 24 h', null]);
    const table = renderToStaticMarkup(createElement(TokensTab, { report: view, open: () => undefined, close: () => undefined }));
    const row = table.split('<tr').find(part => part.includes('$SECOND'))!;
    expect(textOf(`<tr${row}`)).toContain('PRICED stale · 3.0 d');
    expect(row).toContain(`title="Saved price: ${utc(taken)} · stale · 3.0 d"`);
    // Only the stale token carries the label.
    expect(table.match(/class="stale-label"/g)).toHaveLength(1);
    const drawer = renderToStaticMarkup(createElement(TokenDrawer, { report: view, asset: second, onClose: () => undefined }));
    expect(textOf(drawer)).toContain(`Saved price ${utc(taken)} · stale · 3.0 d`);
    const all = periodOptions(view).at(-1)!.period;
    const popover = visible(createElement(AttributedDetails, { report: view, period: all }));
    expect(popover).toContain(`Saved prices ${utc(taken)} → ${utc(CUTOFF)}. Each token is valued at its most recent saved price; one taken more than 24 hours before the cutoff is marked stale.`);
    expect(popover).toContain(`$SECOND stale · 3.0 d ${utc(taken)}`);
    // A period without that token's days has no stale price.
    const recent = customPeriod(view, '2026-09-20', '2026-09-22').period!;
    expect(visible(createElement(AttributedDetails, { report: view, period: recent }))).toContain(`Saved prices ${utc(CUTOFF)}. Each token`);
    expect(visible(createElement(AttributedDetails, { report: view, period: recent }))).toContain('No stale prices in this period.');
  });

  it('copies through the clipboard API and reports failure instead of pretending', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText(MINT)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(MINT);
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    await expect(copyText(MINT)).resolves.toBe('failed');
    vi.stubGlobal('navigator', {});
    await expect(copyText(MINT)).resolves.toBe('failed');
    expect(renderToStaticMarkup(createElement(CopyButton, { value: MINT, label: 'source owner' })))
      .toBe('<button type="button" class="copy-button idle" aria-label="Copy source owner">Copy</button><span class="sr-only" role="status"></span>');
  });
});

describe('trust and coverage tabs', () => {
  it('names each trust source in the report\'s words with the identities behind it in full, their counts, witnesses and snapshots', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET)); const txs = attributedTransactions;
    const html = renderToStaticMarkup(createElement(Trust, { report: view }));
    const text = textOf(html);
    expect(text).toContain(`Where these numbers come from ${view.attribution.explanation} 6 attributed rows from 2 sending identities, each listed in full under the source that trusts it.`);
    const articles = [...html.matchAll(/<article class="trust-source (\w+)" aria-label="([^"]*)">([\s\S]*?)<\/article>/g)];
    expect(articles.map(match => [match[1], match[2]])).toEqual([['feed_witnessed_identity', 'Feed-witnessed distributor'], ['published_withdraw_authority', 'Published withdraw authority']]);
    const [feed, published] = articles.map(match => match[3]!);
    expect(textOf(feed!)).toBe(`Feed-witnessed distributor · 5 ${view.attribution.trustSources.feed_witnessed_identity.explanation} `
      + `${DISTRIBUTOR} Copy Solscan ↗ Attributed rows 5 Rows through this source 5 Tokens 3 Receipts span ${utc(CUTOFF - 172_800)} → ${utc(CUTOFF - 86_900)} `
      + `Witnessed in 3 official StonkFun distributions retained here · first ${utc(CUTOFF - 4000)} ↗ · last ${utc(CUTOFF - 1000)} ↗`);
    expect(feed).toContain(`href="${link(txs.verifiedUnpriced)}"`); expect(feed).toContain(`href="${link(txs.witness)}"`);
    expect(textOf(published!)).toContain(`Published withdraw authority · 1 ${view.attribution.trustSources.published_withdraw_authority.explanation}`);
    expect(textOf(published!)).toContain(`${OTHER_DISTRIBUTOR} Copy Solscan ↗ Attributed rows 1 Rows through this source 1 Tokens 1`);
    expect(textOf(published!)).toContain(`Snapshot retrieved ${utc(CUTOFF - 100)} · taken after the payouts it covers · nearest snapshot for 1 row`);
    for (const owner of [DISTRIBUTOR, OTHER_DISTRIBUTOR]) {
      expect(html).toContain(`<code class="address">${owner}</code>`); expect(html).toContain(`href="https://solscan.io/account/${owner}"`);
    }
    expect(html.match(/aria-label="Copy identity address"/g)).toHaveLength(2);
    expect(html).not.toContain('…');
    expect(text).toContain('No row carries both trust sources.');
    expect(text).toContain('TRUST GATE G6 Identity conflicts NONE None. No row in this report was refused attribution because its sender\'s identity is conflicted. '
      + 'No local attribution revocation applies to any row.');
  });

  it('lists a conflicted identity with the rows it refused, and no longer trusts it', () => {
    const store = attributedStore(); const txs = attributedTransactions;
    const contradicted = payout({ label: 'dashboard-contradicted', time: CUTOFF - 700, legs: legs(200) });
    store.addTransaction(network, contradicted, { source: 'fixture', evidenceId: 'synthetic-dashboard', retrievedAt: iso(CUTOFF), commitment: 'finalized' });
    store.addFeed(officialFeed(contradicted, { evidenceId: 'contradicting-feed', amountRaw: '1' }));
    drain(store);
    const html = renderToStaticMarkup(createElement(Trust, { report: reportView(buildReport(store, WALLET)) }));
    const conflicts = html.split('aria-labelledby="conflicts-title">')[1]!;
    expect(textOf(conflicts)).toBe(`TRUST GATE G6 Identity conflicts 2 rows refused ${DISTRIBUTOR} Copy Solscan ↗ 2 rows refused · latest ${utc(CUTOFF - 86_900)} ↗ `
      + 'No local attribution revocation applies to any row.');
    expect(conflicts).toContain(`href="${link(txs.dual)}"`);
    const feed = html.split('<article class="trust-source feed_witnessed_identity" aria-label="Feed-witnessed distributor">')[1]!.split('</article>')[0]!;
    expect(textOf(feed)).toContain('No attributed row relies on this source.');
  });

  it('keeps conflicts visible while the trust sources wait for the tier to be evaluated', () => {
    const text = visible(createElement(Trust, { report: unevaluatedView('schema v4') }));
    expect(text).toContain('Not evaluated Saved rows predate classifier v3');
    expect(text).toContain('Identity conflicts NONE');
    expect(text).not.toMatch(/attributed rows from|Attributed rows 0|· 0\b/);
  });

  it('shows counts by status under the report\'s labels, ranges and gaps, plain unknown reasons and the reclassify control', () => {
    const view = reportView(buildReport(attributedStore(database(), { busy: true }), WALLET));
    const html = renderToStaticMarkup(createElement(Coverage, { report: view, reclassify: () => undefined, canReclassify: false }));
    const text = textOf(html);
    expect(text).toContain('Coverage & confidence PARTIAL CLASSIFICATION Verified 2 rows 2 signatures Attributed 6 rows 4 signatures '
      + `Excluded 1 row 1 signature Unknown · not counted 1 row 1 signature ${view.uniqueSignatures.all} signatures retained across all statuses.`);
    expect(text).toContain('Complete retrieval does not establish complete reward attribution: a count of zero does not prove that no rewards were paid.');
    expect(text).toContain(`Retrieval ranges · ${view.coverage.completed.length} complete · ${view.coverage.gaps.length} ${view.coverage.gaps.length === 1 ? 'gap' : 'gaps'} · newest first`);
    expect(html.match(/<li class="warning"><span>GAP<\/span>/g)).toHaveLength(view.coverage.gaps.length);
    expect(html).toContain('<button type="button" disabled="">RECLASSIFY LOCALLY</button>');
    for (const item of view.unknownReasons) expect(text).toContain(`${item.reason.replaceAll('_', ' ')} ${REASON_TEXT[item.reason]} ${item.count}`);
    expect(view.unknownReasons.length).toBeGreaterThan(0);
    // The bounded unknown sample prints each mint in full with a copy button.
    const sample = html.split('UNKNOWN CANDIDATE SAMPLE')[1]!.split('</details>')[0]!;
    expect(sample).toContain(`<code class="address">${MINT}</code>`); expect(sample).toContain('aria-label="Copy mint address"');
    expect(textOf(sample)).toMatch(/^\/ 1 of 1 classification records · excluded from reward totals Mint · full address /);
    expect(sample).toContain(`<li title="${REASON_TEXT.distributor_trust_unestablished}">distributor trust unestablished</li>`);
    for (const combined of COMBINED) expect(html).not.toContain(combined);
  });

  it('reads the attributed status as its state, never as a count, while not evaluated', () => {
    const text = visible(createElement(Coverage, { report: unevaluatedView('v5 rows before reclassification'), reclassify: () => undefined, canReclassify: true }));
    expect(text).toContain('Verified 2 rows 2 signatures Attributed Not evaluated Excluded 0 rows 0 signatures Unknown · not counted 4 rows 4 signatures');
    expect(text).toContain('RECLASSIFY LOCALLY');
  });
});

describe('dashboard tabs: hash routing and keyboard-accessible tab bar', () => {
  it('reads the tab and its filters from the hash, dropping anything unknown or malformed', () => {
    expect(TABS.map(tab => tab.id)).toEqual(['overview', 'tokens', 'payouts', 'trust', 'coverage']);
    expect(parseRoute('')).toEqual({ tab: 'overview', params: {} });
    expect(parseRoute('#tokens')).toEqual({ tab: 'tokens', params: {} });
    expect(parseRoute(`#tokens?token=${MINT}:6`)).toEqual({ tab: 'tokens', params: { token: `${MINT}:6` } });
    expect(parseRoute('#tokens?token=native-sol:9')).toEqual({ tab: 'tokens', params: { token: 'native-sol:9' } });
    expect(parseRoute(`#payouts?day=2026-09-20&token=${MINT}:6&trust=published_withdraw_authority&price=unpriced`)).toEqual({ tab: 'payouts',
      params: { day: '2026-09-20', token: `${MINT}:6`, trust: 'published_withdraw_authority', price: 'unpriced' } });
    // Unknown tabs read as the overview; unknown keys, malformed values and injected markup are dropped.
    expect(parseRoute('#main')).toEqual({ tab: 'overview', params: {} });
    expect(parseRoute('#payouts?day=20-09-2026&token=%3Cscript%3E&trust=everyone&price=free&wallet=x')).toEqual({ tab: 'payouts', params: {} });
    expect(parseRoute('#coverage?')).toEqual({ tab: 'coverage', params: {} });
  });

  it('writes a hash that reads back as the same route, never carrying a malformed filter', () => {
    const route = { tab: 'payouts' as const, params: { day: '2026-09-20', price: 'priced' } };
    expect(routeHash(route)).toBe('#payouts?day=2026-09-20&price=priced');
    expect(parseRoute(routeHash(route))).toEqual(route);
    expect(routeHash({ tab: 'overview', params: {} })).toBe('#overview');
    expect(routeHash({ tab: 'trust', params: { day: 'yesterday', token: '' } })).toBe('#trust');
  });

  it('renders one tab stop: only the active tab is selected and focusable, each controlling its panel', () => {
    const html = renderToStaticMarkup(createElement(TabBar, { active: 'payouts', select: () => undefined }));
    expect(textOf(html)).toBe('Overview Tokens Payouts Trust Coverage');
    expect(html).toContain('role="tablist" aria-label="Dashboard sections"');
    const tabs = [...html.matchAll(/<button type="button" role="tab" id="tab-(\w+)" aria-controls="panel-(\w+)" aria-selected="(\w+)" tabindex="(-?\d)"/g)]
      .map(match => match.slice(1));
    expect(tabs).toEqual([['overview', 'overview', 'false', '-1'], ['tokens', 'tokens', 'false', '-1'], ['payouts', 'payouts', 'true', '0'],
      ['trust', 'trust', 'false', '-1'], ['coverage', 'coverage', 'false', '-1']]);
  });
});

/** The same wallet with every saved price removed: its verified receipts remain, in token units only. */
function unpricedView() {
  const path = database(); attributedStore(path).close();
  const db = new DatabaseSync(path); db.exec('DELETE FROM prices;'); db.close();
  const store = new SqliteRewardsStore(path, { readOnly: true }); cleanups.push(() => { store.close(); });
  return reportView(buildReport(store, WALLET));
}

describe('dashboard layout: attributed leads and verified is left out while it has no rows', () => {
  it('hosts the attributed chart on the overview, with the verified chart after it only when verified has rows', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = reportView(buildReport(attributedStore(), WALLET));
    const html = renderToStaticMarkup(createElement(Overview, { report: view }));
    expect(html.indexOf('attributed-plot')).toBeLessThan(html.indexOf('verified-plot'));
    expect(view.counts.confirmed).toBeGreaterThan(0);
    const hidden = renderToStaticMarkup(createElement(Overview, { report: reportView(buildReport(attributedStore(database(), { verified: false }), WALLET)) }));
    expect(hidden).not.toContain('verified-plot');
    expect(hidden).toContain('attributed-plot');
    const collapsed = hidden;
    for (const combined of COMBINED) expect(html + collapsed).not.toContain(combined);
    errors.mockRestore();
  });

  it('leaves out the verified chart and table when no verified receipt exists', () => {
    const view = reportView(buildReport(attributedStore(database(), { verified: false }), WALLET));
    expect([view.verifiedTotals.rows, view.assets.length, view.cumulative.pricedCount]).toEqual([0, 0, 0]);
    expect(view.attribution).toMatchObject({ evaluated: true, rows: 3 });
    expect(verifiedHidden(view)).toBe(true);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const chart = renderToStaticMarkup(createElement(Chart, { report: view }));
    expect(errors).not.toHaveBeenCalled();
    // Only the attributed series is drawn, and nothing of verified: no chart, no note and no empty-state wording.
    expect(chartSvgs(chart)).toHaveLength(1);
    expect(chart).toContain('attributed-chart');
    for (const absent of ['verified-plot', 'verified-note', 'reward-chart', 'empty-bars', 'View exact chart data', EMPTY_MESSAGE]) expect(chart).not.toContain(absent);
    const tab = renderToStaticMarkup(createElement(TokensTab, { report: view, open: () => undefined, close: () => undefined }));
    for (const absent of ['id="token-title"', 'verified-note', EMPTY_MESSAGE]) expect(tab).not.toContain(absent);
    expect(textOf(chart + tab)).not.toMatch(/not verified/i);
  });

  it('keeps the verified table when verified receipts exist but carry no price', () => {
    const view = unpricedView();
    expect(view.cumulative.pricedCount).toBe(0);
    expect(view.assets.map(asset => asset.currentUsd)).toEqual([null, null]);
    expect(verifiedHidden(view)).toBe(false);
    const rows = tableRows(renderToStaticMarkup(createElement(TokenTable, { report: view })));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.includes('UNPRICED'))).toBe(true);
  });
});

describe('layered history on the dashboard', () => {
  /** A saved wallet covered over one range, as a scan under an earlier rule or a fixture left it. */
  const covered = (store: SqliteRewardsStore, coverage: { startTime: number; endTime: number }, trackingStart = coverage.startTime) => {
    const job = { id: `floor-${coverage.startTime}`, network: 'mainnet-beta' as const, wallet: DEMO_WALLET, cutoff: coverage.endTime, createdAt: coverage.endTime * 1000,
      status: 'complete' as const, limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: coverage.endTime * 1000 },
      used: { stonkfun: 0, helius: 0, pages: 0, resumes: 1 }, pageSize: 100, error: null, registryDone: true, hydrationDone: true };
    store.atomic(() => {
      store.saveWallet({ network: 'mainnet-beta', wallet: DEMO_WALLET, trackingStart, cutoff: coverage.endTime, lastSync: null });
      store.saveJob(job); store.createRanges(job, [coverage]); store.completeRange(job, store.ranges(job.id)[0]!);
    });
    return store;
  };
  const coverageText = (report: DashboardReport) => renderToStaticMarkup(createElement(Coverage, { report, reclassify: () => undefined, canReclassify: false }));

  /** A completed range saved by another job, as an interrupted Load earlier batch leaves its finished days. */
  const savedDays = (store: SqliteRewardsStore, range: { startTime: number; endTime: number }) => {
    const job = { id: `saved-${range.startTime}`, network: 'mainnet-beta' as const, wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, createdAt: DEMO_CUTOFF * 1000,
      status: 'paused' as const, limits: { stonkfun: 1, helius: 1, pages: 1, resumes: 1, deadline: DEMO_CUTOFF * 1000 },
      used: { stonkfun: 0, helius: 0, pages: 0, resumes: 1 }, pageSize: 100, error: null, registryDone: true, hydrationDone: true, kind: 'earlier' as const };
    store.atomic(() => { store.saveJob(job); store.createRanges(job, [range]); store.completeRange(job, store.ranges(job.id)[0]!); });
    return store;
  };
  const header = (report: DashboardReport | null, busy = false) => renderToStaticMarkup(createElement(RefreshControl, { health: null, running: false, busy,
    lastRefresh: 'never', history: report ? historyStatus(report) : null, onRefresh: () => undefined }));
  const LOADED_FROM = DEMO_CUTOFF - 10 * 86400;

  it('shows the loaded range, the days left to the floor and Load earlier while earlier history remains', () => {
    const report = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), DEMO_WALLET));
    expect(report.history.oldestLoadedDay).toBe('2026-09-11');
    expect(historyStatus(report)).toEqual({ loaded: 'Loaded 2026-09-11 → today', left: '42 days left to Aug 1',
      earlier: { label: 'Load earlier history', note: null, range: 'Loads 2026-09-04 → 2026-09-11' } });
    const html = header(report);
    expect(textOf(html)).toBe('Refresh rewards Last refresh never Loaded 2026-09-11 → today · 42 days left to Aug 1 Load earlier history Loads 2026-09-04 → 2026-09-11');
    expect(html).toContain('aria-describedby="last-refresh history-loaded"');
    expect(html).toContain('<button type="button" class="earlier-button"><span class="button-label">Load earlier history</span><span class="button-range">Loads 2026-09-04 → 2026-09-11</span></button>');
    // A running scan or a start in flight disables it, as it disables Refresh.
    expect(header(report, true)).toContain('<button type="button" class="earlier-button" disabled=""><span class="button-label">Load earlier history</span>');
    // No wallet on screen: no history line and no control.
    expect(textOf(header(null))).toBe('Refresh rewards Last refresh never');
  });

  it('shows the full history since the floor, and no Load earlier, once loaded back to the floor', () => {
    const report = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }, HISTORY_FLOOR), DEMO_WALLET));
    expect(historyStatus(report)).toEqual({ loaded: 'Full history since 2026-08-01', left: null, earlier: null });
    expect(textOf(header(report))).toBe('Refresh rewards Last refresh never Full history since 2026-08-01');
    expect(header(report)).not.toContain('earlier-button');
  });

  it('offers Continue loading with the days an interrupted batch saved', () => {
    const batch = { startTime: LOADED_FROM - 7 * 86400, endTime: LOADED_FROM };
    const store = savedDays(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), { startTime: LOADED_FROM - 3 * 86400, endTime: LOADED_FROM });
    const report = reportView(buildReport(store, DEMO_WALLET));
    expect(report.history.nextBatch).toEqual({ ...batch, days: 7 });
    expect(historyStatus(report)).toEqual({ loaded: 'Loaded 2026-09-11 → today', left: '42 days left to Aug 1',
      earlier: { label: 'Continue loading', note: '3 of 7 days saved', range: 'Loads 2026-09-04 → 2026-09-11' } });
    expect(textOf(header(report))).toBe('Refresh rewards Last refresh never Loaded 2026-09-11 → today · 42 days left to Aug 1 Continue loading Loads 2026-09-04 → 2026-09-11 3 of 7 days saved');
    // Days saved outside the next batch are not counted toward it.
    const outside = reportView(buildReport(savedDays(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), { startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 86400 }), DEMO_WALLET));
    expect(historyStatus(outside).earlier).toEqual({ label: 'Load earlier history', note: null, range: 'Loads 2026-09-04 → 2026-09-11' });
  });

  it('labels a batch by its UTC days and says how long the last one took', () => {
    expect(batchLabel({ startTime: LOADED_FROM - 7 * 86400, endTime: LOADED_FROM })).toBe('Loading 2026-09-04 → 2026-09-11 (7 days)');
    expect(batchLabel({ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 3 * 86400 })).toBe('Loading 2026-08-01 → 2026-08-03 (3 days)');
    expect(batchLabel({ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 3600 })).toBe('Loading 2026-08-01 → 2026-08-01 (1 day)');
    const history = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), DEMO_WALLET)).history;
    expect(batchTimeText(history)).toBe('Usually a few minutes.');
    expect(batchTimeText(null)).toBe('Usually a few minutes.');
    const last = (kind: 'first' | 'earlier', elapsedSeconds: number, days = 7) => ({ ...history, lastBatch: { kind, startTime: 0, endTime: 0, days, elapsedSeconds, finishedAt: '' } });
    // A first scan is not a Load earlier batch.
    expect(batchTimeText(last('first', 130))).toBe('Usually a few minutes.');
    expect(batchTimeText(last('earlier', 130))).toBe('Last batch: 7 days in 2 min 10 s');
    expect(batchTimeText(last('earlier', 45, 1))).toBe('Last batch: 1 day in 45 s');
    expect([0, 59.6, 60, 120, 3599, 3600, 3660, 7200].map(runTimeText)).toEqual(['0 s', '1 min', '1 min', '2 min', '59 min 59 s', '1 h', '1 h 1 min', '2 h']);
  });

  it('lists the days not loaded yet in Coverage apart from gaps, with the same Load earlier control', () => {
    const report = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), DEMO_WALLET));
    const html = renderToStaticMarkup(createElement(Coverage, { report, reclassify: () => undefined, canReclassify: false, canEarlier: true, onEarlier: () => undefined }));
    expect(textOf(html)).toContain(`COMPLETE ${utc(LOADED_FROM)} → ${utc(DEMO_CUTOFF)} NOT LOADED YET 2026-08-01 00:00 UTC → ${utc(LOADED_FROM)} · 42 days `
      + 'Not scanned yet, so not a gap. Each batch loads 7 more days back to 2026-08-01. Load earlier history Loads 2026-09-04 → 2026-09-11');
    expect(html).toContain('<div class="not-loaded">');
    expect(html).not.toContain('<li class="warning">');
    // Without a start allowed (a scan running, or offline) the control shows but is disabled.
    expect(coverageText(report)).toContain('class="earlier-button" disabled=""><span class="button-label">Load earlier history');
    const floor = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }, HISTORY_FLOOR), DEMO_WALLET));
    expect(coverageText(floor)).not.toContain('NOT LOADED YET');
  });

  it('asks for earlier history on a period the days back to the floor would cover, and names the days otherwise', () => {
    const report = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), DEMO_WALLET));
    // Loaded 2026-09-11 → 2026-09-21: 11 days. The floor makes 52 days reachable, so 14D and 30D wait for Load earlier and 60D cannot.
    expect(periodOptions(report).map(option => [option.label, option.reason])).toEqual([['7D', null], ['14D', LOAD_EARLIER_REASON], ['30D', LOAD_EARLIER_REASON],
      ['60D', 'needs 60 days of tracked history'], ['90D', 'needs 90 days of tracked history'], ['ALL', null]]);
    expect(LOAD_EARLIER_REASON).toBe('Load earlier history to enable');
    expect(resolvePeriod(report, { period: '14d' }).notice).toBe('14D needs earlier history; load earlier history to enable it; showing 7D.');
    const control = textOf(renderToStaticMarkup(createElement(PeriodControl, { report, period: defaultPeriod(report), onPeriod: () => undefined })));
    expect(control).toBe('7D 14D Load earlier history to enable 30D Load earlier history to enable 60D needs 60 days of tracked history 90D needs 90 days of tracked history ALL CUSTOM');
    // At the floor nothing earlier can load, so every short period names its days.
    const floor = reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }, LOADED_FROM + 5 * 86400), DEMO_WALLET));
    expect(periodOptions({ ...floor, history: { ...floor.history, earlierRemaining: false } })[1]!.reason).toBe('needs 14 days of tracked history');
  });

  it('measures coverage against the loaded range: days before a later first covered day are a gap only once loaded, days before the floor never are', () => {
    const notLoaded = reportView(buildReport(covered(open(), { startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF }), DEMO_WALLET));
    expect(coverageTarget(notLoaded)).toEqual({ startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF });
    expect(notLoaded.coverage.gaps).toEqual([]);
    const later = reportView(buildReport(covered(open(), { startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF }, HISTORY_FLOOR), DEMO_WALLET));
    expect(coverageTarget(later)).toEqual({ startTime: HISTORY_FLOOR, endTime: DEMO_CUTOFF });
    expect(later.coverage.gaps).toEqual([{ startTime: HISTORY_FLOOR, endTime: DEMO_CUTOFF - 10 * 86400 }]);
    const html = coverageText(later);
    expect(textOf(html)).toContain(`Retrieval ranges · 1 complete · 1 gap · newest first Target 2026-08-01 00:00 UTC → ${utc(DEMO_CUTOFF)} `
      + `COMPLETE ${utc(DEMO_CUTOFF - 10 * 86400)} → ${utc(DEMO_CUTOFF)} GAP 2026-08-01 00:00 UTC → ${utc(DEMO_CUTOFF - 10 * 86400)}`);
    const earlier = reportView(buildReport(covered(open(), { startTime: HISTORY_FLOOR - 5 * 86400, endTime: DEMO_CUTOFF }, HISTORY_FLOOR), DEMO_WALLET));
    expect(earlier.coverage.gaps).toEqual([]);
    const text = textOf(coverageText(earlier));
    expect(text).toContain(`Retrieval ranges · 1 complete · 0 gaps · newest first Target 2026-08-01 00:00 UTC → ${utc(DEMO_CUTOFF)} COMPLETE ${utc(HISTORY_FLOOR - 5 * 86400)}`);
    expect(text).not.toContain('GAP');
  });

  it('says a first scan covers the last seven days, and only for a job planning that whole range', () => {
    expect(FIRST_SCAN_NOTE).toBe('The first scan covers the last 7 days. Older history loads afterwards in 7-day batches.');
    const job = (ranges: { startTime: number; endTime: number }[]) => ({ cutoff: DEMO_CUTOFF, ranges: ranges.map(range => ({ ...range, status: 'pending' as const, pages: 0 })) });
    expect(isFirstScan(job(planRanges(DEMO_CUTOFF, [], DEMO_CUTOFF - 7 * 86400)))).toBe(true);
    expect(isFirstScan(job(planRanges(DEMO_CUTOFF, [])))).toBe(false);
    expect(isFirstScan(job(planRanges(DEMO_CUTOFF, [{ startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF - 3 * 86400 }])))).toBe(false);
    expect(isFirstScan(job(planRanges(DEMO_CUTOFF, [{ startTime: HISTORY_FLOOR, endTime: DEMO_CUTOFF - 3600 }])))).toBe(false);
    expect(isFirstScan(job([]))).toBe(false);
    const fresh = harness(open(), blocked).service.start(DEMO_WALLET);
    expect(fresh.ranges[0]!.startTime).toBe(fresh.cutoff - 7 * 86400);
    const dialog = (value: typeof fresh) => textOf(renderToStaticMarkup(createElement(Progress, { job: value, now: value.progress.serverNow, close: () => undefined, action: () => undefined })));
    expect(dialog(fresh)).toContain(`Scanning 88888…88888: last 7 days Reading 2026-09-14 → 2026-09-21 UTC`);
    expect(dialog(fresh)).toContain(`Now reading 2026-09-14 · 0 of ${fresh.ranges.length} days done Last backend activity 2s ago Requests so far: Helius 0 · StonkFun 0 ${FIRST_SCAN_NOTE}`);
    const widened = harness(covered(open(), { startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF - 3 * 86400 }), blocked).service.start(DEMO_WALLET);
    expect(widened.ranges[0]!.startTime).toBe(DEMO_CUTOFF - 3 * 86400 - 60);
    expect(dialog(widened)).not.toContain(FIRST_SCAN_NOTE);
  });
  describe('alerts, counts and empty states', () => {
    type Job = ReturnType<DashboardService['start']>;
    /** A job saved by a batch that stopped after three of its seven days, with a class and Helius's or the raw message. */
    const stoppedJob = (base: Job, failureClass: Job['failureClass'], failureDetail: string | null = null, failureMessage: string | null = null) => ({
      ...base, runningLocally: false, status: 'paused', canResume: true, savedDays: { completed: 3, planned: 7 }, failureClass, failureDetail, failureMessage,
      progress: { ...base.progress, finishedAt: DEMO_CUTOFF * 1000, waiting: null } }) as Job;
    /** The job with its progress waiting as the service reports a provider wait. */
    const waiting = (job: Job, wait: Job['progress']['waiting']) => ({ ...job, progress: { ...job.progress, waiting: wait } }) as Job;
    const dialog = (job: Job) => renderToStaticMarkup(createElement(Progress, { job, now: job.progress.serverNow, close: () => undefined, action: () => undefined }));

    it('maps every failure class to one plain message, the saved days and Retry, with the key form only for a rejected key', () => {
      const base = harness(open(), blocked).service.start(DEMO_WALLET);
      const notice = (failureClass: Job['failureClass'], detail: string | null = null, message: string | null = null) => failureNotice(stoppedJob(base, failureClass, detail, message));
      const saved = 'Completed days are saved: 3 of 7.';
      expect(notice('key_rejected')).toEqual({ message: 'Helius rejected your API key. Check the key and try again.', saved, reenterKey: true });
      expect(notice('helius_quota', 'Plan credit limit reached.')).toEqual({ message: 'Helius refused the request: Plan credit limit reached. A free plan may have used its monthly '
        + 'credits. Check usage in your Helius dashboard.', saved, reenterKey: false });
      expect(notice('helius_quota')!.message).toBe('Helius refused the request. A free plan may have used its monthly credits. Check usage in your Helius dashboard.');
      expect(notice('stonkfun_unreachable')).toEqual({ message: 'StonkFun\'s API did not respond. Try again in a few minutes.', saved, reenterKey: false });
      expect(notice('network')).toEqual({ message: 'No connection. Check your internet and try again.', saved, reenterKey: false });
      expect(notice('other', 'Helius server HTTP 500: upstream exploded', 'The scan stopped on an unrecognized error.')!.message).toBe('Helius server HTTP 500: upstream exploded');
      expect(notice('other', null, 'The scan stopped on an unrecognized error.')!.message).toBe('The scan stopped on an unrecognized error.');
      // A rate limit is temporary; a job that stopped during one says to wait, with the same saved days.
      expect(notice('helius_rate_limited')).toEqual({ message: 'Helius was limiting requests when the scan stopped. Wait a minute and try again.', saved, reenterKey: false });
      expect(notice(null)).toBeNull();
      expect(failureNotice({ ...stoppedJob(base, 'network'), savedDays: { completed: 0, planned: 4 } })!.saved).toBe('Completed days are saved: 0 of 4.');
      // Every class reads the same way in the dialog: the message, the saved days, Retry, and no separate Resume.
      const html = dialog(stoppedJob(base, 'key_rejected'));
      expect(textOf(html)).toContain('Scanning 88888…88888: last 7 days');
      expect(textOf(/<div class="failure-notice" role="alert">[\s\S]*?<\/div><\/div>/.exec(html)![0]))
        .toBe(`Helius rejected your API key. Check the key and try again. ${saved} Re-enter API key Retry`);
      expect(html).not.toContain('>RESUME<');
      expect(html).not.toContain('Scan interrupted');
      const quota = textOf(dialog(stoppedJob(base, 'helius_quota', 'Plan credit limit reached')));
      expect(quota).toContain(`Helius refused the request: Plan credit limit reached. A free plan may have used its monthly credits. Check usage in your Helius dashboard. ${saved} Retry`);
      expect(quota).not.toContain('Re-enter API key');
    });

    it('shows a Helius rate limit on a running job as a banner that keeps the scan going, never as a failure', () => {
      const base = harness(open(), blocked).service.start(DEMO_WALLET);
      expect(base.runningLocally).toBe(true);
      const limited = waiting({ ...base, failureClass: 'helius_rate_limited', failureMessage: 'Helius is rate limiting requests.' }, { provider: 'helius', reason: 'rate_limit' });
      expect(rateLimited(limited)).toBe(true);
      expect(failureNotice(limited)).toBeNull();
      expect(progressState(limited, limited.progress.serverNow)).toBe(RATE_LIMITED_TEXT);
      const html = dialog(limited);
      expect(html).toContain(`<p class="progress-note rate-limit" role="status">${RATE_LIMITED_TEXT}</p>`);
      expect(RATE_LIMITED_TEXT).toBe('Helius is limiting requests, slowing down.');
      expect(html).not.toContain('failure-notice');
      expect(textOf(html)).toContain('CANCEL SCAN');
      // Pacing and StonkFun waits are not a Helius rate limit.
      expect(rateLimited(waiting(limited, { provider: 'helius', reason: 'throttle' }))).toBe(false);
      expect(rateLimited(waiting(limited, { provider: 'stonkfun', reason: 'rate_limit' }))).toBe(false);
      expect(rateLimited({ ...limited, runningLocally: false })).toBe(false);
    });

    it('names the last job in the status panel: its kind, elapsed time and requests to each provider', () => {
      const base = harness(open(), blocked).service.start(DEMO_WALLET);
      const figures = (job: Job) => textOf(/<dl class="status-figures" aria-label="Last job">[\s\S]*?<\/dl>/.exec(statusHtml(null, null, job))![0]);
      const earlier: Job = { ...stoppedJob(base, null), status: 'complete', kind: 'earlier', batch: { kind: 'earlier', startTime: LOADED_FROM - 7 * 86400, endTime: LOADED_FROM },
        elapsedSeconds: 130, requests: { helius: 12, stonkfun: 3 } };
      expect(figures(earlier)).toBe('Job Load earlier · 2026-09-04 → 2026-09-11 Elapsed 2 min 10 s Requests Helius 12 · StonkFun 3');
      expect(figures({ ...earlier, kind: 'refresh', batch: { kind: 'first', startTime: DEMO_CUTOFF - 7 * 86400, endTime: DEMO_CUTOFF } })).toContain('Job First scan');
      expect(figures({ ...earlier, kind: 'refresh', batch: null, elapsedSeconds: null })).toMatch(/^Job Refresh Elapsed \d\d:\d\d Requests Helius 12 · StonkFun 3$/);
      // A running job shows its live time; a stopped one with a failure says why above the figures.
      expect(figures(base)).toMatch(/^Job First scan Elapsed \d\d:\d\d Requests Helius 0 · StonkFun 0$/);
      expect(textOf(statusHtml(null, null, stoppedJob(base, 'network')))).toContain('No connection. Check your internet and try again. Completed days are saved: 3 of 7. View scan progress');
    });

    it('replaces an empty chart with what was checked, offering Load earlier until the floor', () => {
      const report = reportView(buildReport(covered(open(), { startTime: DEMO_CUTOFF - 7 * 86400, endTime: DEMO_CUTOFF }), DEMO_WALLET));
      expect(noPayouts(report)).toBe(true);
      const html = renderToStaticMarkup(createElement(Overview, { report, canEarlier: true }));
      expect(textOf(html)).toBe('LOADED HISTORY No StonkFun payouts found between 2026-09-14 and today. Days before 2026-09-14 are not loaded yet. '
        + 'Load earlier history to check them. Load earlier history Loads 2026-09-07 → 2026-09-14');
      expect(html).not.toContain('reward-chart');
      expect(html).not.toContain('period-control');
      const floor = reportView(buildReport(covered(open(), { startTime: DEMO_CUTOFF - 7 * 86400, endTime: DEMO_CUTOFF }, HISTORY_FLOOR), DEMO_WALLET));
      expect(textOf(renderToStaticMarkup(createElement(Overview, { report: floor })))).toBe('LOADED HISTORY No StonkFun payouts found since 2026-08-01. Every day since then '
        + 'is loaded. Rows the scanner could not attribute are counted apart in Coverage.');
      expect(emptyHistoryText(floor.history).earlier).toBe(false);
      // A wallet with payouts keeps its chart.
      const paid = reportView(buildReport(attributedStore(), WALLET));
      expect(noPayouts(paid)).toBe(false);
      expect(renderToStaticMarkup(createElement(Overview, { report: paid }))).toContain('period-control');
    });

    it('checks a wallet address in the page before any request', () => {
      expect(walletInputError(DEMO_WALLET)).toBeNull();
      expect(walletInputError(`  ${WALLET}  `)).toBeNull();
      expect(walletInputError('   ')).toBe('Enter a public Solana wallet address.');
      expect(walletInputError('0xAbC123')).toBe('That is not a Solana address: addresses use letters and digits, without 0, O, I or l.');
      expect(walletInputError('not a wallet')).toBe('That is not a Solana address: addresses use letters and digits, without 0, O, I or l.');
      expect(walletInputError('abc')).toBe('That is not a Solana address: addresses are 32 to 44 characters, and this has 3.');
      expect(walletInputError('1'.repeat(45))).toBe('That is not a Solana address: addresses are 32 to 44 characters, and this has 45.');
    });
  });
  describe('one wallet in view, one clear action', () => {
    type Job = ReturnType<DashboardService['start']>;
    const SHORT = '88888…88888';
    const loadedReport = () => reportView(buildReport(covered(open(), { startTime: LOADED_FROM, endTime: DEMO_CUTOFF }), DEMO_WALLET));
    const control = (scanned: boolean, report: DashboardReport | null = null) => renderToStaticMarkup(createElement(RefreshControl, { health: null, running: false, busy: false,
      scanned, lastRefresh: report ? lastSyncText(report) : 'never', history: report && scanned ? historyStatus(report) : null, onRefresh: () => undefined }));
    const menu = (report: DashboardReport | null, job: Job | null, scanned: boolean, wallet = DEMO_WALLET) => renderToStaticMarkup(createElement(StatusMenu, {
      report, health: null, job, now: DEMO_CUTOFF * 1000, wallet, scanned, openProgress: () => undefined, openWallet: () => undefined }));
    const dialog = (job: Job) => renderToStaticMarkup(createElement(Progress, { job, now: job.progress.serverNow, close: () => undefined, action: () => undefined }));
    const panel = (running: boolean) => renderToStaticMarkup(createElement(UnscannedPanel, { wallet: DEMO_WALLET, health: null, running, busy: false, onScan: () => undefined }));

    it('offers Scan wallet for a wallet with no saved coverage and Refresh rewards once it has some', () => {
      // Untracked: the server has no report. Admitted: its first scan has not saved a day, so it has no coverage and no sync.
      expect(hasSavedCoverage(null)).toBe(false);
      const store = open(); harness(store, blocked).service.start(DEMO_WALLET);
      const admitted = reportView(buildReport(store, DEMO_WALLET));
      expect([admitted.coverage.completed, admitted.lastSync]).toEqual([[], null]);
      expect(hasSavedCoverage(admitted)).toBe(false);
      const loaded = loadedReport();
      expect(hasSavedCoverage(loaded)).toBe(true);
      expect(hasSavedCoverage({ coverage: admitted.coverage, lastSync: '2026-09-21T00:00:00.000Z' })).toBe(true);
      expect([primaryLabel(false), primaryLabel(true)]).toEqual(['Scan wallet', 'Refresh rewards']);
      // Each state of the button: its action, a start in flight, this wallet's scan running, and offline.
      expect([false, true].map(scanned => [primaryText(null, false, scanned), primaryText(null, true, scanned), primaryText('running', false, scanned),
        primaryText('offline', false, scanned)])).toEqual([['Scan wallet', 'Starting…', 'Scan running…', 'Offline · scan disabled'],
        ['Refresh rewards', 'Starting…', 'Scan running…', 'Offline · refresh disabled']]);
      // An unscanned wallet's header has no last refresh and no loaded history; a scanned one keeps both.
      expect(textOf(control(false))).toBe('Scan wallet');
      expect(control(false)).not.toContain('aria-describedby');
      expect(textOf(control(true, loaded))).toBe('Refresh rewards Last refresh Not completed Loaded 2026-09-11 → today · 42 days left to Aug 1 Load earlier history Loads 2026-09-04 → 2026-09-11');
    });

    it('reads Not scanned yet beside the short address until the wallet has saved coverage', () => {
      const running = harness(open(), blocked).service.start(DEMO_WALLET);
      expect(NOT_SCANNED).toBe('Not scanned yet');
      expect(walletStatusText(null, false)).toBe(NOT_SCANNED);
      // Its first scan running reads WORKING; once stopped without a saved day, it has still not been scanned.
      expect(walletStatusText(running, false)).toBe('WORKING');
      expect(walletStatusText({ ...running, runningLocally: false, status: 'paused' }, false)).toBe(NOT_SCANNED);
      expect(walletStatusText({ ...running, runningLocally: false, status: 'complete' }, true)).toBe('COMPLETE');
      expect(walletStatusText(null, true)).toBe('NO SCAN');
      const unscanned = menu(null, null, false);
      expect(textOf(unscanned)).toBe(`${SHORT} Not scanned yet ▾`);
      expect(unscanned).toContain(`<span class="status-wallet" title="${DEMO_WALLET}">${SHORT}</span>`);
      expect(unscanned).toContain(`aria-label="Wallet ${SHORT}. Status: Not scanned yet"`);
      // The chip names the day the running job is on: its first day not saved yet.
      expect(textOf(menu(null, running, false))).toBe(`${SHORT} WORKING · 2026-09-14 ▾`);
      expect(textOf(menu(loadedReport(), null, true))).toBe(`${SHORT} NO SCAN Last refresh Not completed ▾`);
      // No wallet in view, as on a first launch: no address.
      expect(textOf(menu(null, null, false, ''))).toBe('NO SCAN Last refresh Never ▾');
    });

    it('shows an unscanned wallet the same panel on every tab, with Scan wallet', () => {
      expect(textOf(panel(false))).toBe(`${SHORT} has not been scanned yet. Scan wallet The first scan covers the last 7 days and takes a minute or two. `
        + 'Older history loads afterwards in 7-day batches.');
      expect(UNSCANNED_NOTE).toBe('The first scan covers the last 7 days and takes a minute or two. Older history loads afterwards in 7-day batches.');
      expect(panel(false)).toMatch(/<button type="button" class="primary unscanned-button">Scan wallet<\/button>/);
      // While its first scan runs the button says so and starts nothing.
      expect(panel(true)).toMatch(/<button type="button" class="primary unscanned-button" disabled="">Scan running…<\/button>/);
    });

    it('waits while another wallet scans, naming it, and never for the wallet whose job runs', () => {
      const health = { providerConfigured: true, configurationChecked: true, offline: false, activeWallets: [WALLET] };
      expect(runningElsewhere(health, DEMO_WALLET)).toBe(WALLET);
      expect(runningElsewhere(health, WALLET)).toBeNull();
      expect(runningElsewhere({ ...health, activeWallets: [] }, DEMO_WALLET)).toBeNull();
      expect(runningElsewhere(health, '')).toBeNull();
      expect(runningElsewhere(null, DEMO_WALLET)).toBeNull();
      expect(runningElsewhereText(WALLET)).toBe(`A scan is running for ${short(WALLET)}`);
      const loaded = loadedReport();
      const html = renderToStaticMarkup(createElement(RefreshControl, { health, running: false, busy: false, scanned: true, runningFor: WALLET,
        lastRefresh: lastSyncText(loaded), history: historyStatus(loaded), onRefresh: () => undefined }));
      expect(html).toMatch(/<button type="button" class="primary refresh-button" disabled="" aria-describedby="running-elsewhere last-refresh history-loaded">Refresh rewards<\/button>/);
      expect(textOf(html)).toBe(`Refresh rewards A scan is running for ${short(WALLET)} Last refresh Not completed Loaded 2026-09-11 → today · 42 days left to Aug 1 Load earlier history Loads 2026-09-04 → 2026-09-11`);
      // Load earlier is a job too, so it waits with the button.
      expect(html).toContain('class="earlier-button" disabled=""><span class="button-label">Load earlier history');
      const unscanned = renderToStaticMarkup(createElement(UnscannedPanel, { wallet: DEMO_WALLET, health, running: false, busy: false, runningFor: WALLET, onScan: () => undefined }));
      expect(unscanned).toMatch(/disabled="" aria-describedby="unscanned-elsewhere">Scan wallet<\/button><p class="running-elsewhere" id="unscanned-elsewhere">A scan is running for /);
    });

    it('titles the scan dialog by the wallet: a first scan by its seven days, a refresh by name, a batch by its days', () => {
      const first = harness(open(), blocked).service.start(DEMO_WALLET);
      expect(first.batch?.kind).toBe('first');
      expect(progressTitle(first)).toBe(`Scanning ${SHORT}: last 7 days`);
      const refresh = harness(covered(open(), { startTime: DEMO_CUTOFF - 10 * 86400, endTime: DEMO_CUTOFF - 3 * 86400 }), blocked).service.start(DEMO_WALLET);
      expect(refresh.batch).toBeNull();
      expect(progressTitle(refresh)).toBe(`Refreshing ${SHORT}`);
      expect(progressTitle({ ...refresh, kind: 'earlier', batch: { kind: 'earlier', startTime: LOADED_FROM - 7 * 86400, endTime: LOADED_FROM } }))
        .toBe('Loading 2026-09-04 → 2026-09-11 (7 days)');
      expect(dialog(first)).toContain(`<h2 id="progress-title">Scanning ${SHORT}: last 7 days</h2>`);
      expect(dialog(refresh)).toContain(`<h2 id="progress-title">Refreshing ${SHORT}</h2>`);
      // The title keeps naming the wallet once the job stops; its state is in the dialog beneath.
      const complete = dialog({ ...refresh, runningLocally: false, status: 'complete', progress: { ...refresh.progress, finishedAt: DEMO_CUTOFF * 1000 } });
      expect(complete).toContain(`<h2 id="progress-title">Refreshing ${SHORT}</h2>`);
      expect(textOf(complete)).toContain('Completed. Saved report is ready.');
    });
  });

  describe('the UTC dates each scan reads', () => {
    type Job = ReturnType<DashboardService['start']>;
    const HOUR = 3600;
    const LOADED = { startTime: LOADED_FROM, endTime: DEMO_CUTOFF };
    /** A job as the service reports it, running here, with its planned ranges, none saved yet. */
    const job = (kind: 'refresh' | 'earlier', ranges: { startTime: number; endTime: number }[], batch: Job['batch'], extra: Partial<Job> = {}) => ({
      id: 'range-text', wallet: DEMO_WALLET, cutoff: DEMO_CUTOFF, kind, batch, runningLocally: true, status: 'running',
      ranges: ranges.map(range => ({ ...range, status: 'pending' as const, pages: 0 })), savedDays: { completed: 0, planned: ranges.length }, ...extra }) as Job;
    /** The first `count` planned days saved. */
    const saved = (value: Job, count: number) => ({ ...value, ranges: value.ranges.map((range, index) => index < count ? { ...range, status: 'complete' as const } : range),
      savedDays: { completed: count, planned: value.ranges.length } });
    const loadedReport = () => reportView(buildReport(covered(open(), LOADED), DEMO_WALLET));
    /** The report read after a job, with the attributed tier evaluated and the given day buckets and listed receipts. */
    const after = (report: DashboardReport, changes: { cutoff?: number; loadedFrom?: number; buckets?: [string, number][]; times?: number[] }) => ({
      ...report, cutoff: changes.cutoff ?? report.cutoff, history: { ...report.history, loadedFrom: changes.loadedFrom ?? report.history.loadedFrom },
      attribution: { ...report.attribution, evaluated: true, recheckPending: 0,
        dayTokens: (changes.buckets ?? []).map(([day, receipts]) => ({ day, receipts, tokens: [], currentUsd: null })),
        receipts: (changes.times ?? []).map(time => ({ id: `receipt-${time}`, time, day: new Date(time * 1000).toISOString().slice(0, 10) })) } }) as unknown as DashboardReport;

    it('prints whole UTC days, or both times to the minute under a day', () => {
      expect(spanText({ startTime: DEMO_CUTOFF - 7 * 86400, endTime: DEMO_CUTOFF })).toBe('2026-09-14 → 2026-09-21');
      expect(spanText({ startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 86400 })).toBe('2026-08-01 → 2026-08-01');
      expect(spanText({ startTime: DEMO_CUTOFF - HOUR, endTime: DEMO_CUTOFF })).toBe('2026-09-21 13:13 → 2026-09-21 14:13');
    });

    it('a first scan: its seven days on the idle button, then the span, the day being read and the days done', () => {
      expect(firstScanRangeText(DEMO_CUTOFF)).toBe('Scans 2026-09-14 → today (7 days)');
      // Near the floor the first scan is clipped, and says how many days it covers.
      expect(firstScanRangeText(HISTORY_FLOOR + 3.5 * 86400)).toBe('Scans 2026-08-01 → today (4 days)');
      const start = DEMO_CUTOFF - 7 * 86400;
      const first = job('refresh', planRanges(DEMO_CUTOFF, [], start), { kind: 'first', startTime: start, endTime: DEMO_CUTOFF });
      expect(runningRangeText(first, null)).toBe('Scanning 2026-09-14 → 2026-09-21');
      expect(readingText(first, null)).toBe('Reading 2026-09-14 → 2026-09-21 UTC');
      expect(daysDoneText(first, null)).toBe('Now reading 2026-09-14 · 0 of 7 days done');
      expect(workingText(saved(first, 3), null)).toBe('WORKING · 2026-09-17');
      expect(daysDoneText(saved(first, 7), null)).toBe('7 of 7 days done');
      expect(workingText(saved(first, 7), null)).toBe('WORKING');
      // The idle button carries the first scan's days; offline it says only why it is disabled.
      const panel = (health: Health | null) => textOf(renderToStaticMarkup(createElement(UnscannedPanel, { wallet: DEMO_WALLET, health, running: false, busy: false,
        range: firstScanRangeText(DEMO_CUTOFF), onScan: () => undefined })));
      expect(panel(null)).toContain('Scan wallet Scans 2026-09-14 → today (7 days)');
      expect(panel({ providerConfigured: false, configurationChecked: false, offline: true, activeWallets: [] })).not.toContain('Scans ');
    });

    it('a refresh: from the last cutoff or the earliest gap to now, without the minute it rereads', () => {
      const report = loadedReport();
      expect(refreshRangeText(report)).toBe('Checks 2026-09-21 14:13 UTC → now');
      const gapped = { ...report, coverage: { ...report.coverage, gaps: [{ startTime: DEMO_CUTOFF - 2 * 86400, endTime: DEMO_CUTOFF - 86400 }] } };
      expect(refreshRangeText(gapped)).toBe('Checks 2026-09-19 14:13 UTC → now');
      const control = textOf(renderToStaticMarkup(createElement(RefreshControl, { health: null, running: false, busy: false, lastRefresh: 'never',
        range: refreshRangeText(report), onRefresh: () => undefined })));
      expect(control).toBe('Refresh rewards Checks 2026-09-21 14:13 UTC → now Last refresh never');
      const cutoff = DEMO_CUTOFF + 6 * HOUR;
      const refresh = job('refresh', planRanges(cutoff, [LOADED], LOADED_FROM), null, { cutoff });
      // The planner rereads the minute before the last cutoff; the text starts at the cutoff, as the idle button said.
      expect(refresh.ranges[0]!.startTime).toBe(DEMO_CUTOFF - 60);
      expect(runningRangeText(refresh, LOADED_FROM)).toBe('Scanning 2026-09-21 14:13 → 2026-09-21 20:13');
      expect(readingText(refresh, LOADED_FROM)).toBe('Reading 2026-09-21 14:13 → 2026-09-21 20:13 UTC');
      expect(workingText(refresh, LOADED_FROM)).toBe('WORKING · 2026-09-21');
      const running = textOf(renderToStaticMarkup(createElement(RefreshControl, { health: null, running: true, busy: false, lastRefresh: 'never',
        range: runningRangeText(refresh, LOADED_FROM), onRefresh: () => undefined })));
      expect(running).toBe('Scan running… Scanning 2026-09-21 14:13 → 2026-09-21 20:13 Last refresh never');
      // Two days after the last cutoff it prints days.
      expect(readingText(job('refresh', planRanges(DEMO_CUTOFF + 2 * 86400, [LOADED], LOADED_FROM), null), LOADED_FROM)).toBe('Reading 2026-09-21 → 2026-09-23 UTC');
      // At the same cutoff a refresh only rereads its last minute, and says so.
      expect(readingText(job('refresh', planRanges(DEMO_CUTOFF, [LOADED], LOADED_FROM), null), LOADED_FROM)).toBe('Reading 2026-09-21 14:12 → 2026-09-21 14:13 UTC');
    });

    it('a Load earlier batch: its days on the idle button, then the day it is on', () => {
      expect(historyStatus(loadedReport()).earlier?.range).toBe('Loads 2026-09-04 → 2026-09-11');
      const batch = { startTime: LOADED_FROM - 7 * 86400, endTime: LOADED_FROM };
      const earlier = job('earlier', planEarlier(batch, []), { kind: 'earlier', ...batch });
      expect(runningRangeText(earlier, LOADED_FROM)).toBe('Scanning 2026-09-04 → 2026-09-11');
      expect(readingText(earlier, LOADED_FROM)).toBe('Reading 2026-09-04 → 2026-09-11 UTC');
      expect(daysDoneText(saved(earlier, 2), LOADED_FROM)).toBe('Now reading 2026-09-06 · 2 of 7 days done');
      expect(workingText(saved(earlier, 2), LOADED_FROM)).toBe('WORKING · 2026-09-06');
      // Stopped, it is on no day, and the chip reads its state.
      const stopped = { ...saved(earlier, 2), runningLocally: false, status: 'paused' } as Job;
      expect(daysDoneText(stopped, LOADED_FROM)).toBe('2 of 7 days done');
      expect(workingText(stopped, LOADED_FROM)).toBe('PAUSED');
    });

    it('counts new payouts once the report after the job is in view, never the reread minute', () => {
      const report = loadedReport();
      const cutoff = DEMO_CUTOFF + 6 * HOUR;
      const refresh = saved(job('refresh', planRanges(cutoff, [LOADED], LOADED_FROM), null, { cutoff, runningLocally: false, status: 'complete' }), 1);
      // One payout in the reread minute was found before, two after the last cutoff are new, and one lies outside.
      const refreshed = after(report, { cutoff, times: [DEMO_CUTOFF - 30, DEMO_CUTOFF + 10, cutoff - 1, DEMO_CUTOFF - HOUR] });
      expect(newPayouts(refresh, refreshed)).toBe(2);
      expect(doneText(refresh, refreshed)).toBe('Done: 2026-09-21 14:13 → 2026-09-21 20:13 · 2 new payouts');
      // Until the report after the job is read, the count waits.
      expect(newPayouts(refresh, report)).toBeNull();
      expect(doneText(refresh, report)).toBe('Done: 2026-09-21 14:13 → 2026-09-21 20:13');
      // A batch counts whole days from the day buckets, which hold every receipt even when the list is cut.
      const batch = { startTime: HISTORY_FLOOR, endTime: HISTORY_FLOOR + 3 * 86400 };
      const earlier = saved(job('earlier', planEarlier(batch, []), { kind: 'earlier', ...batch }, { runningLocally: false, status: 'complete' }), 3);
      const loaded = after(report, { loadedFrom: HISTORY_FLOOR, buckets: [['2026-08-01', 1], ['2026-08-02', 5], ['2026-08-03', 2], ['2026-08-04', 7]] });
      expect(doneText(earlier, loaded)).toBe('Done: 2026-08-01 → 2026-08-03 · 8 new payouts');
      expect(newPayouts(earlier, after(report, { buckets: [['2026-08-02', 5]] }))).toBeNull();
      expect(doneText(earlier, after(report, { loadedFrom: HISTORY_FLOOR, buckets: [['2026-08-02', 1]] }))).toBe('Done: 2026-08-01 → 2026-08-03 · 1 new payout');
      // The dialog's top line: what it reads while it runs, what it did once done.
      const dialog = (value: Job, shown: DashboardReport | null) => textOf(renderToStaticMarkup(createElement(Progress, { job: value, report: shown, now: DEMO_CUTOFF * 1000,
        close: () => undefined, action: () => undefined })));
      const base = harness(open(), blocked).service.start(DEMO_WALLET);
      expect(dialog({ ...base, ...refresh, runningLocally: true, status: 'running', progress: base.progress }, report))
        .toContain(`Refreshing ${short(DEMO_WALLET)} Reading 2026-09-21 14:13 → 2026-09-21 20:13 UTC`);
      expect(dialog({ ...base, ...refresh, progress: { ...base.progress, finishedAt: cutoff * 1000 } }, refreshed))
        .toContain(`Refreshing ${short(DEMO_WALLET)} Done: 2026-09-21 14:13 → 2026-09-21 20:13 · 2 new payouts`);
    });
  });
});
