import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { SqliteRewardsStore } from '../storage/sqlite.js';
import { earlierRefusal, runScan, STONKFUN_BUDGET_CAP } from '../scanner/engine.js';
import type { Job } from '../scanner/types.js';
import { buildReport, humanReport } from '../scanner/report.js';
import { processDirty } from '../scanner/classifier.js';
import { createRealProviders } from '../providers/real.js';
import { scanSpeed, waitText } from '../providers/limiter.js';
import { runDemo } from './demo.js';
import { EARLIER_BATCH_DAYS, FIRST_SCAN_DAYS, HISTORY_FLOOR } from '../scanner/ranges.js';

const help = `Read-only StonkFun rewards scanner (Node 24.15+)
  pnpm rewards scan <wallet> [--earlier] [options]
  pnpm rewards resume <job-or-wallet> [options]
  pnpm rewards report <wallet> [--json] [--db path]
  pnpm rewards reclassify <wallet> [--json] [--db path]
  pnpm rewards demo [--json] [--db NEW-path]

Options:
  --db PATH              SQLite file (default: local application data/stonkfun-rewards/scanner.sqlite)
  --json                 Structured output; progress goes to stderr
  --cutoff SECONDS        Fixed integer Unix cutoff (scan only; default current time)
  --max-helius N          Total requests, including retries/hydration/pricing (default 200)
  --max-stonkfun N        Total public requests (default: discovery plus one per mint needing a price, at most 200)
  --max-pages N           Total durable history pages (default 200)
  --deadline-minutes N    Absolute job lifetime, preserved across resumes (default 60)
  --page-size N           Full transactions/page, 1–1000 (default 100)
  --catalogue-pages N     Explicit bounded catalogue refresh; default 1 page, cached for 24h
  --helius-rps N         Helius requests per second (default 8; env SCANNER_HELIUS_RPS)
  --helius-burst N       Helius requests allowed at once from a full bucket (default 10; env SCANNER_HELIUS_BURST)
  --stonkfun-rps N       StonkFun requests per second (default 4; env SCANNER_STONKFUN_RPS)
  --stonkfun-burst N     StonkFun burst (default 5; env SCANNER_STONKFUN_BURST)
  --concurrency N        Independent hydrations and prices in flight, 1–16 (default 4; env SCANNER_CONCURRENCY)
  --earlier              scan only: load one batch of older history instead of refreshing
  --help                 Show help

scan refreshes: a new wallet's first scan covers the last ${FIRST_SCAN_DAYS} days; later scans fill only days missing from the oldest
loaded day to the cutoff. scan --earlier loads the ${EARLIER_BATCH_DAYS} days before the oldest loaded day, one batch per run, and
finishes an interrupted batch first. Nothing before ${new Date(HISTORY_FLOOR * 1000).toISOString().slice(0, 10)} (UTC) is ever requested.
Both print this job's Helius and StonkFun request counts at the end.
scan/resume load HELIUS_API_KEY from the process environment or ignored local .env.
report, reclassify and demo require neither credentials nor network. Resume preserves original limits/cutoff.
reclassify drains pending local network evidence in atomic batches; report only reads saved classifications.
Missing evidence and prices remain partial. No wallet connection, signature, or 72-hour standalone limit.`;

const budgetLine = (used: Job['used'], limits: Job['limits']) =>
  `Provider requests this job: StonkFun ${used.stonkfun} of ${limits.stonkfun} · Helius ${used.helius} of ${limits.helius} · pages ${used.pages} of ${limits.pages}`;
