import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardReport, LaunchSources } from '../src/web/view.js';
import type { DashboardJob } from '../src/web/service.js';
import { Coverage } from './Coverage.js';
import { daysToCheck, EMPTY_PALETTE, firstScanRangeText, hasSavedCoverage, utcDay, historyStatus, lastSyncText, parseReceiptSort, PERIOD_PARAMS, primaryLabel, receiptSortParam, refreshRangeText, rescanButtonText,
  resolvePeriod, runningElsewhere, runningRangeText, short, SOURCES_TIMEOUT_MS, tokenPalette, walletInputError } from './model.js';
import type { Health, ReceiptFilters, RescanPick, TabId } from './model.js';
import { RescanDialog } from './Rescan.js';
import { Overview } from './Overview.js';
import { EvidenceModal, PayoutsTab } from './Payouts.js';
import { Progress } from './Progress.js';
import { KeyForm, RefreshControl, UnscannedPanel } from './Refresh.js';
import { StatusMenu } from './Status.js';
import { TabBar, TabPanel, useRoute } from './Tabs.js';
import { TokensTab } from './Tokens.js';
import type { SourcesState } from './Tokens.js';
import { Trust } from './Trust.js';

const messages: Record<string, string> = {
  wallet_not_tracked: 'No saved report for this wallet. Scan wallet to start its first scan.',
  provider_not_configured: 'Provider not configured. Enter a Helius API key to refresh rewards.',
  invalid_request: 'Enter a valid public Solana wallet address.',
  job_not_resumable: 'This job cannot resume within its saved limits. Start a new scan after it is exhausted.',
  job_admission_failed: 'The wallet may be in use by another scanner. Wait for its lease to expire before resuming.',
  offline_mode: 'This server is in offline viewing mode.',
  earlier_history_at_floor: 'History is already loaded back to the floor; there is nothing earlier to load.',
  wallet_not_loaded: 'Nothing is loaded for this wallet yet. Scan the wallet first, then load earlier history.',
  check_range_invalid: 'Choose a start day and an end day, the start on or before the end.',
  check_range_too_long: 'Rescan at most 7 days at a time.',
  check_range_outside_loaded: 'Rescan only days inside the loaded history.',
};
const keyMessages: Record<string, string> = {
  invalid_request: 'The local server did not accept that key. Enter it exactly as Helius shows it.',
  key_not_saved: 'The key could not be written to .env, so it was not kept. Try again without Remember.',
  offline_mode: 'This server is in offline viewing mode; it takes no key.',
};
/** A failed local request, carrying the server's fixed error code. */
class ApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
async function api<T>(path: string, body?: object, wording: Record<string, string> = messages): Promise<T> {
  const response = await fetch(`/api/v1${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result: unknown = await response.json();
  if (!response.ok) { const code = (result as { error?: string }).error ?? ''; throw new ApiError(code, wording[code] ?? 'Local dashboard request failed. Saved progress is retained.'); }
  return result as T;
}
/** One key per stop of a job, complete or not, once it is no longer running here; null while it runs or has never run here. */
const stoppedKey = (job: DashboardJob | null) => job && !job.runningLocally && (job.status === 'complete' || job.progress.finishedAt !== null)
  ? `${job.id}:${job.status}:${job.savedDays.completed}` : null;
function remembered() { try { return localStorage.getItem('stonkfun:last-wallet:v1') ?? ''; } catch { return ''; } }
function remember(wallet: string) { try { localStorage.setItem('stonkfun:last-wallet:v1', wallet); } catch { /* optional local preference */ } }

/** Adds a wallet to the saved list, in the server's address order. */
const withWallet = (wallets: string[], wallet: string) => wallets.includes(wallet) ? wallets : [...wallets, wallet].sort();

export function App() {
  // The wallet in view, chosen by the wallet box or the saved list; every button acts on it. The box may hold an address that
  // could not become the view, which Enter and the primary button then explain.
  const [input, setInput] = useState(''); const [wallet, setWallet] = useState('');
  // The wallet whose job and report have been read; until then the page does not know whether it has saved coverage.
  const [loaded, setLoaded] = useState('');
  const [wallets, setWallets] = useState<string[]>([]); const [report, setReport] = useState<DashboardReport | null>(null);
  const [job, setJob] = useState<DashboardJob | null>(null); const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [modal, setModal] = useState(false);
  // The key form opens when a scan finds no provider; the note confirms a saved key.
  const [keyForm, setKeyForm] = useState(false); const [keySaved, setKeySaved] = useState(false);
  // Opened after Helius rejected the key, the form says so instead of reporting a missing provider.
  const [keyRejected, setKeyRejected] = useState(false);
  // Why the address in the input cannot be loaded, shown under it before any request is made.
  const [inputError, setInputError] = useState('');
  // The wallet box, focused on a first launch with no saved wallet.
  const box = useRef<HTMLInputElement>(null);
  const [route, navigate] = useRoute();
  // Rescan dates: closed, or open with the week it was opened on (null for the newest week).
  const [rescan, setRescan] = useState<{ pick: RescanPick | null } | null>(null);
  // One receipt's evidence, opened from the Payouts list or a token drawer's receipts.
  const [evidence, setEvidence] = useState<string | null>(null);
  // Likely source launches for the wallet on screen. The launches of the wallet already shown stay on screen while a reload runs.
  // After SOURCES_TIMEOUT_MS a load with nothing to show offers Retry, and its answer still shows if it arrives.
  const [sources, setSources] = useState<SourcesState>({ status: 'idle', data: null });
  const loadSources = useCallback(() => {
    const target = selected.current;
    if (!target) return;
    const current = () => selected.current === target;
    setSources(state => ({ status: 'loading', data: state.wallet === target ? state.data : null, wallet: target }));
    const timer = setTimeout(() => {
      if (current()) setSources(state => state.status === 'loading' && state.wallet === target && !state.data ? { status: 'failed', data: null, reason: 'timeout', wallet: target } : state);
    }, SOURCES_TIMEOUT_MS);
    void api<{ wallet: string; sources: LaunchSources | null }>(`/wallets/${target}/sources`)
      .then(result => { if (current() && result.wallet === target) setSources({ status: 'ready', data: result.sources, wallet: target }); })
      .catch(() => { if (current()) setSources(state => state.wallet === target && state.data ? { ...state, status: 'ready' } : { status: 'failed', data: null, reason: 'error', wallet: target }); })
      .finally(() => { clearTimeout(timer); });
  }, []);
  // Read as soon as the Tokens tab opens, once per report: a refresh brings a new report, and the launches are read again.
  const sourcesFor = useRef<DashboardReport | null>(null);
  useEffect(() => {
    if (!report || route.tab !== 'tokens' || sourcesFor.current === report) return;
    sourcesFor.current = report; loadSources();
  }, [report, route.tab, loadSources]);
  const selected = useRef('');
  const refreshed = useRef(new Set<string>());
  const receivedAt = useRef(Date.now());
  const [tick, setTick] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { receivedAt.current = Date.now(); setTick(Date.now()); }, [job?.progress.serverNow]);
  const now = job ? job.progress.serverNow + Math.max(0, tick - receivedAt.current) : tick;
  // The overview's period, kept while other tabs are open so returning to the overview shows it again.
  const overviewPeriod = useRef<Record<string, string>>({});
  useEffect(() => {
    if (route.tab !== 'overview') return;
    overviewPeriod.current = Object.fromEntries(PERIOD_PARAMS.flatMap(key => { const value = route.params[key]; return value ? [[key, value] as const] : []; }));
  }, [route]);
  // Another tab opens unfiltered and the overview with its last period; re-selecting the open tab keeps its filters, such as a
  // day opened from the chart.
  const select = useCallback((tab: TabId, options?: { replace?: boolean }) => {
    navigate(current => current.tab === tab ? current : { tab, params: tab === 'overview' ? overviewPeriod.current : {} }, options);
  }, [navigate]);
  // Arriving at a tab from further down the page (a chart day, a top token) brings the tabs back into view.
  useEffect(() => { const bar = document.querySelector('.tabs'); if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: 'start' }); }, [route.tab]);
  const load = useCallback(async (target: string) => {
    const invalid = walletInputError(target);
    if (invalid) { setInputError(invalid); return; }
    setInputError('');
    // Filters and the period in the hash belong to the wallet on screen; a shared link's survive only the first load.
    if (selected.current && selected.current !== target) { overviewPeriod.current = {}; navigate(current => ({ tab: current.tab, params: {} }), { replace: true }); }
    selected.current = target; setInput(target); setWallet(target); setLoaded(''); setError(''); setReport(null); setJob(null); setEvidence(null);
    try {
      const nextJob = await api<DashboardJob | null>(`/wallets/${target}/job`);
      // A wallet the server does not track has no report: it has not been scanned yet, which is not an error.
      const nextReport = await api<DashboardReport>(`/wallets/${target}/report`)
        .catch((cause: unknown) => { if (cause instanceof ApiError && cause.code === 'wallet_not_tracked') return null; throw cause; });
      if (selected.current === target) {
        setReport(nextReport); setJob(nextJob); setLoaded(target); const key = stoppedKey(nextJob); if (key) refreshed.current.add(key);
        // Only a tracked wallet is remembered for the next visit, and only one with saved coverage joins the saved list.
        if (nextReport) remember(target);
        if (hasSavedCoverage(nextReport)) setWallets(previous => withWallet(previous, target));
      }
    } catch (cause) { if (selected.current === target) setError((cause as Error).message); }
  }, [navigate]);
  /** Switches the view to a well-formed address pasted, typed or submitted in the wallet box. */
  const choose = (value: string) => { const target = value.trim(); if (target !== selected.current && !walletInputError(target)) void load(target); };
  useEffect(() => {
    let alive = true;
    void Promise.all([api<Health>('/health'), api<{ wallets: string[] }>('/wallets')]).then(([status, saved]) => {
      if (!alive) return; setHealth(status); setWallets(saved.wallets);
      const last = remembered(); const target = saved.wallets.includes(last) ? last : saved.wallets[0];
      if (target) void load(target); else box.current?.focus();
    }).catch(() => { if (alive) setError('The local server is unavailable. Reopen the dashboard launcher.'); });
    return () => { alive = false; };
  }, [load]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api<Health>('/health'); if (alive) setHealth(status);
        if (wallet) {
          const nextJob = await api<DashboardJob | null>(`/wallets/${wallet}/job`);
          if (alive && selected.current === wallet) setJob(nextJob);
          // A job that stopped, complete or not, may have saved days: the report is read again once for each stop.
          const key = stoppedKey(nextJob);
          if (key && !refreshed.current.has(key)) {
            refreshed.current.add(key);
            try {
              const nextReport = await api<DashboardReport>(`/wallets/${wallet}/report`);
              // A first scan that saved its days brings the wallet's report into view and adds the wallet to the saved list.
              if (alive && selected.current === wallet) {
                setReport(nextReport); remember(wallet); if (hasSavedCoverage(nextReport)) setWallets(previous => withWallet(previous, wallet));
              }
            }
            catch { refreshed.current.delete(key); throw new Error('report_refresh_failed'); }
          }
        }
      } catch { if (alive) setError('Connection to the local server lost. Reopen the launcher to view saved progress.'); }
      if (alive) timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { alive = false; clearTimeout(timer); };
  }, [wallet]);
  /** The primary button: Scan wallet or Refresh rewards for the wallet in view. An address in the box that could not become the
   * view is explained under the box instead, and starts nothing. */
  function primary() {
    const typed = input.trim();
    if (!wallet || typed !== wallet) {
      const invalid = walletInputError(typed);
      if (invalid) setInputError(invalid); else choose(typed);
      return;
    }
    void scan(wallet);
  }
  /** Starts the first scan or a refresh of `target`, the wallet in view, and opens its progress. The wallet joins the saved list
   * once its report has saved coverage. */
  async function scan(target: string) {
    setInputError(''); setKeySaved(false);
    // A provider already found missing opens the key form at once; otherwise the server finds out when the scan starts.
    if (health?.configurationChecked && !health.providerConfigured) { setKeyRejected(false); setKeyForm(true); return; }
    setBusy(true); setError('');
    try {
      const result = await api<DashboardJob>('/scans', { wallet: target });
      if (selected.current === target) { setJob(result); setModal(true); }
      // Other wallets' buttons wait for this job at once, not at the next poll.
      void api<Health>('/health').then(setHealth).catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'provider_not_configured') {
        setKeyRejected(false); setKeyForm(true); void api<Health>('/health').then(setHealth).catch(() => undefined);
      } else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  /** Starts the next Load earlier batch for the wallet on screen and opens its progress. An interrupted batch that can resume is
   * resumed, so its saved days are kept; otherwise the server plans the batch's missing days again. */
  async function loadEarlier() {
    const target = wallet;
    if (!target) return;
    if (health?.configurationChecked && !health.providerConfigured) { setKeyRejected(false); setKeyForm(true); return; }
    setBusy(true); setError(''); setKeySaved(false);
    try {
      let result = await api<DashboardJob>('/scans', { wallet: target, kind: 'earlier' });
      if (result.kind === 'earlier' && !result.runningLocally && result.canResume) result = await api<DashboardJob>(`/jobs/${result.id}/resume`, {});
      if (selected.current === target) { setJob(result); setModal(true); }
      // Other wallets' buttons wait for this job at once, not at the next poll.
      void api<Health>('/health').then(setHealth).catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'provider_not_configured') {
        setKeyRejected(false); setKeyForm(true); void api<Health>('/health').then(setHealth).catch(() => undefined);
      } else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  /** Starts a rescan of the chosen days for the wallet on screen and opens its progress: each day is listed again and anything
   * missing is fetched and saved. */
  async function startRescan(pick: RescanPick) {
    const target = wallet;
    if (!target) return;
    if (health?.configurationChecked && !health.providerConfigured) { setRescan(null); setKeyRejected(false); setKeyForm(true); return; }
    setBusy(true); setError(''); setKeySaved(false);
    try {
      const result = await api<DashboardJob>('/scans', { wallet: target, kind: 'check', startDay: pick.start, endDay: pick.end });
      setRescan(null);
      if (selected.current === target) { setJob(result); setModal(true); }
      void api<Health>('/health').then(setHealth).catch(() => undefined);
    } catch (cause) {
      setRescan(null);
      if (cause instanceof ApiError && cause.code === 'provider_not_configured') {
        setKeyRejected(false); setKeyForm(true); void api<Health>('/health').then(setHealth).catch(() => undefined);
      } else setError((cause as Error).message);
    } finally { setBusy(false); }
  }
  /** Posts the key once. The page keeps nothing: the form clears it, and the answer is the server's health record. */
  const saveKey = useCallback(async (key: string, remember: boolean) => {
    const next = await api<Health>('/provider-key', { key, remember }, keyMessages);
    setHealth(next); setKeyForm(false); setKeyRejected(false); setKeySaved(true);
  }, []);
  const closeKeyForm = useCallback(() => { setKeyForm(false); setKeyRejected(false); }, []);
  /** Retries a stopped job: Resume when it can, otherwise the same kind of job again, which keeps every saved day. */
  function retry() {
    if (!job) return;
    if (job.canResume) void jobAction('resume');
    else if (job.kind === 'earlier') void loadEarlier();
    else if (job.kind === 'check' && job.check) void startRescan({ start: utcDay(job.check.startTime), end: utcDay(job.check.endTime - 1) });
    else void scan(job.wallet);
  }
  const running = (job?.runningLocally ?? false) || (!!wallet && (health?.activeWallets.includes(wallet) ?? false));
  // Saved coverage decides Scan wallet or Refresh rewards. It is known once the wallet in view has been read; until then the
  // primary button waits.
  const reading = !!wallet && loaded !== wallet;
  const scanned = !reading && hasSavedCoverage(report?.wallet === wallet ? report : null);
  const unscanned = !!wallet && !reading && !scanned;
  // The page starts one job at a time: while another wallet's job runs, starts for the wallet in view wait and say for which.
  const runningFor = runningElsewhere(health, wallet);
  async function jobAction(kind: 'resume' | 'cancel') {
    if (!job) return;
    const target = wallet;
    try { const result = await api<DashboardJob>(`/jobs/${job.id}/${kind}`, {}); if (selected.current === target) { setJob(result); setError(''); } }
    catch (cause) { setError((cause as Error).message); }
  }
  async function reclassify() {
    setBusy(true);
    const target = wallet;
    try { const result = await api<DashboardReport>(`/wallets/${wallet}/reclassify`, {}); if (selected.current === target) { setReport(result); setError(''); } }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  // Token colors follow the overview's period, the one on screen or the one it will return to, on every tab.
  const periodKey = JSON.stringify(route.tab === 'overview' ? route.params : overviewPeriod.current);
  const palette = useMemo(() => report ? tokenPalette(report, resolvePeriod(report, JSON.parse(periodKey) as Record<string, string>).period) : EMPTY_PALETTE,
    [report, periodKey]);
  // The Payouts filters and sort live in the hash together; the default sort, newest first, is left out.
  const payoutFilters: ReceiptFilters = { day: route.params.day, token: route.params.token, trust: route.params.trust, price: route.params.price };
  const payouts = (filters: ReceiptFilters, sort: string | null | undefined) => {
    navigate({ tab: 'payouts', params: Object.fromEntries(Object.entries({ ...filters, sort }).filter((entry): entry is [string, string] => !!entry[1])) }, { replace: true });
  };
  const panel = (current: DashboardReport) => route.tab === 'overview'
    ? <Overview report={current} params={route.params} palette={palette} onPeriod={params => { navigate({ tab: 'overview', params }, { replace: true }); }}
      onDay={(day, token) => { navigate({ tab: 'payouts', params: token ? { day, token } : { day } }); }}
      // Payouts has no date-range filter, so a ranked token opens all its payouts, highest USD first.
      onTokenPayouts={token => { navigate({ tab: 'payouts', params: { token, sort: 'usd-desc' } }); }}
      onEarlier={() => { void loadEarlier(); }} canEarlier={!busy && !running && !runningFor && !health?.offline}/>
    : route.tab === 'tokens' ? <TokensTab report={current} selected={route.params.token} palette={palette} open={token => { navigate({ tab: 'tokens', params: { token } }); }}
      close={() => { navigate({ tab: 'tokens', params: {} }); }} onReceipt={setEvidence} launchSources={sources.wallet === wallet ? sources : { status: 'idle', data: null }} loadSources={loadSources}/>
      : route.tab === 'payouts' ? <PayoutsTab report={current} openReceipt={setEvidence} palette={palette} filters={payoutFilters} sort={parseReceiptSort(route.params.sort)}
        setFilters={next => { payouts(next, route.params.sort); }} setSort={next => { payouts(payoutFilters, receiptSortParam(next)); }}/>
        : route.tab === 'trust' ? <Trust report={current}/>
          : <Coverage report={current} reclassify={() => { void reclassify(); }} canReclassify={!busy && !health?.offline && !health?.activeWallets.length}
            onEarlier={() => { void loadEarlier(); }} canEarlier={!busy && !running && !runningFor && !health?.offline}
            onRescan={pick => { setRescan({ pick }); }} canRescan={!busy && !running && !runningFor && !health?.offline}/>;
  const history = scanned && report ? historyStatus(report) : null;
  // The primary button's second line: the span the running job reads, or the time the next scan would read.
  const shownReport = report?.wallet === wallet ? report : null;
  const range = running ? (job?.wallet === wallet && job.runningLocally ? runningRangeText(job, shownReport?.history.loadedFrom ?? null) : null)
    : scanned && shownReport ? refreshRangeText(shownReport) : unscanned ? firstScanRangeText(now / 1000) : null;
  return <><header className="topbar">
    <h1 className="brand"><span className="brand-mark" aria-hidden="true">▥</span> STONKFUN <span>REWARDS</span></h1>
    <form className="wallet-form" onSubmit={event => { event.preventDefault(); const invalid = walletInputError(input); if (invalid) setInputError(invalid); else choose(input); }}>
      <label htmlFor="wallet" className="sr-only">PUBLIC WALLET ADDRESS</label>
      {/* A well-formed address switches the view as it is pasted or typed; Enter explains one that is not. */}
      <input id="wallet" ref={box} value={input} onChange={event => { setInput(event.target.value); setInputError(''); choose(event.target.value); }}
        aria-invalid={inputError ? true : undefined} aria-describedby={inputError ? 'wallet-error' : undefined} placeholder="Paste a Solana wallet address"
        spellCheck={false} autoComplete="off"/>
      {inputError ? <p className="wallet-error" id="wallet-error" role="alert">{inputError}</p> : null}
      <select aria-label="Saved wallets" value={wallets.includes(wallet) ? wallet : ''} onChange={event => { if (event.target.value) void load(event.target.value); }}><option value="">Saved wallets</option>{wallets.map(saved => <option key={saved} value={saved}>{short(saved)}</option>)}</select>
    </form>
    <RefreshControl health={health} running={running} busy={busy || reading} scanned={scanned} runningFor={runningFor} lastRefresh={report ? lastSyncText(report) : 'never'} history={history} range={range}
      onRefresh={primary} onEarlier={() => { void loadEarlier(); }} onRescan={() => { setRescan({ pick: null }); }}
      rescanText={rescanButtonText(scanned && shownReport ? daysToCheck(shownReport) : 0)}>
      {keyForm ? <KeyForm save={saveKey} close={closeKeyForm} rejected={keyRejected}/>
        : keySaved ? <span className="refresh-note" role="status">Provider configured. {primaryLabel(scanned)} when ready.</span> : null}
    </RefreshControl>
    <StatusMenu report={report} health={health} job={job} now={now} wallet={wallet} scanned={!unscanned} openProgress={() => { setModal(true); }}
      openWallet={active => { void load(active); setModal(true); }}/>
  </header>
    <main id="main">
      {/* The status control holds the mode, provider, sync, cutoff and row counts; the tabs sit directly under the header. */}
      {(scanned && report) || unscanned ? <>
        <TabBar active={route.tab} select={select}/>
        {error ? <div className="notice warning" role="alert">{error}</div> : null}
        {/* A wallet with no saved coverage shows the same panel on every tab, with Scan wallet. */}
        <TabPanel tab={route.tab}>{scanned && report ? panel(report)
          : <UnscannedPanel wallet={wallet} health={health} running={running} busy={busy} runningFor={runningFor} range={range} onScan={() => { void scan(wallet); }}/>}</TabPanel>
      </> : error ? <div className="notice warning" role="alert">{error}</div> : null}
      {wallet ? null : <div className="welcome panel"><span className="eyebrow">YOUR WALLET, YOUR LOCAL DATA</span><h2>Start with a wallet address.</h2>
        <p>Paste a public wallet above. A saved wallet opens its report offline;<br/>a new one offers Scan wallet, which starts an explicit scan with your Helius key.</p>
        <p className="muted">No wallet connection. No signature. No automatic scans.</p></div>}
      <footer><span>STONKFUN REWARDS <span className="muted">/ LOCAL SCANNER</span></span><span>PUBLIC ADDRESSES. EXACT AMOUNTS. VISIBLE UNCERTAINTY.</span></footer>
    </main>{modal && job ? <Progress job={job} now={now} report={report?.wallet === job.wallet ? report : null} close={() => { setModal(false); }} action={kind => { void jobAction(kind); }}
      onRetry={retry} onKey={() => { setModal(false); setKeySaved(false); setKeyRejected(true); setKeyForm(true); }}/> : null}
    {rescan && scanned && report ? <RescanDialog report={report} initial={rescan.pick} busy={busy} onStart={pick => { void startRescan(pick); }}
      onClose={() => { setRescan(null); }}/> : null}
    {report && evidence ? (() => { const receipt = report.attribution.receipts?.find(item => item.id === evidence);
      return receipt ? <EvidenceModal key={receipt.id} report={report} receipt={receipt} onClose={() => { setEvidence(null); }}/> : null; })() : null}</>;
}
