import { describe, expect, it, vi } from 'vitest';
import {
  groupCreditIdentities, individualCreditIdentity, normalizeTransaction, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
} from '../src/index.js';
import type { NormalizationInput, NormalizationReason } from '../src/index.js';
import { SYSTEM_PROGRAM } from '../src/normalization/associated-token.js';
import type { InstructionEvidence } from '../src/normalization/types.js';
import {
  addCreation, addKey, creationCpis, fixture, key, setBalance, signature, token2022Fixture, transfer, wrapper,
} from './fixtures/normalization.js';

function normalized(input = fixture()) { return normalizeTransaction(input); }
function expectUnresolved(input: NormalizationInput, reason: NormalizationReason) {
  const result = normalized(input);
  expect(result.transfers.every(item => item.netCreditRaw === null)).toBe(true);
  expect(result.issues.some(item => item.reason === reason)).toBe(true);
  return result;
}
function balances(input: NormalizationInput, address = key.recipient) {
  const index = input.transaction.transaction.message.accountKeys.findIndex(item => item.pubkey === address);
  return [...input.transaction.meta.preTokenBalances, ...input.transaction.meta.postTokenBalances]
    .filter(item => item.accountIndex === index);
}
function info(input: NormalizationInput, index = 0) {
  return parsedInfo(input.transaction.transaction.message.instructions[index]!);
}
function parsedInfo(instruction: InstructionEvidence) {
  return (instruction.parsed as { info: Record<string, unknown> }).info;
}

