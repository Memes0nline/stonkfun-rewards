import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { createRealProviders } from '../src/providers/real.js';
import { runScan } from '../src/scanner/engine.js';
import { buildReport, humanReport } from '../src/scanner/report.js';
import { thrownFailureClass } from '../src/scanner/failures.js';
import { HISTORY_FLOOR } from '../src/scanner/ranges.js';
import { DashboardService } from '../src/web/service.js';
import { createDashboardServer } from '../src/web/server.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, demoData, demoFetch } from '../src/cli/demo.js';
import type { ScanInput } from '../src/scanner/engine.js';
import type { Providers } from '../src/scanner/types.js';
import type { Provider, WaitReason } from '../src/providers/limiter.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function database() { const dir = mkdtempSync(join(tmpdir(), 'layered-report-')); cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); }); return join(dir, 'test.sqlite'); }
function open(path = database()) { const store = new SqliteRewardsStore(path); cleanups.push(() => { try { store.close(); } catch { /* closed */ } }); return store; }
const DAY = 86400;
type Override = (host: string, method: string | null) => Promise<Response> | undefined;
/** Fixture providers over the demo endpoints. `override` answers a request instead, by host and JSON-RPC method; every request
 * that reaches a fixture is counted by provider. */
function fixtures(override: Override = () => undefined) {
  let clock = cutoff * 1000;
  const now = () => { clock += 1000; return clock; };
  const data = demoData();
  const received = { helius: 0, stonkfun: 0 };
  const fixture = demoFetch(data, now);
  const fetch: typeof globalThis.fetch = (resource, init) => {
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    received[url.hostname === 'www.stonkfun.xyz' ? 'stonkfun' : 'helius']++;
    const method = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method: string }).method : null;
    return override(url.hostname, method) ?? fixture(resource, init);
  };
  const providers = (store: SqliteRewardsStore) => (job: Parameters<typeof createRealProviders>[0]['job'], signal?: AbortSignal) =>
    createRealProviders({ store, job, apiKey: 'synthetic-key', fetch, now, retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 }, ...(signal ? { signal } : {}) });
  let sequence = 0;
  return { data, now, received, providers, scan(store: SqliteRewardsStore, overrides: Partial<ScanInput> = {}) {
    sequence++;
    return runScan(store, { wallet, cutoff, jobId: `report-${sequence}`, owner: `owner-${sequence}`,
      limits: { stonkfun: 60, helius: 200, pages: 200, resumes: 5, deadline: cutoff * 1000 + 30 * DAY * 1000 }, ...overrides }, providers(store), { now });
  } };
}
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: 'history', error: { code, message } });
const history = (answer: () => Promise<Response>): Override => (_host, method) => method === 'getTransactionsForAddress' ? answer() : undefined;

