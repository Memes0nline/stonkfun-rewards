import type { SolanaNetwork } from '../normalization/types.js';
import { add, displayRaw, rounded, valueOf } from './decimal.js';
import type { Decimal } from './decimal.js';
import { earlierBatch, HISTORY_FLOOR, missingRanges } from './ranges.js';
import {
  ATTRIBUTION_MODEL_VERSION, NATIVE_SOL_MINT, NATIVE_SOL_NAME, NATIVE_SOL_SYMBOL, TIER_EVALUATING_VERSIONS,
} from './types.js';
import type { AttributionTrustSource, Classification, Metadata, Price, RewardsStore, WalletState } from './types.js';

/** Native SOL has fixed wording because it is a sentinel, not a mint any registry describes. */
const assetLabel = (mint: string, meta: Metadata | undefined) => mint === NATIVE_SOL_MINT
  ? { symbol: NATIVE_SOL_SYMBOL, name: NATIVE_SOL_NAME }
  : { symbol: meta?.symbol ?? mint, name: meta?.name ?? mint };

/** Fixed group wording. No field, line or chart ever adds verified and attributed together. */
export const REPORT_GROUPS = {
  verified: { label: 'Verified', explanation: 'Confirmed by an exact official StonkFun distribution record, a same-slot witness bracket, or a witness-bounded historical authority epoch.' },
  attributed: { label: 'Attributed · not verified', explanation: 'Paid from a trusted StonkFun distributor\'s own token account in a reward quote mint. No official record names this transaction and its launch is unknown. Never added to verified totals.' },
  unknown: { label: 'Unknown · not counted', explanation: 'Incoming credits whose payout origin could not be established. Not counted as rewards and not a verified zero.' },
  unpriced: { label: 'Unpriced · excluded from USD', explanation: 'No valid current USD price. Shown in token units only and excluded from USD totals, never counted as zero.' },
} as const;
export const TRUST_SOURCES: Record<AttributionTrustSource, { label: string; explanation: string }> = {
  feed_witnessed_identity: { label: 'Feed-witnessed distributor',
    explanation: 'This sender executed official StonkFun distributions retained in this database; each attributed row records how many, the first and last, and its distance from them.' },
  published_withdraw_authority: { label: 'Published withdraw authority',
    explanation: 'StonkFun\'s LaunchLab configuration named this sender as the reward-mode withdraw authority in a snapshot taken after the payouts it covers (at or after each credit\'s block time); the authority before that snapshot is assumed, not observed.' },
};

/** A saved price taken more than this long before the report's fixed cutoff is flagged stale. */
export const STALE_PRICE_SECONDS = 86400;
export const PRICE_RULE = 'Each mint is valued at its most recent saved USD observation from any job; a price taken more than 24 hours before the fixed cutoff is flagged stale. A mint with no saved USD observation stays unpriced.';

const utcDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const days = (range: { startTime: number; endTime: number }) => Math.ceil((range.endTime - range.startTime) / 86400);
/** The loaded range and what Load earlier can still add: the oldest loaded day, the days between the floor and it that are not
 * loaded yet, the next batch, and the most recent completed batch. Days not loaded yet are never gaps. */
export function loadedHistory(state: WalletState) {
  const loadedFrom = Math.max(HISTORY_FLOOR, state.trackingStart);
  const next = earlierBatch(loadedFrom);
  const notLoaded = next ? { startTime: HISTORY_FLOOR, endTime: loadedFrom } : null;
  return { floor: HISTORY_FLOOR, loadedFrom, oldestLoadedDay: utcDay(loadedFrom),
    notLoadedYet: notLoaded ? { ...notLoaded, days: days(notLoaded) } : null,
    earlierRemaining: next !== null, nextBatch: next ? { ...next, days: days(next) } : null,
    lastBatch: state.lastBatch ? { kind: state.lastBatch.kind, startTime: state.lastBatch.startTime, endTime: state.lastBatch.endTime,
      days: state.lastBatch.days, elapsedSeconds: state.lastBatch.elapsedSeconds, finishedAt: new Date(state.lastBatch.finishedAt).toISOString() } : null };
}

