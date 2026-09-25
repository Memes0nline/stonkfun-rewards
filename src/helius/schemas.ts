import { z } from 'zod';
import { addressSchema, cursorSchema, unixSecondsSchema } from './query.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const rawAmount = z.string().regex(/^\d+$/);
const tokenAmount = z.object({ amount: rawAmount, decimals: count.max(255) }).catchall(z.json());
const tokenPrograms = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const instruction = z.object({
  programId: addressSchema,
  program: z.string().optional(),
  parsed: z.json().optional(),
  accounts: z.array(addressSchema).optional(),
  data: z.string().optional(),
}).catchall(z.json()).superRefine((value, context) => {
  if (value.program !== 'spl-token' && value.program !== 'spl-token-2022' && !tokenPrograms.has(value.programId)) return;
  const parsed = value.parsed;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const info = parsed.info;
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return;
  if (('amount' in info && !rawAmount.safeParse(info.amount).success)
    || ('tokenAmount' in info && !tokenAmount.safeParse(info.tokenAmount).success)) {
    context.addIssue({ code: 'custom', message: 'Invalid raw token amount' });
  }
});
const tokenBalance = z.object({
  accountIndex: count,
  mint: addressSchema,
  owner: addressSchema.optional(),
  programId: addressSchema.optional(),
  uiTokenAmount: tokenAmount,
}).catchall(z.json());

/** Known evidence is validated; JSON extensions at every modeled object are retained. */
export const fullTransactionSchema = z.object({
  slot: count,
  transactionIndex: count.optional(),
  blockTime: unixSecondsSchema.nullish(),
  version: z.union([z.literal('legacy'), z.literal(0), z.literal(1)]).optional(),
  transaction: z.object({
    signatures: z.array(signature).min(1),
    message: z.object({
      accountKeys: z.array(z.object({
        pubkey: addressSchema, signer: z.boolean(), writable: z.boolean(),
      }).catchall(z.json())),
      instructions: z.array(instruction),
    }).catchall(z.json()),
  }).catchall(z.json()),
  meta: z.object({
    err: z.json(),
    preTokenBalances: z.array(tokenBalance),
    postTokenBalances: z.array(tokenBalance),
    innerInstructions: z.array(z.object({ index: count, instructions: z.array(instruction) }).catchall(z.json())).nullable(),
    logMessages: z.array(z.string()).nullable(),
  }).catchall(z.json()),
}).catchall(z.json());

export const historyResponseSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal('history'),
  result: z.object({ data: z.array(fullTransactionSchema).max(1000), paginationToken: cursorSchema.nullable() }),
  error: z.never().optional(),
});
/** A signatures-mode page: each transaction's signature and time, without its body. */
export const signaturesResponseSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal('history'),
  result: z.object({
    data: z.array(z.object({ signature, slot: count, blockTime: unixSecondsSchema.nullish(), err: z.json().optional() }).catchall(z.json())).max(1000),
    paginationToken: cursorSchema.nullable(),
  }),
  error: z.never().optional(),
});
export const rpcErrorSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal('history'),
  error: z.object({ code: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), message: z.string() }),
  result: z.never().optional(),
});
export type FullTransaction = z.output<typeof fullTransactionSchema>;
export type HistoryResponse = z.output<typeof historyResponseSchema>['result'];
export type SignaturesResponse = z.output<typeof signaturesResponseSchema>['result'];