describe('days not loaded yet', () => {
  it('are not gaps, and retrieval stays complete for a seven-day wallet', async () => {
    const store = open(); const f = fixtures();
    const job = await f.scan(store);
    expect(job.status).toBe('complete');
    const report = buildReport(store, wallet);
    expect(report.coverage).toMatchObject({ retrieval: 'provider_query_exhausted', gaps: [], completed: [{ startTime: cutoff - 7 * DAY, endTime: cutoff }] });
    expect(report.history).toMatchObject({ floor: HISTORY_FLOOR, loadedFrom: cutoff - 7 * DAY, oldestLoadedDay: '2026-09-14',
      notLoadedYet: { startTime: HISTORY_FLOOR, endTime: cutoff - 7 * DAY, days: 45 }, earlierRemaining: true,
      nextBatch: { startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY, days: 7 },
      lastBatch: { kind: 'first', startTime: cutoff - 7 * DAY, endTime: cutoff, days: 7 } });
    expect(report.history.lastBatch!.elapsedSeconds).toBeGreaterThan(0);
    const text = humanReport(report);
    expect(text).toContain('Retrieval: provider_query_exhausted; gaps: 0.');
    expect(text).toContain('History: loaded from 2026-09-14; 45 days back to 2026-08-01 not loaded yet (scan --earlier loads the next 7). Last batch: first scan, 7 days in');
    expect(text).not.toContain('GAP:');

    // A failed day inside the loaded range is a gap; the days before it stay not loaded yet.
    const failing = open(); const g = fixtures(history(() => json({}, 503)));
    const paused = await g.scan(failing);
    expect(paused.status).toBe('paused');
    const partial = buildReport(failing, wallet);
    expect(partial.coverage.retrieval).toBe('partial');
    expect(partial.coverage.gaps).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(partial.history.notLoadedYet).toEqual({ startTime: HISTORY_FLOOR, endTime: cutoff - 7 * DAY, days: 45 });
    expect(partial.history.lastBatch).toBeNull();
  });

  it('reach zero once Load earlier arrives at the floor', async () => {
    const store = open(); const f = fixtures();
    await f.scan(store);
    let batches = 0;
    for (; batches < 10 && buildReport(store, wallet).history.earlierRemaining; batches++) expect((await f.scan(store, { kind: 'earlier' })).status).toBe('complete');
    // Six whole weeks back from 2026-09-14, then the clipped batch 2026-08-01 → 2026-08-03.
    expect(batches).toBe(7);
    const report = buildReport(store, wallet);
    expect(report.history).toMatchObject({ loadedFrom: HISTORY_FLOOR, oldestLoadedDay: '2026-08-01', notLoadedYet: null, earlierRemaining: false, nextBatch: null,
      lastBatch: { kind: 'earlier', startTime: HISTORY_FLOOR, endTime: cutoff - 49 * DAY, days: 3 } });
    expect(report.coverage).toMatchObject({ retrieval: 'provider_query_exhausted', gaps: [] });
    expect(humanReport(report)).toContain('History: loaded from 2026-08-01, the history floor. Last batch: Load earlier, 3 days in');
  });
});

describe('per-job request counters', () => {
  it('count every Helius and StonkFun request each job made, and job status exposes them', async () => {
    const store = open(); const f = fixtures();
    const first = await f.scan(store);
    expect(first.used).toMatchObject({ helius: f.received.helius, stonkfun: f.received.stonkfun });
    expect(first.used.helius).toBeGreaterThan(0); expect(first.used.stonkfun).toBeGreaterThan(0);
    const before = { ...f.received };
    const earlier = await f.scan(store, { kind: 'earlier' });
    expect(earlier.used).toMatchObject({ helius: f.received.helius - before.helius, stonkfun: f.received.stonkfun - before.stonkfun });
    const service = new DashboardService({ store: () => store, prepareProviders: () => { throw new Error('offline'); } });
    expect(service.job(first.id)).toMatchObject({ kind: 'refresh', requests: { helius: first.used.helius, stonkfun: first.used.stonkfun } });
    expect(service.job(earlier.id)).toMatchObject({ kind: 'earlier', requests: { helius: earlier.used.helius, stonkfun: earlier.used.stonkfun },
      batch: { kind: 'earlier', startTime: cutoff - 14 * DAY, endTime: cutoff - 7 * DAY }, savedDays: { completed: 7, planned: 7 }, savedNote: null });
  });

  it('keep counting across a retry and a resume of the same job', async () => {
    const store = open(); let fail = true;
    const f = fixtures(history(() => fail ? json({}, 503) : undefined!));
    const paused = await f.scan(store, { limits: { stonkfun: 60, helius: 200, pages: 200, resumes: 5, deadline: cutoff * 1000 + 30 * DAY * 1000 } });
    const afterFirst = { ...f.received };
    expect(paused.used).toMatchObject({ helius: afterFirst.helius, stonkfun: afterFirst.stonkfun });
    fail = false;
    const resumed = await f.scan(store, { resume: paused.id });
    expect(resumed.status).toBe('complete');
    expect(resumed.used).toMatchObject({ helius: f.received.helius, stonkfun: f.received.stonkfun });
  });
});

