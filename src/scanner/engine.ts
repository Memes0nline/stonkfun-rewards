import { addressSchema, SIGNATURE_PAGE_SIZE } from '../helius/query.js';
import type { HeliusFailure } from '../helius/types.js';
import { processDirty } from './classifier.js';
import { walletHoldings } from './holdings.js';
import type { HoldingsSnapshot } from './holdings.js';
import { orderedPool } from './pool.js';
import { CHECK_DISAGREED, HALTING_CLASSES, heliusFailureClass, stonkfunFailure, thrownFailureClass } from './failures.js';
import { earlierBatch, firstScanStart, HISTORY_FLOOR, historyTarget, mergeRanges, missingRanges, planCheck, planEarlier, planRanges } from './ranges.js';
import { NATIVE_SOL_MINT, NATIVE_SOL_PRICE_MINT } from './types.js';
import type { CheckResult, Job, JobKind, JobRange, Limits, Providers, Range, RewardsStore, ScanProgress } from './types.js';
import type { ScanPhase } from './progress.js';
import type { SolanaNetwork } from '../normalization/types.js';

export interface ScanInput {
  wallet: string; cutoff: number; jobId: string; owner: string;
  limits: Limits; network?: SolanaNetwork; pageSize?: number; resume?: string;
  /** Size a new job's StonkFun budget when pricing starts: the requests already made plus one per mint needing a price,
   * never more than `limits.stonkfun`, which is then only the cap. Resumes keep the job's own choice. */
  sizeStonkfunBudget?: boolean;
  /** A refresh: once the scan completes, read the wallet's current holdings and store them with its history-derived
   * holdings. An incomplete or failed scan stores neither. */
  snapshotHoldings?: boolean;
  /** A refresh by default: the loaded range to this cutoff, or a first scan for a wallet with no coverage. `earlier` loads one
   * batch before the oldest loaded day and keeps the saved cutoff. `check` lists `check`'s days again and keeps the saved cutoff. */
  kind?: JobKind;
  /** A check job's whole UTC days: from 00:00 of the first to 00:00 after the last, at most seven, inside the loaded range. */
  check?: Range;
}
/** The cache key marking a job whose StonkFun budget is sized at pricing, with its cap. */
export const stonkfunBudgetKey = (jobId: string) => `stonkfun-budget:${jobId}`;
/** The most StonkFun requests a sized budget allows, for the CLI and dashboard defaults. */
export const STONKFUN_BUDGET_CAP = 200;
/** `concurrency` bounds independent provider work in flight (hydrations, prices); default 4. History pages stay sequential. */
export interface EngineRuntime { now: () => number; signal?: AbortSignal; progress?: (event: ScanProgress) => void; concurrency?: number }

/** Admission refusals a caller shows as they are, rather than as a failed admission. */
export const ADMISSION_REFUSALS: ReadonlySet<string> = new Set(['earlier_history_at_floor', 'wallet_not_loaded', 'other_job_unfinished',
  'check_range_invalid', 'check_range_too_long', 'check_range_outside_loaded']);
/** Why Load earlier cannot start for a wallet: nothing is loaded yet, or the loaded range already starts at the floor. */
export function earlierRefusal(store: RewardsStore, network: SolanaNetwork, wallet: string): 'wallet_not_loaded' | 'earlier_history_at_floor' | null {
  const state = store.wallet(network, wallet);
  if (!state || store.coverage(network, wallet).length === 0) return 'wallet_not_loaded';
  return earlierBatch(state.trackingStart) ? null : 'earlier_history_at_floor';
}

