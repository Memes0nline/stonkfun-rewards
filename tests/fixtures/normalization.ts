// Synthetic transactions shaped like Solana jsonParsed RPC evidence; no live wallet data.
import type { FullTransaction, NormalizationInput } from '../../src/index.js';
import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../../src/index.js';
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../../src/normalization/associated-token.js';
import type { InstructionEvidence, TokenBalanceEvidence } from '../../src/normalization/types.js';

export const key = {
  authority: '2'.repeat(32), source: '3'.repeat(32), recipient: '4'.repeat(32),
  recipientB: '5'.repeat(32), sink: '6'.repeat(32), mint: '7'.repeat(32),
  wallet: '8'.repeat(32), otherOwner: '9'.repeat(32), router: 'A'.repeat(32),
  otherMint: 'B'.repeat(32), multisig: 'C'.repeat(32), cosigner: 'D'.repeat(32),
};
export const signature = '3'.repeat(88);
export function transfer(
  rawAmount = '100', source = key.source, destination = key.recipient,
  programId = SPL_TOKEN_PROGRAM, feeRaw?: string,
): InstructionEvidence {
  return { program: 'spl-token', programId, stackHeight: 1,
    parsed: { type: feeRaw === undefined ? 'transferChecked' : 'transferCheckedWithFee', info: {
      source, destination, authority: key.authority, mint: key.mint,
      tokenAmount: { amount: rawAmount, decimals: 6, uiAmount: null, uiAmountString: 'display-only' },
      ...(feeRaw === undefined ? {} : { feeAmount: { amount: feeRaw, decimals: 6, uiAmount: null } }),
    } },
  };
}
export function wrapper(): InstructionEvidence {
  return { programId: key.router, accounts: [key.source, key.recipient, key.authority], data: '3Bxs4', stackHeight: 1 };
}
export function fixture(programId = SPL_TOKEN_PROGRAM): NormalizationInput {
  const addresses = [key.authority, key.source, key.recipient, key.recipientB, key.sink, key.mint,
    key.wallet, key.otherOwner, key.router, key.otherMint, key.multisig, key.cosigner, programId];
  const balance = (accountIndex: number, amount: string): TokenBalanceEvidence => ({ accountIndex,
    mint: key.mint, owner: accountIndex === 2 || accountIndex === 3 ? key.wallet : key.otherOwner,
    programId, uiTokenAmount: { amount, decimals: 6, uiAmount: null },
  });
  const transaction: FullTransaction = {
    slot: 412345678, transactionIndex: 9, blockTime: 1790000000, version: 0,
    transaction: { signatures: [signature], message: {
      accountKeys: addresses.map((pubkey, index) => ({ pubkey, signer: index === 0,
        writable: index >= 1 && index <= 4, source: 'transaction' })),
      instructions: [transfer('100', key.source, key.recipient, programId)], recentBlockhash: 'E'.repeat(32),
      addressTableLookups: [],
    } },
    meta: { err: null, fee: 5000, preBalances: addresses.map(() => 2039280), postBalances: addresses.map(() => 2039280),
      preTokenBalances: [balance(1, '1000'), balance(2, '100'), balance(3, '0'), balance(4, '0')],
      postTokenBalances: [balance(1, '900'), balance(2, '200'), balance(3, '0'), balance(4, '0')],
      innerInstructions: [], logMessages: [`Program ${programId} invoke [1]`, `Program ${programId} success`],
      computeUnitsConsumed: 6324,
    },
  };
  return { transaction, wallet: key.wallet, network: 'mainnet-beta', provenance: {
    source: 'fixture', evidenceId: 'normalization-fixture-1', retrievedAt: '2026-09-21T03:00:00Z', commitment: 'finalized',
  } };
}
export function setBalance(input: NormalizationInput, address: string, phase: 'pre' | 'post', value: string | null) {
  const tx = input.transaction;
  const accountIndex = tx.transaction.message.accountKeys.findIndex(item => item.pubkey === address);
  const field = phase === 'pre' ? 'preTokenBalances' : 'postTokenBalances';
  const existing = tx.meta[field].find(item => item.accountIndex === accountIndex);
  if (value === null) tx.meta[field] = tx.meta[field].filter(item => item.accountIndex !== accountIndex);
  else if (existing) existing.uiTokenAmount.amount = value;
  else throw new Error('Fixture balance must already exist');
}
export interface CreationOptions {
  account?: string; owner?: string; mint?: string; source?: string; program?: string;
  type?: 'create' | 'createIdempotent'; lamports?: number; noop?: 'empty' | 'absent';
}
/** Adds an account key and a matching zero-movement lamport balance when the address is new. */
export function addKey(input: NormalizationInput, pubkey: string, lamports = 2039280) {
  const message = input.transaction.transaction.message;
  if (message.accountKeys.some(item => item.pubkey === pubkey)) return;
  message.accountKeys.push({ pubkey, signer: false, writable: false, source: 'transaction' });
  (input.transaction.meta.preBalances as number[]).push(lamports);
  (input.transaction.meta.postBalances as number[]).push(lamports);
}
/** Appends the associated-token-account program's creation instruction and the CPI list it emits. */
export function addCreation(input: NormalizationInput, options: CreationOptions = {}): number {
  const account = options.account ?? key.recipient;
  const owner = options.owner ?? key.wallet;
  const mint = options.mint ?? key.mint;
  const source = options.source ?? key.authority;
  const tokenProgram = options.program ?? SPL_TOKEN_PROGRAM;
  for (const pubkey of [ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM, account, owner, mint, source, tokenProgram]) addKey(input, pubkey);
  const index = input.transaction.transaction.message.instructions.length;
  input.transaction.transaction.message.instructions.push({ program: 'spl-associated-token-account',
    programId: ASSOCIATED_TOKEN_PROGRAM, stackHeight: 1,
    parsed: { type: options.type ?? 'createIdempotent', info: { account, mint, wallet: owner, source, tokenProgram } } });
  if (options.noop === 'absent') return index;
  const inner = options.noop === 'empty' ? [] : [
    { program: 'spl-token', programId: tokenProgram, stackHeight: 2, parsed: { type: 'getAccountDataSize', info: { mint, extensionTypes: [] } } },
    { program: 'system', programId: SYSTEM_PROGRAM, stackHeight: 2, parsed: { type: 'createAccount',
      info: { source, newAccount: account, lamports: options.lamports ?? 2039280, space: 165, owner: tokenProgram } } },
    { program: 'spl-token', programId: tokenProgram, stackHeight: 2, parsed: { type: 'initializeImmutableOwner', info: { account } } },
    { program: 'spl-token', programId: tokenProgram, stackHeight: 2, parsed: { type: 'initializeAccount3', info: { account, mint, owner } } },
  ];
  input.transaction.meta.innerInstructions!.push({ index, instructions: inner });
  return index;
}
/** The CPI list of the creation unit appended at `index`, for per-shape deviation fixtures. */
export function creationCpis(input: NormalizationInput, index: number): InstructionEvidence[] {
  return input.transaction.meta.innerInstructions!.find(group => group.index === index)!.instructions;
}
export function token2022Fixture(feeRaw?: string): NormalizationInput {
  const input = fixture(TOKEN_2022_PROGRAM);
  input.transaction.transaction.message.instructions = [transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM, feeRaw)];
  setBalance(input, key.recipient, 'post', '197');
  return input;
}
