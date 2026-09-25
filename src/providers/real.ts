import { z } from 'zod';
import { HeliusHistoryClient } from '../helius/client.js';
import { fullTransactionSchema } from '../helius/schemas.js';
import { SIGNATURE_PAGE_SIZE } from '../helius/query.js';
import { failure, hasRpcError, providerFailure, SafeFailure } from '../helius/errors.js';
import { abortable } from '../helius/transport.js';
import { loadStonkFunRegistry } from '../registry/loader.js';
import { PublicClient, RequestFailure, sleep } from '../registry/http.js';
import { mintSchema } from '../registry/schemas.js';
import type { Job, Price, Providers, RewardsStore } from '../scanner/types.js';
import { decimal } from '../scanner/decimal.js';
import type { HoldingsSnapshot, SnapshotHolding } from '../scanner/holdings.js';
import { backoffDelay, DAS_BUCKET, DAS_RATE_LIMIT, DEFAULT_RATE_LIMITS, DEFAULT_RETRY, retryAfterMs } from './limiter.js';
import type { Provider, RateLimit, RetryPolicy, WaitReason } from './limiter.js';

const priceNumber = z.union([z.number().finite().nonnegative(), z.string().max(1024)]).refine(value => {
  try { decimal(String(value)); return true; } catch { return false; }
});
const pricingSchema = z.object({ data: z.object({ quote: z.object({ mint: mintSchema }), prices: z.object({
  quoteUsd: priceNumber.nullish(), observedAt: z.iso.datetime({ offset: true }),
}) }), meta: z.object({ generatedAt: z.iso.datetime({ offset: true }).optional() }).optional() });
const assetSchema = z.object({ id: mintSchema, token_info: z.object({ price_info: z.object({
  currency: z.literal('USD'), price_per_token: priceNumber,
}).optional() }).optional() });
/** A page of `getAssetsByOwner`. Items are read one by one: anything without a whole raw balance and decimals (an NFT, a
 * compressed asset) is not a fungible holding and is skipped. */
const ownedPageSchema = z.object({ items: z.array(z.unknown()).max(1000) });
const label = (max: number) => z.string().max(max).optional().catch(undefined);
const ownedTokenSchema = z.object({ id: mintSchema,
  content: z.object({ metadata: z.object({ name: label(200), symbol: label(50) }).optional().catch(undefined) }).optional().catch(undefined),
  token_info: z.object({ balance: z.string().regex(/^\d{1,40}$/), decimals: z.number().int().min(0).max(30), symbol: label(50) }) });
/** Balances above 2^53 lose digits as JSON numbers; the reviver keeps each balance's source text. */
const exactBalances = (key: string, value: unknown, context?: { source?: string }) =>
  key === 'balance' && typeof value === 'number' && typeof context?.source === 'string' ? context.source : value;
/** Assets per `getAssetsByOwner` page, Helius's maximum. */
export const HOLDINGS_PAGE_LIMIT = 1000;
/** Pages read before a snapshot is abandoned as incomplete. */
const HOLDINGS_MAX_PAGES = 20;
type RpcMethod = 'getTransaction' | 'getAsset' | 'getAssetsByOwner';

/** USDC configuration read for the published reward-mode withdraw authority: one StonkFun request per job. */
export const WITHDRAW_AUTHORITY_CONFIGURATION_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface RealProviderOptions {
  apiKey: string; store: RewardsStore; job: Job; now?: () => number; fetch?: typeof globalThis.fetch;
  signal?: AbortSignal; cataloguePages?: number; liveAllowance?: boolean;
  progress?: (stage: string, count: number) => void;
  /** Each provider's token bucket; defaults are 8 per second with a burst of 10 for Helius and 4 with 5 for StonkFun. */
  limits?: Partial<Record<Provider, RateLimit>>;
  /** Retries after a rate limit, a 5xx or a network failure, and their backoff; every retry is a request against the budget. */
  retry?: RetryPolicy;
  random?: () => number;
  /** Every wait before a dispatch, with its reason. An observer: it never changes what is requested. */
  waiting?: (provider: Provider, reason: WaitReason, delayMs: number) => void;
  /** The DAS bucket; 2 per second with no burst by default. */
  dasLimit?: RateLimit;
  /** Assets per holdings page; Helius's maximum of 1000 by default. */
  holdingsPageLimit?: number;
}