describe('job failure classes', () => {
  const saved = (store: SqliteRewardsStore, id: string) => new DashboardService({ store: () => store, prepareProviders: () => { throw new Error('offline'); } }).job(id)!;
  const historyRequests = (store: SqliteRewardsStore, id: string) => store.ranges(id).filter(range => range.pages > 0 || range.restarts > 0).length;

  it('key rejected: stops at the first refused day, saving nothing it did not complete', async () => {
    const store = open(); let calls = 0;
    const f = fixtures(history(() => { calls++; return json(rpcError(-32000, 'Invalid API key'), 401); }));
    const job = await f.scan(store);
    expect(job).toMatchObject({ status: 'paused', error: 'authentication', failure: { class: 'key_rejected', message: 'Helius rejected the API key.' } });
    expect(calls).toBe(1); expect(historyRequests(store, job.id)).toBe(0);
    expect(saved(store, job.id)).toMatchObject({ failureClass: 'key_rejected', failureDetail: null, savedDays: { completed: 0, planned: 7 },
      savedNote: 'Completed days are saved: 0 of 7.' });
  });

  it('Helius rate limited: retried, then classed as temporary rather than a failure', async () => {
    const store = open(); let calls = 0;
    const f = fixtures(history(() => { calls++; return calls <= 4 ? json(rpcError(-32005, 'Too many requests'), 429) : undefined!; }));
    const job = await f.scan(store);
    // The first day's four attempts were all rate limited; every later day finished.
    expect(job).toMatchObject({ status: 'paused', failure: { class: 'helius_rate_limited' } });
    expect(job.failure!.message).toContain('temporary, not a failure');
    expect(saved(store, job.id)).toMatchObject({ failureClass: 'helius_rate_limited', savedDays: { completed: 6, planned: 7 }, savedNote: 'Completed days are saved: 6 of 7.' });
  });

  it('Helius rate limited while running: job status shows the wait as retrying', async () => {
    const store = open();
    let release: () => void = () => undefined;
    const waitingProviders = (signal: AbortSignal, waiting: (provider: Provider, reason: WaitReason, delayMs: number) => void): Providers => ({
      registry: () => { waiting('helius', 'rate_limit', 5000); return new Promise((_resolve, reject) => { release = () => { reject(new Error('cancelled')); }; signal.addEventListener('abort', release, { once: true }); }); },
      hydrate: () => Promise.resolve(null), history: () => { throw new Error('unexpected'); }, price: () => { throw new Error('unexpected'); },
    });
    let clock = cutoff * 1000;
    const service = new DashboardService({ store: () => store, now: () => (clock += 1000),
      prepareProviders: () => (_job, signal, _progress, waiting) => waitingProviders(signal, waiting) });
    cleanups.push(() => service.shutdown());
    const started = service.start(wallet);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.job(started.id)).toMatchObject({ runningLocally: true, failureClass: 'helius_rate_limited',
      failureMessage: expect.stringContaining('temporary, not a failure') as unknown, savedNote: null });
    service.cancel(started.id); await service.settle();
    expect(service.job(started.id)).toMatchObject({ cancelled: true, failureClass: null, savedNote: 'Completed days are saved: 0 of 7.' });
    release();
  });

  it.each([
    ['a plan message', json(rpcError(-32000, 'Monthly credits exhausted; upgrade your plan to continue'), 403), 'Monthly credits exhausted; upgrade your plan to continue'],
    ['a 403 refusal', json({ message: 'Forbidden' }, 403), 'Forbidden'],
  ])('Helius quota or plan limit, from %s, keeps Helius’s own message', async (_label, response, detail) => {
    const store = open(); let calls = 0;
    const f = fixtures(history(() => { calls++; return response.then(item => item.clone()); }));
    const job = await f.scan(store);
    expect(job.failure).toEqual({ class: 'helius_quota', message: 'Helius refused the request: a quota or plan limit.', detail });
    expect(calls).toBe(1);
    expect(saved(store, job.id)).toMatchObject({ failureClass: 'helius_quota', failureDetail: detail, savedNote: 'Completed days are saved: 0 of 7.' });
  });

  it('StonkFun unreachable: history still loads, and the class says what is missing', async () => {
    const store = open();
    const f = fixtures(host => host === 'www.stonkfun.xyz' ? Promise.reject(new TypeError('fetch failed')) : undefined);
    const job = await f.scan(store);
    expect(job).toMatchObject({ status: 'complete', failure: { class: 'stonkfun_unreachable' } });
    expect(store.coverage('mainnet-beta', wallet)).toEqual([{ startTime: cutoff - 7 * DAY, endTime: cutoff }]);
    expect(saved(store, job.id)).toMatchObject({ failureClass: 'stonkfun_unreachable', savedNote: null });
  });

  it('network: a Helius request that never reaches the server', async () => {
    const store = open();
    const f = fixtures(history(() => Promise.reject(new TypeError('fetch failed'))));
    const job = await f.scan(store);
    expect(job).toMatchObject({ status: 'paused', failure: { class: 'network', message: 'A network request to Helius failed or timed out.' } });
    expect(store.coverage('mainnet-beta', wallet)).toEqual([]);
  });

  it('other: anything unrecognized, with the raw message and no credential or URL', async () => {
    const store = open();
    const f = fixtures(history(() => json(rpcError(-32099, 'Backend exploded near https://example.test/?api-key=secret-value, token=abc123'))));
    const job = await f.scan(store);
    expect(job.failure).toMatchObject({ class: 'other', message: 'The scan stopped on an unrecognized error.' });
    expect(job.failure!.detail).toBe('Helius provider_error HTTP 200 JSON-RPC -32099: Backend exploded near [url] token=[redacted]');
    expect(JSON.stringify(job)).not.toMatch(/secret-value|abc123|api-key/);
    expect(thrownFailureClass(new Error('database disk image is malformed'))).toEqual({ class: 'other', message: 'The scan stopped on an unrecognized error.', detail: 'database disk image is malformed' });
    for (const code of ['cancelled', 'deadline', 'page_budget', 'request_budget_or_deadline']) expect(thrownFailureClass(new Error(code))).toBeNull();
    expect(thrownFailureClass(new Error('network'))).toMatchObject({ class: 'network' });
  });
});