describe('parsed token normalization', () => {
  it('keeps account deltas, gross amounts, and per-instruction credits distinct', () => {
    const result = normalized();
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({ grossAmountRaw: '100', netCreditRaw: '100',
      netCreditBasis: 'instruction_and_balances', mint: { value: key.mint }, decimals: { value: 6 },
      sourceOwner: { value: key.otherOwner }, destinationOwner: { value: key.wallet },
      authority: key.authority, authorityKind: 'single', reasons: [], flags: {
        walletSigner: false, selfTransfer: false, failedTransaction: false, walletDirection: 'incoming',
      } });
    expect(result.accounts.find(item => item.address === key.recipient)?.balanceChangeRaw).toBe('100');
    expect(result.accounts.find(item => item.address === key.source)?.balanceChangeRaw).toBe('-100');
    expect(result.classification).toBe('not_performed');
  });

  it('preserves outer/inner positions, multiple recipients, and identical-looking credits', () => {
    const input = fixture();
    input.transaction.transaction.message.instructions = [transfer(), wrapper()];
    input.transaction.meta.innerInstructions = [{ index: 1, instructions: [
      transfer(), transfer('50', key.source, key.recipientB),
    ] }];
    input.transaction.meta.innerInstructions[0]!.instructions[0]!.stackHeight = 2;
    input.transaction.meta.innerInstructions[0]!.instructions[1]!.stackHeight = 3;
    setBalance(input, key.source, 'post', '750'); setBalance(input, key.recipient, 'post', '300');
    setBalance(input, key.recipientB, 'post', '50');
    const result = normalized(input);
    expect(result.transfers.map(item => item.position)).toEqual([
      { outer: 0, inner: null }, { outer: 1, inner: 0 }, { outer: 1, inner: 1 },
    ]);
    expect(result.transfers.map(item => item.netCreditRaw)).toEqual(['100', '100', '50']);
    expect(new Set(result.transfers.map(item => item.identity)).size).toBe(3);
    expect(result.transfers[2]?.evidence.stackHeight).toBe(3);
    expect(result.accounts.find(item => item.address === key.recipient)?.balanceChangeRaw).toBe('200');
  });

  it('does not collapse two identical transfers at different outer positions', () => {
    const input = fixture(); input.transaction.transaction.message.instructions.push(transfer());
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '300');
    const result = normalized(input);
    expect(result.transfers.map(item => item.netCreditRaw)).toEqual(['100', '100']);
    expect(result.transfers[0]?.identity).not.toBe(result.transfers[1]?.identity);
  });

  it('uses expanded jsonParsed lookup keys once, including noncontiguous token accounts', () => {
    const input = fixture(); const message = input.transaction.transaction.message;
    // Move both token recipients to the expanded lookup section without changing addresses.
    const staticKeys = message.accountKeys.filter(item => ![key.recipient, key.recipientB].includes(item.pubkey));
    message.accountKeys = [...staticKeys, ...[key.recipient, key.recipientB].map(pubkey => ({ pubkey, signer: false, writable: true, source: 'lookupTable' }))];
    for (const balance of [...input.transaction.meta.preTokenBalances, ...input.transaction.meta.postTokenBalances]) {
      const address = [key.authority, key.source, key.recipient, key.recipientB, key.sink][balance.accountIndex]!;
      balance.accountIndex = message.accountKeys.findIndex(item => item.pubkey === address);
    }
    message.addressTableLookups = [{ accountKey: 'F'.repeat(32), writableIndexes: [9, 17], readonlyIndexes: [] }];
    input.transaction.meta.loadedAddresses = { writable: [key.recipient, key.recipientB], readonly: [] };
    expect(normalized(input).transfers[0]?.netCreditRaw).toBe('100');
    // This index would become valid only if loaded addresses were erroneously appended again.
    const outOfBounds = structuredClone(input.transaction.meta.postTokenBalances[1]!);
    outOfBounds.accountIndex = message.accountKeys.length;
    input.transaction.meta.postTokenBalances.push(outOfBounds);
    expectUnresolved(input, 'invalid_account_reference');
  });

  it('keeps exact u64-scale raw strings and ignores every UI amount', () => {
    const input = fixture(); const huge = '09007199254740993001';
    input.transaction.transaction.message.instructions = [transfer(huge)];
    setBalance(input, key.source, 'pre', '18446744073709551615');
    setBalance(input, key.source, 'post', '9439544818968558614');
    setBalance(input, key.recipient, 'pre', '000000'); setBalance(input, key.recipient, 'post', huge);
    for (const balance of [...input.transaction.meta.preTokenBalances, ...input.transaction.meta.postTokenBalances]) {
      balance.uiTokenAmount.decimals = 18; balance.uiTokenAmount.uiAmount = 0.123;
    }
    info(input).tokenAmount = { amount: huge, decimals: 18, uiAmount: 9007199254740992, uiAmountString: 'wrong' };
    const result = normalized(input);
    expect(result.transfers[0]).toMatchObject({ grossAmountRaw: huge, netCreditRaw: '9007199254740993001', decimals: { value: 18 } });
    expect(result.accounts.find(item => item.address === key.recipient)?.post[0]?.uiTokenAmount.amount).toBe(huge);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('resolves unchecked transfer mint/decimals from balance evidence', () => {
    const input = fixture();
    input.transaction.transaction.message.instructions = [{ programId: SPL_TOKEN_PROGRAM, parsed: {
      type: 'transfer', info: { source: key.source, destination: key.recipient, authority: key.authority, amount: '00100' },
    } }];
    expect(normalized(input).transfers[0]).toMatchObject({ grossAmountRaw: '00100', netCreditRaw: '100', mint: { value: key.mint } });
  });

  it('does not treat the parsed program label as the program identity', () => {
    const input = fixture(); input.transaction.transaction.message.instructions[0]!.programId = key.router;
    expect(expectUnresolved(input, 'unsupported_program').transfers).toHaveLength(0);
    const valid = token2022Fixture('3');
    valid.transaction.transaction.message.instructions[0]!.program = 'spl-token';
    expect(normalized(valid).transfers[0]?.netCreditRaw).toBe('97');
  });

  it('preserves multisig authority and instruction signers independently of transaction signers', () => {
    const input = fixture(); delete info(input).authority;
    Object.assign(info(input), { multisigAuthority: key.multisig, signers: [key.authority, key.cosigner] });
    input.transaction.transaction.message.accountKeys.find(item => item.pubkey === key.cosigner)!.signer = true;
    input.transaction.transaction.signatures.push('4'.repeat(88));
    const result = normalized(input);
    expect(result.signers).toEqual([key.authority, key.cosigner]);
    expect(result.transfers[0]).toMatchObject({ authority: key.multisig, authorityKind: 'multisig',
      instructionSigners: [key.authority, key.cosigner], netCreditRaw: '100' });
  });

  it('is deterministic, does not mutate input, and does not read the clock or fetch', () => {
    const input = fixture(); const before = JSON.stringify(input);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Clock forbidden'); });
    expect(normalized(input)).toEqual(normalized(input));
    expect(JSON.stringify(input)).toBe(before); expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
  });
});

describe('ownership, lifecycle, and structural uncertainty', () => {
  it('never assumes a receiving account belongs to the wallet', () => {
    const input = fixture(); balances(input).forEach(balance => { balance.owner = key.otherOwner; });
    expect(normalized(input).transfers[0]).toMatchObject({ destinationOwner: { value: key.otherOwner }, flags: { walletDirection: 'unrelated' } });
    balances(input).forEach(balance => { delete balance.owner; });
    expect(expectUnresolved(input, 'missing_owner').transfers[0]?.destinationOwner.status).toBe('missing');
  });

  it('preserves pre/post ownership contradictions', () => {
    const input = fixture(); balances(input)[1]!.owner = key.otherOwner;
    const result = expectUnresolved(input, 'conflicting_owner');
    expect(result.transfers[0]?.destinationOwner).toMatchObject({ status: 'conflicting', value: null });
    expect(result.transfers[0]?.flags.walletDirection).toBe('unknown');
  });

  it.each(['pre', 'post'] as const)('does not substitute zero for a missing %s balance', phase => {
    const input = fixture(); setBalance(input, key.recipient, phase, null);
    const result = expectUnresolved(input, phase === 'pre' ? 'missing_pre_balance' : 'missing_post_balance');
    expect(result.accounts.find(item => item.address === key.recipient)?.balanceChangeRaw).toBeNull();
  });

  it('records initializeAccount ownership without inventing a pre-balance', () => {
    const input = fixture(); setBalance(input, key.recipient, 'pre', null);
    balances(input).forEach(balance => { delete balance.owner; });
    input.transaction.transaction.message.instructions.unshift({ programId: SPL_TOKEN_PROGRAM, parsed: {
      type: 'initializeAccount3', info: { account: key.recipient, mint: key.mint, owner: key.wallet },
    } });
    const result = expectUnresolved(input, 'missing_pre_balance');
    expect(result.transfers[0]?.destinationOwner.value).toBe(key.wallet);
    expect(result.accounts.find(item => item.address === key.recipient)?.lifecycle[0]?.type).toBe('initializeAccount3');
    expect(result.transfers[0]?.reasons).toContain('account_lifecycle');
  });

  it('does not interpret a closure authority or lamport recipient as token ownership', () => {
    const input = fixture(); setBalance(input, key.recipient, 'post', null);
    balances(input).forEach(balance => { delete balance.owner; });
    input.transaction.transaction.message.instructions.push({ programId: SPL_TOKEN_PROGRAM, parsed: {
      type: 'closeAccount', info: { account: key.recipient, destination: key.wallet, owner: key.wallet },
    } });
    const result = expectUnresolved(input, 'account_lifecycle');
    expect(result.transfers[0]?.destinationOwner.status).toBe('missing');
    expect(result.transfers[0]?.reasons).toContain('missing_post_balance');
  });

  it('retains a close/reinitialize ownership conflict without selecting an account epoch', () => {
    const input = fixture(); input.transaction.transaction.message.instructions.push(
      { programId: SPL_TOKEN_PROGRAM, parsed: { type: 'closeAccount', info: { account: key.recipient, destination: key.wallet, owner: key.wallet } } },
      { programId: SPL_TOKEN_PROGRAM, parsed: { type: 'initializeAccount3', info: { account: key.recipient, mint: key.mint, owner: key.otherOwner } } },
    );
    expectUnresolved(input, 'conflicting_owner');
  });

  it.each(['mint', 'decimals', 'program'] as const)('preserves conflicting %s evidence', field => {
    const input = fixture(); const balance = balances(input)[1]!;
    if (field === 'mint') balance.mint = key.otherMint;
    if (field === 'decimals') balance.uiTokenAmount.decimals = 9;
    if (field === 'program') balance.programId = TOKEN_2022_PROGRAM;
    expectUnresolved(input, field === 'program' ? 'conflicting_token_program' : `conflicting_${field}`);
  });

  it('keeps mint/decimals missing for unchecked transfers with no balances', () => {
    const input = fixture(); input.transaction.meta.preTokenBalances = []; input.transaction.meta.postTokenBalances = [];
    input.transaction.transaction.message.instructions = [{ programId: SPL_TOKEN_PROGRAM, parsed: {
      type: 'transfer', info: { source: key.source, destination: key.recipient, amount: '100', authority: key.authority },
    } }];
    const result = expectUnresolved(input, 'missing_mint');
    expect(result.transfers[0]?.reasons).toContain('missing_decimals');
  });

  it('rejects contradictory checked metadata from source and destination', () => {
    const input = fixture(); balances(input, key.source).forEach(balance => { balance.mint = key.otherMint; });
    expectUnresolved(input, 'conflicting_mint');
  });

  it('rejects duplicate balance entries rather than selecting or summing them', () => {
    const input = fixture(); input.transaction.meta.postTokenBalances.push(structuredClone(balances(input)[1]!));
    expectUnresolved(input, 'conflicting_balance');
  });

  it('rejects references absent from parsed account keys', () => {
    const input = fixture(); info(input).destination = 'G'.repeat(32);
    expectUnresolved(input, 'invalid_account_reference');
  });

  it('does not append lookup data to repair absent parsed keys', () => {
    const input = fixture(); input.transaction.meta.loadedAddresses = { writable: ['G'.repeat(32)], readonly: [] };
    info(input).destination = 'G'.repeat(32);
    expectUnresolved(input, 'invalid_account_reference');
  });

  it('blocks duplicate account keys and inconsistent signer metadata', () => {
    const input = fixture(); input.transaction.transaction.message.accountKeys.push(structuredClone(input.transaction.transaction.message.accountKeys[1]!));
    expectUnresolved(input, 'duplicate_account_key');
    const other = fixture(); other.transaction.transaction.message.accountKeys[0]!.source = 'lookupTable';
    expectUnresolved(other, 'invalid_signer_metadata');
  });

  it('preserves missing inner recording and invalid outer references', () => {
    const input = fixture(); input.transaction.meta.innerInstructions = null;
    expectUnresolved(input, 'inner_instructions_unavailable');
    input.transaction.meta.innerInstructions = [{ index: 4, instructions: [transfer()] }];
    expectUnresolved(input, 'invalid_instruction_position');
  });
});

describe('movements and Token-2022 fee reconciliation', () => {
  it('reconciles incoming and outgoing transfers without allocating the account delta to either', () => {
    const input = fixture(); input.transaction.transaction.message.instructions.push(transfer('40', key.recipient, key.sink));
    setBalance(input, key.recipient, 'post', '160'); setBalance(input, key.sink, 'post', '40');
    const result = normalized(input);
    expect(result.transfers.map(item => item.netCreditRaw)).toEqual(['100', '40']);
    expect(result.transfers.map(item => item.flags.walletDirection)).toEqual(['incoming', 'outgoing']);
    expect(result.accounts.find(item => item.address === key.recipient)?.balanceChangeRaw).toBe('60');
  });

  it('preserves self-transfers between two accounts owned by the wallet', () => {
    const input = fixture(); balances(input, key.source).forEach(balance => { balance.owner = key.wallet; });
    expect(normalized(input).transfers[0]).toMatchObject({ netCreditRaw: '100', flags: { selfTransfer: true, walletDirection: 'self' } });
  });

  it('never turns a same-account transfer instruction into a credit', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [transfer('100', key.recipient, key.recipient)];
    setBalance(input, key.source, 'post', '1000'); setBalance(input, key.recipient, 'post', '100');
    expect(expectUnresolved(input, 'same_account_transfer').transfers[0]?.flags.sameAccount).toBe(true);
  });

  it('preserves the wallet-signer flag without classifying rewards', () => {
    const input = fixture(); input.transaction.transaction.message.accountKeys.find(item => item.pubkey === key.wallet)!.signer = true;
    input.transaction.transaction.signatures.push('4'.repeat(88));
    expect(normalized(input).transfers[0]).toMatchObject({ netCreditRaw: '100', flags: { walletSigner: true } });
  });

  it('preserves failed-transaction instructions but proves no credit', () => {
    const input = fixture(); input.transaction.meta.err = { InstructionError: [0, { Custom: 1 }] };
    const result = expectUnresolved(input, 'failed_transaction');
    expect(result.failedTransaction).toBe(true); expect(result.transfers[0]?.grossAmountRaw).toBe('100');
  });

  it('uses explicit feeAmount evidence only with matching balances', () => {
    const input = token2022Fixture('003');
    expect(normalized(input).transfers[0]).toMatchObject({ grossAmountRaw: '100', explicitFeeRaw: '003', netCreditRaw: '97', netCreditBasis: 'instruction_and_balances' });
    setBalance(input, key.recipient, 'post', '198'); expectUnresolved(input, 'unexplained_balance_change');
  });

  it('solves one unknown Token-2022 net credit from the complete account equation', () => {
    const input = token2022Fixture();
    expect(normalized(input).transfers[0]).toMatchObject({ netCreditRaw: '97', explicitFeeRaw: null, netCreditBasis: 'unique_balance_reconciliation' });
    input.transaction.transaction.message.instructions.push(transfer('40', key.recipient, key.sink, TOKEN_2022_PROGRAM, '1'));
    setBalance(input, key.recipient, 'post', '157'); setBalance(input, key.sink, 'post', '39');
    expect(normalized(input).transfers.map(item => item.netCreditRaw)).toEqual(['97', '39']);
  });

  it('preserves ambiguous per-transfer fee allocation', () => {
    const input = token2022Fixture(); input.transaction.transaction.message.instructions.push(transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM));
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '294');
    const result = expectUnresolved(input, 'ambiguous_fee_allocation');
    expect(result.transfers).toHaveLength(2);
    expect(result.accounts.find(item => item.address === key.recipient)?.balanceChangeRaw).toBe('194');
  });

  it.each(['0', '200'])('handles uniquely forced unknown-fee endpoints %s', net => {
    const input = token2022Fixture(); input.transaction.transaction.message.instructions.push(transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM));
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', (100n + BigInt(net)).toString());
    expect(normalized(input).transfers.map(item => item.netCreditRaw)).toEqual(net === '0' ? ['0', '0'] : ['100', '100']);
  });

  it('preserves separate explicit fees in a shared recipient account', () => {
    const input = token2022Fixture('3'); input.transaction.transaction.message.instructions.push(transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM, '2'));
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '295');
    expect(normalized(input).transfers.map(item => item.netCreditRaw)).toEqual(['97', '98']);
  });

  it('reconciles a mix of explicit and unknown fees without duplicating net amounts', () => {
    const input = token2022Fixture('3'); input.transaction.transaction.message.instructions.push(transfer('100', key.source, key.recipient, TOKEN_2022_PROGRAM));
    setBalance(input, key.source, 'post', '800'); setBalance(input, key.recipient, 'post', '294');
    expect(normalized(input).transfers.map(item => item.netCreditRaw)).toEqual(['97', '97']);
  });

  it.each(['99', '201'])('does not invent a fee for an impossible net balance %s', post => {
    const input = token2022Fixture(); setBalance(input, key.recipient, 'post', post);
    expectUnresolved(input, 'unexplained_balance_change');
  });

  it('requires source reconciliation too', () => {
    const input = fixture(); setBalance(input, key.source, 'post', '950');
    expectUnresolved(input, 'unexplained_balance_change');
  });

  it('reports unexplained credits without creating a synthetic instruction identity', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [];
    const result = expectUnresolved(input, 'unexplained_balance_change'); expect(result.transfers).toEqual([]);
  });

  it.each(['mintTo', 'burn', 'syncNative', 'setAuthority', 'withdrawWithheldTokensFromAccounts', 'harvestWithheldTokensToMint', 'futureExtension'])('retains unsupported %s and blocks invented credits', type => {
    const input = token2022Fixture(); input.transaction.transaction.message.instructions.push({ programId: TOKEN_2022_PROGRAM,
      parsed: { type, info: { account: key.recipient, feeRecipient: key.recipient, amount: '3' } } });
    const result = expectUnresolved(input, 'unsupported_token_instruction');
    expect(result.evidence.transaction.message.instructions).toHaveLength(2);
  });

  it('retains partially decoded token instructions as unsupported evidence', () => {
    const input = fixture(); input.transaction.transaction.message.instructions.push({ programId: SPL_TOKEN_PROGRAM, accounts: [key.source, key.recipient], data: '3Bxs4' });
    expectUnresolved(input, 'unsupported_token_instruction');
  });

  it.each(['-1', '1.5', 'bogus', '18446744073709551616'])('rejects invalid fee evidence %s safely', fee => {
    const input = token2022Fixture(fee); expectUnresolved(input, 'invalid_transfer_evidence');
  });

  it.each(['greater', 'decimals', 'classic', 'authority', 'numeric'])('rejects conflicting transfer evidence: %s', variation => {
    const input = token2022Fixture('3');
    if (variation === 'greater') info(input).feeAmount = { amount: '101', decimals: 6 };
    if (variation === 'decimals') info(input).feeAmount = { amount: '3', decimals: 9 };
    if (variation === 'classic') input.transaction.transaction.message.instructions[0]!.programId = SPL_TOKEN_PROGRAM;
    if (variation === 'authority') info(input).multisigAuthority = key.multisig;
    if (variation === 'numeric') info(input).feeAmount = { amount: 3, decimals: 6 };
    expectUnresolved(input, 'invalid_transfer_evidence');
  });
});

