import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeTransaction } from '../normalization/normalizer.js';
import { ASSOCIATED_TOKEN_PROGRAM } from '../normalization/associated-token.js';
import type { NormalizationProvenance, SolanaNetwork } from '../normalization/types.js';
import type { FullTransaction } from '../helius/schemas.js';
import type { DistributionEvidenceInput } from '../payout-evidence/types.js';
import { canonical } from '../payout-evidence/validation.js';
import { mergeRanges } from '../scanner/ranges.js';
import { authorityIdentity } from '../scanner/historical-authority.js';
import { withdrawalSnapshots } from '../scanner/withdrawal-snapshots.js';
import { attributionIdentity, feedWitnesses } from '../scanner/distributor-pattern.js';
// Storage owns the migration, so it also finishes the requeue that migration creates.
import { processDirty } from '../scanner/classifier.js';
import { ATTRIBUTION_MODEL_VERSION, AUTHORITY_MODEL_VERSION } from '../scanner/types.js';
import { takeToken } from '../providers/limiter.js';
import type { RateLimit } from '../providers/limiter.js';
import type { HoldingsSet, StoredHoldings } from '../scanner/holdings.js';
import type {
  AttributionRevocation, AuthorityObservation, AuthorityRevocation, CacheEntry, Classification, EvidenceSet, IdentityConflict, Job, JobRange,
  Metadata, Price, Range, RewardsStore, WalletState, WithdrawalAuthoritySnapshot,
} from '../scanner/types.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const parse = <T>(row: Record<string, unknown> | undefined): T | undefined => row ? JSON.parse(String(row.body)) as T : undefined;
// Wallet-neutral normalization prevents two wallet scans from manufacturing a chain conflict.
const NEUTRAL_WALLET = '11111111111111111111111111111111';
// Only this optional provider field is compatible enrichment. All other raw evidence stays in the key.
const compatibilityKey = (network: SolanaNetwork, transaction: FullTransaction) => {
  const { transactionIndex: _index, ...withoutIndex } = transaction;
  void _index;
  return hash([network, withoutIndex]);
};
/** Retained signatures in one slot. Without planner statistics SQLite prefers the primary key's `network` prefix, which on
 * a one-network database parses every retained body per lookup; naming the v1 slot index keeps the lookup indexed. */
export const SAME_SLOT_SIGNATURES = "SELECT DISTINCT signature FROM transactions INDEXED BY transaction_slot WHERE network=? AND json_extract(body,'$.evidence.slot')=?";

const SCHEMA_VERSION = 7;
/** The mechanical predicate of the v6 requeue: exactly the shapes normalizer v2 can classify
 * differently — the associated-token-account lifecycle at any position, and every transaction with
 * no supported transfer, which covers the lamport-only and `mintTo` shapes. */
function affectedByNormalizerV2(tx: EvidenceSet['transactions'][number]): boolean {
  if (tx.transfers.length === 0) return true;
  return [...tx.evidence.transaction.message.instructions,
    ...(tx.evidence.meta.innerInstructions ?? []).flatMap(group => group.instructions)]
    .some(instruction => instruction.programId === ASSOCIATED_TOKEN_PROGRAM);
}