describe('Load earlier through the jobs API', () => {
  async function api(service: DashboardService) {
    const app = createDashboardServer(service); const origin = await app.listen(0); cleanups.push(() => app.close());
    return { origin, call(path: string, body?: unknown) {
      return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = request(origin, { path, method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' } }, response => {
          let text = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { text += part; });
          response.on('end', () => { resolve({ status: response.statusCode!, body: JSON.parse(text) as Record<string, unknown> }); });
        }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
      });
    } };
  }
  it('starts, pauses, resumes and completes a batch, and refuses at the floor with a clear message', async () => {
    const store = open(); const f = fixtures();
    let clock = cutoff * 1000;
    // While `hold` is set, each history page waits for it, so a cancel always finds the batch running.
    let hold: Promise<void> | null = null;
    const service = new DashboardService({ store: () => store, now: () => (clock += 1000), prepareProviders: () => (job, signal) => {
      const providers = f.providers(store)(job, signal);
      const history = providers.history.bind(providers);
      providers.history = async (...args: Parameters<Providers['history']>) => { if (hold) await hold; return history(...args); };
      return providers;
    } });
    cleanups.push(() => service.shutdown());
    const http = await api(service);
    expect(await http.call('/api/v1/scans', { wallet, kind: 'earlier' })).toMatchObject({ status: 409,
      body: { error: 'wallet_not_loaded', message: 'Nothing is loaded for this wallet yet; refresh it first, then load earlier history.' } });
    expect((await http.call('/api/v1/scans', { wallet, kind: 'sideways' })).status).toBe(400);
    expect((await http.call('/api/v1/scans', { wallet })).status).toBe(202); await service.settle();
    // The service's cutoff is its clock's second, a moment past the fixture cutoff.
    const loaded = (await http.call(`/api/v1/wallets/${wallet}/report`)).body.history as { loadedFrom: number };

    // A batch cancelled mid-way keeps its completed days and resumes as the same job.
    let release = () => {};
    hold = new Promise(resolve => { release = resolve; });
    const started = await http.call('/api/v1/scans', { wallet, kind: 'earlier' });
    expect(started).toMatchObject({ status: 202, body: { kind: 'earlier', runningLocally: true, batch: { kind: 'earlier', startTime: loaded.loadedFrom - 7 * DAY, endTime: loaded.loadedFrom } } });
    const id = started.body.id as string;
    const cancel = await http.call(`/api/v1/jobs/${id}/cancel`, {});
    hold = null; release();
    expect(cancel.status).toBe(200); await service.settle();
    const cancelled = await http.call(`/api/v1/jobs/${id}`);
    expect(cancelled.body).toMatchObject({ kind: 'earlier', status: 'paused', cancelled: true, canResume: true });
    expect(cancelled.body.savedNote).toMatch(/^Completed days are saved: \d of 7\.$/);
    expect((await http.call(`/api/v1/wallets/${wallet}/report`)).body.history).toMatchObject({ loadedFrom: loaded.loadedFrom });
    expect((await http.call(`/api/v1/jobs/${id}/resume`, {})).status).toBe(200); await service.settle();
    const done = await http.call(`/api/v1/jobs/${id}`);
    expect(done.body).toMatchObject({ kind: 'earlier', status: 'complete', savedDays: { completed: 7, planned: 7 }, failureClass: null });
    expect((done.body.requests as { helius: number }).helius).toBeGreaterThan(0);
    const history = (await http.call(`/api/v1/wallets/${wallet}/report`)).body.history;
    expect(history).toMatchObject({ loadedFrom: loaded.loadedFrom - 7 * DAY, earlierRemaining: true, lastBatch: { kind: 'earlier', days: 7 } });

    // Further batches reach the floor, one per request.
    for (let batch = 0; batch < 10 && ((await http.call(`/api/v1/wallets/${wallet}/report`)).body.history as { earlierRemaining: boolean }).earlierRemaining; batch++) {
      expect((await http.call('/api/v1/scans', { wallet, kind: 'earlier' })).status).toBe(202); await service.settle();
    }
    expect((await http.call(`/api/v1/wallets/${wallet}/report`)).body.history).toMatchObject({ loadedFrom: HISTORY_FLOOR, earlierRemaining: false, notLoadedYet: null });
    expect(await http.call('/api/v1/scans', { wallet, kind: 'earlier' })).toMatchObject({ status: 409,
      body: { error: 'earlier_history_at_floor', message: 'History is already loaded back to the history floor; there is nothing earlier to load.' } });
  });
  it('checks chosen days, and refuses more than seven days or days outside the loaded range with a clear message', async () => {
    const store = open(); const f = fixtures();
    let clock = cutoff * 1000;
    const service = new DashboardService({ store: () => store, now: () => (clock += 1000), prepareProviders: () => (job, signal) => f.providers(store)(job, signal) });
    cleanups.push(() => service.shutdown());
    const http = await api(service);
    const check = (startDay: string, endDay: string) => http.call('/api/v1/scans', { wallet, kind: 'check', startDay, endDay });
    expect(await check('2026-09-20', '2026-09-21')).toMatchObject({ status: 409, body: { error: 'wallet_not_loaded' } });
    expect((await http.call('/api/v1/scans', { wallet })).status).toBe(202); await service.settle();
    // Loaded: 2026-09-14 14:13 UTC to the service's cutoff, a moment past 2026-09-21 14:13.
    expect(await check('2026-09-14', '2026-09-21')).toMatchObject({ status: 400, body: { error: 'check_range_too_long', message: 'Rescan at most 7 days at a time.' } });
    expect(await check('2026-09-12', '2026-09-13')).toMatchObject({ status: 409, body: { error: 'check_range_outside_loaded', message: 'Rescan only days inside the loaded history.' } });
    expect(await check('2026-09-22', '2026-09-22')).toMatchObject({ status: 409, body: { error: 'check_range_outside_loaded' } });
    expect(await check('2026-09-21', '2026-09-20')).toMatchObject({ status: 400, body: { error: 'check_range_invalid' } });
    expect(await check('2026-02-30', '2026-09-20')).toMatchObject({ status: 400, body: { error: 'check_range_invalid' } });
    expect((await http.call('/api/v1/scans', { wallet, startDay: '2026-09-20', endDay: '2026-09-20' })).status).toBe(400);
    const started = await check('2026-09-15', '2026-09-21');
    expect(started).toMatchObject({ status: 202, body: { kind: 'check', check: { startTime: Date.parse('2026-09-15T00:00:00Z') / 1000, endTime: Date.parse('2026-09-22T00:00:00Z') / 1000, days: 7 } } });
    await service.settle();
    // Every day was checked when it was read, so the check lists each day once and fetches nothing.
    expect((await http.call(`/api/v1/jobs/${started.body.id as string}`)).body).toMatchObject({ kind: 'check', status: 'complete', savedDays: { completed: 7, planned: 7 },
      checkResult: { days: 7, checkedDays: 7, unconfirmedDays: 0, newTransactions: 0 }, requests: { helius: 7, stonkfun: 0 } });
  });
});

