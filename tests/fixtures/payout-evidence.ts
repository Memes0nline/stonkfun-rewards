// SYNTHETIC fixtures only. No captured transaction data or historical authority addresses.
import type { DistributionEvidenceInput, DistributionRow, NormalizationInput } from '../../src/index.js';
import { SPL_TOKEN_PROGRAM } from '../../src/index.js';
import { addCreation, fixture, key, transfer, setBalance } from './normalization.js';
import type { CreationOptions } from './normalization.js';

export const retrievedAt = '2026-09-21T03:00:00Z';
export const launchA = 'F'.repeat(32);
export const launchB = 'G'.repeat(32);
export function payout(program = SPL_TOKEN_PROGRAM): NormalizationInput {
  const input = fixture(program);
  // SOL movement is only the fee, paid by the first message account.
  const post = input.transaction.meta.postBalances as number[];
  post[0] = post[0]! - 5000;
  return input;
}
export function row(input = payout(), amountRaw = '100', mint = launchA): DistributionRow {
  return { signature: input.transaction.transaction.signatures[0]!, mint, quoteMint: key.mint,
    amountRaw, holderCount: 1, distributedAt: '2026-09-21T02:00:00Z' };
}
export function feed(rows = [row()], network: DistributionEvidenceInput['network'] = 'mainnet-beta'): DistributionEvidenceInput {
  return { network, provenance: { source: 'fixture', evidenceId: 'synthetic-feed-1', retrievedAt },
    distributions: [...new Set(rows.map(item => item.signature))].map(signature => ({
      signature, rows: rows.filter(item => item.signature === signature).map(value => ({ value, sourceIds: ['source-1'] })),
    })),
    sources: [{ id: 'source-1', source: 'rewards', endpoint: '/rewards?limit=100',
      requestedAt: retrievedAt, retrievedAt, generatedAt: retrievedAt, attempts: 1, outcome: 'success' }],
    withdrawalAuthorities: [],
  };
}
export function batch(): NormalizationInput {
  const input = payout();
  input.transaction.transaction.message.instructions.push(transfer('50', key.source, key.recipientB));
  setBalance(input, key.source, 'post', '850');
  setBalance(input, key.recipientB, 'post', '50');
  return input;
}
/** Moves lamports between two account keys without touching any token balance. */
export function moveLamports(input: NormalizationInput, from: string, to: string, lamports: number) {
  const keys = input.transaction.transaction.message.accountKeys;
  const post = input.transaction.meta.postBalances as number[];
  const at = (address: string) => keys.findIndex(item => item.pubkey === address);
  post[at(from)] = post[at(from)]! - lamports;
  post[at(to)] = post[at(to)]! + lamports;
}
/** A payout batch that also creates an associated token account and funds its exact rent. */
export function withRent(input: NormalizationInput, options: CreationOptions = {}): NormalizationInput {
  const lamports = options.lamports ?? 2039280;
  addCreation(input, { ...options, lamports });
  if (options.noop !== undefined) return input;
  const source = options.source ?? key.authority;
  const at = input.transaction.transaction.message.accountKeys.findIndex(item => item.pubkey === source);
  // The funder must hold the rent before it pays it; both phases move by the same amount.
  (input.transaction.meta.preBalances as number[])[at]! += lamports;
  (input.transaction.meta.postBalances as number[])[at]! += lamports;
  moveLamports(input, source, options.account ?? key.recipient, lamports);
  return input;
}
/** A payout whose recipient's associated token account is created in the same transaction. */
export function createdRecipient(options: CreationOptions = {}): NormalizationInput {
  const input = payout();
  setBalance(input, key.recipient, 'pre', null);
  setBalance(input, key.recipient, 'post', '100');
  return withRent(input, { account: key.recipient, owner: key.wallet, ...options });
}
export function rotate(input: NormalizationInput, authority: string, signature: string, time: number): NormalizationInput {
  // Replace the synthetic authority's references while keeping source ownership independent.
  const result = JSON.parse(JSON.stringify(input).replaceAll(key.authority, authority)) as NormalizationInput;
  result.transaction.transaction.signatures[0] = signature;
  result.transaction.blockTime = time;
  result.provenance.evidenceId = 'synthetic-rotated';
  result.provenance.retrievedAt = '2026-09-22T03:00:00Z';
  return result;
}
