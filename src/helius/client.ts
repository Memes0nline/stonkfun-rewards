import { failure } from './errors.js';
import { cursorSchema, normalizeQuery } from './query.js';
import type { HistoryQueryInput, HistoryQuery } from './query.js';
import { abortable, emit, HeliusTransport, integer } from './transport.js';
import type { PageRead } from './transport.js';
import type { CapabilityResult, EvidenceIssue, HeliusFailure, HeliusHttpOptions, HeliusRuntime, HistoryOptions, HistoryPage, HistoryResult, ListedSignature, OperationOptions,
  SignatureList } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class HeliusHistoryClient {
  #transport: HeliusTransport;
  #busy = false;
  #capability: { query: HistoryQuery; page: Extract<PageRead, { ok: true }> } | undefined;

  constructor(apiKey: string, http: HeliusHttpOptions = {}, runtime: HeliusRuntime = {}) {
    this.#transport = new HeliusTransport(apiKey, http, runtime);
  }
  #query(input: HistoryQueryInput): HistoryQuery {
    const query = normalizeQuery(input);
    if (this.#transport.sensitive(query)) throw new TypeError('Invalid Helius history query');
    return query;
  }
  #enter(): void {
    if (this.#busy) throw new Error('Helius client already has an active operation');
    this.#busy = true;
  }
  async probe(input: HistoryQueryInput, options: OperationOptions = {}): Promise<CapabilityResult> {
    const query = this.#query(input);
    const budget = { made: 0, max: integer(options.maxRequests ?? 3, 1, 100_000) };
    this.#enter();
    this.#capability = undefined;
    try {
      emit(options, { type: 'started', at: this.#transport.timestamp(), operation: 'capability' });
      const page = await this.#transport.read(query, null, budget, options);
      if (page.ok && !options.signal?.aborted) this.#capability = { query, page };
      const supported = page.ok && !options.signal?.aborted;
      const common = { query, checkedAt: this.#transport.timestamp(), requestsMade: budget.made };
      const result: CapabilityResult = supported && page.ok
        ? { ...common, status: 'supported', source: structuredClone(page.source), pageTransactionCount: page.data.data.length }
        : { ...common, status: 'failed', failure: page.ok ? failure('cancelled') : page.failure };
      emit(options, { type: 'finished', at: common.checkedAt, operation: 'capability', status: result.status, pagesDelivered: 0, requestsMade: budget.made });
      return result;
    } finally { this.#busy = false; }
  }

  /** Every signature the history query lists in signatures mode, page by page until its pagination ends. Only succeeded
   * transactions inside the range are kept, each once; the list is complete only when no page failed. */
  async listSignatures(input: HistoryQueryInput, options: OperationOptions & { maxPages?: number } = {}): Promise<SignatureList> {
    const query = this.#query(input);
    const maxPages = integer(options.maxPages ?? 20, 1, 10_000);
    const budget = { made: 0, max: integer(options.maxRequests ?? 1000, 1, 100_000) };
    this.#enter();
    this.#capability = undefined;
    try {
      const signatures: ListedSignature[] = [];
      const seen = new Set<string>(); const seenCursors = new Set<string>();
      let cursor: string | null = null; let pagesFetched = 0; let problem: HeliusFailure | undefined; let exhausted = false;
      while (true) {
        if (options.signal?.aborted) { problem = failure('cancelled'); break; }
        if (pagesFetched >= maxPages) { problem = failure('page_budget'); break; }
        const read = await this.#transport.readSignatures(query, cursor, budget, options);
        if (!read.ok) { problem = read.failure; break; }
        pagesFetched++;
        for (const row of read.data.data) {
          if (row.blockTime === undefined || row.blockTime === null || row.blockTime < query.startTime || row.blockTime >= query.endTime) continue;
          if ((row.err ?? null) !== null || seen.has(row.signature)) continue;
          seen.add(row.signature); signatures.push({ signature: row.signature, slot: row.slot, blockTime: row.blockTime });
        }
        const next = read.data.paginationToken;
        if (next === null) { exhausted = true; break; }
        if (seenCursors.has(next) || this.#transport.sensitive(next)) { problem = failure('cursor_cycle'); break; }
        seenCursors.add(next); cursor = next;
      }
      if (options.signal?.aborted) problem = failure('cancelled');
      return { query, signatures, requestsMade: budget.made, pagesFetched,
        status: problem?.category === 'cancelled' ? 'cancelled' : exhausted && problem === undefined ? 'complete' : 'partial',
        ...(problem === undefined ? {} : { failure: problem }) };
    } finally { this.#busy = false; }
  }

  async scanHistory(input: HistoryQueryInput, options: HistoryOptions): Promise<HistoryResult> {
    const query = this.#query(input);
    const maxPages = integer(options.maxPages ?? 1000, 1, 10_000);
    const budget = { made: 0, max: integer(options.maxRequests ?? 1000, 1, 100_000) };
    if (typeof options.onPage !== 'function'
      || (options.startCursor !== undefined && (!cursorSchema.safeParse(options.startCursor).success || this.#transport.sensitive(options.startCursor)))) {
      throw new TypeError('Invalid Helius history options');
    }
    this.#enter();
    try {
      const startedAt = this.#transport.timestamp();
      emit(options, { type: 'started', at: startedAt, operation: 'history' });
      const startedFromBeginning = options.startCursor === undefined;
      const issues = new Set<EvidenceIssue | 'prefix_unverified'>(startedFromBeginning ? [] : ['prefix_unverified']);
      const seenCursors = new Set<string>();
      const seenSignatures = new Map<string, string>();
      let cursor: string | null = options.startCursor ?? null;
      if (cursor !== null) seenCursors.add(cursor);
      let pagesFetched = 0;
      let pagesDelivered = 0;
      let transactionsDelivered = 0;
      let duplicates = 0;
      let excluded = 0;
      let reusedCapability = false;
      let exhausted = false;
      let problem: HeliusFailure | undefined;
      let retryPage = false;
      let restartRequired = false;
      while (true) {
        if (options.signal?.aborted) { problem = failure('cancelled'); break; }
        if (pagesFetched >= maxPages) { problem = failure('page_budget'); break; }
        let read: PageRead;
        if (pagesFetched === 0 && cursor === null && this.#capability && canonical(this.#capability.query) === canonical(query)) {
          read = this.#capability.page;
          this.#capability = undefined;
          reusedCapability = true;
          emit(options, { type: 'capability_reused', at: this.#transport.timestamp() });
        } else {
          // A scan with another query invalidates the one-shot cached capability page.
          this.#capability = undefined;
          read = await this.#transport.read(query, cursor, budget, options);
        }
        if (!read.ok) { problem = read.failure; retryPage = true; break; }
        pagesFetched++;
        const page: HistoryPage = {
          query, pageIndex: pagesFetched, requestedCursor: cursor, nextCursor: read.data.paginationToken,
          source: read.source, reusedCapability: reusedCapability && pagesFetched === 1,
          transactions: [], excluded: [], duplicateCount: 0,
        };
        const additions = new Map<string, string>();
        for (const transaction of read.data.data) {
          const signature = transaction.transaction.signatures[0];
          if (signature === undefined) throw new Error('Validated signature missing');
          const hash = await fingerprint(transaction);
          const previous = additions.get(signature) ?? seenSignatures.get(signature);
          if (previous === hash) { page.duplicateCount++; continue; }
          let issue: EvidenceIssue | undefined;
          if (previous !== undefined) issue = 'conflicting_signature';
          else if (transaction.blockTime === undefined || transaction.blockTime === null) issue = 'missing_timestamp';
          else if (transaction.blockTime < query.startTime || transaction.blockTime >= query.endTime) issue = 'outside_range';
          else if (transaction.meta.err !== null) issue = 'failed_transaction';
          if (issue) { page.excluded.push({ reason: issue, transaction }); issues.add(issue); restartRequired = true; }
          else page.transactions.push(transaction);
          if (previous === undefined) additions.set(signature, hash);
        }
        if (options.signal?.aborted) { problem = failure('cancelled'); retryPage = true; break; }
        try {
          // Clone protects cached evidence/internal cursor state from consumer mutations.
          await abortable(Promise.resolve(options.onPage(structuredClone(page), options.signal)), options.signal);
        } catch {
          problem = failure(options.signal?.aborted ? 'cancelled' : 'consumer_failure'); retryPage = true; break;
        }
        for (const [signature, hash] of additions) seenSignatures.set(signature, hash);
        pagesDelivered++;
        transactionsDelivered += page.transactions.length;
        duplicates += page.duplicateCount;
        excluded += page.excluded.length;
        const nextCursor = page.nextCursor;
        emit(options, { type: 'page', at: this.#transport.timestamp(), pageIndex: pagesDelivered,
          transactions: page.transactions.length, duplicates: page.duplicateCount, excluded: page.excluded.length, hasMore: nextCursor !== null });
        if (nextCursor === null) { exhausted = true; cursor = null; break; }
        if (seenCursors.has(nextCursor)) { problem = failure('cursor_cycle'); restartRequired = true; break; }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (options.signal?.aborted) problem = failure('cancelled');
      const complete = exhausted && startedFromBeginning && issues.size === 0 && problem === undefined;
      const result: HistoryResult = {
        query, startedAt, finishedAt: this.#transport.timestamp(),
        status: problem?.category === 'cancelled' ? 'cancelled' : complete ? 'complete' : 'partial',
        requestsMade: budget.made, pagesFetched, pagesDelivered, transactionsDelivered, duplicates, excluded, reusedCapability,
        issues: [...issues], ...(problem === undefined ? {} : { failure: problem }),
        coverage: { convention: '[startTime,endTime)', startedFromBeginning, paginationExhausted: exhausted, rangeComplete: complete, persisted: false },
        continuation: { query, kind: restartRequired ? 'restart_range' : exhausted ? 'exhausted' : retryPage ? 'retry_page' : 'next_page', cursor: restartRequired ? null : cursor, restartRequired },
      };
      emit(options, { type: 'finished', at: result.finishedAt, operation: 'history', status: result.status, pagesDelivered, requestsMade: budget.made });
      return result;
    } finally { this.#busy = false; }
  }
}