export class SqliteRewardsStore implements RewardsStore {
  #db: DatabaseSync;
  #depth = 0;
  #readOnly = false;
  #schema = 0;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.#readOnly = true;
      this.#db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
      // Viewing never migrates, and accepts v4 to v7. v4 predates attribution; a newer schema
      // could hold statuses this scanner cannot read.
      this.#schema = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version);
      if (this.#schema > SCHEMA_VERSION) { this.#db.close(); throw new Error('database_schema_newer_than_scanner'); }
      if (this.#schema < 4) { this.#db.close(); throw new Error('database_requires_migration'); }
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > SCHEMA_VERSION) { this.#db.close(); throw new Error('database_schema_newer_than_scanner'); }
    this.#schema = version;
    if (version === 0) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) !== 0) return;
      this.#db.exec(`
        CREATE TABLE wallets(network TEXT, wallet TEXT, body TEXT NOT NULL, PRIMARY KEY(network,wallet)) STRICT;
        CREATE TABLE coverage(network TEXT, wallet TEXT, start INTEGER, end INTEGER, PRIMARY KEY(network,wallet,start,end)) STRICT;
        CREATE TABLE leases(network TEXT, wallet TEXT, owner TEXT, expires INTEGER, PRIMARY KEY(network,wallet)) STRICT;
        CREATE TABLE jobs(id TEXT PRIMARY KEY, network TEXT, wallet TEXT, status TEXT, created INTEGER, body TEXT NOT NULL) STRICT;
        CREATE UNIQUE INDEX active_wallet_job ON jobs(network,wallet) WHERE status IN ('running','paused');
        CREATE INDEX wallet_jobs ON jobs(network,wallet,created DESC);
        CREATE TABLE ranges(id INTEGER PRIMARY KEY, job TEXT REFERENCES jobs(id), start INTEGER, end INTEGER, body TEXT NOT NULL) STRICT;
        CREATE INDEX job_ranges ON ranges(job,id);
        CREATE TABLE transactions(network TEXT, signature TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(network,signature,id)) STRICT;
        CREATE INDEX transaction_slot ON transactions(network,json_extract(body,'$.evidence.slot'));
        CREATE TABLE provenance(evidence TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(evidence,id)) STRICT;
        CREATE TABLE feeds(network TEXT, signature TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(network,signature,id)) STRICT;
        CREATE TABLE watchers(network TEXT, signature TEXT, wallet TEXT, PRIMARY KEY(network,signature,wallet)) STRICT;
        CREATE TABLE dirty(network TEXT, signature TEXT, PRIMARY KEY(network,signature)) STRICT;
        CREATE TABLE classifications(network TEXT, wallet TEXT, identity TEXT, signature TEXT, time INTEGER, mint TEXT,
          status TEXT, raw TEXT, body TEXT NOT NULL, PRIMARY KEY(network,wallet,identity)) STRICT;
        CREATE INDEX classified_signature ON classifications(network,signature,wallet);
        CREATE INDEX classified_window ON classifications(network,wallet,time,status);
        CREATE INDEX classified_mint ON classifications(network,mint);
        CREATE TABLE dependencies(network TEXT, support TEXT, signature TEXT, wallet TEXT, PRIMARY KEY(network,support,signature,wallet)) STRICT;
        CREATE INDEX dependent_signature ON dependencies(network,signature,wallet);
        CREATE TABLE classification_versions(version TEXT PRIMARY KEY, description TEXT) STRICT;
        INSERT INTO classification_versions VALUES ('stonkfun-classifier-v1','Exact-feed or same-slot bracket; bigint net credits; contradictions quarantine');
        CREATE TABLE authorities(network TEXT, signature TEXT, slot INTEGER, id TEXT, body TEXT NOT NULL, PRIMARY KEY(network,signature,id)) STRICT;
        CREATE INDEX authority_slot ON authorities(network,slot);
        CREATE TABLE quotes(network TEXT, mint TEXT, body TEXT NOT NULL, PRIMARY KEY(network,mint)) STRICT;
        CREATE TABLE prices(network TEXT, mint TEXT, retrieved TEXT, body TEXT NOT NULL, PRIMARY KEY(network,mint,retrieved)) STRICT;
        CREATE TABLE cache(key TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE cooldowns(provider TEXT PRIMARY KEY, until INTEGER) STRICT;
        PRAGMA user_version=1;
      `);
    });
    if (version < 2) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 2) return;
      this.#db.exec(`
        CREATE TABLE metadata_observations(network TEXT, mint TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(network,mint,id)) STRICT;
        INSERT INTO metadata_observations SELECT network,mint,'migrated-v1',body FROM quotes;
        PRAGMA user_version=2;
      `);
    });
    if (version < 3) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 3) return;
      this.#db.exec('ALTER TABLE transactions ADD COLUMN compatibility TEXT; ALTER TABLE cooldowns ADD COLUMN server_until INTEGER NOT NULL DEFAULT 0;');
      for (const row of this.#db.prepare('SELECT network,signature,id,body FROM transactions').iterate()) {
        const tx = parse<EvidenceSet['transactions'][number]>(row)!;
        this.#db.prepare('UPDATE transactions SET compatibility=? WHERE network=? AND signature=? AND id=?')
          .run(compatibilityKey(String(row.network) as SolanaNetwork, tx.evidence), String(row.network), String(row.signature), String(row.id));
      }
      // V2 mixed server delays with spacing. Carry it forward as a conservative server restriction.
      this.#db.exec('UPDATE cooldowns SET server_until=until, until=0; PRAGMA user_version=3;');
    });
    if (version < 4) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 4) return;
      // V3 changed reconciliation inputs without invalidating already-processed v2 quarantines.
      // Schedule once, including already-upgraded databases. Keep every raw observation intact.
      const affected = this.#db.prepare(`SELECT DISTINCT network,signature FROM transactions
        GROUP BY network,signature,compatibility
        HAVING COUNT(*) > 1 AND COUNT(json_extract(body,'$.evidence.transactionIndex')) > 0
          AND COUNT(json_extract(body,'$.evidence.transactionIndex')) < COUNT(*)`).all();
      for (const row of affected) {
        const network = String(row.network) as SolanaNetwork;
        const signature = String(row.signature);
        this.#changed(network, signature);
        // A quarantined witness may have lost all dependency edges. Its same-slot candidates
        // still need a recheck, including candidates whose prior classification was unknown.
        for (const candidate of this.#db.prepare(`SELECT DISTINCT signature FROM transactions
          WHERE network=? AND json_extract(body,'$.evidence.slot') IN
            (SELECT json_extract(body,'$.evidence.slot') FROM transactions WHERE network=? AND signature=?)`)
          .all(network, network, signature)) this.#changed(network, String(candidate.signature));
      }
      this.#db.exec('PRAGMA user_version=4;');
    });
    if (version < 5) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 5) return;
      // Feed bodies keep configuration reads only beside a distribution; snapshots need their own relation.
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS withdrawal_authority_snapshots(network TEXT, id TEXT, observed INTEGER, authority TEXT, body TEXT NOT NULL, PRIMARY KEY(network,id)) STRICT;
        CREATE INDEX IF NOT EXISTS snapshot_observed ON withdrawal_authority_snapshots(network,observed);
        CREATE TABLE IF NOT EXISTS identity_conflicts(network TEXT, signature TEXT, owner TEXT, body TEXT NOT NULL, PRIMARY KEY(network,signature,owner)) STRICT;
      `);
      for (const row of this.#db.prepare('SELECT body FROM feeds ORDER BY network,signature,id').all()) {
        for (const snapshot of withdrawalSnapshots(parse<DistributionEvidenceInput>(row)!)) this.#insertSnapshot(snapshot);
      }
      this.#db.exec('PRAGMA user_version=5;');
    });
    let requeued = 0;
    if (version < 6) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 6) return;
      // Installing the v4 marker here makes the blanket install below report no change, which is
      // what keeps this requeue targeted instead of network-wide.
      this.#db.prepare(`INSERT OR IGNORE INTO classification_versions VALUES ('stonkfun-classifier-v4',
        'Exact-feed, same-slot, or witness-bounded historical authority; distributor-pattern attribution on the token and native-SOL lanes; contradictions quarantine')`).run();
      // Normalizer v2 changes decoded evidence, and payout evidence revalidates a retained body by
      // re-normalizing it, so every body is recomputed from the full transaction it already holds.
      // Pure offline arithmetic: no request, and only `body` changes. The primary key and the
      // compatibility column derive from the raw transaction and are untouched.
      const affected: { network: SolanaNetwork; signature: string }[] = [];
      for (const key of this.#db.prepare('SELECT network,signature,id FROM transactions').all()) {
        const network = String(key.network) as SolanaNetwork;
        const signature = String(key.signature); const id = String(key.id);
        const stored = parse<EvidenceSet['transactions'][number]>(
          this.#db.prepare('SELECT body FROM transactions WHERE network=? AND signature=? AND id=?').get(network, signature, id));
        if (!stored) continue;
        const normalized = normalizeTransaction({ network, wallet: stored.wallet, transaction: stored.evidence, provenance: stored.provenance });
        this.#db.prepare('UPDATE transactions SET body=? WHERE network=? AND signature=? AND id=?')
          .run(JSON.stringify(normalized), network, signature, id);
        if (affectedByNormalizerV2(normalized)) affected.push({ network, signature });
      }
      const queue = [...new Set(affected.map(item => JSON.stringify([item.network, item.signature])))];
      for (const item of queue) {
        const [network, signature] = JSON.parse(item) as [SolanaNetwork, string];
        this.#changed(network, signature);
      }
      requeued = queue.length;
      this.#db.exec('PRAGMA user_version=6;');
    });
    if (version < 7) this.atomic(() => {
      if (Number(this.#db.prepare('PRAGMA user_version').get()?.user_version) >= 7) return;
      // Holdings a successful refresh stores: one set per refresh, and its small per-mint rows. Additive only.
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS holding_sets(network TEXT, wallet TEXT, taken TEXT, body TEXT NOT NULL, PRIMARY KEY(network,wallet,taken)) STRICT;
        CREATE TABLE IF NOT EXISTS holdings(network TEXT, wallet TEXT, taken TEXT, source TEXT, mint TEXT, body TEXT NOT NULL,
          PRIMARY KEY(network,wallet,taken,source,mint)) STRICT;
        PRAGMA user_version=7;
      `);
    });
    this.#schema = SCHEMA_VERSION;
    this.atomic(() => {
      const installed = [
        this.#db.prepare(`INSERT OR IGNORE INTO classification_versions VALUES
          ('stonkfun-classifier-v2','Exact-feed, same-slot, or witness-bounded historical authority; contradictions quarantine')`).run(),
        this.#db.prepare(`INSERT OR IGNORE INTO classification_versions VALUES ('stonkfun-classifier-v3',
          'Exact-feed, same-slot, or witness-bounded historical authority; separately reported distributor-pattern attribution; contradictions quarantine')`).run(),
      ];
      // Each new classifier version queues every retained transaction exactly once.
      if (installed.some(result => Number(result.changes))) this.#db.prepare('INSERT OR IGNORE INTO dirty SELECT DISTINCT network,signature FROM transactions').run();
    });
    // The v6 requeue is processed to completion inside this open, so a report taken straight after a
    // migration is evaluated rather than pending. Each batch commits on its own, so an interrupted
    // migration leaves the rest of the queue to the next open or an explicit reclassify.
    if (requeued > 0) {
      for (let guard = 0; guard < 1_000_000; guard++) {
        const pending = this.#db.prepare('SELECT DISTINCT network FROM dirty LIMIT 1').get();
        if (!pending) break;
        processDirty(this, String(pending.network) as SolanaNetwork, 100);
      }
    }
  }
  atomic<T>(work: () => T): T {
    if (this.#depth) return work();
    this.#db.exec(this.#readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'); this.#depth++;
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#depth--; }
  }
  wallet(network: SolanaNetwork, wallet: string) { return parse<WalletState>(this.#db.prepare('SELECT body FROM wallets WHERE network=? AND wallet=?').get(network, wallet)); }
  listWallets() { return this.#db.prepare("SELECT wallet FROM wallets WHERE network='mainnet-beta' ORDER BY wallet LIMIT 1000").all().map(row => String(row.wallet)); }
  saveWallet(value: WalletState) {
    this.#db.prepare('INSERT INTO wallets VALUES (?,?,?) ON CONFLICT(network,wallet) DO UPDATE SET body=excluded.body').run(value.network, value.wallet, JSON.stringify(value));
  }
  coverage(network: SolanaNetwork, wallet: string): Range[] {
    return this.#db.prepare('SELECT start,end FROM coverage WHERE network=? AND wallet=? ORDER BY start').all(network, wallet)
      .map(row => ({ startTime: Number(row.start), endTime: Number(row.end) }));
  }
  completeRange(job: Job, range: JobRange) {
    const merged = mergeRanges([...this.coverage(job.network, job.wallet), range]);
    this.#db.prepare('DELETE FROM coverage WHERE network=? AND wallet=?').run(job.network, job.wallet);
    for (const entry of merged) this.#db.prepare('INSERT INTO coverage VALUES (?,?,?,?)').run(job.network, job.wallet, entry.startTime, entry.endTime);
    range.status = 'complete'; this.saveRange(range);
  }
  acquire(network: SolanaNetwork, wallet: string, owner: string, now: number) {
    this.atomic(() => {
      const row = this.#db.prepare('SELECT owner,expires FROM leases WHERE network=? AND wallet=?').get(network, wallet);
      if (row && Number(row.expires) > now && row.owner !== owner) throw new Error('wallet_job_busy');
      this.#db.prepare('INSERT INTO leases VALUES (?,?,?,?) ON CONFLICT(network,wallet) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(network, wallet, owner, now + 120_000);
    });
  }
  renew(network: SolanaNetwork, wallet: string, owner: string, now: number) {
    // A slow synchronous page may overrun the lease while holding SQLite's writer lock.
    // The same owner may renew if nobody took over; the owner token still fences successors.
    const result = this.#db.prepare('UPDATE leases SET expires=? WHERE network=? AND wallet=? AND owner=?').run(now + 120_000, network, wallet, owner);
    if (Number(result.changes) !== 1) throw new Error('wallet_lease_lost');
  }
  release(network: SolanaNetwork, wallet: string, owner: string) { this.#db.prepare('DELETE FROM leases WHERE network=? AND wallet=? AND owner=?').run(network, wallet, owner); }
  job(idOrWallet: string, network: SolanaNetwork) {
    return parse<Job>(this.#db.prepare("SELECT body FROM jobs WHERE network=? AND (id=? OR wallet=?) ORDER BY CASE WHEN status IN ('running','paused') THEN 0 ELSE 1 END,created DESC LIMIT 1").get(network, idOrWallet, idOrWallet));
  }
  saveJob(job: Job) {
    this.#db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(job.id, job.network, job.wallet, job.status, job.createdAt, JSON.stringify(job));
  }
  createRanges(job: Job, ranges: Range[]) {
    for (const range of ranges) {
      const result = this.#db.prepare('INSERT INTO ranges(job,start,end,body) VALUES (?,?,?,?)').run(job.id, range.startTime, range.endTime, '{}');
      this.saveRange({ ...range, id: Number(result.lastInsertRowid), jobId: job.id,
        query: { wallet: job.wallet, ...range, pageSize: job.pageSize }, cursor: null, status: 'pending', pages: 0, tainted: false, restarts: 0 });
    }
  }
  ranges(jobId: string) { return this.#db.prepare('SELECT body FROM ranges WHERE job=? ORDER BY id').all(jobId).map(row => parse<JobRange>(row)!); }
  saveRange(range: JobRange) { this.#db.prepare('UPDATE ranges SET body=? WHERE id=? AND job=?').run(JSON.stringify(range), range.id, range.jobId); }
  reserveRequest(jobId: string, provider: 'stonkfun' | 'helius', now: number) {
    this.atomic(() => {
      const job = parse<Job>(this.#db.prepare('SELECT body FROM jobs WHERE id=?').get(jobId));
      if (!job || job.status !== 'running' || now >= job.limits.deadline || job.used[provider] >= job.limits[provider]) throw new Error('request_budget_or_deadline');
      job.used[provider]++; this.saveJob(job);
    });
  }
  cooldown(provider: string, until?: number) {
    if (until !== undefined) this.#db.prepare('INSERT INTO cooldowns(provider,until,server_until) VALUES (?,0,?) ON CONFLICT(provider) DO UPDATE SET server_until=MAX(server_until,excluded.server_until)').run(provider, Math.ceil(until));
    return Number(this.#db.prepare('SELECT server_until FROM cooldowns WHERE provider=?').get(provider)?.server_until ?? 0);
  }
  reserveDispatch(provider: string, now: number, deadline: number, limit: RateLimit) {
    return this.atomic(() => {
      const row = this.#db.prepare('SELECT until,server_until FROM cooldowns WHERE provider=?').get(provider);
      // `until` holds the provider's token bucket as its theoretical arrival time; a server cooldown holds every dispatch back.
      const bucket = takeToken(Number(row?.until ?? 0), now, limit);
      const ready = Math.max(bucket.ready, Number(row?.server_until ?? 0));
      if (ready - now > 60_000 || ready >= deadline) throw new Error('provider_cooldown');
      if (ready > now) return ready;
      this.#db.prepare('INSERT INTO cooldowns(provider,until,server_until) VALUES (?,?,0) ON CONFLICT(provider) DO UPDATE SET until=excluded.until')
        .run(provider, bucket.state);
      return ready;
    });
  }
  #dirty(network: SolanaNetwork, signature: string) { this.#db.prepare('INSERT OR IGNORE INTO dirty VALUES (?,?)').run(network, signature); }
  #invalidateHistorical(network: SolanaNetwork) {
    this.#db.prepare(`UPDATE classifications SET status='unknown_candidate',
      body=json_set(body,'$.status','unknown_candidate','$.reasons',json('["authority_recheck_pending"]'))
      WHERE network=? AND status='confirmed' AND json_extract(body,'$.basis')='verified_historical_authority'`).run(network);
    this.#db.prepare('INSERT OR IGNORE INTO dirty SELECT DISTINCT network,signature FROM transactions WHERE network=?').run(network);
  }
  #invalidateAttributed(network: SolanaNetwork) {
    // Distributor trust is identity-wide and spans quote mints. Stop counting every attributed row
    // until all retained signatures are reclassified against the changed evidence.
    this.#db.prepare(`UPDATE classifications SET status='unknown_candidate',
      body=json_set(body,'$.status','unknown_candidate','$.reasons',json('["attribution_recheck_pending"]'))
      WHERE network=? AND status='attributed'`).run(network);
    this.#db.prepare('INSERT OR IGNORE INTO dirty SELECT DISTINCT network,signature FROM transactions WHERE network=?').run(network);
  }
  #changed(network: SolanaNetwork, signature: string) {
    const affected = [signature, ...this.#db.prepare('SELECT DISTINCT signature FROM dependencies WHERE network=? AND support=?').all(network, signature).map(row => String(row.signature))];
    for (const item of affected) {
      this.#dirty(network, item);
      this.#db.prepare("UPDATE classifications SET status='unknown_candidate',body=json_set(body,'$.status','unknown_candidate','$.reasons',json('[\"support_recheck_pending\"]')) WHERE network=? AND signature=? AND status='confirmed'").run(network, item);
      this.#db.prepare("UPDATE classifications SET status='unknown_candidate',body=json_set(body,'$.status','unknown_candidate','$.reasons',json('[\"attribution_recheck_pending\"]')) WHERE network=? AND signature=? AND status='attributed'").run(network, item);
    }
    // Witness and contradicted feed evidence establish or revoke identity-wide distributor trust.
    // Identity conflicts exist from schema v5; earlier migrations queue everything afterwards anyway.
    if (this.#db.prepare('SELECT 1 FROM authorities WHERE network=? AND signature=? LIMIT 1').get(network, signature)
      || (this.#schema >= 5 && this.#db.prepare('SELECT 1 FROM identity_conflicts WHERE network=? AND signature=? LIMIT 1').get(network, signature))) {
      this.#invalidateAttributed(network);
    }
  }
  addTransaction(network: SolanaNetwork, transaction: FullTransaction, provenance: NormalizationProvenance) {
    const signature = transaction.transaction.signatures[0]!;
    const id = hash([network, transaction]);
    const exists = this.#db.prepare('SELECT 1 FROM transactions WHERE network=? AND signature=? AND id=?').get(network, signature, id);
    if (!exists) {
      const normalized = normalizeTransaction({ network, wallet: NEUTRAL_WALLET, transaction, provenance: { ...provenance, evidenceId: id } });
      this.#db.prepare('INSERT INTO transactions(network,signature,id,body,compatibility) VALUES (?,?,?,?,?)')
        .run(network, signature, id, JSON.stringify(normalized), compatibilityKey(network, transaction));
      this.#changed(network, signature);
      for (const row of this.#db.prepare(`${SAME_SLOT_SIGNATURES} LIMIT 10000`).all(network, transaction.slot)) this.#dirty(network, String(row.signature));
    }
    this.#db.prepare('INSERT OR IGNORE INTO provenance VALUES (?,?,?)').run(id, hash(provenance), JSON.stringify(provenance));
    return signature;
  }
  watch(network: SolanaNetwork, signature: string, wallet: string) {
    if (Number(this.#db.prepare('INSERT OR IGNORE INTO watchers VALUES (?,?,?)').run(network, signature, wallet).changes)) this.#dirty(network, signature);
  }
  addFeed(feed: DistributionEvidenceInput) {
    const signatures: string[] = [];
    for (const distribution of feed.distributions) {
      const part = { ...feed, distributions: [distribution] };
      // Collapse repeat content but retain all retrieval provenance in its own relation.
      const id = hash([feed.network, distribution]);
      if (Number(this.#db.prepare('INSERT OR IGNORE INTO feeds VALUES (?,?,?,?)').run(feed.network, distribution.signature, id, JSON.stringify(part)).changes)) {
        this.#changed(feed.network, distribution.signature); signatures.push(distribution.signature);
        const tx = this.evidence(feed.network, distribution.signature).transactions[0];
        if (tx) for (const row of this.#db.prepare(`${SAME_SLOT_SIGNATURES} LIMIT 10000`).all(feed.network, tx.evidence.slot)) this.#dirty(feed.network, String(row.signature));
      }
      this.#db.prepare('INSERT OR IGNORE INTO provenance VALUES (?,?,?)').run(id, hash([feed.provenance, feed.sources]), JSON.stringify({ provenance: feed.provenance, sources: feed.sources }));
    }
    return signatures;
  }
  evidence(network: SolanaNetwork, signature: string): EvidenceSet {
    const txs = this.#db.prepare('SELECT id,compatibility,body FROM transactions WHERE network=? AND signature=? ORDER BY id LIMIT 33').all(network, signature);
    const feeds = this.#db.prepare('SELECT body FROM feeds WHERE network=? AND signature=? ORDER BY id LIMIT 129').all(network, signature);
    const groups = new Map<string, typeof txs>();
    for (const row of txs) {
      const key = String(row.compatibility ?? row.id);
      const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    const transactions: EvidenceSet['transactions'] = [];
    for (const group of groups.values()) {
      const variants = group.map(row => parse<EvidenceSet['transactions'][number]>(row)!);
      const indexes = new Set(variants.map(tx => tx.evidence.transactionIndex).filter(value => value !== undefined));
      if (indexes.size <= 1) transactions.push(variants.find(tx => tx.evidence.transactionIndex !== undefined) ?? variants[0]!);
      else transactions.push(...variants);
    }
    return { transactions: transactions.slice(0, 16), transactionObservationIds: txs.map(row => String(row.id)),
      feeds: feeds.slice(0, 128).map(row => parse<DistributionEvidenceInput>(row)!), overflow: txs.length > 32 || transactions.length > 16 || feeds.length > 128 };
  }
  hasTransaction(network: SolanaNetwork, signature: string) { return !!this.#db.prepare('SELECT 1 FROM transactions WHERE network=? AND signature=? LIMIT 1').get(network, signature); }
  dirty(network: SolanaNetwork, limit: number) {
    // Refresh exact-feed witnesses before candidates, even across small/resumed batches.
    // Otherwise a candidate can finish while an unchanged witness is still hidden as dirty.
    return this.#db.prepare(`SELECT signature FROM dirty d WHERE network=?
      ORDER BY EXISTS (SELECT 1 FROM feeds f WHERE f.network=d.network AND f.signature=d.signature) DESC, signature LIMIT ?`)
      .all(network, limit).map(row => String(row.signature));
  }
  pendingClassifications(network: SolanaNetwork, wallet: string) {
    const row = this.#db.prepare(`SELECT COUNT(*) AS networkSignatures,
      COUNT(CASE WHEN EXISTS (SELECT 1 FROM watchers w WHERE w.network=d.network AND w.signature=d.signature AND w.wallet=?) THEN 1 END) AS walletSignatures
      FROM dirty d WHERE network=?`).get(wallet, network)!;
    return { networkSignatures: Number(row.networkSignatures), walletSignatures: Number(row.walletSignatures) };
  }
  clean(network: SolanaNetwork, signature: string) { this.#db.prepare('DELETE FROM dirty WHERE network=? AND signature=?').run(network, signature); }
  watchers(network: SolanaNetwork, signature: string) { return this.#db.prepare('SELECT wallet FROM watchers WHERE network=? AND signature=?').all(network, signature).map(row => String(row.wallet)); }
  saveClassifications(network: SolanaNetwork, signature: string, wallet: string, rows: Classification[]) {
    this.#db.prepare('DELETE FROM classifications WHERE network=? AND signature=? AND wallet=?').run(network, signature, wallet);
    this.#db.prepare('DELETE FROM dependencies WHERE network=? AND signature=? AND wallet=?').run(network, signature, wallet);
    for (const row of rows) {
      this.#db.prepare('INSERT INTO classifications VALUES (?,?,?,?,?,?,?,?,?)').run(network, wallet, row.identity, signature, row.blockTime, row.mint, row.status, row.netRaw, JSON.stringify(row));
      for (const support of row.supportingSignatures) this.#db.prepare('INSERT OR IGNORE INTO dependencies VALUES (?,?,?,?)').run(network, support, signature, wallet);
    }
  }
  classifiedSignatures(network: SolanaNetwork, wallet: string, start: number, end: number) {
    return this.#db.prepare('SELECT DISTINCT signature FROM classifications WHERE network=? AND wallet=? AND time>=? AND time<?').all(network, wallet, start, end)
      .map(row => String(row.signature));
  }
  historySaved(network: SolanaNetwork, signature: string, wallet: string) {
    // A history evidence id is `page-<range>-<n>` or `check-<range>-<n>`; the range's job names the wallet whose query returned it.
    return !!this.#db.prepare(`SELECT 1 FROM transactions t JOIN provenance p ON p.evidence=t.id
      JOIN ranges r ON r.id=CAST(substr(json_extract(p.body,'$.evidenceId'),instr(json_extract(p.body,'$.evidenceId'),'-')+1) AS INTEGER)
      JOIN jobs j ON j.id=r.job
      WHERE t.network=? AND t.signature=? AND j.wallet=? AND json_extract(t.body,'$.evidence.meta.err') IS NULL AND json_extract(p.body,'$.source')='helius'
      AND (json_extract(p.body,'$.evidenceId') GLOB 'page-*' OR json_extract(p.body,'$.evidenceId') GLOB 'check-*') LIMIT 1`).get(network, signature, wallet);
  }
  payoutRows(network: SolanaNetwork, wallet: string, start: number, end: number) {
    return this.#db.prepare("SELECT signature,status FROM classifications WHERE network=? AND wallet=? AND time>=? AND time<? AND status IN ('confirmed','attributed')")
      .all(network, wallet, start, end).map(row => ({ signature: String(row.signature), status: String(row.status) as 'confirmed' | 'attributed' }));
  }
  classifications(network: SolanaNetwork, wallet: string, after: string, limit: number) {
    return this.#db.prepare('SELECT body FROM classifications WHERE network=? AND wallet=? AND identity>? ORDER BY identity LIMIT ?').all(network, wallet, after, limit).map(row => parse<Classification>(row)!);
  }
  saveAuthorities(network: SolanaNetwork, signature: string, observations: AuthorityObservation[]) {
    const prior = this.#db.prepare('SELECT body FROM authorities WHERE network=? AND signature=? ORDER BY id').all(network, signature).map(row => parse<AuthorityObservation>(row)!);
    this.#db.prepare('DELETE FROM authorities WHERE network=? AND signature=?').run(network, signature);
    for (const item of observations) this.#db.prepare('INSERT INTO authorities VALUES (?,?,?,?,?)').run(network, signature, item.slot, item.pattern.patternId, JSON.stringify(item));
    if (canonical(prior) !== canonical([...observations].sort((a, b) => a.pattern.patternId.localeCompare(b.pattern.patternId)))) {
      // Historical epochs are derived from every retained exact-feed witness. A new,
      // changed, or revoked witness can affect any timestamp, not just its own slot.
      // Quarantine historical totals until all watched signatures are reclassified.
      this.#invalidateHistorical(network);
      this.#invalidateAttributed(network);
      for (const slot of new Set([...prior, ...observations].map(item => item.slot))) {
        for (const row of this.#db.prepare(`${SAME_SLOT_SIGNATURES} AND signature<>? LIMIT 10000`).all(network, slot, signature)) this.#dirty(network, String(row.signature));
      }
    }
  }
  authorities(network: SolanaNetwork, slot: number) { return this.#db.prepare('SELECT body FROM authorities a WHERE network=? AND slot=? AND NOT EXISTS (SELECT 1 FROM dirty d WHERE d.network=a.network AND d.signature=a.signature) ORDER BY signature LIMIT 1000').all(network, slot).map(row => parse<AuthorityObservation>(row)!); }
  authorityHistory(network: SolanaNetwork) { return this.#db.prepare('SELECT body FROM authorities a WHERE network=? AND NOT EXISTS (SELECT 1 FROM dirty d WHERE d.network=a.network AND d.signature=a.signature) ORDER BY signature,id').all(network).map(row => parse<AuthorityObservation>(row)!); }
  authorityRevocations(network: SolanaNetwork) { return this.cache<AuthorityRevocation[]>(`authority-revocations:${network}`)?.value ?? []; }
  saveAuthorityRevocation(network: SolanaNetwork, patternId: string, effectiveFrom: number, decisionId: string) {
    this.atomic(() => {
      if (!Number.isSafeInteger(effectiveFrom) || effectiveFrom < 0 || !/^[A-Za-z0-9_-]{1,100}$/.test(decisionId)) throw new Error('invalid_authority_revocation');
      const prior = this.authorityRevocations(network);
      const existing = prior.find(item => item.decisionId === decisionId);
      if (existing) {
        if (existing.modelVersion !== AUTHORITY_MODEL_VERSION || existing.patternId !== patternId
          || existing.effectiveFrom !== effectiveFrom) throw new Error('conflicting_authority_revocation');
        return;
      }
      const witnesses = this.authorityHistory(network).filter(item => item.pattern.status === 'supported_observations'
        && authorityIdentity(item) === patternId);
      if (new Set(witnesses.map(item => item.signature)).size < 2) throw new Error('unverified_authority_revocation');
      const revocation: AuthorityRevocation = { modelVersion: AUTHORITY_MODEL_VERSION, patternId, effectiveFrom, decisionId,
        witnessSignatures: [...new Set(witnesses.map(item => item.signature))].sort(),
        evidenceIds: [...new Set(witnesses.flatMap(item => item.evidenceIds ?? []))].sort(),
        scope: 'local_safety_revocation' };
      this.saveCache(`authority-revocations:${network}`, { value: [...prior, revocation]
        .sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.decisionId.localeCompare(b.decisionId)), expiresAt: Number.MAX_SAFE_INTEGER });
      this.#invalidateHistorical(network);
    });
  }
  #insertSnapshot(snapshot: WithdrawalAuthoritySnapshot) {
    return Number(this.#db.prepare('INSERT OR IGNORE INTO withdrawal_authority_snapshots VALUES (?,?,?,?,?)')
      .run(snapshot.network, snapshot.id, snapshot.observed, snapshot.authority, JSON.stringify(snapshot)).changes) > 0;
  }
  saveWithdrawalSnapshots(feed: DistributionEvidenceInput) {
    return this.atomic(() => {
      const inserted = withdrawalSnapshots(feed).filter(snapshot => this.#insertSnapshot(snapshot)).map(snapshot => snapshot.id);
      // A new snapshot can cover pending credits or reveal a rotation anywhere on the timeline.
      if (inserted.length) this.#invalidateAttributed(feed.network);
      return inserted;
    });
  }
  withdrawalSnapshots(network: SolanaNetwork) {
    if (this.#schema < 5) return [];
    return this.#db.prepare('SELECT body FROM withdrawal_authority_snapshots WHERE network=? ORDER BY observed,id LIMIT 10000').all(network)
      .map(row => parse<WithdrawalAuthoritySnapshot>(row)!);
  }
  saveIdentityConflicts(network: SolanaNetwork, signature: string, conflicts: IdentityConflict[]) {
    const prior = this.#db.prepare('SELECT body FROM identity_conflicts WHERE network=? AND signature=? ORDER BY owner').all(network, signature).map(row => parse<IdentityConflict>(row)!);
    const next = conflicts.filter(item => item.network === network && item.signature === signature).sort((a, b) => a.owner.localeCompare(b.owner));
    if (canonical(prior) === canonical(next)) return;
    this.#db.prepare('DELETE FROM identity_conflicts WHERE network=? AND signature=?').run(network, signature);
    for (const item of next) this.#db.prepare('INSERT OR REPLACE INTO identity_conflicts VALUES (?,?,?,?)').run(network, signature, item.owner, JSON.stringify(item));
    this.#invalidateAttributed(network);
  }
  identityConflicts(network: SolanaNetwork) {
    if (this.#schema < 5) return [];
    return this.#db.prepare('SELECT body FROM identity_conflicts WHERE network=? ORDER BY owner,signature LIMIT 10000').all(network).map(row => parse<IdentityConflict>(row)!);
  }
  attributionRevocations(network: SolanaNetwork) { return this.cache<AttributionRevocation[]>(`attribution-revocations:${network}`)?.value ?? []; }
  saveAttributionRevocation(network: SolanaNetwork, sourceOwner: string, effectiveFrom: number, decisionId: string) {
    this.atomic(() => {
      if (!Number.isSafeInteger(effectiveFrom) || effectiveFrom < 0 || !/^[A-Za-z0-9_-]{1,100}$/.test(decisionId)
        || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sourceOwner)) throw new Error('invalid_attribution_revocation');
      const prior = this.attributionRevocations(network);
      const existing = prior.find(item => item.decisionId === decisionId);
      if (existing) {
        if (existing.modelVersion !== ATTRIBUTION_MODEL_VERSION || existing.sourceOwner !== sourceOwner
          || existing.effectiveFrom !== effectiveFrom) throw new Error('conflicting_attribution_revocation');
        return;
      }
      // Only an identity that currently holds a trust source can be revoked.
      const witnesses = feedWitnesses(network, this.authorityHistory(network)).get(sourceOwner) ?? [];
      const snapshots = this.withdrawalSnapshots(network).filter(item => item.authority === sourceOwner);
      if (!witnesses.length && !snapshots.length) throw new Error('unverified_attribution_revocation');
      const revocation: AttributionRevocation = { modelVersion: ATTRIBUTION_MODEL_VERSION, identityId: attributionIdentity(network, sourceOwner),
        sourceOwner, effectiveFrom, decisionId,
        trustSources: [...witnesses.length ? ['feed_witnessed_identity' as const] : [], ...snapshots.length ? ['published_withdraw_authority' as const] : []],
        witnessSignatures: witnesses.map(item => item.signature).sort(), snapshotIds: snapshots.map(item => item.id).sort(),
        evidenceIds: [...new Set([...witnesses.flatMap(item => item.evidenceIds), ...snapshots.map(item => item.evidenceId)])].sort(),
        scope: 'local_safety_revocation' };
      this.saveCache(`attribution-revocations:${network}`, { value: [...prior, revocation]
        .sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.decisionId.localeCompare(b.decisionId)), expiresAt: Number.MAX_SAFE_INTEGER });
      this.#invalidateAttributed(network);
    });
  }
  retainedLaunchMints(network: SolanaNetwork) {
    return this.#db.prepare(`SELECT json_extract(e.value,'$.launchMint') AS mint FROM quotes q, json_each(q.body,'$.membershipEvidence') e WHERE q.network=?
      UNION SELECT json_extract(r.value,'$.value.mint') FROM feeds f, json_each(f.body,'$.distributions') d, json_each(d.value,'$.rows') r WHERE f.network=?`)
      .all(network, network).flatMap(row => typeof row.mint === 'string' ? [row.mint] : []).sort();
  }
  /** Every observation of a token account the wallet owns in the wallet's retained transactions: one row per account per
   * retained transaction body, with its raw balance before and after (null when the transaction reports none). Read only. */
  walletTokenBalances(network: SolanaNetwork, wallet: string) {
    return this.#db.prepare(`SELECT t.signature AS signature, json_extract(t.body,'$.evidence.slot') AS slot,
        json_extract(t.body,'$.evidence.transactionIndex') AS position, json_extract(t.body,'$.evidence.blockTime') AS time,
        json_extract(a.value,'$.address') AS account, json_extract(a.value,'$.mint.value') AS mint, json_extract(a.value,'$.decimals.value') AS decimals,
        json_extract(a.value,'$.pre[0].uiTokenAmount.amount') AS pre, json_extract(a.value,'$.post[0].uiTokenAmount.amount') AS post
      FROM watchers w JOIN transactions t ON t.network=w.network AND t.signature=w.signature, json_each(t.body,'$.accounts') a
      WHERE w.network=? AND w.wallet=? AND json_extract(a.value,'$.owner.status')='resolved' AND json_extract(a.value,'$.owner.value')=?
        AND json_extract(a.value,'$.mint.status')='resolved' AND json_extract(a.value,'$.decimals.status')='resolved'
      ORDER BY t.signature, t.id, a.key`).all(network, wallet, wallet).map(row => ({ signature: String(row.signature), slot: Number(row.slot),
      position: row.position === null ? null : Number(row.position), time: row.time === null ? null : Number(row.time), account: String(row.account),
      mint: String(row.mint), decimals: Number(row.decimals), preRaw: row.pre === null ? null : String(row.pre), postRaw: row.post === null ? null : String(row.post) }));
  }
  /** Changes whenever the wallet gains a watched signature or any transaction body is retained; cheap to read. */
  retainedFingerprint(network: SolanaNetwork, wallet: string) {
    const row = this.#db.prepare(`SELECT (SELECT COUNT(*) FROM watchers WHERE network=? AND wallet=?) AS watched, (SELECT MAX(rowid) FROM watchers) AS watchers,
      (SELECT MAX(rowid) FROM transactions) AS transactions, (SELECT MAX(rowid) FROM metadata_observations) AS observations`).get(network, wallet)!;
    return `${Number(row.watched)}:${Number(row.watchers ?? 0)}:${Number(row.transactions ?? 0)}:${Number(row.observations ?? 0)}`;
  }
  /** Stores one refresh's holdings: the history-derived rows the wallet ever held, and the snapshot's positive balances.
   * Every set is kept; readers take the latest. */
  saveHoldings(network: SolanaNetwork, wallet: string, set: HoldingsSet) {
    this.atomic(() => {
      const history = set.history.filter(item => item.everHeld);
      const snapshot = set.snapshot?.tokens.filter(item => /^\d+$/.test(item.raw) && BigInt(item.raw) > 0n) ?? null;
      const inserted = this.#db.prepare('INSERT OR IGNORE INTO holding_sets VALUES (?,?,?,?)').run(network, wallet, set.takenAt,
        JSON.stringify({ fingerprint: set.fingerprint, snapshot: snapshot !== null, snapshotTakenAt: set.snapshot?.takenAt ?? null,
          history: history.length, tokens: snapshot?.length ?? 0 }));
      if (!Number(inserted.changes)) return;
      const row = this.#db.prepare('INSERT OR IGNORE INTO holdings VALUES (?,?,?,?,?,?)');
      for (const item of history) row.run(network, wallet, set.takenAt, 'history', item.mint, JSON.stringify({ decimals: item.decimals,
        raw: item.raw.toString(), time: item.time, slot: item.slot, signature: item.signature }));
      for (const item of snapshot ?? []) row.run(network, wallet, set.takenAt, 'snapshot', item.mint,
        JSON.stringify({ raw: item.raw, decimals: item.decimals, name: item.name, symbol: item.symbol }));
    });
  }
  /** The latest stored history holdings and the latest complete snapshot; undefined before the wallet's first stored refresh. */
  holdings(network: SolanaNetwork, wallet: string): StoredHoldings | undefined {
    if (this.#schema < 7) return undefined;
    const latest = this.#db.prepare('SELECT taken,body FROM holding_sets WHERE network=? AND wallet=? ORDER BY taken DESC LIMIT 1').get(network, wallet);
    if (!latest) return undefined;
    const rows = (taken: string, source: string) => this.#db.prepare('SELECT mint,body FROM holdings WHERE network=? AND wallet=? AND taken=? AND source=? ORDER BY mint')
      .all(network, wallet, taken, source).map(row => Object.assign(JSON.parse(String(row.body)) as Record<string, unknown>, { mint: String(row.mint) }));
    const set = JSON.parse(String(latest.body)) as { fingerprint: string };
    const history = rows(String(latest.taken), 'history').map(item => ({ mint: item.mint, decimals: Number(item.decimals), everHeld: true,
      raw: BigInt(String(item.raw)), time: item.time === null ? null : Number(item.time), slot: Number(item.slot), signature: String(item.signature) }));
    const complete = this.#db.prepare(`SELECT taken,json_extract(body,'$.snapshotTakenAt') AS at FROM holding_sets
      WHERE network=? AND wallet=? AND json_extract(body,'$.snapshot')=1 ORDER BY taken DESC LIMIT 1`).get(network, wallet);
    const snapshot = complete ? { takenAt: String(complete.at ?? complete.taken), tokens: rows(String(complete.taken), 'snapshot').map(item => ({
      mint: item.mint, raw: String(item.raw), decimals: Number(item.decimals),
      name: typeof item.name === 'string' ? item.name : null, symbol: typeof item.symbol === 'string' ? item.symbol : null })) } : null;
    return { history: { takenAt: String(latest.taken), fingerprint: set.fingerprint, holdings: history }, snapshot };
  }
  /** Launch mints that any retained /rewards summary names for this quote mint, each with the latest retrieval naming it. */
  rewardSummaryLaunches(network: SolanaNetwork, quoteMint: string) {
    return this.#db.prepare(`SELECT json_extract(e.value,'$.launchMint') AS launch, MAX(json_extract(e.value,'$.retrievedAt')) AS retrievedAt
      FROM metadata_observations o, json_each(o.body,'$.membershipEvidence') e
      WHERE o.network=? AND o.mint=? AND json_extract(e.value,'$.kind')='rewardSummary' GROUP BY 1 ORDER BY 1`).all(network, quoteMint)
      .flatMap(row => typeof row.launch === 'string' ? [{ launchMint: row.launch, retrievedAt: String(row.retrievedAt) }] : []);
  }
  quote(network: SolanaNetwork, mint: string) { return parse<Metadata>(this.#db.prepare('SELECT body FROM quotes WHERE network=? AND mint=?').get(network, mint)); }
  saveQuote(network: SolanaNetwork, metadata: Metadata) {
    this.#db.prepare('INSERT OR IGNORE INTO metadata_observations VALUES (?,?,?,?)').run(network, metadata.mint, hash(metadata), JSON.stringify(metadata));
    const previous = this.quote(network, metadata.mint);
    const changedMembership = !previous || (metadata.membershipEvidence !== undefined
      && canonical(previous.membershipEvidence ?? []) !== canonical(metadata.membershipEvidence));
    if (changedMembership) for (const row of this.#db.prepare('SELECT DISTINCT signature FROM classifications WHERE network=? AND mint=?').all(network, metadata.mint)) {
      this.#changed(network, String(row.signature));
    }
    this.#db.prepare('INSERT INTO quotes VALUES (?,?,?) ON CONFLICT(network,mint) DO UPDATE SET body=excluded.body').run(network, metadata.mint, JSON.stringify({ ...previous, ...metadata }));
  }
  price(network: SolanaNetwork, mint: string) { return parse<Price>(this.#db.prepare('SELECT body FROM prices WHERE network=? AND mint=? ORDER BY retrieved DESC LIMIT 1').get(network, mint)); }
  latestPrice(network: SolanaNetwork, mint: string) {
    return parse<Price>(this.#db.prepare("SELECT body FROM prices WHERE network=? AND mint=? AND json_type(body,'$.value')='text' ORDER BY retrieved DESC LIMIT 1").get(network, mint));
  }
  savePrice(network: SolanaNetwork, price: Price) { this.#db.prepare('INSERT OR IGNORE INTO prices VALUES (?,?,?,?)').run(network, price.mint, price.retrievedAt, JSON.stringify(price)); }
  cache<T>(key: string) { return parse<CacheEntry<T>>(this.#db.prepare('SELECT body FROM cache WHERE key=?').get(key)); }
  saveCache<T>(key: string, entry: CacheEntry<T>) { this.#db.prepare('INSERT INTO cache VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(entry)); }
  close() { this.#db.close(); }
}
