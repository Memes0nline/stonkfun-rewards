import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { DashboardService } from '../src/web/service.js';
import { createDashboardServer } from '../src/web/server.js';
import { createKeyIntake, rememberKey } from '../src/web/key.js';
import { createRealProviders } from '../src/providers/real.js';
import { DEMO_CUTOFF, DEMO_WALLET, demoData, demoFetch } from '../src/cli/demo.js';

/** A synthetic, UUID-shaped key: never a real credential. */
const KEY = '5f2b1c9e-0d4a-4c1b-9a77-synthetic0001';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'rewards-key-')); cleanups.push(() => { rmSync(path, { recursive: true, force: true }); }); return path; }

describe('key intake', () => {
  it('keeps the key in memory only unless asked to remember it', () => {
    const dir = directory(); const intake = createKeyIntake(dir);
    expect(intake.current()).toBeUndefined();
    intake.accept(KEY, false);
    expect(intake.current()).toBe(KEY);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('remembers it in the ignored .env, keeping every other line and replacing an older key', () => {
    const dir = directory();
    writeFileSync(join(dir, '.env'), 'SCANNER_CONCURRENCY=2\r\nHELIUS_API_KEY=older-key-value\r\n# a comment\nexport HELIUS_API_KEY=duplicate-value\n');
    createKeyIntake(dir).accept(KEY, true);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`SCANNER_CONCURRENCY=2\nHELIUS_API_KEY=${KEY}\n# a comment\n`);
    // A fresh folder gets a file with the key alone, and no temporary file is left behind.
    const empty = directory(); rememberKey(empty, KEY);
    expect(readFileSync(join(empty, '.env'), 'utf8')).toBe(`HELIUS_API_KEY=${KEY}\n`);
    expect(readdirSync(empty)).toEqual(['.env']);
  });

  it.each(['short', 'has space inside-key', 'quote"key-value', 'semi;colon-key', 'x'.repeat(257), 'dollar$key-value', 'new\nline-key'])(
    'refuses %j without keeping or writing anything', value => {
      const dir = directory(); const intake = createKeyIntake(dir);
      expect(() => { intake.accept(value, true); }).toThrow('invalid_request');
      expect(intake.current()).toBeUndefined();
      expect(existsSync(join(dir, '.env'))).toBe(false);
    });
});

async function server(options: { offline?: boolean; dir?: string } = {}) {
  const store = new SqliteRewardsStore(':memory:'); cleanups.push(() => { store.close(); });
  const intake = createKeyIntake(options.dir ?? directory());
  const data = demoData();
  let clock = DEMO_CUTOFF * 1000;
  const now = () => { clock += 1000; return clock; };
  const dispatched: string[] = [];
  const service = new DashboardService({ store: () => store, now, offline: options.offline ?? false,
    prepareProviders: () => {
      const key = intake.current();
      if (!key) throw new Error('provider_not_configured');
      return (job, signal) => createRealProviders({ store, job, apiKey: key, signal, now,
        fetch: (input, init) => { dispatched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return demoFetch(data, now)(input, init); } });
    },
    acceptProviderKey: (key, remember) => { intake.accept(key, remember); } });
  cleanups.push(() => service.shutdown());
  const app = createDashboardServer(service); const origin = await app.listen(0); cleanups.push(() => app.close());
  const responses: string[] = [];
  const call = (path: string, init: { method?: string; body?: string; headers?: OutgoingHttpHeaders } = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(origin, { path, method: init.method ?? 'GET', headers: init.headers ?? {} }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { text += part; });
        response.on('end', () => { responses.push(text, JSON.stringify(response.headers)); resolve({ status: response.statusCode!, text }); });
      }); req.on('error', reject); if (init.body) req.write(init.body); req.end();
    });
  const post = (path: string, body: unknown, headers: OutgoingHttpHeaders = { Origin: origin }) =>
    call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  return { service, intake, origin, call, post, responses, dispatched };
}

