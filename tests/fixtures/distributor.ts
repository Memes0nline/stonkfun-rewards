// SYNTHETIC distributor-pattern fixtures. Keys are hashes of labels, never captured addresses.
import { createHash } from 'node:crypto';
import type { FullTransaction } from '../../src/helius/schemas.js';
import type { InstructionEvidence } from '../../src/normalization/types.js';
import type { DistributionEvidenceInput } from '../../src/payout-evidence/types.js';
import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../../src/normalization/normalizer.js';
import { COMPUTE_BUDGET_PROGRAM } from '../../src/payout-evidence/compute-budget.js';
import { ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../../src/normalization/associated-token.js';
import { associatedTokenAddress, base58Decode, base58Encode } from '../../src/scanner/ata.js';
import { WITHDRAW_AUTHORITY_CONFIGURATION_MINT } from '../../src/providers/real.js';

export const syntheticKey = (label: string) => base58Encode(createHash('sha256').update(`synthetic-key:${label}`).digest());
export const syntheticSignature = (label: string) => base58Encode(createHash('sha512').update(`synthetic-signature:${label}`).digest());
export const ata = (owner: string, mint: string, program = SPL_TOKEN_PROGRAM) => associatedTokenAddress(owner, mint, program)!.address;
export const DISTRIBUTOR = syntheticKey('distributor');
export const OTHER_DISTRIBUTOR = syntheticKey('other-distributor');
export const MINT = syntheticKey('quote-mint');
export const SECOND_MINT = syntheticKey('second-quote-mint');
export const WALLET = syntheticKey('wallet');
export const WALLET_ACCOUNT = syntheticKey('wallet-token-account');
export const FEE_PAYER = syntheticKey('fee-payer');
export const DELEGATE = syntheticKey('delegate');
export const CUTOFF = 1_790_100_000;
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** A different valid key sharing the first and last four characters. */
export function lookAlike(address: string): string {
  for (const character of 'abcdefghijkmnopqrstuvwxyz') {
    const candidate = address.slice(0, 4) + character.repeat(address.length - 8) + address.slice(-4);
    if (candidate !== address && base58Decode(candidate)?.length === 32) return candidate;
  }
  throw new Error('no synthetic look-alike');
}
export const recipient = (index: number) => ({ destination: syntheticKey(`recipient-account-${index}`), destinationOwner: syntheticKey(`recipient-${index}`) });

export interface Leg {
  owner?: string; source?: string; authority?: string; multisigSigners?: string[]; signs?: boolean;
  destination: string; destinationOwner: string; amount: string; mint?: string; program?: string;
}
export interface CreationSpec {
  account: string; owner: string; mint?: string; program?: string; source?: string; lamports?: number; noop?: boolean;
}
export interface PayoutShape {
  label: string; time: number | null; slot?: number; transactionIndex?: number; legs: Leg[];
  feePayer?: string; extraSigners?: string[]; extraKeys?: { pubkey: string; signer?: boolean; writable?: boolean }[];
  extraInstructions?: InstructionEvidence[]; computeBudget?: boolean; nativeLeak?: boolean; failed?: boolean; missingPre?: string[];
  /** Recognized associated-token-account creation units, each funding its exact rent. */
  creations?: CreationSpec[];
  /** Token-balance rows for accounts no supported transfer touches. */
  extraBalances?: { address: string; owner: string; mint?: string; program?: string; pre?: string; post?: string }[];
}
export const toWallet = (amount = '1000000', extra: Partial<Leg> = {}): Leg => ({ destination: WALLET_ACCOUNT, destinationOwner: WALLET, amount, ...extra });

/** jsonParsed-shaped payout: fee-only SOL movement, exact token balances, optional compute-budget prefix. */
export function payout(shape: PayoutShape): FullTransaction {
  const legs = shape.legs.map(leg => {
    const owner = leg.owner ?? DISTRIBUTOR; const mint = leg.mint ?? MINT; const program = leg.program ?? SPL_TOKEN_PROGRAM;
    return { ...leg, owner, mint, program, source: leg.source ?? ata(owner, mint, program), authority: leg.authority ?? owner };
  });
  const feePayer = shape.feePayer ?? legs[0]?.authority ?? DISTRIBUTOR;
  const signers = [...new Set([feePayer, ...legs.flatMap(leg => leg.multisigSigners ?? (leg.signs === false ? [] : [leg.authority])),
    ...shape.extraSigners ?? []])];
  const accounts = new Map<string, { owner: string; mint: string; program: string; pre: bigint; post: bigint }>();
  for (const leg of legs) {
    const source = accounts.get(leg.source) ?? { owner: leg.owner, mint: leg.mint, program: leg.program, pre: 10_000_000_000n, post: 10_000_000_000n };
    source.post -= BigInt(leg.amount); accounts.set(leg.source, source);
    const destination = accounts.get(leg.destination) ?? { owner: leg.destinationOwner, mint: leg.mint, program: leg.program, pre: 0n, post: 0n };
    destination.post += BigInt(leg.amount); accounts.set(leg.destination, destination);
  }
  const keys: { pubkey: string; signer: boolean; writable: boolean }[] = [];
  const add = (pubkey: string, signer = false, writable = false) => {
    const existing = keys.find(item => item.pubkey === pubkey);
    if (existing) { existing.signer ||= signer; existing.writable ||= writable; } else keys.push({ pubkey, signer, writable });
  };
  for (const signer of signers) add(signer, true, signer === feePayer);
  for (const address of accounts.keys()) add(address, false, true);
  for (const leg of legs) { add(leg.authority); add(leg.mint); add(leg.program); }
  if (shape.computeBudget !== false) add(COMPUTE_BUDGET_PROGRAM);
  const creations = (shape.creations ?? []).map(item => ({ lamports: 2039280, mint: MINT, program: SPL_TOKEN_PROGRAM,
    source: feePayer, noop: false, ...item }));
  for (const creation of creations) {
    add(ASSOCIATED_TOKEN_PROGRAM); add(SYSTEM_PROGRAM);
    // The future owner is only a seed: a non-signer, non-writable key that authorizes nothing.
    add(creation.account, false, true); add(creation.owner); add(creation.mint); add(creation.program); add(creation.source, false, true);
  }
  for (const item of shape.extraBalances ?? []) { add(item.address, false, true); add(item.owner); add(item.mint ?? MINT); add(item.program ?? SPL_TOKEN_PROGRAM); }
  for (const extra of shape.extraKeys ?? []) add(extra.pubkey, extra.signer ?? false, extra.writable ?? false);
  for (const instruction of shape.extraInstructions ?? []) for (const address of [instruction.programId, ...instruction.accounts ?? []]) add(address);
  const index = (address: string) => keys.findIndex(item => item.pubkey === address);
  const extraRow = (item: NonNullable<PayoutShape['extraBalances']>[number], amount: string) => ({ accountIndex: index(item.address),
    mint: item.mint ?? MINT, owner: item.owner, programId: item.program ?? SPL_TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6, uiAmount: null } });
  const extraBalances = (phase: 'pre' | 'post') => (shape.extraBalances ?? [])
    .flatMap(item => item[phase] === undefined ? [] : [extraRow(item, item[phase])]);
  const balance = (address: string, phase: 'pre' | 'post') => {
    const account = accounts.get(address)!;
    return { accountIndex: index(address), mint: account.mint, owner: account.owner, programId: account.program,
      uiTokenAmount: { amount: account[phase].toString(), decimals: 6, uiAmount: null } };
  };
  const signatureLabels = keys.filter(item => item.signer).map((_, position) => position === 0 ? shape.label : `${shape.label}:${position}`);
  const creationOffset = (shape.computeBudget !== false ? 1 : 0) + legs.length + (shape.extraInstructions?.length ?? 0);
  const preBalances = keys.map(() => 2039280);
  const postBalances = keys.map((_, position) => position === 0 ? 2034280 : shape.nativeLeak && position === 1 ? 2039281 : 2039280);
  for (const creation of creations) {
    if (creation.noop) continue;
    // The funder holds the rent beforehand and the created account receives exactly it.
    preBalances[index(creation.source)]! += creation.lamports;
    postBalances[index(creation.account)]! += creation.lamports;
  }
  return {
    slot: shape.slot ?? (shape.time ?? CUTOFF), ...(shape.transactionIndex === undefined ? {} : { transactionIndex: shape.transactionIndex }),
    blockTime: shape.time, version: 0,
    transaction: { signatures: signatureLabels.map(syntheticSignature), message: { accountKeys: keys, instructions: [
      ...shape.computeBudget !== false ? [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: 'Fj2Eoy' }] : [],
      ...legs.map(leg => ({ program: leg.program === TOKEN_2022_PROGRAM ? 'spl-token-2022' : 'spl-token', programId: leg.program,
        parsed: { type: 'transferChecked', info: { source: leg.source, destination: leg.destination,
          ...leg.multisigSigners ? { multisigAuthority: leg.authority, signers: leg.multisigSigners } : { authority: leg.authority },
          mint: leg.mint, tokenAmount: { amount: leg.amount, decimals: 6, uiAmount: null } } } })),
      ...shape.extraInstructions ?? [],
      ...creations.map(creation => ({ program: 'spl-associated-token-account', programId: ASSOCIATED_TOKEN_PROGRAM,
        parsed: { type: 'createIdempotent', info: { account: creation.account, mint: creation.mint,
          wallet: creation.owner, source: creation.source, tokenProgram: creation.program } } })),
    ] } },
    meta: { err: shape.failed ? { InstructionError: [1, { Custom: 1 }] } : null, fee: 5000, preBalances, postBalances,
      preTokenBalances: [...[...accounts.keys()].filter(address => !shape.missingPre?.includes(address)).map(address => balance(address, 'pre')), ...extraBalances('pre')],
      postTokenBalances: [...[...accounts.keys()].map(address => balance(address, 'post')), ...extraBalances('post')],
      innerInstructions: creations.flatMap((creation, position) => creation.noop ? [] : [{ index: creationOffset + position, instructions: [
        { program: 'spl-token', programId: creation.program, parsed: { type: 'getAccountDataSize', info: { mint: creation.mint, extensionTypes: [] } } },
        { program: 'system', programId: SYSTEM_PROGRAM, parsed: { type: 'createAccount', info: { source: creation.source,
          newAccount: creation.account, lamports: creation.lamports, space: 165, owner: creation.program } } },
        { program: 'spl-token', programId: creation.program, parsed: { type: 'initializeImmutableOwner', info: { account: creation.account } } },
        { program: 'spl-token', programId: creation.program, parsed: { type: 'initializeAccount3',
          info: { account: creation.account, mint: creation.mint, owner: creation.owner } } },
      ] }]), logMessages: [] },
  };
}
export interface NativeShape {
  label: string; time: number | null; source?: string; feePayer?: string;
  credits: { destination: string; lamports: number }[];
  extraSigners?: string[]; extraInstructions?: InstructionEvidence[]; computeBudget?: boolean;
  /** Wraps the System transfers as CPIs of an undecoded program, as an on-chain batcher would. */
  wrapper?: string;
  /** A token account this transaction touches, which makes the transaction move tokens. */
  tokenAccount?: { address: string; owner: string; pre: string; post: string };
  /** A lamport movement no instruction accounts for. */
  unexplainedLamports?: { destination: string; lamports: number };
  failed?: boolean;
}
/** A lamport-only payout: parsed System transfers, one funding source, no token movement at all. */
export function nativePayout(shape: NativeShape): FullTransaction {
  const source = shape.source ?? DISTRIBUTOR;
  const feePayer = shape.feePayer ?? source;
  const signers = [...new Set([feePayer, source, ...shape.extraSigners ?? []])];
  const keys: { pubkey: string; signer: boolean; writable: boolean }[] = [];
  const add = (pubkey: string, signer = false, writable = false) => {
    const existing = keys.find(item => item.pubkey === pubkey);
    if (existing) { existing.signer ||= signer; existing.writable ||= writable; } else keys.push({ pubkey, signer, writable });
  };
  for (const signer of signers) add(signer, true, true);
  add(source, false, true);
  for (const credit of shape.credits) add(credit.destination, false, true);
  if (shape.unexplainedLamports) add(shape.unexplainedLamports.destination, false, true);
  if (shape.tokenAccount) { add(shape.tokenAccount.address, false, true); add(MINT); add(SPL_TOKEN_PROGRAM); }
  add(SYSTEM_PROGRAM);
  if (shape.computeBudget !== false) add(COMPUTE_BUDGET_PROGRAM);
  if (shape.wrapper) add(shape.wrapper);
  for (const instruction of shape.extraInstructions ?? []) for (const address of [instruction.programId, ...instruction.accounts ?? []]) add(address);
  const index = (address: string) => keys.findIndex(item => item.pubkey === address);
  const extra = shape.unexplainedLamports;
  const preBalances = keys.map(() => 2039280);
  const postBalances = keys.map(() => 2039280);
  preBalances[index(source)]! += shape.credits.reduce((total, item) => total + item.lamports, 0) + (extra?.lamports ?? 0);
  postBalances[index(feePayer)]! -= 5000;
  for (const move of shape.credits) postBalances[index(move.destination)]! += move.lamports;
  if (extra) postBalances[index(extra.destination)]! += extra.lamports;
  const transfers = shape.credits.map(move => ({ program: 'system', programId: SYSTEM_PROGRAM,
    parsed: { type: 'transfer', info: { source, destination: move.destination, lamports: move.lamports } } }));
  const balance = (phase: 'pre' | 'post') => shape.tokenAccount
    ? [{ accountIndex: index(shape.tokenAccount.address), mint: MINT, owner: shape.tokenAccount.owner, programId: SPL_TOKEN_PROGRAM,
      uiTokenAmount: { amount: shape.tokenAccount[phase], decimals: 6, uiAmount: null } }] : [];
  const signatureLabels = keys.filter(item => item.signer).map((_, position) => position === 0 ? shape.label : `${shape.label}:${position}`);
  return {
    slot: shape.time ?? CUTOFF, blockTime: shape.time, version: 0,
    transaction: { signatures: signatureLabels.map(syntheticSignature), message: { accountKeys: keys, instructions: [
      ...shape.computeBudget !== false ? [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: 'Fj2Eoy' }] : [],
      ...shape.wrapper ? [{ programId: shape.wrapper, accounts: keys.map(item => item.pubkey), data: '2' }] : transfers,
      ...shape.extraInstructions ?? [],
    ] } },
    meta: { err: shape.failed ? { InstructionError: [1, { Custom: 1 }] } : null, fee: 5000, preBalances, postBalances,
      preTokenBalances: balance('pre'), postTokenBalances: balance('post'),
      innerInstructions: shape.wrapper ? [{ index: shape.computeBudget !== false ? 1 : 0, instructions: transfers }] : [],
      logMessages: [] },
  };
}