const HOSTS: Readonly<Record<string, Provider>> = { 'www.stonkfun.xyz': 'stonkfun', 'mainnet.helius-rpc.com': 'helius' };
/** A dispatched request the network refused. No provider or operating-system text is kept. */
class DispatchedFailure extends Error { constructor() { super('network'); } }
/** A request refused before dispatch, in each client's own non-retryable terms. Codes are the existing ones, because retained
 * registry sources are validated against them. */
const refusal = (provider: Provider, cooldown: boolean) => provider === 'helius'
  ? new SafeFailure(cooldown ? { ...failure('transient', { reason: 'rate_limit' }), retryable: false } : failure('request_budget'))
  : new RequestFailure(cooldown ? 'rate_limit' : 'network', false);

/** Single shared persistent allocation for history, hydration, pricing, and public registry requests. */
export function createRealProviders(options: RealProviderOptions): Providers {
  const { store, job } = options;
  if (job.network !== 'mainnet-beta') throw new Error('real_provider_requires_mainnet');
  const now = options.now ?? Date.now;
  const rawFetch = options.fetch ?? globalThis.fetch;
  const signal = options.signal;
  const limits: Record<Provider, RateLimit> = { ...DEFAULT_RATE_LIMITS, ...options.limits };
  const retry = options.retry ?? DEFAULT_RETRY;
  const random = options.random ?? Math.random;
  const waiting = (provider: Provider, reason: WaitReason, delayMs: number) => {
    try { options.waiting?.(provider, reason, delayMs); } catch { /* observer only */ }
  };
  const safe = (value: unknown) => {
    const text = JSON.stringify(value) ?? '';
    return !text.includes(JSON.stringify(options.apiKey).slice(1, -1)) && !text.includes(encodeURIComponent(options.apiKey))
      && !/https?:\/\/[^\s"<>]*[?&](?:api[-_]?key|access_token|auth_token|token|authorization|password|client_secret)=/i.test(text)
      && !/https?:\/\/[^\s/:"]+:[^\s/@"]+@/i.test(text);
  };
  // Consecutive rate-limit responses per provider, which set the provider-wide backoff when no Retry-After is given, and the
  // reason behind the cooldown this instance last set, for reporting a wait.
  const limited: Record<Provider, number> = { helius: 0, stonkfun: 0 };
  const cooldowns = new Map<Provider, { until: number; reason: WaitReason }>();
  const cooldown = (provider: Provider, until: number, reason: WaitReason) => {
    store.cooldown(provider, until);
    if (until >= (cooldowns.get(provider)?.until ?? 0)) cooldowns.set(provider, { until, reason });
  };
  /** The end of a rate limit: the server's Retry-After, or else the provider's backoff for its consecutive rate limits. */
  const rateLimited = (provider: Provider, current: number, after: number | null) => {
    limited[provider]++;
    return current + (after ?? backoffDelay(limited[provider], retry, random));
  };
  const dasLimit = options.dasLimit ?? DAS_RATE_LIMIT;
  /** Every provider request. A DAS call takes its token from the DAS bucket, after any Helius-wide server cooldown. */
  const dispatch = async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit | undefined, das: boolean) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const provider = HOSTS[url.hostname];
    if (!provider) throw new Error('provider_not_allowed');
    if (das && provider !== 'helius') throw new Error('provider_not_allowed');
    const requestSignal = init?.signal ?? signal;
    while (true) {
      let ready = 0;
      let server = 0;
      let dispatched = false;
      try {
        store.atomic(() => {
          const current = now();
          if (requestSignal?.aborted || current >= job.limits.deadline) throw new Error('cancelled_or_deadline');
          if (das) {
            const held = store.cooldown(provider);
            if (held > current) {
              if (held - current > 60_000 || held >= job.limits.deadline) throw new Error('provider_cooldown');
              ready = held; server = held; return;
            }
          }
          // A token in the bucket dispatches at once. Overdue waiters compete again; only an admitted dispatch takes a token.
          const bucket = das ? DAS_BUCKET : provider;
          ready = store.reserveDispatch(bucket, current, job.limits.deadline, das ? dasLimit : limits[provider]);
          if (ready > current) { server = store.cooldown(bucket); return; }
          if (options.liveAllowance) {
            const allowance = store.cache<{ stonkfun: number; helius: number }>('live-milestone-2026-09-21')?.value ?? { stonkfun: 0, helius: 0 };
            if (allowance[provider] >= (provider === 'stonkfun' ? 5 : 30)) throw new Error('live_allowance_exhausted');
            allowance[provider]++; store.saveCache('live-milestone-2026-09-21', { value: allowance, expiresAt: Number.MAX_SAFE_INTEGER });
          }
          store.reserveRequest(job.id, provider, current);
          dispatched = true;
        });
      } catch (error) {
        if (requestSignal?.aborted) throw error;
        // A local refusal — budget, deadline, allowance or a cooldown past the longest wait — is final, never retried.
        throw refusal(provider, error instanceof Error && error.message === 'provider_cooldown');
      }
      if (dispatched) break;
      const delay = Math.max(0, ready - now());
      const own = cooldowns.get(provider);
      waiting(provider, server < ready ? 'throttle' : own?.until === server ? own.reason : 'rate_limit', delay);
      await sleep(delay, requestSignal ?? undefined);
    }
    try { options.progress?.(provider, store.job(job.id, job.network)!.used[provider]); } catch { /* observer only */ }
    let response: Response;
    try { response = await rawFetch(input, init); }
    catch { throw new DispatchedFailure(); }
    // Persist headers at arrival, before any reader can fail/timeout on the response body. A rate limit holds back the whole
    // provider: its Retry-After, or else the provider's own backoff.
    const current = now();
    let until = 0;
    if (response.headers.get('x-ratelimit-remaining') === '0') until = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const after = retryAfterMs(response.headers.get('retry-after'), current);
    if (response.status === 429) until = Math.max(until, rateLimited(provider, current, after));
    else {
      if (response.ok) limited[provider] = 0;
      if (after !== null && response.status >= 500) until = Math.max(until, current + after);
    }
    if (Number.isFinite(until) && until > 0) cooldown(provider, until, 'rate_limit');
    return response;
  };
  const sharedFetch: typeof globalThis.fetch = (input, init) => dispatch(input, init, false);
  const readyAt = (provider: Provider) => () => store.cooldown(provider);
  const clientRetry = { maxAttempts: retry.retries + 1, minRequestIntervalMs: 0, retryBaseMs: retry.baseMs, retryMaxMs: retry.maxMs, retryJitter: retry.jitter };
  const heliusRuntime = { fetch: sharedFetch, now, random, readyAt: readyAt('helius') };
  const stonkfunRuntime = { fetch: sharedFetch, now, random, readyAt: readyAt('stonkfun') };
  const report = (provider: Provider) => (event: { type: string; reason?: WaitReason; delayMs?: number }) => {
    if (event.type === 'waiting' && event.reason && event.delayMs !== undefined) waiting(provider, event.reason, event.delayMs);
  };
  const history = new HeliusHistoryClient(options.apiKey, clientRetry, heliusRuntime);
  const publicClient = new PublicClient(clientRetry, stonkfunRuntime, signal, report('stonkfun'));
  /** One JSON-RPC call; null for any failure. A rate limit, a 5xx, a network failure or a timeout is retried with backoff. */
  const rpc = async (method: RpcMethod, params: unknown): Promise<unknown> => {
    for (let attempt = 1; attempt <= retry.retries + 1; attempt++) {
      if (signal?.aborted) return null;
      // Wait out a provider cooldown before the attempt's own timeout starts.
      const cooling = store.cooldown('helius') - now();
      if (cooling > 60_000) return null;
      if (cooling > 0) {
        const own = cooldowns.get('helius');
        waiting('helius', own?.until === store.cooldown('helius') ? own.reason : 'rate_limit', cooling);
        try { await sleep(cooling, signal); } catch { return null; }
      }
      const outcome = await rpcAttempt(method, params);
      if (outcome.kind !== 'retry') return outcome.value;
      if (attempt > retry.retries) return null;
      // A rate limit or Retry-After has already set the provider's cooldown, which the next attempt waits out instead.
      const delay = store.cooldown('helius') > now() ? 0 : backoffDelay(attempt, retry, random);
      if (delay > 0) {
        waiting('helius', 'retry', delay);
        try { await sleep(delay, signal); } catch { return null; }
      }
    }
    return null;
  };
  type Attempt = { kind: 'done'; value: unknown } | { kind: 'retry' };
  const rpcAttempt = async (method: RpcMethod, params: unknown): Promise<Attempt> => {
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    let timedOut = false;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, Math.min(15_000, Math.max(1, job.limits.deadline - now())));
    try {
      if (signal?.aborted) return { kind: 'done', value: null };
      const response = await abortable(dispatch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(options.apiKey)}`, {
        method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'scanner', method, params }),
      }, method !== 'getTransaction'), controller.signal);
      if (response.status === 429 || response.status >= 500) {
        void response.body?.cancel().catch(() => undefined); return { kind: 'retry' };
      }
      if (!response.ok || Number(response.headers.get('content-length')) > 8 * 1024 * 1024 || !response.body) { void response.body?.cancel().catch(() => undefined); return { kind: 'done', value: null }; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = ''; let length = 0;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), controller.signal); if (chunk.done) break;
          length += chunk.value.length; if (length > 8 * 1024 * 1024) return { kind: 'done', value: null };
          text += decoder.decode(chunk.value, { stream: true });
        }
        const raw: unknown = method === 'getAssetsByOwner' ? JSON.parse(text + decoder.decode(), exactBalances) : JSON.parse(text + decoder.decode());
        // An owner's asset list carries third-party metadata URLs; only the fields kept from it are checked, in `holdings`.
        if (method !== 'getAssetsByOwner' && !safe(raw)) return { kind: 'done', value: null };
        if (hasRpcError(raw)) {
          // A JSON-RPC rate-limit error holds back the provider like HTTP 429; other transient errors are retried.
          const problem = providerFailure(response.status, raw);
          if (problem.reason === 'rate_limit') cooldown('helius', rateLimited('helius', now(), null), 'rate_limit');
          return problem.retryable ? { kind: 'retry' } : { kind: 'done', value: null };
        }
        const result = z.object({ jsonrpc: z.literal('2.0'), id: z.literal('scanner'), result: z.unknown(), error: z.never().optional() }).safeParse(raw);
        return { kind: 'done', value: result.success ? result.data.result : null };
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      // Cancellation, a refused dispatch (budget, deadline, cooldown) and a malformed body end the call. A dispatched request
      // that failed in the network or timed out is retried.
      if (signal?.aborted) return { kind: 'done', value: null };
      return timedOut || error instanceof DispatchedFailure ? { kind: 'retry' } : { kind: 'done', value: null };
    }
    finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
  };
  return {
    async registry() {
      const cached = store.cache<boolean>('catalogue-read:mainnet-beta');
      const refreshCatalogue = options.cataloguePages !== undefined || !cached || cached.expiresAt <= now();
      const registry = await loadStonkFunRegistry({ maxPages: options.cataloguePages ?? 1, maxCatchUpPasses: 0,
        includeLaunches: refreshCatalogue, includePairs: refreshCatalogue, authorityQuoteMint: WITHDRAW_AUTHORITY_CONFIGURATION_MINT,
        http: clientRetry, onProgress: report('stonkfun'), ...(signal ? { signal } : {}),
      }, stonkfunRuntime);
      if (!safe(registry)) throw new Error('sensitive_response');
      if (registry.discovery.pagesFetched > 0) store.saveCache('catalogue-read:mainnet-beta', { value: true, expiresAt: now() + 86400_000 });
      return { retrievedAt: registry.finishedAt, complete: !registry.discovery.incomplete,
        detail: `ledger=${registry.discovery.ledger}; rewards=${registry.discovery.rewards}; withdraw-configuration=${registry.authorities.configuration}; recent feed only; no lifetime guarantee`,
        feeds: [{ network: job.network, provenance: { source: 'stonkfun-public-api', evidenceId: `feed-${job.id}`, retrievedAt: registry.finishedAt },
          distributions: registry.distributions, sources: registry.sources, withdrawalAuthorities: registry.authorities.withdrawal }],
        quotes: registry.quoteAssets.map(quote => {
          const meta = quote.pairMetadata[0]?.value;
          const symbol = meta?.symbol ?? quote.evidence.find(item => item.symbol)?.symbol;
          const decimals = meta?.decimals ?? quote.evidence.find(item => item.decimals !== undefined)?.decimals;
          return { mint: quote.mint, retrievedAt: registry.finishedAt, ...(symbol ? { symbol } : {}),
            ...(meta?.name ? { name: meta.name } : {}), ...(decimals !== undefined ? { decimals } : {}),
            membershipEvidence: quote.evidence.map(item => ({ kind: item.kind, launchMint: item.launchMint,
              endpoint: registry.sources.find(source => source.id === item.sourceId)!.endpoint,
              retrievedAt: registry.sources.find(source => source.id === item.sourceId)!.retrievedAt })) };
        }),
      };
    },
    async history(query, cursor, onPage) {
      const current = store.job(job.id, job.network)!;
      return history.scanHistory(query, { onPage, onProgress: report('helius'), maxRequests: Math.max(1, current.limits.helius - current.used.helius),
        maxPages: Math.max(1, current.limits.pages - current.used.pages), ...(cursor ? { startCursor: cursor } : {}), ...(signal ? { signal } : {}) });
    },
    async signatures(query) {
      const current = store.job(job.id, job.network)!;
      return history.listSignatures({ ...query, pageSize: SIGNATURE_PAGE_SIZE }, { onProgress: report('helius'),
        maxRequests: Math.max(1, current.limits.helius - current.used.helius), ...(signal ? { signal } : {}) });
    },
    async hydrate(signature) {
      const raw = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
      const tx = fullTransactionSchema.safeParse(raw);
      if (!tx.success || tx.data.transaction.signatures[0] !== signature) return null;
      return { transaction: tx.data, provenance: { source: 'helius', evidenceId: `hydrate-${job.id}`, retrievedAt: new Date(now()).toISOString(), commitment: 'finalized' } };
    },
    async price(mint) {
      const retrievedAt = new Date(now()).toISOString();
      let price: Price = { mint, currency: 'USD', value: null, provider: 'stonkfun', observedAt: null, retrievedAt, expiresAt: now() + 60_000, reason: 'price_unavailable' };
      const result = await publicClient.get('withdrawalConfig', `/launchlab/pricing?quoteMint=${mint}`, pricingSchema);
      if (result && safe(result.value) && result.value.data.quote.mint === mint) {
        const { quoteUsd, observedAt } = result.value.data.prices;
        const time = Date.parse(observedAt);
        if (quoteUsd !== null && quoteUsd !== undefined && time <= now() + 60_000 && time >= now() - 3600_000) {
          price = { ...price, value: String(quoteUsd), observedAt, retrievedAt: result.source.retrievedAt, expiresAt: Math.min(time + 3600_000, now() + 300_000), reason: null };
          return price;
        }
      }
      const raw = await rpc('getAsset', { id: mint, displayOptions: { showFungible: true } });
      const asset = assetSchema.safeParse(raw);
      if (asset.success && asset.data.id === mint && asset.data.token_info?.price_info) {
        return { ...price, value: String(asset.data.token_info.price_info.price_per_token), provider: 'helius', retrievedAt: new Date(now()).toISOString(), expiresAt: now() + 600_000,
          reason: 'provider_may_cache_600_seconds' };
      }
      return { ...price, retrievedAt: new Date(now()).toISOString(), provider: 'helius', reason: 'no_valid_usd_price' };
    },
    async holdings(owner) {
      const limit = options.holdingsPageLimit ?? HOLDINGS_PAGE_LIMIT;
      const takenAt = new Date(now()).toISOString();
      const tokens = new Map<string, SnapshotHolding>();
      for (let page = 1; page <= HOLDINGS_MAX_PAGES; page++) {
        const raw = await rpc('getAssetsByOwner', { ownerAddress: owner, page, limit, options: { showFungible: true, showZeroBalance: false } });
        const read = ownedPageSchema.safeParse(raw);
        if (!read.success) return null;
        for (const item of read.data.items) {
          const token = ownedTokenSchema.safeParse(item);
          if (!token.success || BigInt(token.data.token_info.balance) === 0n) continue;
          const { id, content, token_info: info } = token.data;
          const symbol = content?.metadata?.symbol ?? info.symbol;
          tokens.set(id, { mint: id, raw: BigInt(info.balance).toString(), decimals: info.decimals,
            name: content?.metadata?.name?.trim() || null, symbol: symbol?.trim() || null });
        }
        if (read.data.items.length < limit) {
          const snapshot: HoldingsSnapshot = { takenAt, tokens: [...tokens.values()].sort((a, b) => a.mint.localeCompare(b.mint)) };
          return safe(snapshot) ? snapshot : null;
        }
      }
      return null;
    },
  };
}