describe('key entry through the local server', () => {
  it('accepts a key once under the mutation checks, configures the next scan, and never sends the key back or logs it', async () => {
    const logged: unknown[][] = [];
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
    const dir = directory(); const h = await server({ dir });
    // Before a key: a scan finds no provider.
    expect(JSON.parse((await h.call('/api/v1/health')).text)).toMatchObject({ providerConfigured: false });
    expect(await h.post('/api/v1/scans', { wallet: DEMO_WALLET })).toMatchObject({ status: 409, text: '{"error":"provider_not_configured"}' });
    // Mutation checks: no Origin, a foreign Origin, the wrong content type and a malformed body are refused.
    expect((await h.post('/api/v1/provider-key', { key: KEY, remember: false }, {})).status).toBe(403);
    expect((await h.post('/api/v1/provider-key', { key: KEY, remember: false }, { Origin: 'http://127.0.0.1:1' })).status).toBe(403);
    expect((await h.call('/api/v1/provider-key', { method: 'POST', body: JSON.stringify({ key: KEY, remember: false }), headers: { Origin: h.origin, 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await h.post('/api/v1/provider-key', { key: KEY })).status).toBe(400);
    expect((await h.post('/api/v1/provider-key', { key: KEY, remember: false, extra: true })).status).toBe(400);
    expect((await h.post('/api/v1/provider-key', { key: 'not a key', remember: false })).status).toBe(400);
    expect((await h.call('/api/v1/provider-key')).status).toBe(405);
    expect(h.intake.current()).toBeUndefined();
    // The key is taken once; the answer is the health record, now configured.
    const saved = await h.post('/api/v1/provider-key', { key: KEY, remember: false });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text)).toEqual({ version: 1, providerConfigured: true, configurationChecked: true, offline: false, activeWallets: [] });
    expect(readdirSync(dir)).toEqual([]);
    // The next scan uses it.
    expect((await h.post('/api/v1/scans', { wallet: DEMO_WALLET })).status).toBe(202);
    await h.service.settle();
    expect(h.dispatched.some(url => url.includes(`api-key=${encodeURIComponent(KEY)}`))).toBe(true);
    for (const path of ['/api/v1/health', '/api/v1/wallets', `/api/v1/wallets/${DEMO_WALLET}/report`, `/api/v1/wallets/${DEMO_WALLET}/job`]) {
      expect((await h.call(path)).status).toBe(200);
    }
    await h.post('/api/v1/provider-key', { key: `${KEY}-changed`, remember: false });
    // Nowhere in any response body or header, nor in any log line.
    expect(h.responses.length).toBeGreaterThan(20);
    for (const text of h.responses) { expect(text).not.toContain(KEY); expect(text).not.toContain('synthetic0001'); }
    for (const line of logged) expect(JSON.stringify(line)).not.toContain('synthetic0001');
  });

  it('writes the ignored .env only when Remember is set', async () => {
    const dir = directory(); const h = await server({ dir });
    expect((await h.post('/api/v1/provider-key', { key: KEY, remember: true })).status).toBe(200);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`HELIUS_API_KEY=${KEY}\n`);
    for (const text of h.responses) expect(text).not.toContain(KEY);
  });

  it('refuses a key in offline viewing and keeps nothing', async () => {
    const dir = directory(); const h = await server({ offline: true, dir });
    expect(await h.post('/api/v1/provider-key', { key: KEY, remember: true })).toMatchObject({ status: 409, text: '{"error":"offline_mode"}' });
    expect(h.intake.current()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a failed write without keeping the key', async () => {
    const h = await server({ dir: join(directory(), 'missing-folder') });
    expect(await h.post('/api/v1/provider-key', { key: KEY, remember: true })).toMatchObject({ status: 500, text: '{"error":"key_not_saved"}' });
    expect(h.intake.current()).toBeUndefined();
    expect(JSON.parse((await h.call('/api/v1/health')).text)).toMatchObject({ providerConfigured: false });
  });
});