/** A classified failure, and for a job that stopped short, that its completed days are saved. */
const outcomeLines = (job: Job, ranges: { status: string }[]) => [
  ...(job.failure ? [`Failure class: ${job.failure.class}. ${job.failure.message}${job.failure.detail ? ` Detail: ${job.failure.detail}` : ''}`] : []),
  ...(job.status === 'complete' ? [] : [`Completed days are saved: ${ranges.filter(range => range.status === 'complete').length} of ${ranges.length}.`]),
];
const refusals: Record<string, string> = {
  earlier_history_at_floor: 'history is already loaded back to the history floor; there is nothing earlier to load',
  wallet_not_loaded: 'nothing is loaded for this wallet yet; run scan first, then scan --earlier',
  other_job_unfinished: 'an unfinished job of the other kind exists; resume it by its job id first',
};

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, json: { type: 'boolean' }, db: { type: 'string' }, cutoff: { type: 'string' },
    'max-helius': { type: 'string' }, 'max-stonkfun': { type: 'string' }, 'max-pages': { type: 'string' },
    'deadline-minutes': { type: 'string' }, 'page-size': { type: 'string' }, 'catalogue-pages': { type: 'string' },
    'helius-rps': { type: 'string' }, 'helius-burst': { type: 'string' }, 'stonkfun-rps': { type: 'string' }, 'stonkfun-burst': { type: 'string' },
    concurrency: { type: 'string' }, 'live-validation': { type: 'boolean' }, earlier: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (!['scan', 'resume', 'report', 'reclassify', 'demo'].includes(command) || positionals.length > 2 || (values.earlier && command !== 'scan')) throw new Error('invalid_command');
  const integer = (name: keyof typeof values, fallback: number, max = 100000) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('invalid_numeric_option');
    return value;
  };
  const progress = (event: { stage: string; count?: number }) => { console.error(`[${event.stage}]${event.count === undefined ? '' : ` ${event.count}`}`); };
  const path = values.db ? resolve(values.db) : join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'stonkfun-rewards', 'scanner.sqlite');
  if (command === 'demo') {
    const demoPath = values.db ? path : join(mkdtempSync(join(tmpdir(), 'stonkfun-demo-')), 'demo.sqlite');
    const demo = await runDemo(demoPath, progress);
    console.log(values.json ? JSON.stringify(demo, null, 2) : `${demo.label}\n\n${humanReport(demo.afterRestart)}`); return;
  }
  const target = positionals[1]; if (!target) throw new Error('wallet_or_job_required');
  const store = new SqliteRewardsStore(path);
  try {
    if (command === 'report' || command === 'reclassify') {
      if (!store.wallet('mainnet-beta', target)) throw new Error('wallet_not_tracked');
      if (command === 'reclassify') {
        let processed = 0; let batch: number;
        while ((batch = processDirty(store, 'mainnet-beta', 100)) > 0) {
          processed += batch; progress({ stage: 'local-classification', count: processed });
        }
      }
      const report = buildReport(store, target); console.log(values.json ? JSON.stringify(report, null, 2) : humanReport(report)); return;
    }
    // A refused Load earlier needs neither credentials nor network.
    if (values.earlier) { const refusal = earlierRefusal(store, 'mainnet-beta', target); if (refusal) throw new Error(refusal); }
    if (!process.env.HELIUS_API_KEY) { try { process.loadEnvFile(); } catch { /* optional local configuration */ } }
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) throw new Error('helius_credentials_unavailable');
    const { limits, concurrency } = scanSpeed({ heliusRps: values['helius-rps'], heliusBurst: values['helius-burst'],
      stonkfunRps: values['stonkfun-rps'], stonkfunBurst: values['stonkfun-burst'], concurrency: values.concurrency }, process.env);
    const previous = command === 'resume' ? store.job(target, 'mainnet-beta') : undefined;
    if (command === 'resume' && !previous) throw new Error('resume_job_not_found');
    const wallet = previous?.wallet ?? target;
    // Live validation runs only for the one wallet authorized for it, named by SCANNER_LIVE_VALIDATION_WALLET in the environment or the
    // ignored .env, never in source.
    if (values['live-validation'] && (!process.env.SCANNER_LIVE_VALIDATION_WALLET || wallet !== process.env.SCANNER_LIVE_VALIDATION_WALLET)) throw new Error('live_validation_wallet_mismatch');
    const cutoff = previous?.cutoff ?? integer('cutoff', Math.floor(Date.now() / 1000), 8_640_000_000_000);
    const controller = new AbortController(); const cancel = () => { controller.abort(); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    // Without --max-stonkfun the StonkFun budget is sized when pricing starts: discovery plus one request per mint needing a
    // price, at most STONKFUN_BUDGET_CAP.
    const sized = values['max-stonkfun'] === undefined && !values['live-validation'];
    try {
      await runScan(store, { wallet, cutoff, jobId: randomUUID(), owner: randomUUID(), pageSize: integer('page-size', 100, 1000),
        ...(command === 'resume' ? { resume: target } : {}), sizeStonkfunBudget: sized, snapshotHoldings: true, kind: values.earlier ? 'earlier' : 'refresh',
        limits: { helius: values['live-validation'] ? 30 : integer('max-helius', 200),
          stonkfun: values['live-validation'] ? 5 : integer('max-stonkfun', STONKFUN_BUDGET_CAP),
          pages: integer('max-pages', 200, 10000), resumes: 10, deadline: Date.now() + integer('deadline-minutes', 60, 10080) * 60_000 },
      }, job => createRealProviders({ store, job, apiKey, signal: controller.signal,
        ...(values['catalogue-pages'] === undefined ? {} : { cataloguePages: integer('catalogue-pages', 1, 10000) }),
        liveAllowance: values['live-validation'] ?? false, progress: (stage, count) => { progress({ stage, count }); },
        limits, waiting: (provider, reason, delayMs) => { console.error(`[waiting] ${waitText(provider, reason, delayMs)}`); },
      }), { now: Date.now, signal: controller.signal, progress, concurrency });
      const report = buildReport(store, wallet);
      console.log(values.json ? JSON.stringify(report, null, 2) : humanReport(report));
      // The budget used, beside the report rather than in it; JSON output keeps stdout to the report alone.
      const job = store.job(wallet, 'mainnet-beta');
      const lines = report.job ? [budgetLine(report.job.requests, report.job.limits), ...(job ? outcomeLines(job, store.ranges(job.id)) : [])] : [];
      for (const line of lines) { if (values.json) console.error(line); else console.log(line); }
      if (report.job?.status !== 'complete') process.exitCode = 2;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } finally { store.close(); }
}

void main().catch((error: unknown) => {
  // Whitelist local diagnostic codes; never echo arbitrary provider/OS errors, URLs, paths or stacks.
  const allowed = new Set(['invalid_command', 'invalid_numeric_option', 'invalid_speed_option', 'wallet_or_job_required', 'wallet_not_tracked', 'helius_credentials_unavailable',
    'resume_job_not_found', 'live_validation_wallet_mismatch', 'wallet_job_busy', 'job_admission_failed', 'database_schema_newer_than_scanner', 'demo_requires_empty_database']);
  const code = error instanceof Error && (allowed.has(error.message) || Object.hasOwn(refusals, error.message)) ? error.message : 'scanner_failed';
  console.error(refusals[code] ? `Rewards scanner: ${refusals[code]} (${code}).` : `Rewards scanner: ${code}. Use --help for commands; saved progress is retained.`);
  process.exitCode = 1;
});
