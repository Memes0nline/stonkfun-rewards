import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { addressSchema } from '../helius/query.js';
import { PROVIDER_KEY_PATTERN } from './key.js';
import type { DashboardService } from './service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A refresh unless `kind` asks for one Load earlier batch, or a check of the UTC days `startDay` through `endDay`. */
const scanBody = z.object({ wallet: addressSchema, kind: z.enum(['refresh', 'earlier', 'check']).optional(), startDay: day.optional(), endDay: day.optional() }).strict();
/** A check's whole UTC days as seconds, from 00:00 of the first to 00:00 after the last; null unless both are real days. */
function checkDays(startDay: string | undefined, endDay: string | undefined) {
  const at = (value: string | undefined) => {
    const time = value === undefined ? Number.NaN : Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / 1000 : null;
  };
  const start = at(startDay); const end = at(endDay);
  return start === null || end === null ? null : { startTime: start, endTime: end + 86400 };
}
const emptyBody = z.object({}).strict();
// The key is checked for shape only; it is never echoed, logged or stored by this layer.
const keyBody = z.object({ key: z.string().regex(PROVIDER_KEY_PATTERN), remember: z.boolean() }).strict();
const errors: Record<string, number> = {
  invalid_request: 400, invalid_origin: 403, invalid_host: 403, not_found: 404, wallet_not_tracked: 404,
  method_not_allowed: 405, body_too_large: 413, unsupported_content_type: 415,
  provider_not_configured: 409, job_not_resumable: 409, job_not_running_locally: 409,
  job_admission_failed: 409, local_work_busy: 409, offline_mode: 409, database_requires_migration: 409, key_not_saved: 500,
  earlier_history_at_floor: 409, wallet_not_loaded: 409,
  check_range_invalid: 400, check_range_too_long: 400, check_range_outside_loaded: 409,
};
/** Plain words for refusals the page shows as they are. */
const messages: Record<string, string> = {
  earlier_history_at_floor: 'History is already loaded back to the history floor; there is nothing earlier to load.',
  wallet_not_loaded: 'Nothing is loaded for this wallet yet; refresh it first, then load earlier history.',
  check_range_invalid: 'Choose a start day and an end day, the start on or before the end.',
  check_range_too_long: 'Rescan at most 7 days at a time.',
  check_range_outside_loaded: 'Rescan only days inside the loaded history.',
};
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new Error('unsupported_content_type');
  if (request.headers['content-encoding']) throw new Error('unsupported_content_type');
  if (Number(request.headers['content-length'] ?? 0) > 2048) throw new Error('body_too_large');
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length; if (length > 2048) throw new Error('body_too_large'); chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('invalid_request'); }
}
export function createDashboardServer(service: DashboardService, staticDirectory?: string) {
  // Build a static allowlist once. URL paths never become filesystem paths.
  const files = new Map<string, { bytes: Buffer; type: string }>();
  if (staticDirectory) {
    files.set('/', { bytes: readFileSync(join(staticDirectory, 'index.html')), type: 'text/html; charset=utf-8' });
    for (const name of readdirSync(join(staticDirectory, 'assets'))) {
      if (!/^[a-zA-Z0-9_-]+\.(js|css)$/.test(name)) continue;
      files.set(`/assets/${name}`, { bytes: readFileSync(join(staticDirectory, 'assets', name)), type: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
    }
  }
  let origin = '';
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      if (request.headers.host !== new URL(origin).host) throw new Error('invalid_host');
      const rawPath = request.url ?? '';
      if (!rawPath.startsWith('/') || rawPath.includes('%') || rawPath.includes('..') || rawPath.includes('\\')) throw new Error('invalid_request');
      const url = new URL(rawPath, origin);
      if (url.origin !== origin || url.search) throw new Error('invalid_request');
      const path = url.pathname;
      const mutation = path === '/api/v1/scans' || path === '/api/v1/provider-key' || /^\/api\/v1\/jobs\/[^/]+\/(resume|cancel)$/.test(path)
        || /^\/api\/v1\/wallets\/[^/]+\/reclassify$/.test(path);
      if (request.method !== (mutation ? 'POST' : 'GET')) {
        response.setHeader('Allow', mutation ? 'POST' : 'GET'); throw new Error('method_not_allowed');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new Error('invalid_origin');
      if (request.headers.origin && request.headers.origin !== origin) throw new Error('invalid_origin');
      if (mutation && request.headers.origin !== origin) throw new Error('invalid_origin');
      const payload = mutation ? await body(request) : undefined;
      if (path === '/api/v1/health') return send(response, 200, service.health());
      if (path === '/api/v1/wallets') return send(response, 200, { wallets: service.wallets() });
      if (path === '/api/v1/provider-key') {
        const parsed = keyBody.safeParse(payload); if (!parsed.success) throw new Error('invalid_request');
        return send(response, 200, service.configureProvider(parsed.data.key, parsed.data.remember));
      }
      if (path === '/api/v1/scans') {
        const parsed = scanBody.safeParse(payload); if (!parsed.success) throw new Error('invalid_request');
        if (parsed.data.kind !== 'check' && (parsed.data.startDay !== undefined || parsed.data.endDay !== undefined)) throw new Error('invalid_request');
        const days = parsed.data.kind === 'check' ? checkDays(parsed.data.startDay, parsed.data.endDay) : undefined;
        if (days === null) throw new Error('check_range_invalid');
        return send(response, 202, service.start(parsed.data.wallet, undefined, parsed.data.kind, days));
      }
      const walletRoute = /^\/api\/v1\/wallets\/([^/]+)\/(report|job|sources|reclassify)$/.exec(path);
      if (walletRoute) {
        const wallet = addressSchema.safeParse(walletRoute[1]); if (!wallet.success) throw new Error('invalid_request');
        if (walletRoute[2] === 'reclassify' && !emptyBody.safeParse(payload).success) throw new Error('invalid_request');
        const result = walletRoute[2] === 'report' ? service.report(wallet.data) : walletRoute[2] === 'job' ? service.job(wallet.data)
          : walletRoute[2] === 'sources' ? service.sources(wallet.data) : await service.reclassify(wallet.data);
        return send(response, 200, result);
      }
      const jobRoute = /^\/api\/v1\/jobs\/([A-Za-z0-9_-]{1,90})(?:\/(resume|cancel))?$/.exec(path);
      if (jobRoute) {
        const id = jobRoute[1]!; const job = service.job(id); if (!job) throw new Error('not_found');
        if (mutation && !emptyBody.safeParse(payload).success) throw new Error('invalid_request');
        return send(response, 200, jobRoute[2] === 'resume' ? service.start(job.wallet, id) : jobRoute[2] === 'cancel' ? service.cancel(id) : job);
      }
      const file = files.get(path);
      if (file) { response.writeHead(200, { 'Content-Type': file.type }); response.end(file.bytes); return; }
      throw new Error('not_found');
    })().catch((error: unknown) => {
      const code = error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : 'dashboard_failed';
      if (!response.headersSent && !response.destroyed) send(response, errors[code] ?? 500, { error: code, ...(messages[code] ? { message: messages[code] } : {}) });
    });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  return { server, async listen(port = 4317) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen_failed');
    origin = `http://127.0.0.1:${address.port}`; return origin;
  }, async close() { await service.shutdown(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}
