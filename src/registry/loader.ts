import { boundedInteger, emit, PublicClient } from './http.js';
import type { HttpOptions, Runtime } from './http.js';
import { launchesSchema, mintSchema, pairsSchema, rewardsSchema, withdrawalSchema } from './schemas.js';
import type { Launch, RewardLaunch } from './schemas.js';
import type { Issue, LaunchEntry, Observation, ProgressEvent, QuoteAsset, QuoteEvidence, Registry } from './types.js';

export interface RegistryOptions {
  /** Distribution refresh can skip an expensive launch sweep; discovery stays explicitly incomplete. */
  includeLaunches?: boolean;
  includePairs?: boolean;
  pageSize?: number;
  /** Total launch-page requests across all passes, excluding HTTP retries. */
  maxPages?: number;
  /** Full reconciliation sweeps after the initial sweep. */
  maxCatchUpPasses?: number;
  /** Opt-in single configuration read; never used as payout verification. */
  authorityQuoteMint?: string;
  http?: HttpOptions;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

/** Canonical JSON equality includes distribution extensions, independent of key order. */
function key(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(key).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => `${JSON.stringify(name)}:${key(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
function observe<T>(observations: Observation<T>[], value: T, sourceId: string): void {
  const fingerprint = key(value);
  const existing = observations.find((item) => key(item.value) === fingerprint);
  if (existing) {
    if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
  } else observations.push({ value, sourceIds: [sourceId] });
}

export async function loadStonkFunRegistry(options: RegistryOptions = {}, runtime: Runtime = {}): Promise<Registry> {
  const pageSize = boundedInteger(options.pageSize ?? 100, 1, 100);
  const maxPages = boundedInteger(options.maxPages ?? 2000, 1, 10_000);
  const catchUpPasses = boundedInteger(options.maxCatchUpPasses ?? 1, 0, 3);
  if (options.authorityQuoteMint !== undefined && !mintSchema.safeParse(options.authorityQuoteMint).success) {
    throw new TypeError('Invalid authority quote mint');
  }
  const client = new PublicClient(options.http ?? {}, runtime, options.signal, options.onProgress);
  const startedAt = client.timestamp();
  emit(options.onProgress, { type: 'started', at: startedAt });
  const launches = new Map<string, LaunchEntry>();
  const quotes = new Map<string, QuoteAsset>();
  const quoteEvidenceKeys = new Map<string, Set<string>>();
  const groups = new Map<string, Registry['distributions'][number]>();
  const issues: Issue[] = [];
  const withdrawal: Registry['authorities']['withdrawal'] = [];
  let quoteConflict = false;
  const addQuote = (mint: string, evidence: QuoteEvidence) => {
    let asset = quotes.get(mint);
    if (!asset) { asset = { mint, evidence: [], pairMetadata: [] }; quotes.set(mint, asset); }
    let evidenceKeys = quoteEvidenceKeys.get(mint);
    if (!evidenceKeys) { evidenceKeys = new Set(); quoteEvidenceKeys.set(mint, evidenceKeys); }
    const evidenceKey = key(evidence);
    if (!evidenceKeys.has(evidenceKey)) { asset.evidence.push(evidence); evidenceKeys.add(evidenceKey); }
  };
  const addLaunch = (value: Launch | RewardLaunch, sourceId: string, kind: 'launch' | 'rewardSummary') => {
    let entry = launches.get(value.mint);
    if (!entry) { entry = { mint: value.mint, ledger: [], rewardSummaries: [] }; launches.set(value.mint, entry); }
    const previousQuotes = [...entry.ledger, ...entry.rewardSummaries].map((item) => item.value.quote.mint);
    if (previousQuotes.some((mint) => mint !== value.quote.mint)) {
      quoteConflict = true;
      issues.push({ code: 'launch_quote_conflict', source: kind === 'launch' ? 'launches' : 'rewards', sourceId });
    }
    if ('mode' in value) observe(entry.ledger, value, sourceId);
    else observe(entry.rewardSummaries, value, sourceId);
    addQuote(value.quote.mint, {
      sourceId, kind, launchMint: value.mint,
      ...(value.quote.symbol === undefined ? {} : { symbol: value.quote.symbol }),
      ...(value.quote.decimals === undefined ? {} : { decimals: value.quote.decimals }),
    });
  };
  let pagesFetched = 0;
  let passes = 0;
  let stable = false;
  let previousPass: string | undefined;
  let previousMetadata: string | undefined;
  let stop = false;
  for (let pass = 0; options.includeLaunches !== false && pass <= catchUpPasses && !stop && !options.signal?.aborted; pass++) {
    passes++;
    const seenPages = new Set<string>();
    const passMints = new Map<string, string>();
    let metadata: string | undefined;
    let passConsistent = true;
    for (let page = 1; ; page++) {
      if (pagesFetched >= maxPages) { issues.push({ code: 'page_limit', source: 'launches' }); stop = true; break; }
      const response = await client.get('launches', `/launches?mode=reward&pageSize=${pageSize}&page=${page}`, launchesSchema, { requestedPage: page, pass });
      if (!response) { issues.push({ code: 'source_failure', source: 'launches', sourceId: client.sources.at(-1)?.id ?? '' }); stop = true; break; }
      pagesFetched++;
      const { launches: rows, pagination } = response.value.data;
      response.source.pagination = pagination;
      for (const row of rows) {
        addLaunch(row, response.source.id, 'launch');
        passMints.set(row.mint, row.quote.mint);
      }
      emit(options.onProgress, {
        type: 'page', at: client.timestamp(), pass, requestedPage: page, returnedPage: pagination.page,
        totalPages: pagination.totalPages, pagesFetched, uniqueLaunches: launches.size,
      });
      if (pagination.page !== page) { issues.push({ code: 'clamped_page', source: 'launches', sourceId: response.source.id }); stop = true; break; }
      const fingerprint = key(rows.map((row) => row.mint).sort());
      if (seenPages.has(fingerprint)) { issues.push({ code: 'repeated_page', source: 'launches', sourceId: response.source.id }); stop = true; break; }
      seenPages.add(fingerprint);
      const currentMetadata = key([pagination.total, pagination.totalPages, pagination.pageSize]);
      if (metadata !== undefined && metadata !== currentMetadata) {
        passConsistent = false;
        issues.push({ code: 'changing_totals', source: 'launches', sourceId: response.source.id });
      }
      metadata = currentMetadata;
      const expectedPages = Math.ceil(pagination.total / pagination.pageSize);
      const expectedRows = Math.min(pagination.pageSize, Math.max(0, pagination.total - (page - 1) * pagination.pageSize));
      if ((pagination.totalPages !== expectedPages && !(pagination.total === 0 && pagination.totalPages === 1)) || rows.length !== expectedRows) {
        passConsistent = false;
        issues.push({ code: 'inconsistent_pagination', source: 'launches', sourceId: response.source.id });
      }
      if (pagination.page >= pagination.totalPages) {
        if (passMints.size !== pagination.total) passConsistent = false;
        break;
      }
      if (options.signal?.aborted) { stop = true; break; }
    }
    const identities = key([...passMints.entries()].sort(([a], [b]) => a.localeCompare(b)));
    if (!stop && passConsistent && identities === previousPass && metadata === previousMetadata) {
      stable = true; break;
    }
    previousPass = passConsistent ? identities : undefined;
    previousMetadata = metadata;
  }
  if (!stable) issues.push({ code: 'unstable_discovery', source: 'launches' });

  let rewards: Registry['discovery']['rewards'] = 'not_requested';
  if (!options.signal?.aborted) {
    const response = await client.get('rewards', '/rewards?limit=100', rewardsSchema);
    rewards = response ? 'loaded' : 'failed';
    if (response) {
      for (const row of response.value.data.launches) addLaunch(row, response.source.id, 'rewardSummary');
      for (const row of response.value.data.recentDistributions) {
        let group = groups.get(row.signature);
        if (!group) { group = { signature: row.signature, rows: [] }; groups.set(row.signature, group); }
        observe(group.rows, row, response.source.id);
        addQuote(row.quoteMint, { sourceId: response.source.id, kind: 'distribution', launchMint: row.mint });
      }
    } else issues.push({ code: 'source_failure', source: 'rewards', sourceId: client.sources.at(-1)?.id ?? '' });
    emit(options.onProgress, { type: 'source', at: client.timestamp(), source: 'rewards', outcome: response ? 'success' : 'failure', records: response ? response.value.data.launches.length + response.value.data.recentDistributions.length : 0 });
  }
  let enrichment: Registry['enrichment'] = 'not_requested';
  if (options.includePairs !== false && !options.signal?.aborted) {
    const response = await client.get('pairs', '/pairs', pairsSchema);
    enrichment = response ? 'loaded' : 'failed';
    if (response) {
      for (const pair of response.value.data.pairs) {
        const asset = quotes.get(pair.mint);
        if (asset) observe(asset.pairMetadata, pair, response.source.id);
      }
    } else issues.push({ code: 'source_failure', source: 'pairs', sourceId: client.sources.at(-1)?.id ?? '' });
    emit(options.onProgress, { type: 'source', at: client.timestamp(), source: 'pairs', outcome: response ? 'success' : 'failure', records: response?.value.data.pairs.length ?? 0 });
  }
  let configuration: Registry['authorities']['configuration'] = 'not_requested';
  if (options.authorityQuoteMint !== undefined && !options.signal?.aborted) {
    const response = await client.get('withdrawalConfig', `/launchlab/pricing?quoteMint=${options.authorityQuoteMint}`, withdrawalSchema);
    configuration = response ? 'loaded' : 'failed';
    if (response) withdrawal.push({
      role: 'withdrawWithheldAuthority', authority: response.value.data.modes.reward.withdrawWithheldAuthority,
      configurationQuoteMint: options.authorityQuoteMint, sourceId: response.source.id,
    });
    else issues.push({ code: 'source_failure', source: 'withdrawalConfig', sourceId: client.sources.at(-1)?.id ?? '' });
    emit(options.onProgress, { type: 'source', at: client.timestamp(), source: 'withdrawalConfig', outcome: response ? 'success' : 'failure', records: withdrawal.length });
  }
  const cancelled = options.signal?.aborted === true;
  if (cancelled) issues.push({ code: 'cancelled', source: client.sources.at(-1)?.source ?? 'launches' });
  const incomplete = !stable || rewards !== 'loaded' || quoteConflict || cancelled;
  const result: Registry = {
    schemaVersion: 1, startedAt, finishedAt: client.timestamp(),
    status: cancelled ? 'cancelled' : incomplete || enrichment !== 'loaded' || configuration === 'failed' ? 'partial' : 'complete',
    discovery: { incomplete, ledger: stable ? 'observed_stable' : 'incomplete', rewards, atomicSnapshot: false, lifetimeCoverage: 'not_guaranteed', passes, pagesFetched },
    enrichment, launches: [...launches.values()], quoteAssets: [...quotes.values()], distributions: [...groups.values()],
    authorities: { withdrawal, payout: { status: 'not_verified', evidence: [] }, configuration },
    sources: client.sources, issues,
  };
  emit(options.onProgress, { type: 'finished', at: result.finishedAt, status: result.status, pagesFetched, uniqueLaunches: launches.size, quoteMints: quotes.size });
  return result;
}
