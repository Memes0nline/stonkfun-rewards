import type { FullTransaction } from '../helius/schemas.js';
import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../normalization/normalizer.js';
import { COMPUTE_BUDGET_PROGRAM } from '../payout-evidence/compute-budget.js';
import { SqliteRewardsStore } from '../storage/sqlite.js';
import { createRealProviders } from '../providers/real.js';
import { runScan } from '../scanner/engine.js';
import { buildReport } from '../scanner/report.js';
import type { JobKind, ScanProgress } from '../scanner/types.js';

export const DEMO_WALLET = '8'.repeat(32);
export const DEMO_MINT = '7'.repeat(32);
export const DEMO_UNPRICED_MINT = 'B'.repeat(32);
export const DEMO_CUTOFF = 1790000000;
/** Synthetic published withdraw authority; it signs no demo transfer, so it never attributes a demo credit. */
export const DEMO_WITHDRAW_AUTHORITY = 'C'.repeat(32);
const source = '3'.repeat(32); const destination = '4'.repeat(32); const authority = '2'.repeat(32); const owner = '9'.repeat(32);
const launch = 'F'.repeat(32);

/** Clearly synthetic evidence, used by the demo and end-to-end acceptance tests. */
export function demoTransaction(signatureCharacter: string, time: number, raw = '1000000', mint = DEMO_MINT, fee = '0'): FullTransaction {
  const program = fee === '0' ? SPL_TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const keys = [authority, source, destination, mint, DEMO_WALLET, owner, program, COMPUTE_BUDGET_PROGRAM];
  const balance = (accountIndex: number, amount: string) => ({ accountIndex, mint, owner: accountIndex === 2 ? DEMO_WALLET : owner,
    programId: program, uiTokenAmount: { amount, decimals: 6, uiAmount: null } });
  return { slot: time, transactionIndex: 1, blockTime: time, version: 0,
    transaction: { signatures: [signatureCharacter.repeat(88)], message: {
      accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
      instructions: [
        // Base58 of [2, 64, 13, 3, 0]: SetComputeUnitLimit(200000).
        { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: 'Fj2Eoy' },
        { programId: program, program: 'spl-token', parsed: { type: fee === '0' ? 'transferChecked' : 'transferCheckedWithFee', info: {
          source, destination, authority, mint, tokenAmount: { amount: raw, decimals: 6 },
          ...(fee === '0' ? {} : { feeAmount: { amount: fee, decimals: 6 } }),
        } } },
      ],
    } },
    meta: { err: null, fee: 5000, preBalances: keys.map(() => 2039280), postBalances: keys.map((_, i) => i === 0 ? 2034280 : 2039280),
      preTokenBalances: [balance(1, raw), balance(2, '0')],
      postTokenBalances: [balance(1, '0'), balance(2, (BigInt(raw) - BigInt(fee)).toString())], innerInstructions: [], logMessages: [] },
  };
}