/** Idempotent associated-account creation for an existing account: an undecoded instruction naming the wallet. */
export function createIdempotent(payer: string, account: string, owner: string, mint: string): InstructionEvidence {
  return { programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [payer, account, owner, mint, '11111111111111111111111111111111', SPL_TOKEN_PROGRAM], data: '2' };
}
/** Exact official rows: one per quote mint, amount equal to the instruction aggregate unless overridden. */
export function officialFeed(tx: FullTransaction, options: { evidenceId?: string; amountRaw?: string; launch?: string; retrievedAt?: string } = {}): DistributionEvidenceInput {
  const signature = tx.transaction.signatures[0]!;
  const retrievedAt = options.retrievedAt ?? iso(CUTOFF);
  const totals = new Map<string, bigint>();
  for (const instruction of tx.transaction.message.instructions) {
    const info = (instruction.parsed as { info?: { mint?: string; tokenAmount?: { amount: string } } } | undefined)?.info;
    if (info?.mint && info.tokenAmount) totals.set(info.mint, (totals.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
  }
  return { network: 'mainnet-beta', provenance: { source: 'fixture', evidenceId: options.evidenceId ?? 'synthetic-official-feed', retrievedAt },
    sources: [{ id: 'source-1', source: 'rewards', endpoint: '/rewards?limit=100', requestedAt: retrievedAt, retrievedAt, attempts: 1, outcome: 'success' }],
    withdrawalAuthorities: [],
    distributions: [{ signature, rows: [...totals].map(([quoteMint, amount]) => ({ sourceIds: ['source-1'], value: {
      signature, mint: options.launch ?? syntheticKey('launch'), quoteMint, amountRaw: options.amountRaw ?? amount.toString(), holderCount: 1, distributedAt: retrievedAt,
    } })) }],
  };
}
/** A successful published LaunchLab configuration read naming `authority` at `observed`. */
export function configurationFeed(authority: string, observed: number, label = 'configuration'): DistributionEvidenceInput {
  const at = iso(observed);
  return { network: 'mainnet-beta', provenance: { source: 'fixture', evidenceId: `${label}-${observed}`, retrievedAt: at }, distributions: [],
    sources: [{ id: 'source-1', source: 'withdrawalConfig', endpoint: `/launchlab/pricing?quoteMint=${WITHDRAW_AUTHORITY_CONFIGURATION_MINT}`,
      requestedAt: at, retrievedAt: at, attempts: 1, outcome: 'success', httpStatus: 200 }],
    withdrawalAuthorities: [{ role: 'withdrawWithheldAuthority', authority, configurationQuoteMint: WITHDRAW_AUTHORITY_CONFIGURATION_MINT, sourceId: 'source-1' }] };
}