export function admitJob(store: RewardsStore, input: ScanInput, now: number): Job {
  if (!addressSchema.safeParse(input.wallet).success) throw new Error('invalid_wallet');
  historyTarget(input.cutoff);
  if (input.cutoff > Math.floor(now / 1000) + 60 || !/^[A-Za-z0-9_-]{1,90}$/.test(input.jobId)) throw new Error('invalid_scan_cutoff_or_id');
  const network = input.network ?? 'mainnet-beta';
  const kind = input.kind ?? 'refresh';
  return store.atomic(() => {
    const prior = store.job(input.resume ?? input.wallet, network);
    if (input.resume && !prior) throw new Error('resume_job_not_found');
    if (prior && (input.resume || prior.status === 'running' || prior.status === 'paused')) {
      if (prior.wallet !== input.wallet || prior.status === 'complete' || prior.status === 'exhausted') throw new Error('job_not_resumable');
      // An unfinished job of the other kind is resumed by its id, never in place of the job asked for.
      if (!input.resume && (prior.kind ?? 'refresh') !== kind) throw new Error('other_job_unfinished');
      // An unfinished check of other days is resumed by its id, never in place of the days asked for.
      if (!input.resume && kind === 'check' && (prior.check?.startTime !== input.check?.startTime || prior.check?.endTime !== input.check?.endTime)) {
        throw new Error('other_job_unfinished');
      }
      if (now >= prior.limits.deadline || prior.used.resumes >= prior.limits.resumes) {
        prior.status = 'exhausted'; prior.error = 'resume_budget_or_deadline'; store.saveJob(prior); return prior;
      }
      prior.used.resumes++; prior.status = 'running'; prior.error = null; prior.failure = null; store.saveJob(prior); return prior;
    }
    const pageSize = input.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('invalid_page_size');
    if (!Object.values(input.limits).every(value => Number.isSafeInteger(value) && value > 0) || input.limits.deadline <= now) throw new Error('invalid_job_limits');
    const coverage = store.coverage(network, input.wallet);
    let wallet = store.wallet(network, input.wallet);
    let planned: Range[]; let batch: Job['batch']; let cutoff = input.cutoff; let check: Job['check'];
    if (kind === 'check') {
      // A check keeps the saved cutoff and plans one range per chosen day, inside the loaded range only.
      if (!wallet || coverage.length === 0) throw new Error('wallet_not_loaded');
      if (!input.check) throw new Error('check_range_invalid');
      planned = planCheck(input.check, { startTime: wallet.trackingStart, endTime: wallet.cutoff });
      cutoff = wallet.cutoff; check = { ...input.check, days: planned.length };
    } else if (kind === 'earlier') {
      // Load earlier keeps the saved cutoff and plans only its batch's missing days, so an interrupted batch is finished
      // before the oldest loaded day moves back.
      const refusal = earlierRefusal(store, network, input.wallet);
      if (refusal) throw new Error(refusal);
      cutoff = wallet!.cutoff;
      const next = earlierBatch(wallet!.trackingStart)!;
      batch = { kind: 'earlier', ...next }; planned = planEarlier(next, coverage);
    } else {
      // A wallet with no coverage starts with its first scan, the seven days before the cutoff. Otherwise a refresh keeps the
      // oldest loaded day and plans every missing day from it to the cutoff.
      wallet ??= { network, wallet: input.wallet, trackingStart: HISTORY_FLOOR, cutoff: input.cutoff, lastSync: null };
      if (input.cutoff < wallet.cutoff) throw new Error('cutoff_before_saved_cutoff');
      const first = coverage.length === 0;
      wallet.trackingStart = first ? firstScanStart(input.cutoff) : Math.max(HISTORY_FLOOR, wallet.trackingStart);
      wallet.cutoff = input.cutoff; store.saveWallet(wallet);
      if (first) batch = { kind: 'first', startTime: wallet.trackingStart, endTime: input.cutoff };
      planned = planRanges(input.cutoff, coverage, wallet.trackingStart);
    }
    const job: Job = { id: input.jobId, network, wallet: input.wallet, cutoff, createdAt: now,
      status: 'running', limits: input.limits, used: { stonkfun: 0, helius: 0, pages: 0, resumes: 1 },
      // A check reads no StonkFun feed and hydrates nothing: it only compares and fetches wallet history.
      pageSize, error: null, registryDone: kind === 'check', hydrationDone: kind === 'check', kind, ...(batch ? { batch } : {}), ...(check ? { check } : {}) };
    store.saveJob(job); store.createRanges(job, planned);
    if (input.sizeStonkfunBudget) store.saveCache(stonkfunBudgetKey(job.id), { value: { cap: input.limits.stonkfun }, expiresAt: input.limits.deadline });
    return job;
  });
}

