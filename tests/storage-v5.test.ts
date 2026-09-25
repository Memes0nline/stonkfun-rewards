import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { buildReport } from '../src/scanner/report.js';
import { runScan } from '../src/scanner/engine.js';
import { normalizeTransaction } from '../src/normalization/normalizer.js';
import type { NormalizedTransaction } from '../src/normalization/types.js';
import { nativePayout, payout, syntheticKey, toWallet } from './fixtures/distributor.js';
import { createRealProviders, WITHDRAW_AUTHORITY_CONFIGURATION_MINT as USDC } from '../src/providers/real.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, DEMO_WITHDRAW_AUTHORITY, demoData, demoFetch, demoTransaction } from '../src/cli/demo.js';
import type { DistributionEvidenceInput } from '../src/payout-evidence/types.js';
import type { Retrieval } from '../src/registry/types.js';
import { removeTempFolder } from './temp-folder.js';

const network = 'mainnet-beta';
const at = new Date(cutoff * 1000).toISOString();
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-v5', retrievedAt: at, commitment: 'finalized' as const };
const directories: string[] = [];
const stores: SqliteRewardsStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) await removeTempFolder(directory);
});
function database() { const directory = mkdtempSync(join(tmpdir(), 'rewards-v5-')); directories.push(directory); return join(directory, 'v5.sqlite'); }
function open(path: string, readOnly = false) { const store = new SqliteRewardsStore(path, { readOnly }); stores.push(store); return store; }
function drain(store: SqliteRewardsStore) { for (let i = 0; i < 20 && store.dirty(network, 1).length; i++) processDirty(store, network); expect(store.dirty(network, 1)).toEqual([]); }
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const configuration = (id: string, retrievedAt: string, overrides: Partial<Retrieval> = {}): Retrieval => ({ id, source: 'withdrawalConfig',
  endpoint: `/launchlab/pricing?quoteMint=${USDC}`, requestedAt: retrievedAt, retrievedAt, attempts: 1, outcome: 'success', httpStatus: 200, ...overrides });
/** A registry observation carrying configuration reads beside one distribution row, as real.ts stores it. */
function feed(retrievedAt = at, authority = 'A'.repeat(32), extra: { authority: string; source: Retrieval }[] = []): DistributionEvidenceInput {
  const tx = demoTransaction('3', cutoff - 100);
  return { network, provenance: { source: 'fixture', evidenceId: 'synthetic-feed', retrievedAt },
    sources: [{ id: 'source-1', source: 'rewards', endpoint: '/rewards?limit=100', requestedAt: retrievedAt, retrievedAt, attempts: 1, outcome: 'success' },
      configuration('source-2', retrievedAt), ...extra.map(item => item.source)],
    withdrawalAuthorities: [{ role: 'withdrawWithheldAuthority', authority, configurationQuoteMint: USDC, sourceId: 'source-2' },
      ...extra.map(item => ({ role: 'withdrawWithheldAuthority' as const, authority: item.authority, configurationQuoteMint: USDC, sourceId: item.source.id }))],
    distributions: [{ signature: tx.transaction.signatures[0]!, rows: [{ sourceIds: ['source-1'], value: { signature: tx.transaction.signatures[0]!,
      mint: 'F'.repeat(32), quoteMint: tx.meta.preTokenBalances[0]!.mint, amountRaw: '1000000', holderCount: 1, distributedAt: retrievedAt } }] }],
  };
}
function seeded(path: string, observation = feed()) {
  const store = open(path);
  store.atomic(() => {
    store.saveWallet({ wallet, network, trackingStart: cutoff - 864000, cutoff, lastSync: null });
    const tx = demoTransaction('3', cutoff - 100);
    store.saveQuote(network, { mint: tx.meta.preTokenBalances[0]!.mint, retrievedAt: at,
      membershipEvidence: [{ kind: 'distribution', launchMint: 'F'.repeat(32), endpoint: '/rewards?limit=100', retrievedAt: at }] });
    store.addTransaction(network, tx, provenance); store.watch(network, tx.transaction.signatures[0]!, wallet);
    store.addFeed(observation);
  });
  drain(store);
  return store;
}
const creditAccount = syntheticKey('v6-credited-account');
/** A payout batch that also creates the credited account: affected by the v6 requeue predicate. */
const ataTx = payout({ label: 'v6-ata', time: cutoff - 200, missingPre: [creditAccount],
  legs: [toWallet('1000', { destination: creditAccount, destinationOwner: wallet })],
  creations: [{ account: creditAccount, owner: wallet }] });
