import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { buildReport, humanReport } from '../src/scanner/report.js';
import { admitJob } from '../src/scanner/engine.js';
import { DEMO_CUTOFF as cutoff, DEMO_MINT as mint, DEMO_WALLET as wallet, demoTransaction } from '../src/cli/demo.js';
import type { EvidenceSet } from '../src/scanner/types.js';
import type { DistributionEvidenceInput } from '../src/payout-evidence/types.js';
import { removeTempFolder } from './temp-folder.js';

const network = 'mainnet-beta';
const provenance = { source: 'fixture' as const, evidenceId: 'legacy-synthetic', retrievedAt: new Date(cutoff * 1000).toISOString(), commitment: 'finalized' as const };
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) await removeTempFolder(directory);
});
function open(path: string) { const store = new SqliteRewardsStore(path); stores.push(store); return store; }
function drain(store: SqliteRewardsStore, limit = 1) {
  for (let i = 0; store.dirty(network, 1).length && i < 30; i++) processDirty(store, network, limit);
  expect(store.dirty(network, 1)).toEqual([]);
}

/** Exercise the prior classifier on actual unmerged observations, then persist its fully drained
 * quarantine. This is not a confirmed receipt relabelled by the test or a pending dirty queue. */
function legacy(version: 2 | 3, contradiction?: 'ordering' | 'missing' | 'changed') {
  const directory = mkdtempSync(join(tmpdir(), 'rewards-legacy-')); directories.push(directory);
  const path = join(directory, 'legacy.sqlite'); const store = open(path);
  const before = demoTransaction('3', cutoff - 100); before.transactionIndex = 1;
  const candidate = demoTransaction('4', cutoff - 100); candidate.transactionIndex = 2;
  const after = demoTransaction('5', cutoff - 100); after.transactionIndex = 3;
  const unrelated = demoTransaction('6', cutoff - 200);
  const unindexed = structuredClone(before); delete unindexed.transactionIndex;
  const transactions = [before, candidate, after, unrelated, unindexed];
  if (contradiction) {
    const bad = structuredClone(before);
    if (contradiction === 'ordering') bad.transactionIndex = 4;
    else if (contradiction === 'missing') bad.transaction.message.instructions.pop();
    else bad.meta.postTokenBalances[1]!.uiTokenAmount.amount = '999999';
    transactions.push(bad);
  }
  const official: DistributionEvidenceInput = {
    network, provenance: { source: 'fixture', evidenceId: 'legacy-feed', retrievedAt: provenance.retrievedAt }, withdrawalAuthorities: [],
    sources: [{ id: 'source-1', source: 'rewards', endpoint: '/rewards?limit=100', requestedAt: provenance.retrievedAt, retrievedAt: provenance.retrievedAt, attempts: 1, outcome: 'success' }],
    distributions: [before, after, unrelated].map(tx => ({ signature: tx.transaction.signatures[0]!, rows: [{ sourceIds: ['source-1'], value: {
      signature: tx.transaction.signatures[0]!, mint: 'F'.repeat(32), quoteMint: mint, amountRaw: '1000000', holderCount: 1, distributedAt: provenance.retrievedAt,
    } }] })),
  };
  const job = admitJob(store, { wallet, cutoff, jobId: 'legacy-job', owner: 'legacy-owner',
    limits: { stonkfun: 20, helius: 40, pages: 100, resumes: 10, deadline: cutoff * 1000 + 3600000 } }, cutoff * 1000);
  store.createRanges(job, [{ startTime: cutoff - 864000, endTime: cutoff - 1000 }]);
  store.completeRange(job, store.ranges(job.id)[0]!);
  store.saveJob({ ...job, status: 'exhausted', used: { stonkfun: 3, helius: 28, pages: 15, resumes: 2 } });
  store.saveCache('live-milestone-2026-09-21', { value: { stonkfun: 3, helius: 28 }, expiresAt: Number.MAX_SAFE_INTEGER });
  store.saveQuote(network, { mint, retrievedAt: provenance.retrievedAt });
  for (const tx of transactions) { store.addTransaction(network, tx, provenance); store.watch(network, tx.transaction.signatures[0]!, wallet); }
  store.addFeed(official);
  const raw = new DatabaseSync(path, { readOnly: true });
  const currentEvidence = store.evidence.bind(store);
  const oldRead = vi.spyOn(store, 'evidence').mockImplementation((chain, signature) => ({
    ...currentEvidence(chain, signature),
    transactions: raw.prepare('SELECT body FROM transactions WHERE network=? AND signature=? ORDER BY id').all(chain, signature)
      .map(row => JSON.parse(String(row.body)) as EvidenceSet['transactions'][number]),
  }));
  try { drain(store, 100); } finally { oldRead.mockRestore(); raw.close(); }
  const report = buildReport(store, wallet);
  expect(report.details.find(row => row.signature === before.transaction.signatures[0])?.reasons).toContain('conflicting_evidence_quarantined');
  expect(report.details.find(row => row.signature === candidate.transaction.signatures[0])?.status).toBe('unknown_candidate');
  expect(report.pendingClassification.networkSignatures).toBe(0);
  store.close();
  const db = new DatabaseSync(path);
  if (version === 2) db.exec('ALTER TABLE transactions DROP COLUMN compatibility; ALTER TABLE cooldowns DROP COLUMN server_until;');
  db.exec(`PRAGMA user_version=${version}`);
  // Snapshots prove migrations/reclassification leave original evidence and accounting unchanged.
  const preserved = () => Object.fromEntries(['transactions', 'provenance', 'feeds', 'coverage', 'jobs', 'ranges', 'cache', 'wallets'].map(table => [table,
    db.prepare(table === 'transactions' ? 'SELECT network,signature,id,body FROM transactions ORDER BY network,signature,id' : `SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const snapshot = preserved(); db.close();
  return { path, before, unindexed, candidate, unrelated, snapshot };
}
function preserved(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(['transactions', 'provenance', 'feeds', 'coverage', 'jobs', 'ranges', 'cache', 'wallets'].map(table => [table,
      db.prepare(table === 'transactions' ? 'SELECT network,signature,id,body FROM transactions ORDER BY network,signature,id' : `SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

describe('schema v4 local quarantine repair', () => {
  it.each([2, 3] as const)('repairs a fully processed v%s quarantine once and restores lost authority dependents', version => {
    const saved = legacy(version); let store = open(saved.path);
    expect(store.evidence(network, saved.before.transaction.signatures[0]!).transactions).toHaveLength(1);
    // The repaired witness carries authority rows, so identity-wide attribution is rechecked as well:
    // every retained signature is queued once, including the unrelated confirmed receipt.
    expect(store.dirty(network, 100)).toHaveLength(4);
    const pending = buildReport(store, wallet);
    expect(pending.counts.confirmed).toBe(1); // unrelated receipt only; pending support never counts
    expect(pending.pendingClassification).toEqual({ networkSignatures: 4, walletSignatures: 4 });
    expect(humanReport(pending)).toContain('Pending local classification: 4 wallet signatures');
    store.addTransaction(network, saved.unindexed, provenance); // identical repeat must not be the repair trigger
    store.close(); store = open(saved.path);
    expect(store.dirty(network, 100)).toHaveLength(4);
    // An interrupted batch must retain both the queue and prior classifications.
    const fail = vi.spyOn(store, 'saveClassifications').mockImplementationOnce(() => { throw new Error('interrupted repair'); });
    expect(() => processDirty(store, network, 1)).toThrow('interrupted repair'); fail.mockRestore();
    expect(store.dirty(network, 100)).toHaveLength(4);
    expect(buildReport(store, wallet)).toEqual(pending);
    processDirty(store, network, 1); store.close(); store = open(saved.path);
    drain(store);
    const repaired = buildReport(store, wallet);
    expect(repaired.details.find(row => row.signature === saved.before.transaction.signatures[0])).toMatchObject({ status: 'confirmed', basis: 'official_feed', netRaw: '1000000' });
    expect(repaired.details.find(row => row.signature === saved.candidate.transaction.signatures[0])).toMatchObject({ status: 'confirmed', basis: 'same_slot_pattern' });
    expect(repaired.counts.confirmed).toBe(4);
    expect(repaired.pendingClassification).toEqual({ networkSignatures: 0, walletSignatures: 0 });
    store.close(); store = open(saved.path);
    store.addTransaction(network, saved.before, provenance); store.addTransaction(network, saved.unindexed, provenance);
    expect(processDirty(store, network)).toBe(0); expect(buildReport(store, wallet)).toEqual(repaired);
    expect(preserved(saved.path)).toEqual(saved.snapshot);
  });
  it.each(['ordering', 'missing', 'changed'] as const)('retains genuine %s contradictions through repair, reopening and repeats', contradiction => {
    const saved = legacy(3, contradiction); let store = open(saved.path); drain(store);
    store.close(); store = open(saved.path);
    store.addTransaction(network, saved.before, provenance); store.addTransaction(network, saved.unindexed, provenance); drain(store);
    const report = buildReport(store, wallet);
    expect(report.details.find(row => row.signature === saved.before.transaction.signatures[0])?.reasons).toContain('conflicting_evidence_quarantined');
    expect(report.details.find(row => row.signature === saved.candidate.transaction.signatures[0])?.status).toBe('unknown_candidate');
    expect(report.counts.confirmed).toBe(2);
    expect(preserved(saved.path)).toEqual(saved.snapshot);
  });
  it('applies pending repairs with the guarded offline CLI and leaves report viewing read-only', () => {
    const saved = legacy(2);
    const run = (command: string) => JSON.parse(execFileSync(process.execPath, ['--import', './tests/fixtures/no-network.mjs',
      'dist/cli/main.js', command, wallet, '--db', saved.path, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as ReturnType<typeof buildReport>;
    expect(run('report').pendingClassification.walletSignatures).toBe(4);
    expect(run('report').counts.confirmed).toBe(1);
    const result = run('reclassify'); expect(result.counts.confirmed).toBe(4);
    expect(run('report')).toEqual(result); expect(run('reclassify')).toEqual(result);
    expect(preserved(saved.path)).toEqual(saved.snapshot);
  });
});
