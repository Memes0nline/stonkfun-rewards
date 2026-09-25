import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { admitJob, earlierRefusal, runScan, STONKFUN_BUDGET_CAP } from '../scanner/engine.js';
import { heliusFailureClass } from '../scanner/failures.js';
import { processDirty } from '../scanner/classifier.js';
import { buildReport } from '../scanner/report.js';
import { planCheck } from '../scanner/ranges.js';
import type { Job, JobKind, Providers, Range, RewardsStore, ScanProgress } from '../scanner/types.js';
import type { ScanPhase } from '../scanner/progress.js';
import { waitText } from '../providers/limiter.js';
import type { Provider, WaitReason } from '../providers/limiter.js';
import { walletHoldings } from '../scanner/holdings.js';
import type { HistoryHolding } from '../scanner/holdings.js';
import { reportView, sourcesView } from './view.js';
import type { RetainedLaunchData } from './view.js';

/** Local-adapter reads the dashboard uses when a store offers them; none is part of RewardsStore. */
type WebStore = RewardsStore & {
  listWallets?: () => string[];
  rewardSummaryLaunches?: (network: 'mainnet-beta', quoteMint: string) => { launchMint: string; retrievedAt: string }[];
};
export interface DashboardOptions {
  store: (write?: boolean) => WebStore;
  prepareProviders: () => (job: Job, signal: AbortSignal, progress: (provider: 'stonkfun' | 'helius', count: number) => void,
    waiting: (provider: Provider, reason: WaitReason, delayMs: number) => void) => Providers;
  now?: () => number;
  offline?: boolean;
  /** Independent provider work in flight, read once providers are prepared; the engine's default when absent. */
  concurrency?: () => number;
  /** Takes a Helius key entered in the page, keeping it for later scans; with `remember`, also in the ignored `.env`. */
  acceptProviderKey?: (key: string, remember: boolean) => void;
}
interface ProgressSnapshot {
  startedAt: number;
  lastActivityAt: number;
  finishedAt: number | null;
  phase: ScanPhase;
  action: string;
  awaitingProvider: boolean;
  completedPhases: ScanPhase[];
  phaseProgress: ScanProgress['progress'] | null;
  events: { phase: ScanPhase; at: number; action: string }[];
  reportFailed: boolean;
  /** The wait before the next provider dispatch, until any later progress; a Helius rate limit here is shown as retrying. */
  waiting: { provider: Provider; reason: WaitReason } | null;
}
/** A Helius rate limit the running job is waiting out: temporary, never a failure. */
const RATE_LIMITED = heliusFailureClass({ category: 'transient', reason: 'rate_limit', retryable: true, action: 'retry' })!;
export class DashboardService {
  #options: DashboardOptions;
  #now: () => number;
  #active = new Map<string, { controller: AbortController; done: Promise<unknown>; progress: ProgressSnapshot; jobId: string | null }>();
  #finished = new Map<string, ProgressSnapshot>();
  #configured = false;
  #checked = false;
  #reclassifying = false;
  constructor(options: DashboardOptions) { this.#options = options; this.#now = options.now ?? Date.now; }
  health() { return { version: 1, providerConfigured: this.#configured, configurationChecked: this.#checked, offline: this.#options.offline ?? false, activeWallets: [...this.#active.keys()] }; }
  wallets() { return this.#options.store().listWallets?.() ?? []; }
  // Every detail record, so the attributed table and evidence cover every attributed row. The view keeps the
  // unknown and confirmed samples bounded to the first 500 records.
  report(wallet: string) { return reportView(buildReport(this.#options.store(), wallet, 'mainnet-beta', Number.MAX_SAFE_INTEGER)); }
  /** The likely source launches of each token, from saved data only. A refresh stores the wallet's holdings: its history-derived
   * rows, and its snapshot. Without them, or once retained data has changed since, the holdings are computed from every retained
   * transaction body the wallet watches, and kept per wallet until the store's retained data changes. */
  #retained = new Map<string, { key: string; holdings: ReadonlyMap<string, HistoryHolding>; summaries: Map<string, { launchMint: string; retrievedAt: string }[]> }>();
  sources(wallet: string) {
    const store = this.#options.store();
    return store.atomic(() => {
      const report = buildReport(store, wallet, 'mainnet-beta', Number.MAX_SAFE_INTEGER);
      if (!store.walletTokenBalances || !store.retainedFingerprint || !store.rewardSummaryLaunches) return { wallet, sources: null };
      const fingerprint = store.retainedFingerprint('mainnet-beta', wallet);
      const stored = store.holdings?.('mainnet-beta', wallet);
      const current = stored?.history?.fingerprint === fingerprint ? stored.history : null;
      const key = `${fingerprint}:${current?.takenAt ?? 'computed'}`;
      let cached = this.#retained.get(wallet);
      if (cached?.key !== key) {
        cached = { key, summaries: cached?.key.startsWith(`${fingerprint}:`) ? cached.summaries : new Map<string, { launchMint: string; retrievedAt: string }[]>(),
          holdings: current ? new Map(current.holdings.map(item => [item.mint, item])) : walletHoldings(store.walletTokenBalances('mainnet-beta', wallet)) };
        this.#retained.set(wallet, cached);
      }
      const mints = new Set([...report.cumulative.assets, ...report.totals.attributed.cumulative?.assets ?? []].map(asset => asset.mint));
      for (const mint of mints) if (!cached.summaries.has(mint)) cached.summaries.set(mint, store.rewardSummaryLaunches('mainnet-beta', mint));
      const retained: RetainedLaunchData = { summaries: cached.summaries, holdings: cached.holdings, snapshot: stored?.snapshot ?? null,
        launchMetadata: mint => { const meta = store.quote('mainnet-beta', mint); return meta ? { symbol: meta.symbol, name: meta.name } : undefined; },
        feedRows: signature => store.evidence('mainnet-beta', signature).feeds.flatMap(feed => feed.distributions.filter(item => item.signature === signature)
          .flatMap(item => item.rows.map(row => ({ launchMint: row.value.mint, quoteMint: row.value.quoteMint })))) };
      return { wallet, sources: sourcesView(report, retained) };
    });
  }
  job(target: string) {
    const store = this.#options.store(); const job = store.job(target, 'mainnet-beta');
    if (!job) return null;
    const local = this.#active.get(job.wallet);
    const progress = local?.jobId === job.id ? local.progress : this.#finished.get(job.id);
    const lastSync = store.job(job.wallet, 'mainnet-beta')?.id === job.id ? store.wallet('mainnet-beta', job.wallet)?.lastSync : null;
    const durableFinish = job.status === 'complete' ? job.finishedAt ?? (lastSync ? Date.parse(lastSync) : null) : null;
    const ranges = store.ranges(job.id);
    const completedDays = ranges.filter(range => range.status === 'complete').length;
    // Every day count the job shows is its saved days: the phase meter in days reads the same ranges as savedDays, for every
    // job kind, so the two never differ however the engine's events lag.
    const savedDays = { completed: completedDays, planned: ranges.length };
    const dayMeter = (meter: ScanProgress['progress'] | null) => meter?.unit === 'days' ? { completed: savedDays.completed, total: savedDays.planned, unit: meter.unit } : meter;
    const running = !!local && local.jobId === job.id;
    // A stopped job — paused, cancelled, failed or out of budget — keeps every completed day.
    const stopped = !running && job.status !== 'complete';
    const waiting = running ? local.progress.waiting : null;
    const failure = waiting?.provider === 'helius' && waiting.reason === 'rate_limit' ? RATE_LIMITED : job.failure ?? null;
    const budgetLeft = this.#now() < job.limits.deadline && job.used.resumes < job.limits.resumes
      && job.used.helius < job.limits.helius && job.used.pages < job.limits.pages;
    return { id: job.id, wallet: job.wallet, cutoff: job.cutoff, status: job.status,
      runningLocally: running,
      stage: progress?.phase ?? (job.status === 'running' ? 'interrupted_or_external' : job.status),
      progress: progress ? { ...progress, phaseProgress: dayMeter(progress.phaseProgress), serverNow: this.#now() } : {
        startedAt: job.createdAt, lastActivityAt: Number.isFinite(durableFinish) && durableFinish !== null ? durableFinish : job.createdAt,
        finishedAt: Number.isFinite(durableFinish) ? durableFinish : null,
        phase: null, action: job.status === 'running' ? 'No local worker is reporting activity' : 'Saved job state',
        awaitingProvider: false, completedPhases: [] as ScanPhase[], phaseProgress: null,
        events: [], reportFailed: false, waiting: null, serverNow: this.#now(),
      },
      used: job.used, limits: job.limits,
      // The Helius and StonkFun requests this job made, retries included, across every run.
      requests: { helius: job.used.helius, stonkfun: job.used.stonkfun },
      kind: job.kind ?? 'refresh', batch: job.batch ?? null,
      // A check job's chosen days, and what its checks found once its history is done.
      check: job.check ?? null, checkResult: job.checkResult ?? null,
      elapsedSeconds: job.elapsedMs === undefined ? null : Math.round(job.elapsedMs / 1000),
      ranges: ranges.map(range => ({ startTime: range.startTime, endTime: range.endTime, status: range.status, pages: range.pages, ...(range.check ? { check: range.check.status } : {}) })),
      savedDays,
      savedNote: stopped ? `Completed days are saved: ${savedDays.completed} of ${savedDays.planned}.` : null,
      failureClass: failure?.class ?? null, failureMessage: failure?.message ?? null, failureDetail: failure?.detail ?? null,
      canResume: !this.#options.offline && !local && (job.status === 'paused' || job.status === 'running') && budgetLeft,
      resumeBlocked: job.status !== 'complete' && (job.status === 'exhausted' || !budgetLeft),
      cancelled: job.error === 'cancelled',
      failure: progress?.reportFailed ? 'Dashboard report calculation failed; saved evidence remains' : job.error && job.error !== 'cancelled' ? (job.error === 'resume_budget_or_deadline' ? 'Budget or deadline reached'
        : 'Scan interrupted; acknowledged work is saved') : null,
    };
  }
  /** Starts a refresh, a Load earlier batch, a check of chosen days, or a resume of a saved job. Load earlier is refused when
   * the wallet has nothing loaded or its loaded range already starts at the floor; a check, when its days are not whole UTC days,
   * number more than seven or leave the loaded range. */
  start(wallet: string, resume?: string, kind: JobKind = 'refresh', check?: Range) {
    if (this.#options.offline) throw new Error('offline_mode');
    if (this.#reclassifying) throw new Error('local_work_busy');
    if (this.#active.has(wallet)) return this.job(wallet)!;
    let previous = this.#options.store().job(resume ?? wallet, 'mainnet-beta');
    // Let the engine retire an expired orphan under its normal fenced lease. Otherwise a
    // saved paused job could permanently block new checks after its Resume deadline.
    if (!resume && previous && (previous.status === 'paused' || previous.status === 'running')
      && (this.#now() >= previous.limits.deadline || previous.used.resumes >= previous.limits.resumes)) {
      const store = this.#options.store(true); const owner = randomUUID();
      try { store.acquire('mainnet-beta', wallet, owner, this.#now()); }
      catch { return this.job(wallet)!; }
      try {
        previous = admitJob(store, { wallet, cutoff: previous.cutoff, jobId: previous.id, owner, resume: previous.id, limits: previous.limits }, this.#now());
      } finally { store.release('mainnet-beta', wallet, owner); }
    }
    // Admission is synchronous through runScan's first await, so duplicate requests cannot race. An unfinished job of either
    // kind is returned as it is, for Resume.
    if (!resume && previous && (previous.status === 'running' || previous.status === 'paused')) return this.job(wallet)!;
    if (kind === 'earlier' && !resume) {
      const refusal = earlierRefusal(this.#options.store(), 'mainnet-beta', wallet);
      if (refusal) throw new Error(refusal);
    }
    if (kind === 'check' && !resume) {
      const saved = this.#options.store(); const state = saved.wallet('mainnet-beta', wallet);
      if (!state || saved.coverage('mainnet-beta', wallet).length === 0) throw new Error('wallet_not_loaded');
      if (!check) throw new Error('check_range_invalid');
      planCheck(check, { startTime: state.trackingStart, endTime: state.cutoff });
    }
    if (resume && (!previous || previous.wallet !== wallet || !this.job(resume)?.canResume)) throw new Error('job_not_resumable');
    this.#checked = true;
    let factory: ReturnType<DashboardOptions['prepareProviders']>;
    let concurrency: number | undefined;
    try { factory = this.#options.prepareProviders(); concurrency = this.#options.concurrency?.(); this.#configured = true; }
    catch { this.#configured = false; throw new Error('provider_not_configured'); }
    const store = this.#options.store(true);
    const controller = new AbortController();
    const startedAt = previous && resume ? previous.createdAt : this.#now();
    const progressState: ProgressSnapshot = { startedAt, lastActivityAt: startedAt, finishedAt: null,
      phase: 'preparing', action: 'Preparing scan', awaitingProvider: false,
      completedPhases: [], phaseProgress: null, events: [], reportFailed: false, waiting: null };
    const entry = { controller, done: Promise.resolve<unknown>(undefined), progress: progressState, jobId: resume ?? null as string | null };
    this.#active.set(wallet, entry);
    const progress = (event: ScanProgress) => {
      entry.jobId = event.jobId;
      progressState.waiting = null;
      progressState.lastActivityAt = event.at;
      progressState.phase = event.phase;
      progressState.action = event.action;
      progressState.awaitingProvider = event.awaitingProvider ?? false;
      if (event.progress) progressState.phaseProgress = event.progress;
      else if (event.kind === 'started') progressState.phaseProgress = null;
      if (event.kind === 'completed' && !progressState.completedPhases.includes(event.phase))
        progressState.completedPhases.push(event.phase);
      if (event.kind !== 'activity') progressState.events.push({ phase: event.phase, at: event.at, action: event.action });
    };
    const providerProgress = (provider: 'stonkfun' | 'helius', count: number) => {
      progress({ jobId: entry.jobId ?? '', stage: provider, count, phase: progressState.phase, kind: 'activity', at: this.#now(),
        action: `${provider === 'helius' ? 'Helius' : 'StonkFun'} request ${count} dispatched`,
        awaitingProvider: true });
    };
    // Every wait before a dispatch — pacing, a provider rate limit or retry backoff — is shown with its reason.
    const providerWaiting = (provider: Provider, reason: WaitReason, delayMs: number) => {
      progress({ jobId: entry.jobId ?? '', stage: provider, phase: progressState.phase, kind: 'activity', at: this.#now(),
        action: waitText(provider, reason, delayMs), awaitingProvider: true });
      progressState.waiting = { provider, reason };
    };
    entry.done = runScan(store, { wallet, cutoff: previous && resume ? previous.cutoff : Math.floor(this.#now() / 1000),
      jobId: randomUUID(), owner: randomUUID(), ...(resume ? { resume } : {}), kind: resume ? previous?.kind ?? 'refresh' : kind,
      ...(!resume && kind === 'check' && check ? { check } : {}),
      // StonkFun is sized when pricing starts: discovery plus one request per mint needing a price, within the cap.
      sizeStonkfunBudget: true, snapshotHoldings: true,
      limits: { stonkfun: STONKFUN_BUDGET_CAP, helius: 200, pages: 200, resumes: 10, deadline: this.#now() + 3_600_000 },
    }, job => factory(job, controller.signal, providerProgress, providerWaiting), { now: this.#now, signal: controller.signal, progress,
      ...(concurrency === undefined ? {} : { concurrency }) })
      .then(result => {
        progressState.lastActivityAt = this.#now(); progressState.awaitingProvider = false;
        if (result.status === 'complete') {
          this.report(wallet);
          progress({ jobId: result.id, stage: 'report', phase: 'report', kind: 'completed', at: this.#now(), action: 'Dashboard totals calculated from saved evidence' });
          progress({ jobId: result.id, stage: 'complete', phase: 'complete', kind: 'completed', at: this.#now(), action: 'Scan complete' });
        } else {
          progressState.action = result.error === 'cancelled' ? 'Cancelled; acknowledged pages and evidence remain saved'
            : result.status === 'exhausted' ? 'Stopped at saved budget or deadline; a new check can fill gaps'
              : 'Paused with acknowledged pages and evidence saved';
        }
      }).catch(() => { progressState.reportFailed = true; progressState.action = 'Dashboard report calculation failed; saved evidence remains'; })
      .finally(() => {
        progressState.finishedAt = this.#now();
        if (entry.jobId) this.#finished.set(entry.jobId, { ...progressState });
        this.#active.delete(wallet);
      });
    const admitted = store.job(wallet, 'mainnet-beta');
    if (admitted?.id === entry.jobId) progressState.startedAt = admitted.createdAt;
    const result = this.job(wallet);
    if (!result) throw new Error('job_admission_failed');
    return result;
  }
  /** A key entered in the page. It configures later scans and is never returned: the answer is the health record. */
  configureProvider(key: string, remember: boolean) {
    if (this.#options.offline) throw new Error('offline_mode');
    if (!this.#options.acceptProviderKey) throw new Error('not_found');
    this.#options.acceptProviderKey(key, remember);
    this.#configured = true; this.#checked = true;
    return this.health();
  }
  cancel(id: string) {
    const job = this.#options.store().job(id, 'mainnet-beta');
    if (!job || !this.#active.has(job.wallet) || this.#options.store().job(job.wallet, 'mainnet-beta')?.id !== id) throw new Error('job_not_running_locally');
    this.#active.get(job.wallet)!.controller.abort(); return this.job(id);
  }
  async reclassify(wallet: string) {
    if (this.#options.offline) throw new Error('offline_mode');
    if (this.#active.size || this.#reclassifying) throw new Error('local_work_busy');
    if (!this.#options.store().wallet('mainnet-beta', wallet)) throw new Error('wallet_not_tracked');
    this.#reclassifying = true;
    try {
      const store = this.#options.store(true);
      while (processDirty(store, 'mainnet-beta', 100) > 0) await setImmediate();
      return this.report(wallet);
    } finally { this.#reclassifying = false; }
  }
  async settle() { await Promise.all([...this.#active.values()].map(entry => entry.done)); }
  async shutdown() { for (const entry of this.#active.values()) entry.controller.abort(); await this.settle(); }
}
export type DashboardJob = NonNullable<ReturnType<DashboardService['job']>>;