describe('versioned individual-credit identities and conflicts', () => {
  it('has a fixed v1 identity independent of enrichment and retrieval metadata', () => {
    const input = fixture(); const first = normalized(input);
    expect(first.transfers[0]?.identity).toBe(JSON.stringify(['solana-token-credit', 1, 'mainnet-beta', signature, 0, null, 0]));
    input.provenance.retrievedAt = '2026-09-22T03:00:00Z'; input.transaction.metadata = { symbol: 'TEST' };
    expect(normalized(input).transfers[0]?.identity).toBe(first.transfers[0]?.identity);
    expect(individualCreditIdentity('devnet', signature, { outer: 0, inner: null })).not.toBe(first.transfers[0]?.identity);
    expect(individualCreditIdentity('mainnet-beta', signature, { outer: 0, inner: 0 })).not.toBe(first.transfers[0]?.identity);
    expect(individualCreditIdentity('mainnet-beta', signature, { outer: 0, inner: null }, 1)).not.toBe(first.transfers[0]?.identity);
  });

  it('groups repeat observations without discarding either provenance or adding amounts', () => {
    const input = fixture(); const first = normalized(input);
    input.provenance = { source: 'solana-rpc', evidenceId: 'second-observation',
      retrievedAt: '2026-09-22T03:00:00Z', commitment: 'confirmed' };
    const second = normalized(input); const groups = groupCreditIdentities([first, second]);
    expect(groups).toHaveLength(1); expect(groups[0]?.status).toBe('repeated');
    expect(groups[0]?.observations.map(item => item.resultIndex)).toEqual([0, 1]);
    expect(groups[0]?.missingTransferObservations).toEqual([]);
    expect(first.provenance.evidenceId).toBe('normalization-fixture-1');
  });

  describe.each([
    'unsupported replacement', 'empty inner group', 'missing inner group',
    'unavailable inner recording', 'missing outer credit', 'missing inner credit',
  ] as const)('%s', variation => {
    it.each([false, true])('retains missing-transfer conflicts and later repeats (missing first: %s)', missingFirst => {
      const input = fixture();
      const inner = variation !== 'unsupported replacement' && variation !== 'missing outer credit';
      const multiple = variation === 'missing outer credit' || variation === 'missing inner credit';
      if (inner) {
        input.transaction.transaction.message.instructions = [wrapper()];
        input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }];
      }
      if (multiple) {
        const instructions = inner ? input.transaction.meta.innerInstructions![0]!.instructions
          : input.transaction.transaction.message.instructions;
        instructions.push(transfer('50', key.source, key.recipientB));
        setBalance(input, key.source, 'post', '850'); setBalance(input, key.recipientB, 'post', '50');
      }
      const changed = structuredClone(input);
      changed.provenance.evidenceId = 'missing-transfer-observation';
      switch (variation) {
        case 'unsupported replacement':
          changed.transaction.transaction.message.instructions[0]!.parsed = {
            type: 'mintTo', info: { mint: key.mint, account: key.recipient, amount: '100', mintAuthority: key.authority },
          };
          break;
        case 'empty inner group': changed.transaction.meta.innerInstructions![0]!.instructions = []; break;
        case 'missing inner group': changed.transaction.meta.innerInstructions = []; break;
        case 'unavailable inner recording': changed.transaction.meta.innerInstructions = null; break;
        case 'missing outer credit': changed.transaction.transaction.message.instructions.pop(); break;
        case 'missing inner credit': changed.transaction.meta.innerInstructions![0]!.instructions.pop(); break;
      }
      const original = normalized(input); const missing = normalized(changed);
      expect(original.transfers.map(item => item.netCreditRaw)).toEqual(multiple ? ['100', '50'] : ['100']);
      expect(missing.transfers).toHaveLength(multiple ? 1 : 0);
      const identity = original.transfers.at(-1)!.identity;
      const pair = missingFirst ? [missing, original] : [original, missing];
      const originalIndex = missingFirst ? 1 : 0; const missingIndex = missingFirst ? 0 : 1;
      for (const results of [pair, [...pair, normalized(input)], [...pair, normalized(input), normalized(changed)]]) {
        const before = structuredClone(results);
        const groups = groupCreditIdentities(results);
        expect(groups).toHaveLength(original.transfers.length);
        // The existing policy also conflicts retained credits when transaction evidence changes.
        expect(groups.every(group => group.status === 'conflicting' && group.reason === 'conflicting_identity_evidence')).toBe(true);
        const group = groups.find(item => item.identity === identity)!;
        const supportedIndexes = results.length >= 3 ? [originalIndex, 2] : [originalIndex];
        const missingIndexes = results.length === 4 ? [missingIndex, 3] : [missingIndex];
        expect(group.observations.map(item => item.resultIndex)).toEqual(supportedIndexes);
        expect(group.missingTransferObservations).toEqual(missingIndexes.map(resultIndex => ({ resultIndex })));
        for (const observation of group.observations) {
          expect(observation.transferIndex).toBe(multiple ? 1 : 0);
          expect(observation.transfer).toBe(results[observation.resultIndex]!.transfers[observation.transferIndex]);
        }
        for (const observation of group.missingTransferObservations) {
          const result = results[observation.resultIndex]!;
          expect(result.provenance.evidenceId).toBe('missing-transfer-observation');
          expect(result.evidence).toEqual(changed.transaction);
        }
        if (multiple) {
          const retained = groups.find(item => item.identity === original.transfers[0]!.identity)!;
          expect(retained.observations).toHaveLength(results.length);
          expect(retained.missingTransferObservations).toEqual([]);
        }
        expect(results).toEqual(before);
      }
    });
  });

  it.each(['network', 'signature'] as const)('isolates unrelated %s observations with and without transfers', field => {
    const input = fixture(); const original = normalized(input);
    const unrelated = structuredClone(input);
    if (field === 'network') unrelated.network = 'devnet';
    else unrelated.transaction.transaction.signatures[0] = '4'.repeat(88);
    const unrelatedSupported = normalized(unrelated);
    unrelated.transaction.transaction.message.instructions = [];
    const unrelatedMissing = normalized(unrelated);
    for (const pair of [[original, unrelatedMissing], [unrelatedMissing, original]]) {
      const single = groupCreditIdentities(pair);
      expect(single).toHaveLength(1);
      expect(single[0]).toMatchObject({ identity: original.transfers[0]!.identity, status: 'single', reason: null,
        missingTransferObservations: [] });
      const groups = groupCreditIdentities([...pair, normalized(input), unrelatedSupported]);
      expect(groups).toHaveLength(2);
      const repeated = groups.find(item => item.identity === original.transfers[0]!.identity)!;
      expect(repeated).toMatchObject({ status: 'repeated', reason: null, missingTransferObservations: [] });
      expect(repeated.observations).toHaveLength(2);
      const conflicting = groups.find(item => item.identity === unrelatedSupported.transfers[0]!.identity)!;
      expect(conflicting).toMatchObject({ status: 'conflicting', reason: 'conflicting_identity_evidence',
        missingTransferObservations: [{ resultIndex: pair.indexOf(unrelatedMissing) }] });
      expect(conflicting.observations).toHaveLength(1);
    }
  });

  it('keeps different wallet contexts associated with the same transaction', () => {
    const input = fixture(); const original = normalized(input);
    input.wallet = key.otherOwner;
    const otherWallet = normalized(input);
    expect(groupCreditIdentities([original, otherWallet])[0]?.status).toBe('conflicting');
    input.transaction.transaction.message.instructions = [];
    const missing = normalized(input);
    for (const results of [[original, otherWallet, missing], [missing, otherWallet, original]]) {
      const groups = groupCreditIdentities(results);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ status: 'conflicting', reason: 'conflicting_identity_evidence',
        missingTransferObservations: [{ resultIndex: results.indexOf(missing) }] });
      expect(groups[0]?.observations).toHaveLength(2);
    }
  });

  it('does not manufacture identities when every observation lacks supported transfers', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [];
    expect(groupCreditIdentities([normalized(input), normalized(input)])).toEqual([]);
  });

  it.each(['amount', 'destination', 'owner', 'signer', 'failure', 'metadata'])('surfaces %s conflicts for the same identity', change => {
    const input = fixture(); const first = normalized(input);
    if (change === 'amount') info(input).tokenAmount = { amount: '101', decimals: 6 };
    if (change === 'destination') info(input).destination = key.recipientB;
    if (change === 'owner') balances(input).forEach(balance => { balance.owner = key.otherOwner; });
    if (change === 'signer') input.transaction.transaction.message.accountKeys.find(item => item.pubkey === key.wallet)!.signer = true;
    if (change === 'failure') input.transaction.meta.err = 'AccountNotFound';
    if (change === 'metadata') input.transaction.metadata = { symbol: 'enrichment' };
    const second = normalized(input);
    const group = groupCreditIdentities([first, second, first])[0]!;
    expect(first.transfers[0]?.identity).toBe(second.transfers[0]?.identity);
    expect(group.status).toBe('conflicting'); expect(group.reason).toBe('conflicting_identity_evidence');
    expect(group.observations).toHaveLength(3);
  });

  it('retains duplicate inner positions as ambiguous evidence', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [wrapper()];
    input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }, { index: 0, instructions: [transfer('101')] }];
    const result = expectUnresolved(input, 'duplicate_instruction_position');
    expect(result.transfers).toHaveLength(2);
    expect(groupCreditIdentities([result])[0]?.status).toBe('conflicting');
  });

  it('uses object-key-order-independent comparison', () => {
    const input = fixture(); const first = normalized(input);
    input.transaction.meta = Object.fromEntries(Object.entries(input.transaction.meta).reverse()) as typeof input.transaction.meta;
    expect(groupCreditIdentities([first, normalized(input)])[0]?.status).toBe('repeated');
  });

  it('throws safe errors for invalid context and identities', () => {
    const input = fixture(); input.wallet = 'bad'; expect(() => normalized(input)).toThrow('Invalid normalization input');
    input.wallet = key.wallet; input.provenance.evidenceId = 'https://example.invalid/?api-key=private';
    expect(() => normalized(input)).toThrow('Invalid normalization input');
    expect(() => individualCreditIdentity('mainnet-beta', signature, { outer: -1, inner: null })).toThrow('Invalid individual-credit identity input');
  });
});