/** A lamport-only batch: no supported transfer at all, so also affected. */
const lamportTx = nativePayout({ label: 'v6-lamports', time: cutoff - 300, credits: [{ destination: wallet, lamports: 4321 }] });
/** Put a current database back into the state a v5 scanner left: normalization v1 bodies at v3. */
function v5State(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`UPDATE transactions SET body=json_remove(json_set(body,'$.normalizationVersion',1),'$.accountCreations');
    UPDATE classifications SET body=json_set(body,'$.version','stonkfun-classifier-v3');
    DELETE FROM classification_versions WHERE version='stonkfun-classifier-v4';
    PRAGMA user_version=5;`);
  db.close();
}
/** Recreate the prior schema from a current database: v5 only added these two relations. */
function downgrade(path: string, version = 4) {
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE withdrawal_authority_snapshots; DROP TABLE identity_conflicts; PRAGMA user_version=${version};`); db.close();
}
function evidenceTables(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(['transactions', 'provenance', 'feeds', 'coverage', 'jobs', 'ranges', 'cache', 'wallets', 'quotes', 'metadata_observations', 'authorities']
      // A transaction's raw evidence, key and compatibility must survive untouched; the derived
      // normalization inside `body` is recomputed by the v6 migration and is not raw evidence.
      .map(table => [table, table === 'transactions'
        ? db.prepare("SELECT network,signature,id,compatibility,json_extract(body,'$.evidence') AS evidence FROM transactions ORDER BY rowid").all()
        : db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

describe('SQLite v5 withdraw-authority snapshots', () => {
  it('migrates v4 to v5 transactionally, backfills only validated retained snapshots and rewrites no evidence', () => {
    const path = database();
    const invalid = [
      { authority: 'B'.repeat(32), source: configuration('source-3', at, { outcome: 'failure', failure: 'http', httpStatus: 500 }) },
      { authority: 'C'.repeat(32), source: configuration('source-4', at, { endpoint: '/launchlab/pricing?quoteMint=' + 'D'.repeat(32) }) },
      { authority: 'E'.repeat(32), source: configuration('source-5', at, { source: 'pairs', endpoint: '/pairs' }) },
    ];
    seeded(path, feed(at, 'A'.repeat(32), invalid)).close();
    downgrade(path);
    const before = evidenceTables(path);
    const store = open(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('withdrawal_authority_snapshots','identity_conflicts','snapshot_observed') ORDER BY name").all()
        .map(row => row.name)).toEqual(['identity_conflicts', 'snapshot_observed', 'withdrawal_authority_snapshots']);
      expect(db.prepare('SELECT COUNT(*) AS count FROM identity_conflicts').get()?.count).toBe(0);
    } finally { db.close(); }
    const snapshots = store.withdrawalSnapshots(network);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ network, role: 'withdrawWithheldAuthority', authority: 'A'.repeat(32), configurationQuoteMint: USDC,
      retrievedAt: at, observed: cutoff, generatedAt: null, endpoint: `/launchlab/pricing?quoteMint=${USDC}`, evidenceId: 'synthetic-feed', sourceId: 'source-2' });
    expect(snapshots[0]!.id).toMatch(/^[0-9a-f]{64}$/);
    store.close();
    expect(evidenceTables(path)).toEqual(before);
  });

  it('reopens v5 idempotently without requeueing or duplicating snapshots', () => {
    const path = database(); seeded(path).close(); downgrade(path);
    let store = open(path); drain(store); const ids = store.withdrawalSnapshots(network).map(item => item.id); store.close();
    store = open(path);
    expect(store.dirty(network, 100)).toEqual([]);
    expect(store.withdrawalSnapshots(network).map(item => item.id)).toEqual(ids);
  });

  it('inserts by content id, dedupes repeats and invalidates only on new content', () => {
    const path = database(); const store = seeded(path);
    // seeded() stores the feed but not its snapshot; registry retention is an explicit engine step.
    expect(store.withdrawalSnapshots(network)).toEqual([]);
    const first = store.saveWithdrawalSnapshots(feed());
    expect(first).toHaveLength(1);
    expect(store.dirty(network, 100)).toEqual(['3'.repeat(88)]);
    drain(store);
    expect(store.saveWithdrawalSnapshots(feed())).toEqual([]);
    expect(store.dirty(network, 100)).toEqual([]);
    const later = new Date((cutoff + 60) * 1000).toISOString();
    const rotated = store.saveWithdrawalSnapshots(feed(later, 'B'.repeat(32)));
    expect(rotated).toHaveLength(1); expect(rotated[0]).not.toBe(first[0]);
    expect(store.dirty(network, 100)).toEqual(['3'.repeat(88)]);
    expect(store.withdrawalSnapshots(network).map(item => [item.authority, item.observed])).toEqual([['A'.repeat(32), cutoff], ['B'.repeat(32), cutoff + 60]]);
    for (const overrides of [{ outcome: 'failure' as const }, { failure: 'timeout' as const }, { attempts: 0 }, { httpStatus: 302 },
      { endpoint: `/launchlab/pricing?quoteMint=${'D'.repeat(32)}` }, { source: 'rewards' as const }, { retrievedAt: 'not-a-time' }]) {
      const bad = feed(new Date((cutoff + 120) * 1000).toISOString()); bad.sources[1] = { ...bad.sources[1]!, ...overrides };
      expect(store.saveWithdrawalSnapshots(bad), JSON.stringify(overrides)).toEqual([]);
    }
    const ambiguous = feed(new Date((cutoff + 180) * 1000).toISOString()); ambiguous.sources.push({ ...ambiguous.sources[1]! });
    expect(store.saveWithdrawalSnapshots(ambiguous)).toEqual([]);
    expect(store.withdrawalSnapshots(network)).toHaveLength(2);
  });

  it.each([4, 5, 6, 7])('views schema v%s read-only without changing the database file', version => {
    const path = database(); const store = seeded(path); store.saveWithdrawalSnapshots(feed()); drain(store); store.close();
    if (version === 4) downgrade(path);
    else if (version < 7) { const back = new DatabaseSync(path); back.exec(`DROP TABLE holdings; DROP TABLE holding_sets; PRAGMA user_version=${version}`); back.close(); }
    const hash = sha(path);
    const viewer = open(path, true);
    expect(buildReport(viewer, wallet).counts.confirmed).toBe(1);
    expect(viewer.withdrawalSnapshots(network)).toHaveLength(version === 4 ? 0 : 1);
    viewer.close();
    expect(sha(path)).toBe(hash);
    const db = new DatabaseSync(path, { readOnly: true }); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(version); db.close();
  });

  it('fails closed on a newer schema in writable and read-only modes', () => {
    const path = database(); seeded(path).close();
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=8'); db.close();
    expect(() => new SqliteRewardsStore(path)).toThrow('database_schema_newer_than_scanner');
    expect(() => new SqliteRewardsStore(path, { readOnly: true })).toThrow('database_schema_newer_than_scanner');
    const old = database(); seeded(old).close();
    const legacy = new DatabaseSync(old); legacy.exec('PRAGMA user_version=3'); legacy.close();
    expect(() => new SqliteRewardsStore(old, { readOnly: true })).toThrow('database_requires_migration');
  });

  it('migrates v5 to v6 with a targeted requeue processed to completion, and is idempotent', () => {
    const path = database();
    const store = seeded(path);
    store.atomic(() => {
      for (const tx of [ataTx, lamportTx]) { store.addTransaction(network, tx, provenance); store.watch(network, tx.transaction.signatures[0]!, wallet); }
    });
    drain(store); store.close();
    v5State(path);
    const migrated = open(path);
    // Processed to completion inside the open: nothing is left queued for a later reclassify.
    expect(migrated.dirty(network, 100)).toEqual([]);
    const report = buildReport(migrated, wallet);
    expect(report.attribution.evaluated).toBe(true);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
      // Exactly the two signatures the predicate names were reclassified; the third kept classifier v3.
      const versions = db.prepare("SELECT signature,json_extract(body,'$.version') AS version FROM classifications ORDER BY signature").all();
      expect(versions.filter(row => row.version === 'stonkfun-classifier-v4').map(row => String(row.signature)).sort())
        .toEqual([ataTx, lamportTx].map(tx => tx.transaction.signatures[0]!).sort());
      expect(versions.filter(row => row.version === 'stonkfun-classifier-v3')).toHaveLength(1);
      // Every rewritten body is exactly what the current normalizer produces from its own evidence.
      for (const row of db.prepare('SELECT body FROM transactions').all()) {
        const body = JSON.parse(String(row.body)) as NormalizedTransaction;
        expect(normalizeTransaction({ network: body.network, wallet: body.wallet, transaction: body.evidence, provenance: body.provenance })).toEqual(body);
      }
    } finally { db.close(); }
    const digest = () => {
      const read = new DatabaseSync(path, { readOnly: true });
      try {
        return createHash('sha256').update(read.prepare('SELECT body FROM classifications ORDER BY network,wallet,identity')
          .all().map(row => String(row.body)).join('\n')).digest('hex');
      } finally { read.close(); }
    };
    const first = digest();
    migrated.close();
    const reopened = open(path);
    expect(reopened.dirty(network, 100)).toEqual([]);
    expect(digest()).toBe(first);
  });

  it('registry stage makes one configuration read per job and persists only a successful retrieval', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const store = open(database()); const data = demoData(); let clock = cutoff * 1000; const now = () => { clock += 1000; return clock; };
      const endpoints: string[] = []; const base = demoFetch(data, now);
      const fetcher: typeof fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === 'www.stonkfun.xyz') endpoints.push(url.pathname + url.search);
        if (outcome === 'failure' && url.searchParams.get('quoteMint') === USDC) return Promise.resolve(new Response('{}', { status: 503 }));
        return base(input, init);
      };
      const job = await runScan(store, { wallet, cutoff, jobId: `configuration-${outcome}`, owner: 'owner',
        limits: { stonkfun: 20, helius: 50, pages: 100, resumes: 5, deadline: now() + 3600_000 } },
      item => createRealProviders({ store, job: item, apiKey: 'synthetic-key', fetch: fetcher, now,
        retry: { retries: 3, baseMs: 0, maxMs: 0, jitter: 0 } }), { now });
      expect(job.status).toBe('complete');
      // One configuration read per job. A 5xx is retried three times, and each retry is a request against the budget.
      expect(endpoints.filter(endpoint => endpoint === `/api/public/v1/launchlab/pricing?quoteMint=${USDC}`)).toHaveLength(outcome === 'failure' ? 4 : 1);
      expect(job.used.stonkfun).toBe(endpoints.length);
      const snapshots = store.withdrawalSnapshots(network);
      if (outcome === 'failure') { expect(snapshots).toEqual([]); continue; }
      expect(snapshots).toMatchObject([{ authority: DEMO_WITHDRAW_AUTHORITY, configurationQuoteMint: USDC, evidenceId: `feed-${job.id}` }]);
      expect(store.dirty(network, 1)).toEqual([]);
    }
  });
});
