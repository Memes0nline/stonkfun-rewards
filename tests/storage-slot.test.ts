import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SAME_SLOT_SIGNATURES, SqliteRewardsStore } from '../src/storage/sqlite.js';
import { processDirty } from '../src/scanner/classifier.js';
import { DEMO_CUTOFF as cutoff, DEMO_WALLET as wallet, demoTransaction } from '../src/cli/demo.js';

const network = 'mainnet-beta';
const provenance = { source: 'fixture' as const, evidenceId: 'synthetic-slot', retrievedAt: new Date(cutoff * 1000).toISOString(), commitment: 'finalized' as const };
const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) { try { close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database() { const directory = mkdtempSync(join(tmpdir(), 'rewards-slot-')); directories.push(directory); return join(directory, 'slot.sqlite'); }
/** One synthetic transaction per signature character, all in `slot`. */
function inSlot(characters: string, slot: number) {
  return [...characters].map(character => { const tx = demoTransaction(character, cutoff - 100); tx.slot = slot; return tx; });
}

describe('same-slot evidence lookups', () => {
  it('are answered from the slot index, not a scan of every retained body', () => {
    const path = database();
    const store = new SqliteRewardsStore(path); closers.push(() => { store.close(); });
    store.atomic(() => { for (const tx of [...inSlot('3', 100), ...inSlot('4', 200)]) store.addTransaction(network, tx, provenance); });
    const db = new DatabaseSync(path, { readOnly: true }); closers.push(() => { db.close(); });
    for (const statement of [`${SAME_SLOT_SIGNATURES} LIMIT 10000`, `${SAME_SLOT_SIGNATURES} AND signature<>? LIMIT 10000`]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(network, 100, ...statement.includes('<>') ? ['x'] : []).map(row => String(row.detail));
      expect(plan.join(' ')).toContain('USING INDEX transaction_slot (network=? AND <expr>=?)');
      expect(plan.join(' ')).not.toContain('sqlite_autoindex_transactions_1');
    }
    // The indexed statement returns exactly the slot's signatures.
    expect(db.prepare(`${SAME_SLOT_SIGNATURES} LIMIT 10000`).all(network, 100).map(row => String(row.signature))).toEqual(['3'.repeat(88)]);
    expect(db.prepare(`${SAME_SLOT_SIGNATURES} LIMIT 10000`).all(network, 300)).toEqual([]);
  });

  it('still requeues every retained signature of the slot when new evidence lands in it', () => {
    const store = new SqliteRewardsStore(database()); closers.push(() => { store.close(); });
    const [first, second] = inSlot('34', 100);
    const [other] = inSlot('5', 200);
    store.atomic(() => {
      store.saveWallet({ wallet, network, trackingStart: cutoff - 864000, cutoff, lastSync: null });
      for (const tx of [first!, other!]) { store.addTransaction(network, tx, provenance); store.watch(network, tx.transaction.signatures[0]!, wallet); }
    });
    while (processDirty(store, network, 100) > 0) { /* drain */ }
    expect(store.dirty(network, 10)).toEqual([]);
    store.atomic(() => { store.addTransaction(network, second!, provenance); });
    // The slot-mate is queued again; the transaction in another slot is not.
    expect(store.dirty(network, 10).sort()).toEqual(['3'.repeat(88), '4'.repeat(88)]);
  });
});
