// Synthetic public transaction shapes; no captured wallet history or real credentials.
export const fixtureKey = 'fixture-key-never-a-real-credential';
export const wallet = '8'.repeat(32); // The synthetic demo wallet.
export const quoteMint = 'So11111111111111111111111111111111111111112';
export const tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const tokenAccount = '5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ';
export const exactAmount = '184467440737095516150001234567890';
export const query = { wallet, startTime: 1_790_000_000, endTime: 1_790_864_000, pageSize: 100 };
export const sig = (letter = '3'): string => letter.repeat(88);
export function transaction(letter = '3', blockTime = query.startTime + 10) {
  const instruction = {
    program: 'spl-token', programId: tokenProgram,
    parsed: { type: 'transferChecked', info: {
      source: tokenAccount, destination: wallet, authority: tokenAccount,
      mint: quoteMint, tokenAmount: { amount: exactAmount, decimals: 9, uiAmount: null, uiAmountString: '184467440737095516150001.234567890' },
    } }, stackHeight: 2,
  };
  return {
    slot: 100, transactionIndex: 4, blockTime, version: 1,
    transaction: {
      signatures: [sig(letter)],
      message: {
        accountKeys: [{ pubkey: tokenAccount, signer: true, writable: true, source: 'transaction' }, { pubkey: wallet, signer: false, writable: true, source: 'lookupTable' }],
        instructions: [instruction, structuredClone(instruction)],
        recentBlockhash: quoteMint,
        addressTableLookups: [{ accountKey: tokenAccount, writableIndexes: [0], readonlyIndexes: [1] }],
      },
    },
    meta: {
      err: null, status: { Ok: null }, fee: 5000, preBalances: [10000, 10000], postBalances: [5000, 10000],
      preTokenBalances: [{ accountIndex: 1, mint: quoteMint, owner: wallet, programId: tokenProgram, uiTokenAmount: { amount: '000123', decimals: 9, uiAmount: null } }],
      postTokenBalances: [{ accountIndex: 1, mint: quoteMint, owner: wallet, programId: tokenProgram, uiTokenAmount: { amount: exactAmount, decimals: 9, uiAmount: null } }],
      innerInstructions: [{ index: 0, instructions: [structuredClone(instruction), structuredClone(instruction)] }],
      loadedAddresses: { writable: [wallet], readonly: [tokenProgram] },
      logMessages: ['Program synthetic instruction succeeded'], computeUnitsConsumed: 4321, rewards: [],
    },
    futureEvidence: { retained: true },
  };
}
export function response(data: unknown[] = [], paginationToken: string | null = null) {
  return { jsonrpc: '2.0', id: 'history', result: { data, paginationToken } };
}
export function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: 'history', error: { code, message } };
}