describe('additional evidence consistency regressions', () => {
  it.each([0, 9, 255])('preserves valid decimals %s without display arithmetic', decimals => {
    const input = fixture();
    for (const balance of [...input.transaction.meta.preTokenBalances, ...input.transaction.meta.postTokenBalances]) balance.uiTokenAmount.decimals = decimals;
    info(input).tokenAmount = { amount: '100', decimals, uiAmount: null };
    expect(normalized(input).transfers[0]).toMatchObject({ decimals: { value: decimals }, netCreditRaw: '100' });
  });

  it('detects conflicting decimals for the same mint on an otherwise unrelated account', () => {
    const input = fixture(); balances(input, key.sink).forEach(balance => { balance.uiTokenAmount.decimals = 9; });
    expectUnresolved(input, 'conflicting_decimals');
  });

  it('detects conflicting programs for the same mint on another account', () => {
    const input = fixture(); balances(input, key.sink).forEach(balance => { balance.programId = TOKEN_2022_PROGRAM; });
    expectUnresolved(input, 'conflicting_token_program');
  });

  it('requires the actual token program account to be present', () => {
    const input = fixture(); input.transaction.transaction.message.accountKeys.pop();
    expectUnresolved(input, 'invalid_account_reference');
  });

  it('does not silently overwrite exact duplicate inner positions', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [wrapper()];
    input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }, { index: 0, instructions: [transfer()] }];
    const result = expectUnresolved(input, 'duplicate_instruction_position');
    expect(groupCreditIdentities([result])[0]?.status).toBe('conflicting');
  });

  it('preserves uninterpreted wrapper evidence alongside proven CPI credits', () => {
    const input = fixture(); input.transaction.transaction.message.instructions = [wrapper()];
    input.transaction.meta.innerInstructions = [{ index: 0, instructions: [transfer()] }];
    const result = normalized(input);
    expect(result.transfers[0]?.netCreditRaw).toBe('100');
    expect(result.issues).toContainEqual({ reason: 'uninterpreted_instruction', position: { outer: 0, inner: null } });
  });

  it('keeps lifecycle and unsupported authority-change directions uncertain', () => {
    const input = fixture(); input.transaction.transaction.message.instructions.push({ programId: SPL_TOKEN_PROGRAM,
      parsed: { type: 'setAuthority', info: { account: key.recipient, newAuthority: key.otherOwner, authorityType: 'accountOwner' } } });
    const result = expectUnresolved(input, 'unsupported_token_instruction');
    expect(result.transfers[0]?.flags.walletDirection).toBe('unknown');
  });

  it('retains an absent source owner and prevents it being inferred from authority', () => {
    const input = fixture(); balances(input, key.source).forEach(balance => { delete balance.owner; });
    const result = expectUnresolved(input, 'missing_owner');
    expect(result.transfers[0]?.sourceOwner.status).toBe('missing');
  });

  it('retains out-of-range raw amount strings as invalid evidence rather than truncating', () => {
    const input = fixture(); info(input).tokenAmount = { amount: '18446744073709551616', decimals: 6 };
    const result = expectUnresolved(input, 'invalid_transfer_evidence');
    expect(result.evidence.transaction.message.instructions).toEqual(input.transaction.transaction.message.instructions);
  });

  it('keeps a single observed owner with the missing opposite owner field visible', () => {
    const input = fixture(); delete balances(input)[0]!.owner;
    const result = normalized(input);
    expect(result.transfers[0]?.destinationOwner.value).toBe(key.wallet);
    expect(result.accounts.find(item => item.address === key.recipient)?.pre[0]?.owner).toBeUndefined();
  });
});