function reportSnapshot(store: RewardsStore, wallet: string, network: SolanaNetwork, detailLimit: number) {
  const state = store.wallet(network, wallet);
  if (!state) throw new Error('wallet_not_tracked');
  const cutoff = state.cutoff;
  const prices = new Map<string, Price | undefined>();
  // A pass that found no price saves an observation without a value, and must not hide an earlier valued one. Without a
  // valued observation the latest one stays, carrying its reason.
  const priceOf = (mint: string) => {
    const latest = store.price(network, mint);
    return latest?.value !== null && latest?.value !== undefined ? latest : store.latestPrice?.(network, mint) ?? latest;
  };
  /** The valued price's own time, and how long before the fixed cutoff it was taken; null when unpriced. */
  const priceAge = (price: Price | undefined) => {
    if (price?.value === null || price?.value === undefined) return { priceAt: null, priceAgeSeconds: null, priceStale: null };
    const priceAt = price.observedAt ?? price.retrievedAt;
    const time = Date.parse(priceAt);
    const priceAgeSeconds = Number.isFinite(time) ? Math.max(0, cutoff - Math.floor(time / 1000)) : null;
    return { priceAt, priceAgeSeconds, priceStale: priceAgeSeconds === null || priceAgeSeconds > STALE_PRICE_SECONDS };
  };
  interface Amount { mint: string; decimals: number; raw: bigint; count: number; groups: number; lastSignature: string; lastRewardTime: number; evidenceSignature: string }
  const periods = () => ({ rolling: new Map<string, Amount>(), latest: new Map<string, Amount>(), cumulative: new Map<string, Amount>(),
    days: new Map<string, Map<string, Amount>>() });
  const verified = periods(); const attributed = periods();
  const unknownCredits = new Map<string, Amount>();
  const details: (Classification & { evidenceLink: string })[] = [];
  const counts = { confirmed: 0, attributed: 0, excluded: 0, unknown_candidate: 0 };
  const signatureSets = { all: new Set<string>(), confirmed: new Set<string>(), attributed: new Set<string>(),
    excluded: new Set<string>(), unknown_candidate: new Set<string>() };
  const confirmationBasisCounts = { official_feed: 0, same_slot_pattern: 0, verified_historical_authority: 0 };
  const attributionBasisCounts = { feed_witnessed_identity: 0, published_withdraw_authority: 0, withBothTrustSources: 0 };
  const reasonCounts: Record<string, number> = {};
  const unknownReasonCounts: Record<string, number> = {};
  // Rows saved before classifier v3, or awaiting an attribution recheck, were never evaluated for the tier.
  // v3 and v4 both evaluate it, and the v6 requeue covers every signature v4 can classify differently.
  let evaluated = true;
  // Unknown rows saved before classifier v2 carry no destination owner, so their credits cannot be proven.
  let ownerEvidence = true;
  const append = (map: Map<string, Amount>, row: Classification) => {
    const key = `${row.mint!}:${row.decimals!}`;
    const amount = map.get(key) ?? { mint: row.mint!, decimals: row.decimals!, raw: 0n, count: 0, groups: 0, lastSignature: '', lastRewardTime: 0, evidenceSignature: '' };
    if ((row.blockTime ?? 0) >= amount.lastRewardTime) { amount.lastRewardTime = row.blockTime ?? 0; amount.evidenceSignature = row.signature; }
    // Identity v1 orders signatures contiguously; distinct positions remain separate credits.
    if (amount.lastSignature !== row.signature) { amount.groups++; amount.lastSignature = row.signature; }
    amount.raw += BigInt(row.netRaw!); amount.count++; map.set(key, amount);
  };
  let after = '';
  let totalDetails = 0;
  while (true) {
    const rows = store.classifications(network, wallet, after, 500);
    if (!rows.length) break;
    for (const row of rows) {
      evaluated &&= TIER_EVALUATING_VERSIONS.has(row.version) && !row.reasons.includes('attribution_recheck_pending');
      if (row.blockTime !== null && (row.blockTime < state.trackingStart || row.blockTime >= cutoff)) continue;
      counts[row.status]++;
      signatureSets.all.add(row.signature); signatureSets[row.status].add(row.signature);
      if (row.status === 'confirmed' && row.basis && row.basis !== 'distributor_pattern') confirmationBasisCounts[row.basis]++;
      if (row.status === 'attributed' && row.attributionEvidence) {
        attributionBasisCounts[row.attributionEvidence.primaryTrustSource]++;
        if (row.attributionEvidence.trustSources.length > 1) attributionBasisCounts.withBothTrustSources++;
      }
      for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      if (row.status === 'unknown_candidate') for (const reason of row.reasons) unknownReasonCounts[reason] = (unknownReasonCounts[reason] ?? 0) + 1;
      if (row.status === 'unknown_candidate' && row.destinationOwner === undefined) ownerEvidence = false;
      totalDetails++;
      if (details.length < detailLimit) details.push({ ...row, evidenceLink: `https://solscan.io/tx/${row.signature}${network === 'mainnet-beta' ? '' : `?cluster=${network}`}` });
      if (row.mint === null || row.netRaw === null || row.decimals === null) continue;
      // Proven wallet credits that stay unknown: token units only, never priced or counted as rewards.
      if (row.status === 'unknown_candidate' && row.destinationOwner === wallet && BigInt(row.netRaw) > 0n) append(unknownCredits, row);
      if ((row.status !== 'confirmed' && row.status !== 'attributed') || row.blockTime === null) continue;
      const group = row.status === 'confirmed' ? verified : attributed;
      append(group.cumulative, row);
      if (row.blockTime >= cutoff - 604800) append(group.rolling, row);
      if (row.blockTime >= cutoff - 86400) append(group.latest, row);
      const day = new Date(row.blockTime * 1000).toISOString().slice(0, 10);
      const bucket = group.days.get(day) ?? new Map<string, Amount>(); append(bucket, row); group.days.set(day, bucket);
    }
    after = rows.at(-1)!.identity;
  }
  const summarize = (amounts: Map<string, Amount>, sevenDayAverage = false) => {
    let usd: Decimal = { coefficient: 0n, scale: 0 };
    let pricedGroups = 0; let totalGroups = 0;
    const assets = [...amounts.values()].sort((a, b) => a.mint.localeCompare(b.mint) || a.decimals - b.decimals).map(amount => {
      if (!prices.has(amount.mint)) prices.set(amount.mint, priceOf(amount.mint));
      const price = prices.get(amount.mint);
      const meta = store.quote(network, amount.mint);
      totalGroups += amount.groups;
      let currentUsd: string | null = null;
      if (price?.value !== null && price?.value !== undefined) {
        const value = valueOf(amount.raw.toString(), amount.decimals, price.value);
        usd = add(usd, value); currentUsd = rounded(value); pricedGroups += amount.groups;
      }
      return { mint: amount.mint, ...assetLabel(amount.mint, meta),
        decimals: amount.decimals, raw: amount.raw.toString(), amount: displayRaw(amount.raw.toString(), amount.decimals),
        receipts: amount.count, walletCreditGroups: amount.groups, currentUsd, price: price ?? null, ...priceAge(price),
        lastRewardTime: amount.lastRewardTime, evidenceSignature: amount.evidenceSignature };
    });
    const pricedMints = new Set(assets.filter(asset => asset.currentUsd !== null).map(asset => asset.mint)).size;
    const times = assets.flatMap(asset => asset.priceAt === null ? [] : [asset.priceAt]).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { currentUsd: pricedMints ? rounded(usd) : null, dailyAverageUsd: pricedMints && sevenDayAverage ? rounded(usd, 6, 7n) : null,
      assets, unpriced: assets.filter(asset => asset.currentUsd === null),
      pricingCoverage: { pricedWalletCreditGroups: pricedGroups, totalWalletCreditGroups: totalGroups, pricedMints, totalMints: new Set(assets.map(asset => asset.mint)).size },
      // The saved prices behind this figure: the oldest and newest, and how many priced mints are flagged stale.
      priceAges: { oldestPriceAt: times[0] ?? null, newestPriceAt: times.at(-1) ?? null,
        stalePricedMints: new Set(assets.filter(asset => asset.priceStale === true).map(asset => asset.mint)).size } };
  };
  const windows = (group: ReturnType<typeof periods>) => ({
    rolling168h: { startTime: cutoff - 604800, endTime: cutoff, ...summarize(group.rolling, true) },
    latest24h: { startTime: cutoff - 86400, endTime: cutoff, ...summarize(group.latest) },
    cumulative: summarize(group.cumulative),
    utcDays: [...group.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, amounts]) => ({ day, ...summarize(amounts) })),
  });
  const unpriced = (assets: ReturnType<typeof summarize>['unpriced']) => assets.map(asset => ({ mint: asset.mint, symbol: asset.symbol,
    decimals: asset.decimals, raw: asset.raw, amount: asset.amount }));
  const verifiedWindows = windows(verified);
  const attributedWindows = evaluated ? windows(attributed) : null;
  const provenCredits = [...unknownCredits.values()].sort((a, b) => a.mint.localeCompare(b.mint) || a.decimals - b.decimals).map(amount => ({
    mint: amount.mint, symbol: assetLabel(amount.mint, store.quote(network, amount.mint)).symbol, decimals: amount.decimals,
    raw: amount.raw.toString(), amount: displayRaw(amount.raw.toString(), amount.decimals), credits: amount.count }));
  const coverage = store.coverage(network, wallet);
  // Gaps are the days missing from the oldest loaded day to the cutoff. Days before it are not loaded yet, never gaps.
  const gaps = missingRanges(Math.max(HISTORY_FLOOR, state.trackingStart), cutoff, coverage);
  const registry = store.cache<{ complete: boolean; detail: string; retrievedAt: string }>(`registry-status:${network}`)?.value ?? null;
  const job = store.job(wallet, network);
  // Schema v3 adds fields only: price times, ages and stale flags, the price rule, and the loaded history.
  return { schemaVersion: 3, wallet, network, cutoff, lastSync: state.lastSync, trackingStart: state.trackingStart, history: loadedHistory(state),
    dataLabel: store.cache<string>(`dataset:${network}:${wallet}`)?.value ?? 'Provider-attributed evidence; classification and coverage limits apply',
    label: `Rewards tracked since ${new Date(state.trackingStart * 1000).toISOString()}`,
    valuation: 'Timestamped current USD valuation of priced verified receipts, with attributed receipts valued separately; not historical payout-time earnings. Saved prices may be stale.',
    priceRule: PRICE_RULE, stalePriceSeconds: STALE_PRICE_SECONDS,
    rounding: 'USD: 6 decimal places, round half up after exact aggregation; seven-day average divides by 7 before rounding.',
    // `checked`: loaded time whose full read agreed with a signatures listing; the rest of `completed` was read once.
    coverage: { retrieval: gaps.length ? 'partial' : 'provider_query_exhausted', completed: coverage, gaps, checked: state.checked ?? [],
      classification: 'partial: capped official feed and unknown historical authority validity', registry, verifiedZero: false },
    // Top-level windows keep their verified-only meaning from schema v1.
    ...verifiedWindows,
    counts: { ...counts, attributed: evaluated ? counts.attributed : null },
    uniqueSignatures: { all: signatureSets.all.size, confirmed: signatureSets.confirmed.size, attributed: evaluated ? signatureSets.attributed.size : null,
      excluded: signatureSets.excluded.size, unknown_candidate: signatureSets.unknown_candidate.size },
    confirmationBasisCounts,
    attribution: { evaluated, modelVersion: ATTRIBUTION_MODEL_VERSION, trustSources: TRUST_SOURCES },
    attributionBasisCounts: evaluated ? attributionBasisCounts : null,
    totals: {
      verified: { ...REPORT_GROUPS.verified, rows: counts.confirmed, signatures: signatureSets.confirmed.size, ...verifiedWindows },
      attributed: { ...REPORT_GROUPS.attributed, rows: evaluated ? counts.attributed : null, signatures: evaluated ? signatureSets.attributed.size : null,
        rolling168h: attributedWindows?.rolling168h ?? null, latest24h: attributedWindows?.latest24h ?? null,
        cumulative: attributedWindows?.cumulative ?? null, utcDays: attributedWindows?.utcDays ?? null },
      unknown: { ...REPORT_GROUPS.unknown, rows: counts.unknown_candidate, signatures: signatureSets.unknown_candidate.size,
        provenCredits: ownerEvidence ? { credits: provenCredits.reduce((sum, item) => sum + item.credits, 0),
          mints: new Set(provenCredits.map(item => item.mint)).size, assets: provenCredits } : null },
      unpriced: { ...REPORT_GROUPS.unpriced, verified: unpriced(verifiedWindows.cumulative.unpriced),
        attributed: attributedWindows ? unpriced(attributedWindows.cumulative.unpriced) : null },
    },
    reasonCounts, unknownReasonCounts, details, detailsTruncated: totalDetails > details.length,
    pendingClassification: store.pendingClassifications(network, wallet),
    job: job ? { id: job.id, status: job.status, requests: job.used, limits: job.limits, error: job.error } : null,
  };
}
export function buildReport(store: RewardsStore, wallet: string, network: SolanaNetwork = 'mainnet-beta', detailLimit = 500) {
  return store.atomic(() => reportSnapshot(store, wallet, network, detailLimit));
}
export type RewardsReport = ReturnType<typeof buildReport>;
const utc = (seconds: number) => new Date(seconds * 1000).toISOString();
function attributionDetail(row: RewardsReport['details'][number]): string {
  const evidence = row.attributionEvidence;
  if (!evidence) return '';
  const witnesses = evidence.witnesses;
  const snapshot = evidence.publishedSnapshots.find(item => item.role === 'nearest_at_or_after');
  return `; attribution model=${evidence.modelVersion}, trust=${evidence.trustSources.join('+')}, source owner=${evidence.sourceOwner}`
    + (evidence.lane === 'native_sol' ? `, lane=native_sol, native SOL from system account=${evidence.sourceAta}`
      : `, source ATA=${evidence.sourceAta}`)
    + (witnesses ? `, feed-witnessed ${witnesses.count} official distributions (first ${utc(witnesses.first.blockTime)}, last ${utc(witnesses.last.blockTime)}; `
      + `${witnesses.relation}, ${witnesses.secondsToNearestWitness}s)` : '')
    + (snapshot && evidence.secondsToNearestSnapshot !== null ? `, published authority snapshot ${snapshot.retrievedAt} taken after this payout`
      + ` (nearest snapshot ${evidence.secondsToNearestSnapshot}s away)` : '')
    + (evidence.creditedMintAlsoRetainedLaunch ? ', credited mint is also a retained launch mint' : '');
}
export function humanReport(report: RewardsReport): string {
  const amount = (value: string | null, group: string) => value === null ? `unavailable / no priced ${group} receipts` : `$${value}`;
  const valued = (asset: RewardsReport['cumulative']['assets'][number]) => asset.currentUsd === null ? 'UNPRICED'
    : `$${asset.currentUsd} at ${asset.priceAt ?? 'unknown time'}${asset.priceStale ? ` — STALE, ${asset.priceAgeSeconds ?? 'unknown'} s before the cutoff` : ''}`;
  const totals = report.totals;
  const attributed = totals.attributed;
  const unpricedAttributed = totals.unpriced.attributed;
  return [
    `StonkFun rewards — ${report.wallet}`, report.dataLabel, report.label, `Cutoff: ${new Date(report.cutoff * 1000).toISOString()}`,
    `Last sync: ${report.lastSync ?? 'not completed'}`,
    `Verified — rolling 168 hours: ${amount(report.rolling168h.currentUsd, 'verified')}; daily average (/7): ${amount(report.rolling168h.dailyAverageUsd, 'verified')}`,
    `Verified — latest 24 hours: ${amount(report.latest24h.currentUsd, 'verified')}; tracked cumulative: ${amount(report.cumulative.currentUsd, 'verified')}`,
    attributed.cumulative && attributed.rolling168h && attributed.latest24h && report.attributionBasisCounts
      ? `Attributed — distributor pattern, not verified: rolling 168 hours: ${amount(attributed.rolling168h.currentUsd, 'attributed')}; `
        + `latest 24 hours: ${amount(attributed.latest24h.currentUsd, 'attributed')}; tracked cumulative: ${amount(attributed.cumulative.currentUsd, 'attributed')}; `
        + `${attributed.rows} rows / ${attributed.signatures} signatures (feed-witnessed ${report.attributionBasisCounts.feed_witnessed_identity}; `
        + `published authority ${report.attributionBasisCounts.published_withdraw_authority}; both sources ${report.attributionBasisCounts.withBothTrustSources})`
      : 'Attributed — distributor pattern, not verified: not evaluated (saved rows predate classifier v3 or await an attribution recheck; run reclassify)',
    `Unknown — not counted: ${totals.unknown.rows} rows / ${totals.unknown.signatures} signatures; ${totals.unknown.provenCredits
      ? `${totals.unknown.provenCredits.credits} proven credits in ${totals.unknown.provenCredits.mints} mints (token units only)`
      : 'proven credits not determinable (rows predate owner evidence; run reclassify)'}`,
    `Unpriced — excluded from USD, not zero: verified ${totals.unpriced.verified.length}; attributed ${unpricedAttributed === null ? 'not evaluated' : `${unpricedAttributed.length} assets`}`,
    ...(report.attributionBasisCounts && report.attributionBasisCounts.published_withdraw_authority + report.attributionBasisCounts.withBothTrustSources > 0
      ? [`${TRUST_SOURCES.published_withdraw_authority.label}: ${TRUST_SOURCES.published_withdraw_authority.explanation}`] : []),
    report.valuation, `Retrieval: ${report.coverage.retrieval}; gaps: ${report.coverage.gaps.length}. Classification: ${report.coverage.classification}.`,
    `History: loaded from ${report.history.oldestLoadedDay}${report.history.notLoadedYet
      ? `; ${report.history.notLoadedYet.days} days back to ${utcDay(report.history.floor)} not loaded yet (scan --earlier loads the next ${report.history.nextBatch!.days})`
      : `, the history floor`}.${report.history.lastBatch ? ` Last batch: ${report.history.lastBatch.kind === 'first' ? 'first scan' : 'Load earlier'}, `
        + `${report.history.lastBatch.days} days in ${report.history.lastBatch.elapsedSeconds} s.` : ''}`,
    `Classification rows — confirmed: ${report.counts.confirmed}; attributed (not verified): ${report.counts.attributed ?? 'not evaluated'}; excluded: ${report.counts.excluded}; unknown candidates: ${report.counts.unknown_candidate}.`,
    `Unique signatures — all: ${report.uniqueSignatures.all}; confirmed: ${report.uniqueSignatures.confirmed}; attributed (not verified): ${report.uniqueSignatures.attributed ?? 'not evaluated'}; excluded: ${report.uniqueSignatures.excluded}; unknown candidates: ${report.uniqueSignatures.unknown_candidate}.`,
    `Confirmed basis — exact official feed: ${report.confirmationBasisCounts.official_feed}; same-slot pattern: ${report.confirmationBasisCounts.same_slot_pattern}; verified historical authority: ${report.confirmationBasisCounts.verified_historical_authority}.`,
    `Pending local classification: ${report.pendingClassification.walletSignatures} wallet signatures; ${report.pendingClassification.networkSignatures} network signatures (including authority evidence).`,
    ...report.cumulative.assets.map(asset => `Verified ${asset.symbol} [${asset.mint}]: ${asset.amount} — ${valued(asset)}`),
    ...(attributed.cumulative?.assets ?? []).map(asset => `Attributed (not verified) ${asset.symbol} [${asset.mint}]: ${asset.amount} — ${valued(asset)}`),
    ...report.coverage.gaps.map(gap => `GAP: [${new Date(gap.startTime * 1000).toISOString()}, ${new Date(gap.endTime * 1000).toISOString()})`),
    ...report.details.slice(0, 20).map(row => `${row.status}${row.basis ? ` [${row.basis}${row.attributionEvidence ? `/${row.attributionEvidence.primaryTrustSource}` : ''}]` : ''}: ${row.reasons.join(', ')}; `
      + `gross=${row.grossRaw ?? 'unknown'}, net=${row.netRaw ?? 'unknown'}, decimals=${row.decimals ?? 'unknown'}; `
      + `source=${row.sourceAccount ?? 'unknown'} (${row.sourceOwner ?? 'unknown'}), destination=${row.recipient ?? 'unknown'} (${row.destinationOwner ?? 'unknown'})`
      + (row.authorityEvidence ? `; authority model=${row.authorityEvidence.modelVersion}, epoch=${row.authorityEvidence.epochId}, `
        + `witnesses=${row.authorityEvidence.witnesses.map(item => item.signature).join(',')}` : '')
      + (row.status === 'attributed' ? attributionDetail(row) : '')
      + ` — ${row.evidenceLink}`),
    `Job: ${report.job?.id ?? 'none'} (${report.job?.status ?? 'unknown'}). Use --json for structured evidence and UTC daily buckets.`,
  ].join('\n');
}