/** Credentials, clock, database driver, and transport are adapter concerns. No environment access here. */
export async function runScan(store: RewardsStore, input: ScanInput, createProviders: (job: Job) => Providers, runtime: EngineRuntime): Promise<Job> {
  const network = input.network ?? 'mainnet-beta';
  const concurrency = runtime.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('invalid_concurrency');
  store.acquire(network, input.wallet, input.owner, runtime.now());
  let job: Job | undefined;
  const runStartedAt = runtime.now();
  /** Adds this run's time to the job's and stamps when it ended. */
  const finish = (target: Job) => {
    target.finishedAt = runtime.now(); target.elapsedMs = (target.elapsedMs ?? 0) + Math.max(0, target.finishedAt - runStartedAt);
  };
  const emit = (phase: ScanPhase, kind: ScanProgress['kind'], action: string,
    options: Pick<ScanProgress, 'progress' | 'awaitingProvider'> = {}, stage: string = phase) => {
    try { runtime.progress?.({ jobId: job?.id ?? input.jobId, stage, phase, kind, action, at: runtime.now(), ...options }); }
    catch { /* observer only */ }
  };
  const check = () => {
    if (runtime.signal?.aborted) throw new Error('cancelled');
    store.renew(network, input.wallet, input.owner, runtime.now());
    job = store.job(job!.id, network)!;
    if (runtime.now() >= job.limits.deadline) throw new Error('deadline');
  };
  const drain = async (phase: ScanPhase) => {
    let processed = 0;
    while (store.dirty(network, 1).length) {
      check(); store.atomic(() => { processed += processDirty(store, network, 100); });
      const remaining = store.pendingClassifications(network, input.wallet).networkSignatures;
      emit(phase, 'activity', `Reconciled ${processed} signatures; ${remaining} remain queued`,
        { progress: { completed: processed, total: processed + remaining, unit: 'signatures' } });
      // Let the local HTTP adapter serve progress between bounded batches.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    emit(phase, 'activity', `Reconciled ${processed} queued signatures`,
      { progress: { completed: processed, total: processed, unit: 'signatures' } });
  };
  let providers: Providers;
  /** The wallet's current holdings, when the provider reads them, and what its retained transactions show it holding. A
   * snapshot that fails leaves the last complete one in place; the history-derived holdings are stored either way. */
  const saveHoldings = async () => {
    emit('checkpoint', 'activity', 'Reading current token holdings', { awaitingProvider: true });
    let snapshot: HoldingsSnapshot | null = null;
    try { snapshot = await providers.holdings?.(input.wallet) ?? null; } catch { snapshot = null; }
    check();
    if (!store.saveHoldings || !store.walletTokenBalances || !store.retainedFingerprint) return;
    emit('checkpoint', 'activity', snapshot ? `Saving ${snapshot.tokens.length} current token holdings` : 'Saving token holdings from retained transactions');
    store.atomic(() => {
      store.saveHoldings!(network, input.wallet, { takenAt: new Date(runtime.now()).toISOString(), fingerprint: store.retainedFingerprint!(network, input.wallet),
        snapshot, history: [...walletHoldings(store.walletTokenBalances!(network, input.wallet)).values()] });
    });
  };
  try {
    emit('preparing', 'started', 'Preparing scan and checking saved job');
    job = admitJob(store, input, runtime.now());
    if (job.status === 'exhausted') return job;
    emit('preparing', 'completed', 'Saved job admitted');
    providers = createProviders(job);
    check(); emit('registry', 'started', 'Loading StonkFun registry and token metadata', { awaitingProvider: !job.registryDone });
    if (!job.registryDone) {
      const update = await providers.registry(); check();
      store.atomic(() => {
        for (const quote of update.quotes) store.saveQuote(network, quote);
        // A configuration snapshot is retained even when the feed carries no distribution rows.
        for (const feed of update.feeds) { store.addFeed(feed); store.saveWithdrawalSnapshots(feed); }
        store.saveCache(`registry-status:${network}`, { value: { complete: update.complete, detail: update.detail, retrievedAt: update.retrievedAt }, expiresAt: runtime.now() + 300_000 });
        store.saveCache(`job-feed:${job!.id}`, { value: update.feeds.flatMap(feed => feed.distributions.map(item => item.signature)), expiresAt: job!.limits.deadline });
        // StonkFun being unreachable does not stop the job; Helius history still loads, and the class says what is missing.
        job!.failure = stonkfunFailure(update) ?? job!.failure ?? null;
        job!.registryDone = true; store.saveJob(job!);
      });
    }
    emit('registry', 'completed', 'Registry and token metadata saved');
    emit('metadata', 'started', 'Checking registry token metadata');
    await drain('metadata');
    emit('metadata', 'completed', 'Registry token metadata and new feed evidence saved');
    emit('planning', 'started', 'Reading saved coverage and planned days');
    // Each planned range is at most one day, so ranges count as days.
    const planned = store.ranges(job.id);
    emit('planning', 'completed', `${planned.length} ${planned.length === 1 ? 'day' : 'days'} planned`,
      { progress: { completed: planned.length, total: planned.length, unit: 'days' } });
    // Wallet history first: hydration reuses full transactions already present in SQLite.
    emit('history', 'started', 'Reading blockchain history',
      { progress: { completed: planned.filter(range => range.status === 'complete').length, total: planned.length, unit: 'days' }, awaitingProvider: true });
    const listing = providers.signatures?.bind(providers);
    const checking = job.kind === 'check';
    if (checking && !listing) throw new Error('check_unavailable');
    /** Records a failed listing or refetch like a failed page; a rejected key or a quota refusal stops the job. */
    const failed = (problem: HeliusFailure | undefined) => {
      const classed = problem ? heliusFailureClass(problem) : null;
      job!.error = problem?.category ?? 'range_check_incomplete';
      if (classed) job!.failure = classed;
      store.saveJob(job!);
      if (classed && HALTING_CLASSES.has(classed.class)) throw new Error('provider_refused');
      return false;
    };
    const savedHere = (signature: string) => store.hasTransaction(network, signature) && store.watchers(network, signature).includes(input.wallet);
    /** Lists the range once more in signatures mode, with the same filters, and fetches in full mode the span of every listed
     * signature not saved for this wallet. When the two agree the range is complete and checked. When they still disagree it
     * stays partial: a refresh or Load earlier reads it again from its start, and a check job reports the day and keeps its
     * saved coverage. False when the check could not finish. */
    const checkRange = async (range: JobRange): Promise<boolean> => {
      emit('history', 'activity', 'Checking the day against a list of its transactions', { awaitingProvider: true });
      const listed = await listing!({ ...range.query, pageSize: SIGNATURE_PAGE_SIZE });
      check();
      if (listed.status !== 'complete') return failed(listed.failure);
      const alreadySaved = listed.signatures.filter(item => savedHere(item.signature)).length;
      const recovered: string[] = [];
      // A transaction retained for another wallet only needs this wallet to watch it.
      store.atomic(() => {
        for (const item of listed.signatures) {
          if (!savedHere(item.signature) && store.hasTransaction(network, item.signature)) { store.watch(network, item.signature, input.wallet); recovered.push(item.signature); }
        }
      });
      const missing = listed.signatures.filter(item => !store.hasTransaction(network, item.signature));
      if (missing.length > 0) {
        emit('history', 'activity', `Fetching ${missing.length} missed ${missing.length === 1 ? 'transaction' : 'transactions'}`, { awaitingProvider: true });
        const query = { ...range.query, startTime: Math.min(...missing.map(item => item.blockTime)), endTime: Math.max(...missing.map(item => item.blockTime)) + 1 };
        let pageIndex = 0;
        const result = await providers.history(query, null, page => {
          check();
          store.atomic(() => {
            if (job!.used.pages >= job!.limits.pages) throw new Error('page_budget');
            job!.used.pages++; store.saveJob(job!);
          });
          store.atomic(() => {
            for (const tx of [...page.transactions, ...page.excluded.map(item => item.transaction)]) {
              const signature = tx.transaction.signatures[0]!;
              const fresh = !savedHere(signature);
              store.addTransaction(network, tx, { source: 'helius', evidenceId: `check-${range.id}-${pageIndex}`, retrievedAt: page.source.retrievedAt, commitment: 'finalized' });
              store.watch(network, signature, input.wallet);
              if (fresh) recovered.push(signature);
            }
            processDirty(store, network, Math.max(100, page.transactions.length + page.excluded.length));
            pageIndex++;
          });
        });
        check();
        if (result.failure) return failed(result.failure);
      }
      const listedSet = new Set(listed.signatures.map(item => item.signature));
      const stillMissing = listed.signatures.filter(item => !savedHere(item.signature)).length;
      // Saved history the listing leaves out means the listing itself was short. Only this wallet's own history pages are
      // compared: feed hydrations, failed transactions and other wallets' pages are never listed by this query.
      const unlisted = store.classifiedSignatures(network, input.wallet, range.startTime, range.endTime)
        .filter(signature => !listedSet.has(signature) && store.historySaved(network, signature, input.wallet)).length;
      const agreed = stillMissing === 0 && unlisted === 0;
      store.atomic(() => {
        range.check = { status: agreed ? 'agreed' : 'disagreed', listed: listedSet.size, alreadySaved,
          recovered: [...new Set([...range.check?.recovered ?? [], ...recovered])], missing: stillMissing, unlisted };
        range.read = false;
        if (agreed) {
          store.completeRange(job!, range);
          const state = store.wallet(network, input.wallet)!;
          state.checked = mergeRanges([...state.checked ?? [], { startTime: range.startTime, endTime: range.endTime }]);
          store.saveWallet(state);
        } else if (!checking) {
          range.cursor = null; range.tainted = false;
          job!.failure = CHECK_DISAGREED; store.saveJob(job!);
        }
        store.saveRange(range);
      });
      return true;
    };
    for (const range of store.ranges(job.id)) {
      if (range.status === 'complete' || (checking && range.check)) continue;
      check();
      if (job.used.pages >= job.limits.pages || job.used.helius >= job.limits.helius) break;
      if (checking || range.read) {
        if (!await checkRange(range) && runtime.signal?.aborted) break;
        continue;
      }
      emit('history', 'activity', 'Waiting for blockchain history response', { awaitingProvider: true });
      const result = await providers.history(range.query, range.cursor, page => {
        check();
        store.atomic(() => {
          if (job!.used.pages >= job!.limits.pages) throw new Error('page_budget');
          // A fetched page consumes budget even if its evidence transaction later rolls back.
          job!.used.pages++; store.saveJob(job!);
        });
        store.atomic(() => {
          if (page.requestedCursor !== range.cursor || JSON.stringify(page.query) !== JSON.stringify(range.query)) {
            // Object field order is not part of a query identity.
            if (page.requestedCursor !== range.cursor || page.query.wallet !== range.query.wallet || page.query.startTime !== range.startTime
              || page.query.endTime !== range.endTime || page.query.pageSize !== range.query.pageSize) throw new Error('checkpoint_query_mismatch');
          }
          for (const tx of [...page.transactions, ...page.excluded.map(item => item.transaction)]) {
            const signature = store.addTransaction(network, tx, { source: 'helius', evidenceId: `page-${range.id}-${range.pages}`,
              retrievedAt: page.source.retrievedAt, commitment: 'finalized' });
            store.watch(network, signature, input.wallet);
          }
          processDirty(store, network, Math.max(100, page.transactions.length + page.excluded.length));
          range.tainted ||= page.excluded.length > 0;
          range.pages++; range.cursor = page.nextCursor;
          // A range read to its end is checked before it counts as loaded; without a signatures listing it is read once.
          if (page.nextCursor === null && !range.tainted && listing) range.read = true;
          store.saveJob(job!); store.saveRange(range);
          // No partial page, last transaction timestamp, or unacknowledged cursor establishes coverage.
          if (page.nextCursor === null && !range.tainted && !listing) store.completeRange(job!, range);
        });
        const ranges = store.ranges(job!.id);
        emit('history', 'activity', `Saved page ${range.pages}; transaction evidence normalized and classified`,
          { progress: { completed: ranges.filter(item => item.status === 'complete').length, total: ranges.length, unit: 'days' }, awaitingProvider: page.nextCursor !== null }, 'page_saved');
      });
      check();
      const problem = result.failure ? heliusFailureClass(result.failure) : null;
      if (result.failure) job.error = result.failure.category;
      if (problem) job.failure = problem;
      if (store.ranges(job.id).find(item => item.id === range.id)?.status !== 'complete' && (result.continuation.restartRequired || result.failure?.category === 'invalid_parameter')) {
        if (range.restarts < 1) { range.cursor = null; range.tainted = false; range.restarts++; store.saveRange(range); }
        else { range.tainted = true; store.saveRange(range); }
      }
      store.saveJob(job);
      // A rejected key or a quota refusal answers every later request the same way, so the job stops here.
      if (problem && HALTING_CLASSES.has(problem.class)) throw new Error('provider_refused');
      if (runtime.signal?.aborted) break;
      if (range.read && !await checkRange(range) && runtime.signal?.aborted) break;
      // Failed older chunks stay visible; independent newer chunks may still finish.
    }
    const completedDays = store.ranges(job.id).filter(range => range.status === 'complete').length;
    emit('history', 'completed', completedDays === planned.length ? `All ${planned.length} planned days saved`
      : `History retrieval attempt finished; ${completedDays} of ${planned.length} days saved`,
    { progress: { completed: completedDays, total: planned.length, unit: 'days' } });
    check(); emit('evidence', 'started', 'Checking exact distribution transaction evidence');
    if (!job.hydrationDone) {
      const signatures = (store.cache<string[]>(`job-feed:${job.id}`)?.value ?? []).slice(0, 12);
      let inspected = 0;
      // Independent hydrations run in parallel under the provider limiter; each is saved in feed order once every earlier
      // one is, so the evidence written is the serial loop's.
      await orderedPool<string, Awaited<ReturnType<Providers['hydrate']>> | 'saved'>(signatures, concurrency, signature => {
        if (store.hasTransaction(network, signature)) return Promise.resolve('saved');
        emit('evidence', 'activity', 'Waiting for exact distribution transaction', { awaitingProvider: true });
        return providers.hydrate(signature);
      }, (hydrated, signature) => {
        check();
        if (hydrated && hydrated !== 'saved') store.atomic(() => {
          store.addTransaction(network, hydrated.transaction, hydrated.provenance);
          // Hydrated payouts can include this wallet even when the history query was partial.
          store.watch(network, signature, input.wallet);
        });
        inspected++; emit('evidence', 'activity', hydrated === 'saved' ? 'Exact distribution evidence already saved' : 'Exact distribution transaction checked',
          { progress: { completed: inspected, total: signatures.length, unit: 'signatures' } });
      }, () => { check(); return job!.used.helius < job!.limits.helius; });
      job.hydrationDone = true; store.saveJob(job);
    }
    emit('evidence', 'completed', 'Exact distribution evidence checked');
    emit('normalization', 'started', 'Processing queued transaction normalization');
    emit('authority', 'started', 'Reconciling payout authority evidence');
    emit('classification', 'started', 'Classifying queued reward candidates');
    await drain('classification');
    emit('normalization', 'completed', 'Queued transfer normalization finished');
    emit('authority', 'completed', 'Queued payout authority evidence reconciled');
    emit('classification', 'completed', 'Queued reward candidates classified');
    check();
    if (!checking) {
      emit('pricing', 'started', 'Finding supported reward assets for current pricing');
      const verifiedMints = new Set<string>(); const attributedMints = new Set<string>();
      let after = '';
      while (true) {
        const rows = store.classifications(network, input.wallet, after, 500);
        if (!rows.length) break;
        for (const row of rows) {
          if (row.status === 'confirmed' && row.mint) verifiedMints.add(row.mint);
          else if (row.status === 'attributed' && row.mint) attributedMints.add(row.mint);
        }
        after = rows.at(-1)!.identity;
      }
      // Verified assets are priced first; attributed assets only use the remaining shared budget.
      const mints = [...verifiedMints, ...[...attributedMints].filter(mint => !verifiedMints.has(mint))];
      const sizing = store.cache<{ cap: number }>(stonkfunBudgetKey(job.id))?.value;
      if (sizing) {
        // One StonkFun request per mint without a saved unexpired price, on top of what discovery used, within the cap.
        const needed = mints.filter(mint => !((store.price(network, mint)?.expiresAt ?? 0) > runtime.now())).length;
        const used = job.used.stonkfun;
        job.limits.stonkfun = Math.max(used, Math.min(sizing.cap, used + needed)); store.saveJob(job);
        emit('pricing', 'activity', `StonkFun budget ${job.limits.stonkfun}: ${used} already used + ${needed} ${needed === 1 ? 'price' : 'prices'}${used + needed > sizing.cap ? `, capped at ${sizing.cap}` : ''}`,
          { progress: { completed: 0, total: mints.length, unit: 'assets' } });
      }
    let priced = 0;
    // A saved unexpired price is reused. Otherwise independent lookups run in parallel under the provider limiter and are
    // saved in mint order; once both budgets are spent no further lookup starts, as the serial loop stopped.
    const fresh = new Set<string>();
    await orderedPool(mints, concurrency, mint => {
      if (fresh.has(mint)) return Promise.resolve(null);
      emit('pricing', 'activity', 'Waiting for current asset price', { awaitingProvider: true,
        progress: { completed: priced, total: mints.length, unit: 'assets' } });
      // Native SOL is priced under the mint both sources quote it with, and saved under its sentinel.
      return providers.price(mint === NATIVE_SOL_MINT ? NATIVE_SOL_PRICE_MINT : mint);
    }, (quoted, mint) => {
      check();
      if (quoted) store.savePrice(network, { ...quoted, mint });
      priced++; emit('pricing', 'activity', quoted ? 'Current asset price saved' : 'Using saved current price',
        { progress: { completed: priced, total: mints.length, unit: 'assets' } });
    }, mint => {
      check(); const cached = store.price(network, mint);
      if (cached && cached.expiresAt > runtime.now()) { fresh.add(mint); return true; }
      return !(job!.used.helius >= job!.limits.helius && job!.used.stonkfun >= job!.limits.stonkfun);
    });
    emit('pricing', 'completed', 'Current-price lookup finished',
      { progress: { completed: priced, total: mints.length, unit: 'assets' } });
    } else emit('pricing', 'completed', 'Saved prices kept; a rescan requests none');
    check();
    const state = store.wallet(network, input.wallet)!;
    // A Load earlier job's target is its batch; a refresh's is the loaded range from its oldest day to the cutoff. Days still
    // missing stay gaps: the job pauses or exhausts, and the next job of its kind plans them again.
    const earlier = job.kind === 'earlier' && job.batch !== undefined;
    const target = earlier ? job.batch! : { startTime: state.trackingStart, endTime: job.cutoff };
    // A check job is done once every day was checked, whatever the check found.
    const gaps = checking ? store.ranges(job.id).filter(range => !range.check)
      : missingRanges(target.startTime, target.endTime, store.coverage(network, input.wallet));
    emit('checkpoint', 'started', 'Saving scan checkpoint and completed date coverage');
    if (gaps.length === 0 && input.snapshotHoldings && !earlier && !checking) await saveHoldings();
    if (listing) job.checkResult = checkResult(store, job, store.ranges(job.id));
    job.status = gaps.length === 0 ? 'complete' : job.used.pages >= job.limits.pages || job.used.helius >= job.limits.helius ? 'exhausted' : 'paused';
    finish(job);
    // A completed batch moves the oldest loaded day back to its start and is kept as the wallet's most recent batch.
    if (job.status === 'complete' && job.batch) {
      if (earlier) state.trackingStart = Math.min(state.trackingStart, job.batch.startTime);
      state.lastBatch = { kind: job.batch.kind, jobId: job.id, startTime: job.batch.startTime, endTime: job.batch.endTime,
        days: store.ranges(job.id).length, elapsedSeconds: Math.round(job.elapsedMs! / 1000), finishedAt: job.finishedAt! };
    }
    if (!earlier && !checking) state.lastSync = new Date(job.finishedAt!).toISOString();
    store.atomic(() => { store.saveJob(job!); store.saveWallet(state); });
    emit('checkpoint', 'completed', 'Scan checkpoint saved');
    emit('report', 'started', 'Calculating dashboard totals from saved evidence');
    return job;
  } catch (error) {
    if (!job) throw error instanceof Error && ADMISSION_REFUSALS.has(error.message) ? error : new Error('job_admission_failed');
    // An expired worker cannot overwrite the state of the process that took over its lease.
    try { store.renew(network, input.wallet, input.owner, runtime.now()); }
    catch { return store.job(job.id, network)!; }
    job = store.job(job.id, network)!;
    job.status = runtime.now() >= job.limits.deadline || job.used.helius >= job.limits.helius || job.used.pages >= job.limits.pages ? 'exhausted' : 'paused';
    // A halt keeps the Helius category and class the history step saved; any other error is classified here.
    const halted = error instanceof Error && error.message === 'provider_refused';
    if (!halted && !runtime.signal?.aborted) job.failure = thrownFailureClass(error) ?? job.failure ?? null;
    job.error = runtime.signal?.aborted ? 'cancelled' : halted ? job.error : 'scan_interrupted'; finish(job); store.saveJob(job); return job;
  } finally { store.release(network, input.wallet, input.owner); }
}
/** What a job's range checks found, counted from classification rows once they are drained: payouts in transactions the checks
 * saved, and payouts already saved in the same ranges. A check job's ranges are disjoint days, so no row counts twice. */
function checkResult(store: RewardsStore, job: Job, ranges: JobRange[]): CheckResult {
  const recovered = new Set(ranges.flatMap(range => range.check?.recovered ?? []));
  const found = { confirmed: 0, attributed: 0 }; const saved = { confirmed: 0, attributed: 0 };
  for (const range of mergeRanges(ranges.filter(item => item.check))) {
    for (const row of store.payoutRows(job.network, job.wallet, range.startTime, range.endTime)) (recovered.has(row.signature) ? found : saved)[row.status]++;
  }
  return { days: ranges.length, checkedDays: ranges.filter(range => range.check?.status === 'agreed').length,
    unconfirmedDays: ranges.filter(range => range.check?.status === 'disagreed').length, newTransactions: recovered.size,
    newPayouts: found.attributed, alreadySaved: saved.attributed, newVerified: found.confirmed, verifiedAlreadySaved: saved.confirmed };
}