describe('recognized associated-token-account creation', () => {
  const credited = (input: NormalizationInput) => normalized(input).accounts.find(item => item.address === key.recipient);
  /** Every refusal keeps the exact blocker it has today, rather than merely failing to prove a credit. */
  const expectBlocked = (input: NormalizationInput, reason: NormalizationReason = 'unsupported_token_instruction') => {
    const result = expectUnresolved(input, reason);
    expect(result.accountCreations).toEqual([]);
    return result;
  };

  it.each([SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM])('accepts the creation unit under %s without blocking the batch', program => {
    const input = program === SPL_TOKEN_PROGRAM ? fixture() : token2022Fixture();
    addCreation(input, { account: key.sink, owner: key.otherOwner, program });
    const result = normalized(input);
    expect(result.normalizationVersion).toBe(2);
    expect(result.issues.some(item => item.reason === 'unsupported_token_instruction')).toBe(false);
    expect(result.transfers[0]?.netCreditRaw).toBe(program === SPL_TOKEN_PROGRAM ? '100' : '97');
    expect(result.accountCreations).toMatchObject([{ type: 'createIdempotent', account: key.sink, mint: key.mint,
      owner: key.otherOwner, source: key.authority, tokenProgram: program, created: { lamports: '2039280' } }]);
    // The two account-shape instructions contribute no owner, mint or balance observation.
    expect(result.accounts.find(item => item.address === key.sink)?.owner.observations.map(item => item.evidence))
      .toEqual(['preTokenBalances:3', 'postTokenBalances:3', 'instruction:1:3']);
  });

  it('proves a credit into an account the recognized unit created in this transaction', () => {
    const input = fixture();
    setBalance(input, key.recipient, 'pre', null); setBalance(input, key.recipient, 'post', '100');
    addCreation(input);
    const result = normalized(input);
    const account = result.accounts.find(item => item.address === key.recipient)!;
    expect(account).toMatchObject({ createdInTransaction: true, balanceChangeRaw: '100', reasons: [] });
    expect(account.pre).toEqual([]);
    expect(result.transfers[0]).toMatchObject({ netCreditRaw: '100', netCreditBasis: 'instruction_and_balances',
      reasons: [], flags: { walletDirection: 'incoming', selfTransfer: false } });
  });

  it.each(['empty', 'absent'] as const)('keeps the idempotent %s no-op a no-op with no synthesized zero', noop => {
    const input = fixture();
    addCreation(input, { noop });
    const result = normalized(input);
    expect(result.accountCreations).toMatchObject([{ account: key.recipient, created: null }]);
    expect(result.accounts.find(item => item.address === key.recipient))
      .toMatchObject({ createdInTransaction: false, balanceChangeRaw: '100' });
    expect(result.transfers[0]?.netCreditRaw).toBe('100');
    // Without both observed snapshots the no-op proves nothing, because it created nothing.
    const missing = fixture(); setBalance(missing, key.recipient, 'pre', null);
    addCreation(missing, { noop });
    expect(credited(missing)).toMatchObject({ createdInTransaction: false, balanceChangeRaw: null });
    expect(normalized(missing).transfers[0]?.netCreditRaw).toBeNull();
  });

  it.each([
    ['a missing instruction', (list: InstructionEvidence[]) => { list.splice(2, 1); }],
    ['a reordered list', (list: InstructionEvidence[]) => { list.reverse(); }],
    ['an appended fifth instruction', (list: InstructionEvidence[]) => { list.push(structuredClone(list[2]!)); }],
    ['a disagreeing initializeAccount3 owner', (list: InstructionEvidence[]) => { parsedInfo(list[3]!).owner = key.router; }],
    ['a malformed initializeAccount3', (list: InstructionEvidence[]) => { delete parsedInfo(list[3]!).mint; }],
    ['a disagreeing createAccount newAccount', (list: InstructionEvidence[]) => { parsedInfo(list[1]!).newAccount = key.recipientB; }],
    ['a disagreeing createAccount owner', (list: InstructionEvidence[]) => { parsedInfo(list[1]!).owner = key.router; }],
    ['a disagreeing createAccount source', (list: InstructionEvidence[]) => { parsedInfo(list[1]!).source = key.recipientB; }],
    ['an invalid createAccount lamports value', (list: InstructionEvidence[]) => { parsedInfo(list[1]!).lamports = -1; }],
    ['a disagreeing getAccountDataSize mint', (list: InstructionEvidence[]) => { parsedInfo(list[0]!).mint = key.otherMint; }],
    ['a substituted token program', (list: InstructionEvidence[]) => { list[2]!.programId = TOKEN_2022_PROGRAM; }],
    ['an initializeAccount3 for another account', (list: InstructionEvidence[]) => { parsedInfo(list[3]!).account = key.recipientB; }],
  ])('refuses %s and keeps the transaction-wide blocker', (_label, mutate) => {
    const input = fixture();
    const index = addCreation(input, { account: key.sink, owner: key.otherOwner });
    mutate(creationCpis(input, index));
    expectBlocked(input);
  });

  it('refuses a token program outside the two supported programs', () => {
    const input = fixture();
    addCreation(input, { account: key.sink, owner: key.otherOwner, program: key.router });
    // Nothing in the unit is recognized, and its token-labelled CPIs keep the program mismatch blocker.
    expectBlocked(input, 'unsupported_program');
  });

  it('refuses two inner groups at one outer index and keeps duplicate_instruction_position', () => {
    const input = fixture();
    const index = addCreation(input, { account: key.sink, owner: key.otherOwner });
    input.transaction.meta.innerInstructions!.push({ index, instructions: structuredClone(creationCpis(input, index)) });
    const result = expectBlocked(input, 'duplicate_instruction_position');
    expect(result.issues.some(item => item.reason === 'unsupported_token_instruction')).toBe(true);
  });

  it('keeps a pre balance plus a recognized creation contradictory rather than preferring one source', () => {
    const input = fixture();
    addCreation(input);
    const account = credited(input)!;
    expect(account.createdInTransaction).toBe(false);
    expect(account.reasons).toContain('conflicting_balance');
    expect(account.balanceChangeRaw).toBeNull();
    expect(normalized(input).transfers[0]?.netCreditRaw).toBeNull();
  });

  it('restores the lifecycle block for a closure and never synthesizes a zero without the unit', () => {
    const closed = fixture();
    setBalance(closed, key.recipient, 'pre', null); setBalance(closed, key.recipient, 'post', '100');
    addCreation(closed);
    closed.transaction.transaction.message.instructions.push({ program: 'spl-token', programId: SPL_TOKEN_PROGRAM,
      parsed: { type: 'closeAccount', info: { account: key.recipient, destination: key.sink, owner: key.wallet } } });
    expect(credited(closed)?.reasons).toContain('account_lifecycle');
    expect(normalized(closed).transfers[0]).toMatchObject({ netCreditRaw: null, netCreditBasis: null });
    // createAccountWithSeed plus a bare initializeAccount3 is a different creation path entirely.
    const seeded = fixture();
    setBalance(seeded, key.recipient, 'pre', null); setBalance(seeded, key.recipient, 'post', '100');
    addKey(seeded, SYSTEM_PROGRAM);
    seeded.transaction.transaction.message.instructions.push(
      { program: 'system', programId: SYSTEM_PROGRAM, parsed: { type: 'createAccountWithSeed',
        info: { base: key.authority, seed: 'x', newAccount: key.recipient, owner: SPL_TOKEN_PROGRAM, lamports: 2039280, space: 165 } } },
      { program: 'spl-token', programId: SPL_TOKEN_PROGRAM, parsed: { type: 'initializeAccount3',
        info: { account: key.recipient, mint: key.mint, owner: key.wallet } } });
    expect(credited(seeded)).toMatchObject({ createdInTransaction: false, balanceChangeRaw: null });
    expect(normalized(seeded).accountCreations).toEqual([]);
  });

  it('still blocks the whole transaction when an unsupported token instruction sits beside the unit', () => {
    const input = fixture();
    addCreation(input, { account: key.sink, owner: key.otherOwner });
    input.transaction.transaction.message.instructions.push({ program: 'spl-token', programId: SPL_TOKEN_PROGRAM,
      parsed: { type: 'syncNative', info: { account: key.sink } } });
    const result = expectUnresolved(input, 'unsupported_token_instruction');
    expect(result.accountCreations).toHaveLength(1);
  });
});