describe('CLI scan and scan --earlier', () => {
  const cli = (path: string, ...args: string[]) => spawnSync(process.execPath, ['--import', './tests/fixtures/demo-network.mjs', 'dist/cli/main.js', ...args, '--db', path],
    { encoding: 'utf8', env: { ...process.env, HELIUS_API_KEY: 'synthetic-cli-key' } });
  it('refresh and load one batch each, printing the request counts at the end', () => {
    const path = database();
    const scan = cli(path, 'scan', wallet, '--cutoff', String(cutoff));
    expect(scan.status, scan.stderr).toBe(0);
    expect(scan.stdout).toContain('History: loaded from 2026-09-14; 45 days back to 2026-08-01 not loaded yet (scan --earlier loads the next 7).');
    expect(scan.stdout.trim().split('\n').at(-1)).toMatch(/^Provider requests this job: StonkFun \d+ of \d+ · Helius [1-9]\d* of 200 · pages 7 of 200$/);
    // Six whole weeks, then the batch clipped at the floor reads its three days, one page each.
    for (const [loadedFrom, pages] of [['2026-09-07', 7], ['2026-08-31', 7], ['2026-08-24', 7], ['2026-08-17', 7], ['2026-08-10', 7], ['2026-08-03', 7], ['2026-08-01', 3]] as const) {
      const earlier = cli(path, 'scan', wallet, '--earlier');
      expect(earlier.status, earlier.stderr).toBe(0);
      expect(earlier.stdout).toContain(pages === 7 ? `History: loaded from ${loadedFrom}; ` : `History: loaded from ${loadedFrom}, the history floor.`);
      expect(earlier.stdout.trim().split('\n').at(-1)).toMatch(new RegExp(`^Provider requests this job: StonkFun \\d+ of \\d+ · Helius [1-9]\\d* of 200 · pages ${pages} of 200$`));
    }
    const refused = cli(path, 'scan', wallet, '--earlier');
    expect(refused.status).toBe(1);
    expect(refused.stderr.trim()).toBe('Rewards scanner: history is already loaded back to the history floor; there is nothing earlier to load (earlier_history_at_floor).');
    const report = JSON.parse(execFileSync(process.execPath, ['--import', './tests/fixtures/no-network.mjs', 'dist/cli/main.js', 'report', wallet, '--db', path, '--json'],
      { encoding: 'utf8' })) as ReturnType<typeof buildReport>;
    expect(report.history).toMatchObject({ loadedFrom: HISTORY_FLOOR, earlierRemaining: false });
    expect(report.coverage.gaps).toEqual([]);
    expect(cli(path, 'resume', wallet, '--earlier').stderr).toContain('invalid_command');
  }, 60_000); // Eleven CLI processes: eight scans to the floor and three checks.
  it('refuses scan --earlier for a wallet with nothing loaded, without credentials or network', () => {
    const path = database();
    const refused = spawnSync(process.execPath, ['--import', './tests/fixtures/no-network.mjs', 'dist/cli/main.js', 'scan', wallet, '--earlier', '--db', path], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr.trim()).toBe('Rewards scanner: nothing is loaded for this wallet yet; run scan first, then scan --earlier (wallet_not_loaded).');
  });
});
