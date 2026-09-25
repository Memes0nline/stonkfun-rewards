import { z } from 'zod';

// Syntactic public-key validation; account existence is outside this loader.
export const mintSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const signatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const rawAmountSchema = z.string().regex(/^\d+$/);
const quote = z.object({
  mint: mintSchema,
  symbol: z.string().optional(),
  decimals: z.number().int().min(0).max(255).optional(),
});
const launch = z.object({
  mint: mintSchema,
  quote,
  mode: z.literal('reward'),
  launchpad: z.string().optional(),
  pool: mintSchema.nullish(),
  creator: mintSchema.optional(),
  transferFee: z.object({ bps: count }).nullish(),
  createdAt: timestamp.optional(),
});
const rewardLaunch = z.object({
  mint: mintSchema,
  quote,
  distributedRaw: rawAmountSchema,
  payoutCount: count,
  holderCount: count,
  lastPayoutAt: timestamp.nullish(),
});
const distribution = z.object({
  signature: signatureSchema,
  mint: mintSchema,
  quoteMint: mintSchema,
  amountRaw: rawAmountSchema,
  holderCount: count,
  distributedAt: timestamp,
}).catchall(z.json());
const pair = z.object({
  mint: mintSchema,
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().min(0).max(255),
  category: z.string(),
  tokenProgram: mintSchema,
  launchable: z.boolean(),
  launchLabReady: z.boolean().optional(),
});
export const paginationSchema = z.object({
  page: count.min(1), pageSize: count.min(1).max(100), total: count, totalPages: count,
});
const meta = z.object({ generatedAt: timestamp.optional() }).optional();
export const launchesSchema = z.object({
  data: z.object({ launches: z.array(launch), pagination: paginationSchema }), meta,
});
export const rewardsSchema = z.object({
  data: z.object({ launches: z.array(rewardLaunch), recentDistributions: z.array(distribution) }), meta,
});
export const pairsSchema = z.object({ data: z.object({ pairs: z.array(pair) }), meta });
export const withdrawalSchema = z.object({
  data: z.object({
    modes: z.object({ reward: z.object({ withdrawWithheldAuthority: mintSchema }) }),
  }), meta,
});

export type Launch = z.infer<typeof launch>;
export type RewardLaunch = z.infer<typeof rewardLaunch>;
export type DistributionRow = z.infer<typeof distribution>;
export type Pair = z.infer<typeof pair>;
export type Pagination = z.infer<typeof paginationSchema>;