export interface DemoData {
  transactions: FullTransaction[]; official: FullTransaction[]; prices: Record<string, string | null>; calls: { stonkfun: number; helius: number };
  failCursor?: string; staleCursor?: string;
  /** Full-mode reads left out a transaction by signature, as Helius's short pages did: each full read starting in its range
   * uses one. Signatures mode always lists it. */
  fullOmits?: Map<string, number>;
  /** Signatures the current full read leaves out, fixed at its first page. */
  hiding?: Set<string>;
  /** Signatures every signatures-mode listing leaves out, as a short listing would. */
  listOmits?: Set<string>;
}
export function demoData(): DemoData {
  const first = demoTransaction('3', DEMO_CUTOFF - 3600, '12345678901234567');
  const old = demoTransaction('4', DEMO_CUTOFF - 8 * 86400, '5000000');
  const fee = demoTransaction('5', DEMO_CUTOFF - 7200, '1000000', DEMO_UNPRICED_MINT, '30000');
  const unknown = demoTransaction('6', DEMO_CUTOFF - 8000, '2000000');
  const self = demoTransaction('7', DEMO_CUTOFF - 9000, '3000000');
  self.transaction.message.accountKeys.find(key => key.pubkey === DEMO_WALLET)!.signer = true;
  return { transactions: [first, old, fee, unknown, self], official: [first, old, fee],
    prices: { [DEMO_MINT]: '1.25', [DEMO_UNPRICED_MINT]: null }, calls: { stonkfun: 0, helius: 0 } };
}
export function demoFetch(data: DemoData, now: () => number): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const generatedAt = new Date(now()).toISOString();
    const response = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    if (url.hostname === 'www.stonkfun.xyz') {
      data.calls.stonkfun++;
      if (url.pathname.endsWith('/launches')) return response({ data: { launches: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } }, meta: { generatedAt } });
      if (url.pathname.endsWith('/pairs')) return response({ data: { pairs: [DEMO_MINT, DEMO_UNPRICED_MINT].map(mint => ({ mint, symbol: mint === DEMO_MINT ? 'DEMO' : 'UNPRICED', name: 'Synthetic demo asset', decimals: 6, category: 'fixture', tokenProgram: SPL_TOKEN_PROGRAM, launchable: false })) }, meta: { generatedAt } });
      if (url.pathname.endsWith('/rewards')) return response({ data: { launches: [], recentDistributions: data.official.map(tx => ({ signature: tx.transaction.signatures[0], mint: launch,
        quoteMint: tx.meta.preTokenBalances[0]!.mint, amountRaw: tx.meta.preTokenBalances[0]!.uiTokenAmount.amount,
        holderCount: 1, distributedAt: new Date(tx.blockTime! * 1000).toISOString() })) }, meta: { generatedAt } });
      const mint = url.searchParams.get('quoteMint')!;
      return response({ data: { quote: { mint }, prices: { quoteUsd: data.prices[mint] ?? null, observedAt: generatedAt },
        modes: { reward: { withdrawWithheldAuthority: DEMO_WITHDRAW_AUTHORITY } } } });
    }
    if (url.hostname !== 'mainnet.helius-rpc.com') throw new Error('demo_network_forbidden');
    data.calls.helius++;
    if (typeof init?.body !== 'string') throw new Error('demo_expected_json_body');
    const request = JSON.parse(init.body) as { id: string; method: string; params: unknown };
    if (request.method === 'getTransactionsForAddress') {
      const [, query] = request.params as [string, { transactionDetails?: string; limit: number; paginationToken?: string; filters: { blockTime: { gte: number; lte: number } } }];
      if (data.staleCursor !== undefined && query.paginationToken === data.staleCursor) return response({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid pagination token' } });
      if (data.failCursor !== undefined && query.paginationToken === data.failCursor) return Promise.resolve(new Response('{}', { status: 503 }));
      let transactions = data.transactions.filter(tx => tx.blockTime! >= query.filters.blockTime.gte && tx.blockTime! <= query.filters.blockTime.lte).sort((a, b) => a.blockTime! - b.blockTime!);
      const offset = Number(query.paginationToken ?? 0);
      const next = (length: number) => offset + query.limit < length ? String(offset + query.limit) : null;
      if (query.transactionDetails === 'signatures') {
        const listed = transactions.filter(tx => !data.listOmits?.has(tx.transaction.signatures[0]!));
        return response({ jsonrpc: '2.0', id: request.id, result: { data: listed.slice(offset, offset + query.limit).map(tx => ({ signature: tx.transaction.signatures[0],
          slot: tx.slot, blockTime: tx.blockTime, err: null, memo: null, confirmationStatus: 'finalized', transactionIndex: tx.transactionIndex ?? 0 })),
        paginationToken: next(listed.length) } });
      }
      if (query.paginationToken === undefined) {
        data.hiding = new Set(transactions.map(tx => tx.transaction.signatures[0]!).filter(signature => {
          const left = data.fullOmits?.get(signature) ?? 0;
          if (left > 0) data.fullOmits!.set(signature, left - 1);
          return left > 0;
        }));
      }
      transactions = transactions.filter(tx => !data.hiding?.has(tx.transaction.signatures[0]!));
      const page = transactions.slice(offset, offset + query.limit);
      return response({ jsonrpc: '2.0', id: request.id, result: { data: page, paginationToken: next(transactions.length) } });
    }
    if (request.method === 'getTransaction') {
      const found = data.official.find(tx => tx.transaction.signatures[0] === (request.params as string[])[0]);
      // Standard getTransaction does not promise the history method's transactionIndex.
      const transaction = found ? structuredClone(found) : null;
      if (transaction) delete transaction.transactionIndex;
      return response({ jsonrpc: '2.0', id: request.id, result: transaction });
    }
    return response({ jsonrpc: '2.0', id: request.id, result: { id: (request.params as { id: string }).id, token_info: {} } });
  };
}
export async function runDemo(path: string, progress?: (event: ScanProgress) => void) {
  const data = demoData();
  let clock = DEMO_CUTOFF * 1000;
  const now = () => { clock += 1000; return clock; };
  const scan = async (store: SqliteRewardsStore, cutoff: number, id: string, kind: JobKind = 'refresh') => runScan(store, {
    wallet: DEMO_WALLET, cutoff, jobId: id, owner: id, kind, limits: { stonkfun: 20, helius: 50, pages: 100, resumes: 5, deadline: now() + 3600_000 },
  }, job => createRealProviders({ store, job, apiKey: 'synthetic-demo-key', fetch: demoFetch(data, now), now }), { now, ...(progress ? { progress } : {}) });
  let store = new SqliteRewardsStore(path);
  let initial: ReturnType<typeof buildReport>;
  try {
    if (store.wallet('mainnet-beta', DEMO_WALLET)) throw new Error('demo_requires_empty_database');
    store.saveCache(`dataset:mainnet-beta:${DEMO_WALLET}`, { value: 'SYNTHETIC DEMO — deterministic fixtures, no real rewards', expiresAt: Number.MAX_SAFE_INTEGER });
    // The first scan loads the last seven days; one Load earlier batch adds the seven before them, with the older receipt.
    await scan(store, DEMO_CUTOFF, 'synthetic-demo-initial');
    await scan(store, DEMO_CUTOFF, 'synthetic-demo-earlier', 'earlier'); initial = buildReport(store, DEMO_WALLET);
  }
  finally { store.close(); }
  // Real connection close/reopen exercises persistent checkpoints and incremental planning.
  clock = (DEMO_CUTOFF + 3 * 86400) * 1000;
  const later = demoTransaction('9', DEMO_CUTOFF + 2 * 86400, '2000000');
  data.transactions.push(later); data.official.push(later); data.prices[DEMO_MINT] = '2.50';
  store = new SqliteRewardsStore(path);
  try {
    await scan(store, DEMO_CUTOFF + 3 * 86400, 'synthetic-demo-later');
    return { label: 'DETERMINISTIC SYNTHETIC DEMO — no network requests or real rewards', initial, afterRestart: buildReport(store, DEMO_WALLET), fixtureRequests: data.calls };
  } finally { store.close(); }
}
