import { z } from 'zod';
import { addressSchema } from '../helius/query.js';
import { fullTransactionSchema } from '../helius/schemas.js';
import { individualCreditIdentity } from './identity.js';
import { recognizeAccountCreation } from './associated-token.js';
import type {
  AccountCreationEvidence, AccountEvidence, EvidenceIssue, InstructionEvidence, InstructionPosition, NormalizationInput,
  NormalizationReason, NormalizedTransaction, NormalizedTransfer, ResolvedEvidence,
} from './types.js';

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const tokenPrograms = new Set([SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const raw = z.string().regex(/^\d+$/).refine(value => /^\d+$/.test(value) && BigInt(value) <= 18446744073709551615n);
const amount = z.object({ amount: raw, decimals: z.number().int().min(0).max(255) });
const transferInfo = z.object({
  source: addressSchema, destination: addressSchema,
  authority: addressSchema.optional(), multisigAuthority: addressSchema.optional(),
  signers: z.array(addressSchema).optional(), mint: addressSchema.optional(),
  amount: raw.optional(), tokenAmount: amount.optional(), feeAmount: amount.optional(),
});
const inputContext = z.object({
  wallet: addressSchema, network: z.enum(['mainnet-beta', 'devnet', 'testnet']),
  provenance: z.object({ source: z.enum(['helius', 'solana-rpc', 'fixture']),
    evidenceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), retrievedAt: z.iso.datetime(),
    commitment: z.enum(['confirmed', 'finalized', 'unknown']),
  }).strict(),
});
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function resolution<T>(observations: ResolvedEvidence<T>['observations']): ResolvedEvidence<T> {
  const values = [...new Set(observations.map(item => item.value))];
  return { status: values.length === 0 ? 'missing' : values.length === 1 ? 'resolved' : 'conflicting',
    value: values.length === 1 ? values[0] ?? null : null, observations };
}
function add<T>(field: ResolvedEvidence<T>, value: T, evidence: string): ResolvedEvidence<T> {
  return resolution([...field.observations, { value, evidence }]);
}
function unique(reasons: NormalizationReason[]): NormalizationReason[] { return [...new Set(reasons)]; }
function label(position: InstructionPosition): string { return `instruction:${position.outer}:${position.inner ?? 'outer'}`; }

/** No I/O, clock, environment, registry, or classification dependencies. */
export function normalizeTransaction(input: NormalizationInput): NormalizedTransaction {
  const context = inputContext.safeParse(input);
  const validated = fullTransactionSchema.safeParse(input.transaction);
  if (!context.success || !validated.success) throw new Error('Invalid normalization input');
  const evidence = validated.data;
  const { wallet, network, provenance } = context.data;
  const signature = evidence.transaction.signatures[0]!;
  const keys = evidence.transaction.message.accountKeys;
  const signers = keys.filter(key => key.signer).map(key => key.pubkey);
  const failedTransaction = evidence.meta.err !== null;
  const walletSigner = signers.includes(wallet);
  const issues: EvidenceIssue[] = [];
  const blockers: NormalizationReason[] = [];
  const block = (reason: NormalizationReason, position?: InstructionPosition) => {
    blockers.push(reason); issues.push(position ? { reason, position } : { reason });
  };
  if (new Set(keys.map(key => key.pubkey)).size !== keys.length) block('duplicate_account_key');
  if (signers.length !== evidence.transaction.signatures.length
    || keys.some(key => key.signer && key.source === 'lookupTable')) block('invalid_signer_metadata');
  if (evidence.meta.innerInstructions === null) block('inner_instructions_unavailable');
  if (failedTransaction) block('failed_transaction');

  const accounts = new Map<string, AccountEvidence>();
  function account(address: string): AccountEvidence {
    let entry = accounts.get(address);
    if (!entry) {
      // jsonParsed keys already include resolved lookup addresses. Never append loadedAddresses.
      const index = keys.findIndex(key => key.pubkey === address);
      entry = { address, accountIndex: index < 0 ? null : index, owner: resolution([]), mint: resolution([]),
        decimals: resolution([]), tokenProgram: resolution([]), pre: [], post: [], balanceChangeRaw: null,
        lifecycle: [], createdInTransaction: false, reconciliation: 'unresolved', reasons: index < 0 ? ['invalid_account_reference'] : [] };
      accounts.set(address, entry);
    }
    return entry;
  }
  for (const phase of ['pre', 'post'] as const) {
    const balances = phase === 'pre' ? evidence.meta.preTokenBalances : evidence.meta.postTokenBalances;
    for (const [index, balance] of balances.entries()) {
      const key = keys[balance.accountIndex];
      if (!key) { block('invalid_account_reference'); continue; }
      const entry = account(key.pubkey);
      const ref = `${phase}TokenBalances:${index}`;
      entry[phase].push(balance);
      entry.mint = add(entry.mint, balance.mint, ref);
      entry.decimals = add(entry.decimals, balance.uiTokenAmount.decimals, ref);
      if (balance.owner) entry.owner = add(entry.owner, balance.owner, ref);
      if (balance.programId) entry.tokenProgram = add(entry.tokenProgram, balance.programId, ref);
      if (!raw.safeParse(balance.uiTokenAmount.amount).success) entry.reasons.push('conflicting_balance');
    }
  }

  const positioned: { position: InstructionPosition; instruction: InstructionEvidence }[] = [];
  const outer = evidence.transaction.message.instructions;
  outer.forEach((instruction, index) => positioned.push({ position: { outer: index, inner: null }, instruction }));
  const innerGroups = new Set<number>();
  for (const group of evidence.meta.innerInstructions ?? []) {
    if (innerGroups.has(group.index)) block('duplicate_instruction_position', { outer: group.index, inner: null });
    innerGroups.add(group.index);
    if (!outer[group.index]) block('invalid_instruction_position', { outer: group.index, inner: null });
    group.instructions.forEach((instruction, index) => positioned.push({ position: { outer: group.index, inner: index }, instruction }));
  }
  positioned.sort((a, b) => a.position.outer - b.position.outer || (a.position.inner ?? -1) - (b.position.inner ?? -1));
  // One recognized associated-token-account creation unit per outer position, cross-checked against
  // its own complete CPI list. Recognition removes only the two account-shape blockers below; every
  // other blocker in the transaction still applies, and no address is derived.
  const innerLists = new Map<number, InstructionEvidence[] | null>();
  for (const group of evidence.meta.innerInstructions ?? []) {
    innerLists.set(group.index, innerLists.has(group.index) ? null : [...group.instructions]);
  }
  const accountCreations: AccountCreationEvidence[] = [];
  if (evidence.meta.innerInstructions !== null) {
    outer.forEach((instruction, index) => {
      const recognized = recognizeAccountCreation(instruction, index, innerLists.get(index) ?? (innerLists.has(index) ? null : []), tokenPrograms);
      if (recognized) accountCreations.push(recognized);
    });
  }
  const supportPositions = new Set(accountCreations.flatMap(item => item.created
    ? [label(item.created.dataSize), label(item.created.immutableOwner)] : []));
  const createdAccounts = new Map<string, AccountCreationEvidence[]>();
  for (const item of accountCreations) {
    if (item.created) createdAccounts.set(item.account, [...createdAccounts.get(item.account) ?? [], item]);
  }
  const transfers: NormalizedTransfer[] = [];
  for (const { position, instruction } of positioned) {
    if (![instruction.programId, ...(instruction.accounts ?? [])].every(address => keys.some(key => key.pubkey === address))) {
      block('invalid_account_reference', position);
    }
    const parsed = object(instruction.parsed);
    const info = object(parsed.info);
    const type = parsed.type;
    if (!tokenPrograms.has(instruction.programId)) {
      if (instruction.program === 'spl-token' || instruction.program === 'spl-token-2022'
        || type === 'transferChecked' || type === 'transferCheckedWithFee') block('unsupported_program', position);
      else issues.push({ reason: 'uninterpreted_instruction', position });
      continue;
    }
    // Pure account-shape operations at their exact positions inside a recognized creation unit: no
    // balance change, no owner and no mint observation. Accepted nowhere else and for nothing else.
    if (supportPositions.has(label(position))) continue;
    if (type === 'initializeAccount' || type === 'initializeAccount2' || type === 'initializeAccount3' || type === 'closeAccount') {
      const address = addressSchema.safeParse(info.account);
      if (!address.success) { block('unsupported_token_instruction', position); continue; }
      const entry = account(address.data);
      entry.lifecycle.push({ type, position });
      entry.tokenProgram = add(entry.tokenProgram, instruction.programId, label(position));
      if (type !== 'closeAccount') {
        const init = z.object({ mint: addressSchema, owner: addressSchema }).safeParse(info);
        if (!init.success) block('unsupported_token_instruction', position);
        else {
          entry.owner = add(entry.owner, init.data.owner, label(position));
          entry.mint = add(entry.mint, init.data.mint, label(position));
        }
      }
      continue;
    }
    if (type !== 'transfer' && type !== 'transferChecked' && type !== 'transferCheckedWithFee') {
      block('unsupported_token_instruction', position); continue;
    }
    const parsedInfo = transferInfo.safeParse(info);
    if (!parsedInfo.success) { block('invalid_transfer_evidence', position); continue; }
    const data = parsedInfo.data;
    const checked = type !== 'transfer';
    const fee = type === 'transferCheckedWithFee';
    if ((data.authority === undefined) === (data.multisigAuthority === undefined)
      || (data.multisigAuthority !== undefined && !data.signers?.length)
      || (data.authority !== undefined && data.signers !== undefined)
      || (checked && (!data.mint || !data.tokenAmount || data.amount !== undefined))
      || (!checked && (data.amount === undefined || data.tokenAmount !== undefined || data.mint !== undefined))
      || (fee && (instruction.programId !== TOKEN_2022_PROGRAM || !data.feeAmount
        || data.feeAmount.decimals !== data.tokenAmount?.decimals
        || BigInt(data.feeAmount.amount) > BigInt(data.tokenAmount.amount)))
      || (!fee && data.feeAmount !== undefined)) {
      block('invalid_transfer_evidence', position); continue;
    }
    const authority = data.authority ?? data.multisigAuthority!;
    const references = [data.source, data.destination, authority, ...(data.signers ?? []), ...(data.mint ? [data.mint] : [])];
    const reasons: NormalizationReason[] = references.every(address => keys.some(key => key.pubkey === address))
      ? [] : ['invalid_account_reference'];
    for (const address of [data.source, data.destination]) {
      const entry = account(address);
      entry.tokenProgram = add(entry.tokenProgram, instruction.programId, label(position));
      if (data.mint) entry.mint = add(entry.mint, data.mint, label(position));
      if (data.tokenAmount) entry.decimals = add(entry.decimals, data.tokenAmount.decimals, label(position));
    }
    transfers.push({ identity: individualCreditIdentity(network, signature, position), identityVersion: 1, position,
      recipientOrdinal: 0, programId: instruction.programId, instructionType: type,
      source: data.source, destination: data.destination, authority,
      authorityKind: data.authority ? 'single' : 'multisig', instructionSigners: data.signers ?? [],
      mint: resolution([]), decimals: resolution([]), sourceOwner: resolution([]), destinationOwner: resolution([]),
      grossAmountRaw: checked ? data.tokenAmount!.amount : data.amount!, explicitFeeRaw: data.feeAmount?.amount ?? null,
      netCreditRaw: null, netCreditBasis: null,
      flags: { failedTransaction, walletSigner, sameAccount: data.source === data.destination,
        selfTransfer: null, walletDirection: 'unknown' }, reasons, evidence: instruction });
  }

  // Decimals and token program are properties of a mint, including evidence on other accounts.
  const mintFacts = new Map<string, { decimals: ResolvedEvidence<number>; program: ResolvedEvidence<string> }>();
  for (const entry of accounts.values()) {
    if (entry.mint.value === null) continue;
    const facts = mintFacts.get(entry.mint.value) ?? { decimals: resolution<number>([]), program: resolution<string>([]) };
    facts.decimals = resolution([...facts.decimals.observations, ...entry.decimals.observations]);
    facts.program = resolution([...facts.program.observations, ...entry.tokenProgram.observations]);
    mintFacts.set(entry.mint.value, facts);
  }
  for (const entry of accounts.values()) {
    const facts = entry.mint.value === null ? undefined : mintFacts.get(entry.mint.value);
    if (facts) { entry.decimals = facts.decimals; entry.tokenProgram = facts.program; }
  }
  for (const entry of accounts.values()) {
    for (const field of ['owner', 'mint', 'decimals'] as const) {
      if (entry[field].status !== 'resolved') entry.reasons.push(`${entry[field].status}_${field}` as NormalizationReason);
    }
    if (entry.tokenProgram.status === 'conflicting'
      || (entry.tokenProgram.value !== null && !tokenPrograms.has(entry.tokenProgram.value))) entry.reasons.push('conflicting_token_program');
    // An address allocated by a recognized unit's own `system createAccount` did not exist before this
    // transaction, so it held no tokens. A pre row, or two creations, is a contradiction, not a choice.
    const creations = createdAccounts.get(entry.address) ?? [];
    if (creations.length === 1 && entry.pre.length === 0) entry.createdInTransaction = true;
    else if (creations.length > 0) entry.reasons.push('conflicting_balance');
    if (!entry.pre.length && !entry.createdInTransaction) entry.reasons.push('missing_pre_balance');
    if (!entry.post.length) entry.reasons.push('missing_post_balance');
    if (entry.pre.length > 1 || entry.post.length > 1) entry.reasons.push('conflicting_balance');
    // A recognized creation has one lifetime beginning here, so there is no epoch to split. Any other
    // lifecycle entry on the account, including a closure, restores the block.
    const creation = entry.createdInTransaction ? creations[0]!.created! : null;
    const onlyRecognizedCreation = creation !== null && entry.lifecycle.length === 1
      && entry.lifecycle[0]!.type === 'initializeAccount3'
      && label(entry.lifecycle[0]!.position) === label(creation.initialization);
    if (entry.lifecycle.length && !onlyRecognizedCreation) entry.reasons.push('account_lifecycle');
    const pre = entry.pre.length === 1 ? BigInt(entry.pre[0]!.uiTokenAmount.amount)
      : entry.createdInTransaction && entry.pre.length === 0 ? 0n : null;
    if (pre !== null && entry.post.length === 1 && !entry.reasons.includes('conflicting_balance')
      && entry.mint.status === 'resolved' && entry.decimals.status === 'resolved' && !entry.reasons.includes('conflicting_token_program')) {
      entry.balanceChangeRaw = (BigInt(entry.post[0]!.uiTokenAmount.amount) - pre).toString();
    }
  }
  for (const transfer of transfers) {
    const source = account(transfer.source), destination = account(transfer.destination);
    transfer.mint = resolution([...source.mint.observations, ...destination.mint.observations]);
    transfer.decimals = resolution([...source.decimals.observations, ...destination.decimals.observations]);
    transfer.sourceOwner = source.owner;
    transfer.destinationOwner = destination.owner;
    const sourceOwned = source.owner.value === wallet, destinationOwned = destination.owner.value === wallet;
    const ownersKnown = source.owner.status === 'resolved' && destination.owner.status === 'resolved'
      && !source.reasons.includes('account_lifecycle') && !destination.reasons.includes('account_lifecycle')
      && !blockers.includes('unsupported_token_instruction');
    transfer.flags.selfTransfer = ownersKnown ? sourceOwned && destinationOwned : null;
    transfer.flags.walletDirection = !ownersKnown ? 'unknown' : sourceOwned && destinationOwned ? 'self'
      : destinationOwned ? 'incoming' : sourceOwned ? 'outgoing' : 'unrelated';
    for (const field of ['mint', 'decimals'] as const) {
      if (transfer[field].status !== 'resolved') transfer.reasons.push(`${transfer[field].status}_${field}` as NormalizationReason);
    }
    for (const entry of [source, destination]) {
      transfer.reasons.push(...entry.reasons.filter(reason => !['missing_pre_balance', 'missing_post_balance'].includes(reason)));
    }
  }

  const proposed = new Map<NormalizedTransfer, { amount: bigint; basis: NormalizedTransfer['netCreditBasis'] }>();
  for (const entry of accounts.values()) {
    const touching = transfers.filter(transfer => transfer.source === entry.address || transfer.destination === entry.address);
    // Unknown token operations can alter balances/owners. Fail closed across the transaction.
    const invalid = touching.some(transfer => transfer.reasons.some(reason => reason !== 'missing_owner'));
    if (blockers.length || entry.reasons.some(reason => reason !== 'missing_owner') || invalid || entry.balanceChangeRaw === null) {
      entry.reasons.push('reconciliation_blocked'); continue;
    }
    const incoming = touching.filter(transfer => transfer.destination === entry.address && !transfer.flags.sameAccount);
    const outgoing = touching.filter(transfer => transfer.source === entry.address && !transfer.flags.sameAccount);
    const debit = outgoing.reduce((sum, transfer) => sum + BigInt(transfer.grossAmountRaw), 0n);
    const known = incoming.filter(transfer => transfer.programId === SPL_TOKEN_PROGRAM || transfer.explicitFeeRaw !== null);
    const unknown = incoming.filter(transfer => !known.includes(transfer));
    const knownNet = (transfer: NormalizedTransfer) => BigInt(transfer.grossAmountRaw) - BigInt(transfer.explicitFeeRaw ?? '0');
    const residual = BigInt(entry.balanceChangeRaw) + debit - known.reduce((sum, transfer) => sum + knownNet(transfer), 0n);
    const maximum = unknown.reduce((sum, transfer) => sum + BigInt(transfer.grossAmountRaw), 0n);
    if (residual < 0n || residual > maximum) { entry.reasons.push('unexplained_balance_change'); continue; }
    if (unknown.length > 1 && residual !== 0n && residual !== maximum) {
      entry.reasons.push('ambiguous_fee_allocation'); continue;
    }
    entry.reconciliation = 'matched';
    known.forEach(transfer => proposed.set(transfer, { amount: knownNet(transfer), basis: 'instruction_and_balances' }));
    unknown.forEach(transfer => proposed.set(transfer, {
      amount: unknown.length === 1 ? residual : residual === 0n ? 0n : BigInt(transfer.grossAmountRaw),
      basis: 'unique_balance_reconciliation',
    }));
  }
  for (const transfer of transfers) {
    const source = account(transfer.source), destination = account(transfer.destination);
    transfer.reasons.push(...blockers, ...source.reasons, ...destination.reasons);
    if (transfer.flags.sameAccount) transfer.reasons.push('same_account_transfer');
    // A contradictory source delta also invalidates the proposed receipt.
    if (source.reconciliation !== 'matched') transfer.reasons.push('reconciliation_blocked');
    const proof = proposed.get(transfer);
    if (proof && !transfer.reasons.length && destination.owner.status === 'resolved') {
      transfer.netCreditRaw = proof.amount.toString(); transfer.netCreditBasis = proof.basis;
    }
    transfer.reasons = unique(transfer.reasons);
    for (const reason of transfer.reasons) issues.push({ reason, position: transfer.position });
  }
  for (const entry of accounts.values()) {
    entry.reasons = unique(entry.reasons);
    for (const reason of entry.reasons) issues.push({ reason, account: entry.address });
  }
  return { normalizationVersion: 2, identityVersion: 1, network, wallet, signature, provenance,
    signers, failedTransaction, walletSigner, transfers, accounts: [...accounts.values()], accountCreations, issues,
    evidence, classification: 'not_performed' };
}
