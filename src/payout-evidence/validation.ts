import { z } from 'zod';
import { mintSchema, rewardsSchema, paginationSchema } from '../registry/schemas.js';
import { normalizeTransaction } from '../normalization/normalizer.js';
import type { NormalizedTransaction } from '../normalization/types.js';
import type { DistributionEvidenceInput, PayoutEvidenceInput, PayoutEvidenceState } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
export function unique<T>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [canonical(item), item])).values()];
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const distribution = rewardsSchema.shape.data.shape.recentDistributions.element;
const feedSchema = z.object({
  network: z.enum(['mainnet-beta', 'devnet', 'testnet']),
  provenance: z.object({ source: z.enum(['stonkfun-public-api', 'fixture']), evidenceId: id, retrievedAt: timestamp }).strict(),
  distributions: z.array(z.object({
    signature: distribution.shape.signature,
    rows: z.array(z.object({ value: distribution, sourceIds: z.array(id) }).strict()),
  }).strict().refine(group => group.rows.every(row => row.value.signature === group.signature))),
  sources: z.array(z.object({
    id, source: z.enum(['launches', 'rewards', 'pairs', 'withdrawalConfig']),
    // Exactly the loader's public relative endpoint vocabulary, with no free-form URLs.
    endpoint: z.string().regex(/^\/(?:rewards\?limit=\d+|pairs|launches\?mode=reward&pageSize=\d+&page=\d+|launchlab\/pricing\?quoteMint=[1-9A-HJ-NP-Za-km-z]{32,44})$/),
    requestedAt: timestamp, retrievedAt: timestamp, attempts: count,
    outcome: z.enum(['success', 'failure']), generatedAt: timestamp.optional(),
    httpStatus: count.optional(), requestedPage: count.optional(), pass: count.optional(),
    pagination: paginationSchema.optional(),
    failure: z.enum(['network', 'timeout', 'http', 'rate_limit', 'invalid_response', 'response_too_large', 'cancelled']).optional(),
  }).strict()),
  withdrawalAuthorities: z.array(z.object({
    role: z.literal('withdrawWithheldAuthority'), authority: mintSchema,
    configurationQuoteMint: mintSchema, sourceId: id,
  }).strict()),
}).strict();

function transaction(value: NormalizedTransaction): NormalizedTransaction {
  const normalized = normalizeTransaction({
    transaction: value.evidence, wallet: value.wallet, network: value.network, provenance: value.provenance,
  });
  // Refuse forged/edited derived credits, identity keys, flags or a caller-supplied trust field.
  if (canonical(normalized) !== canonical(value)) throw new Error('Invalid payout evidence input');
  return normalized;
}

export function retainedInputs(input: PayoutEvidenceInput): PayoutEvidenceState {
  try {
    if (Object.keys(input).some(key => !['feeds', 'transactions', 'prior', 'policyVersion'].includes(key))) throw new Error();
    const policyVersion = input.policyVersion ?? input.prior?.policyVersion ?? 'payout-evidence-v1';
    if (!['payout-evidence-v1', 'payout-evidence-v2', 'payout-evidence-v3'].includes(policyVersion)) throw new Error();
    const prior = input.prior;
    if (prior !== undefined && (prior === null || prior.schemaVersion !== 1 || prior.policyVersion !== policyVersion
      || Object.keys(prior).some(key => !['schemaVersion', 'policyVersion', 'feeds', 'transactions'].includes(key)))) throw new Error();
    return { schemaVersion: 1, policyVersion,
      feeds: unique([...prior?.feeds ?? [], ...input.feeds].map(value =>
        // Drop explicitly undefined optional fields to match the registry's exact-optional types.
        JSON.parse(JSON.stringify(feedSchema.parse(value))) as DistributionEvidenceInput)),
      transactions: unique([...prior?.transactions ?? [], ...input.transactions].map(transaction)),
    };
  } catch {
    // Never reflect raw inputs, provider extensions, or validation diagnostics in an error.
    throw new Error('Invalid payout evidence input');
  }
}
