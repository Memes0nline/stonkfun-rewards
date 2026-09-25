import { z } from 'zod';

export const addressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const unixSecondsSchema = z.number().int().min(0).max(8_640_000_000_000);
export const cursorSchema = z.string().min(1).max(4096);
const querySchema = z.object({
  wallet: addressSchema,
  startTime: unixSecondsSchema,
  endTime: unixSecondsSchema,
  pageSize: z.number().int().min(1).max(1000).default(100),
}).refine((value) => value.startTime < value.endTime);

export interface HistoryQueryInput {
  wallet: string;
  /** Inclusive Unix seconds. */
  startTime: number;
  /** Exclusive Unix seconds; fixed for the entire operation. */
  endTime: number;
  pageSize?: number;
}
export type HistoryQuery = Readonly<z.output<typeof querySchema>>;
export function normalizeQuery(input: HistoryQueryInput): HistoryQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid Helius history query');
  return Object.freeze(parsed.data);
}
/** Signatures listed per page in signatures mode, Helius's maximum. */
export const SIGNATURE_PAGE_SIZE = 1000;
/** The history request, in full mode or listing signatures only; every other field and filter is the same in both. */
export function historyRequest(query: HistoryQuery, cursor: string | null, details: 'full' | 'signatures' = 'full') {
  return {
    jsonrpc: '2.0', id: 'history', method: 'getTransactionsForAddress',
    params: [query.wallet, {
      transactionDetails: details, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1,
      commitment: 'finalized', sortOrder: 'asc', limit: query.pageSize,
      filters: {
        blockTime: { gte: query.startTime, lte: query.endTime - 1 },
        status: 'succeeded', tokenAccounts: 'balanceChanged', tokenTransfer: { direction: 'in' },
      },
      ...(cursor === null ? {} : { paginationToken: cursor }),
    }],
  };
}
