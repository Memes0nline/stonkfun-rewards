import { createHash } from 'node:crypto';
import type { DistributionEvidenceInput } from '../payout-evidence/types.js';
import { canonical } from '../payout-evidence/validation.js';
import type { WithdrawalAuthoritySnapshot } from './types.js';

const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const id = /^[A-Za-z0-9_-]{1,128}$/;
const time = (value: string | undefined) => value !== undefined && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Published LaunchLab configuration snapshots, each validated against its own successful
 * withdrawalConfig retrieval. Content-addressed; a caller-supplied identifier is never trusted. */
export function withdrawalSnapshots(feed: DistributionEvidenceInput): WithdrawalAuthoritySnapshot[] {
  if (!['mainnet-beta', 'devnet', 'testnet'].includes(feed.network) || !id.test(feed.provenance.evidenceId)) return [];
  return feed.withdrawalAuthorities.flatMap(item => {
    const sources = feed.sources.filter(source => source.id === item.sourceId);
    const source = sources[0];
    const retrievedAt = time(source?.retrievedAt);
    if (item.role !== 'withdrawWithheldAuthority' || !address.test(item.authority) || !address.test(item.configurationQuoteMint)
      || sources.length !== 1 || !source || source.source !== 'withdrawalConfig' || source.outcome !== 'success'
      || source.failure !== undefined || source.attempts < 1
      || (source.httpStatus !== undefined && (source.httpStatus < 200 || source.httpStatus >= 300))
      || source.endpoint !== `/launchlab/pricing?quoteMint=${item.configurationQuoteMint}` || retrievedAt === null
      || (source.generatedAt !== undefined && time(source.generatedAt) === null)) return [];
    const content = { network: feed.network, role: item.role, authority: item.authority,
      configurationQuoteMint: item.configurationQuoteMint, retrievedAt, observed: Math.floor(Date.parse(retrievedAt) / 1000),
      generatedAt: time(source.generatedAt), endpoint: source.endpoint, evidenceId: feed.provenance.evidenceId, sourceId: source.id };
    return [{ id: createHash('sha256').update(canonical(content)).digest('hex'), ...content }];
  });
}
