import type { RewardsReport } from '../scanner/report.js';
import { decimal, displayRaw, rounded, valueOf } from '../scanner/decimal.js';
import type { AttributionTrustSource } from '../scanner/types.js';
import type { HistoryHolding, HoldingsSnapshot } from '../scanner/holdings.js';
import { stonkfunTokenLink } from './links.js';

const text = (value: string, fallback: string) => /^[\p{L}\p{N} $._()+-]{1,100}$/u.test(value) ? value : fallback;
const signature = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) ? value : null;
const safeReasons = new Set([
  'missing_official_distribution', 'missing_transaction', 'failed_transaction', 'conflicting_feed_rows',
  'feed_provenance_unresolved', 'conflicting_transaction_evidence', 'conflicting_identity_evidence',
  'missing_transfer_observation', 'no_supported_transfers', 'unresolved_normalization', 'uninterpreted_activity',
  'unexplained_native_movement', 'mint_mismatch', 'amount_mismatch', 'feed_fee_semantics_unresolved',
  'unproven_net_credit', 'ambiguous_attribution', 'recipient_participation', 'unsupported_authority_pattern',
  'conflicting_evidence_quarantined', 'self_or_outgoing_transfer', 'wallet_participation',
  'recipient_ownership_unresolved', 'positive_credit_unproven', 'reward_quote_unverified', 'timestamp_missing',
  'payout_origin_unverified', 'ordering_unavailable', 'no_supported_credit',
  'authority_recheck_pending', 'support_recheck_pending', 'attribution_recheck_pending',
  'distributor_credit_unreconciled', 'distributor_trust_unestablished', 'distributor_source_not_ata',
  'distributor_signer_shape_unsupported', 'wallet_in_account_keys', 'distributor_identity_conflicted',
  'distributor_attribution_revoked', 'published_authority_rotation_ambiguous', 'published_authority_snapshot_pending',
  'distributor_native_source_unsupported', 'native_credit_from_distributor_unproven',
  'no_token_credit_to_wallet', 'zero_value_token_credit', 'credit_without_supported_transfer_instruction',
]);
/** Every reason code the projection passes through; any other code is dropped. */
export const KNOWN_REASONS: ReadonlySet<string> = safeReasons;
const address = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
const instant = (value: string | undefined) => value !== undefined && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const txLink = (value: string | undefined) => value !== undefined && signature(value) ? `https://solscan.io/tx/${value}` : null;
const TRUST_ORDER: AttributionTrustSource[] = ['feed_witnessed_identity', 'published_withdraw_authority'];
const reasons = (value: Record<string, number>) => Object.entries(value)
  .filter(([key]) => safeReasons.has(key)).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([reason, count]) => ({ reason, count }));
/** Exact order of two nonnegative decimal strings, such as the report's USD figures. */
function compareExact(a: string, b: string) {
  const left = decimal(a); const right = decimal(b); const scale = Math.max(left.scale, right.scale);
  const x = left.coefficient * 10n ** BigInt(scale - left.scale); const y = right.coefficient * 10n ** BigInt(scale - right.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Highest USD first; an unpriced value (null) after every priced one. */
const byUsd = (a: string | null, b: string | null) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : compareExact(b, a);
const utcDay = (time: number) => new Date(time * 1000).toISOString().slice(0, 10);
/** Attributed receipts listed individually, newest first. Totals, day buckets and token figures always cover every row. */
export const RECEIPT_LIMIT = 10_000;

/** Explicit browser DTO. Never serialize raw provider objects, config, errors or source URLs. */
export function reportView(report: RewardsReport) {
  const summary = (value: RewardsReport['cumulative']) => ({
    currentUsd: value.currentUsd, dailyAverageUsd: value.dailyAverageUsd,
    unpricedCount: value.unpriced.length, pricedCount: value.pricingCoverage.pricedMints, priceAges: value.priceAges,
  });
  /** The report's price time for a priced figure, how long before the cutoff it was taken, and whether that makes it stale. */
  const priceOf = (asset: RewardsReport['cumulative']['assets'][number]) => ({ priceAt: instant(asset.priceAt ?? undefined),
    priceAgeSeconds: asset.priceAgeSeconds, priceStale: asset.priceStale });
  // The dashboard service passes every detail record. The unknown and confirmed samples keep their documented bound,
  // the first 500 records; attributed evidence and per-mint trust sources use every attributed row, newest first.
  const sample = report.details.slice(0, 500);
  const attributed = report.details.filter(row => row.status === 'attributed')
    .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0) || a.identity.localeCompare(b.identity));
  const assetKey = (mint: string | null, decimals: number | null) => `${mint}:${decimals}`;
  const symbols = new Map((report.totals.attributed.cumulative?.assets ?? []).map(asset => [assetKey(asset.mint, asset.decimals), text(asset.symbol, 'TOKEN')]));
  const trust = new Map<string, Set<AttributionTrustSource>>();
  for (const row of attributed) {
    const sources = trust.get(assetKey(row.mint, row.decimals)) ?? new Set();
    for (const source of row.attributionEvidence?.trustSources ?? []) sources.add(source);
    trust.set(assetKey(row.mint, row.decimals), sources);
  }
  const attributionOf = (row: RewardsReport['details'][number]) => row.attributionEvidence ? {
    modelVersion: text(row.attributionEvidence.modelVersion, 'unavailable'),
    // Absent on every row recorded before the native lane, all of which are the token lane.
    lane: row.attributionEvidence.lane ?? 'token',
    primaryTrustSource: row.attributionEvidence.primaryTrustSource, trustSources: row.attributionEvidence.trustSources,
    sourceOwner: address(row.attributionEvidence.sourceOwner), sourceAta: address(row.attributionEvidence.sourceAta),
    witnessCount: row.attributionEvidence.witnesses?.count ?? 0,
    firstWitnessTime: row.attributionEvidence.witnesses?.first.blockTime ?? null,
    lastWitnessTime: row.attributionEvidence.witnesses?.last.blockTime ?? null,
    witnessRelation: row.attributionEvidence.witnesses?.relation ?? null,
    secondsToNearestWitness: row.attributionEvidence.witnesses?.secondsToNearestWitness ?? null,
    snapshotRetrievedAt: instant(row.attributionEvidence.publishedSnapshots.find(item => item.role === 'nearest_at_or_after')?.retrievedAt),
    secondsToNearestSnapshot: row.attributionEvidence.secondsToNearestSnapshot,
    creditedMintAlsoRetainedLaunch: row.attributionEvidence.creditedMintAlsoRetainedLaunch,
    firstWitnessLink: txLink(row.attributionEvidence.witnesses?.first.signature),
    lastWitnessLink: txLink(row.attributionEvidence.witnesses?.last.signature),
    batch: { outerTransfersFromSource: row.attributionEvidence.batch.outerTransfersFromSource,
      transfersFromSource: row.attributionEvidence.batch.transfersFromSource,
      distinctRecipientOwners: row.attributionEvidence.batch.distinctRecipientOwners },
  } : null;
  // Dashboard-only projections, all additive: per-day token buckets, individual receipts, token detail lists, trust
  // identities and exclusion reasons. Null wherever the attributed tier is not evaluated, never an empty zero.
  const evaluated = report.attribution.evaluated;
  const complete = !report.detailsTruncated;
  const priced = new Map((report.totals.attributed.cumulative?.assets ?? []).map(asset => [assetKey(asset.mint, asset.decimals), asset.price?.value ?? null]));
  const occurrences = new Map<string, number>();
  const receipts = attributed.slice(0, RECEIPT_LIMIT).map((row, index) => {
    const key = assetKey(row.mint, row.decimals);
    const exact = row.netRaw !== null && /^\d+$/.test(row.netRaw) && row.decimals !== null;
    const price = priced.get(key) ?? null;
    const valid = signature(row.signature);
    const occurrence = occurrences.get(row.signature) ?? 0; occurrences.set(row.signature, occurrence + 1);
    return {
      // One signature can carry several credits; its rows keep their stable identity order.
      id: valid ? `${valid}:${occurrence}` : `receipt-${index}`, signature: valid, evidenceLink: txLink(row.signature),
      time: row.blockTime, day: row.blockTime === null ? null : utcDay(row.blockTime),
      asset: key, mint: row.mint, mintAddress: row.mint === null ? null : address(row.mint), symbol: symbols.get(key) ?? null,
      decimals: row.decimals, netRaw: row.netRaw, amount: exact ? displayRaw(row.netRaw!, row.decimals!) : null,
      // This receipt's exact amount at its mint's saved current price, rounded like every report figure. Not a payout-time value.
      currentUsd: exact && price !== null ? rounded(valueOf(row.netRaw!, row.decimals!, price)) : null,
      attribution: attributionOf(row),
    };
  });
  const listed = new Map<string, string[]>();
  for (const receipt of receipts) { const ids = listed.get(receipt.asset) ?? []; ids.push(receipt.id); listed.set(receipt.asset, ids); }
  const firstReceipt = new Map<string, number>();
  for (const row of attributed) if (row.blockTime !== null) firstReceipt.set(assetKey(row.mint, row.decimals), row.blockTime);
  interface Identity {
    owner: string | null; rows: number; tokens: Set<string>; sources: Map<AttributionTrustSource, number>;
    firstReceiptTime: number | null; lastReceiptTime: number | null; counts: number[];
    firstWitness: { time: number; link: string | null } | null; lastWitness: { time: number; link: string | null } | null;
    snapshots: Map<string, number>;
  }
  const identities = new Map<string, Identity>();
  for (const row of attributed) {
    const evidence = row.attributionEvidence;
    if (!evidence) continue;
    const owner = address(evidence.sourceOwner);
    const identity: Identity = identities.get(owner ?? '') ?? { owner, rows: 0, tokens: new Set(), sources: new Map(), firstReceiptTime: null, lastReceiptTime: null,
      counts: [], firstWitness: null, lastWitness: null, snapshots: new Map() };
    identity.rows++; identity.tokens.add(assetKey(row.mint, row.decimals));
    for (const source of evidence.trustSources) identity.sources.set(source, (identity.sources.get(source) ?? 0) + 1);
    if (row.blockTime !== null) {
      identity.firstReceiptTime = Math.min(identity.firstReceiptTime ?? row.blockTime, row.blockTime);
      identity.lastReceiptTime = Math.max(identity.lastReceiptTime ?? row.blockTime, row.blockTime);
    }
    const witnesses = evidence.witnesses;
    if (witnesses) {
      identity.counts.push(witnesses.count);
      if (!identity.firstWitness || witnesses.first.blockTime < identity.firstWitness.time) identity.firstWitness = { time: witnesses.first.blockTime, link: txLink(witnesses.first.signature) };
      if (!identity.lastWitness || witnesses.last.blockTime > identity.lastWitness.time) identity.lastWitness = { time: witnesses.last.blockTime, link: txLink(witnesses.last.signature) };
    }
    const snapshot = instant(evidence.publishedSnapshots.find(item => item.role === 'nearest_at_or_after')?.retrievedAt);
    if (snapshot) identity.snapshots.set(snapshot, (identity.snapshots.get(snapshot) ?? 0) + 1);
    identities.set(owner ?? '', identity);
  }
  const conflicted = new Map<string, { owner: string | null; rows: number; lastTime: number | null; evidenceLink: string | null }>();
  const excludedReasons: Record<string, number> = {};
  for (const row of report.details) {
    if (row.status === 'excluded') for (const reason of row.reasons) excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    if (!row.reasons.includes('distributor_identity_conflicted')) continue;
    const owner = row.sourceOwner === null ? null : address(row.sourceOwner);
    const item = conflicted.get(owner ?? '') ?? { owner, rows: 0, lastTime: null, evidenceLink: null };
    item.rows++;
    if (row.blockTime !== null && (item.lastTime === null || row.blockTime >= item.lastTime)) { item.lastTime = row.blockTime; item.evidenceLink = txLink(row.signature); }
    conflicted.set(owner ?? '', item);
  }
  return {
    wallet: report.wallet, cutoff: report.cutoff, trackingStart: report.trackingStart, lastSync: report.lastSync, history: report.history,
    synthetic: report.dataLabel.startsWith('SYNTHETIC DEMO'),
    // Verified/unknown/excluded keep their existing DTO shape; attributed data is projected separately.
    counts: { confirmed: report.counts.confirmed, excluded: report.counts.excluded, unknown_candidate: report.counts.unknown_candidate },
    uniqueSignatures: { all: report.uniqueSignatures.all, confirmed: report.uniqueSignatures.confirmed,
      excluded: report.uniqueSignatures.excluded, unknown_candidate: report.uniqueSignatures.unknown_candidate },
    confirmationBasisCounts: report.confirmationBasisCounts, pendingClassification: report.pendingClassification,
    cumulative: summary(report.cumulative), rolling168h: summary(report.rolling168h),
    utcDays: report.utcDays.map(day => ({ day: day.day, currentUsd: day.currentUsd, unpricedCount: day.unpriced.length })),
    coverage: { completed: report.coverage.completed, gaps: report.coverage.gaps, checked: report.coverage.checked, verifiedZero: false as const },
    unknownReasons: reasons(report.unknownReasonCounts),
    unknownCandidates: sample.filter(row => row.status === 'unknown_candidate').slice(0, 20).map(row => ({
      mint: row.mint, time: row.blockTime, reasons: row.reasons.filter(reason => safeReasons.has(reason)),
      evidenceLink: signature(row.signature) ? `https://solscan.io/tx/${row.signature}` : null,
    })),
    confirmedEvidence: sample.filter(row => row.status === 'confirmed').slice(0, 20).map(row => ({
      mint: row.mint, time: row.blockTime, basis: row.basis,
      evidenceLink: signature(row.signature) ? `https://solscan.io/tx/${row.signature}` : null,
      authority: row.authorityEvidence ? {
        modelVersion: text(row.authorityEvidence.modelVersion, 'unavailable'),
        epochId: text(row.authorityEvidence.epochId, 'unavailable'),
        validAfter: row.authorityEvidence.validAfter, validBefore: row.authorityEvidence.validBefore,
        witnesses: row.authorityEvidence.witnesses.map(item => signature(item.signature)).filter(item => item !== null),
      } : null,
    })),
    // Full addresses only: look-alike senders share leading and trailing characters.
    attributedEvidence: attributed.slice(0, 500).map(row => ({
      mint: row.mint, symbol: symbols.get(assetKey(row.mint, row.decimals)) ?? null, time: row.blockTime, netRaw: row.netRaw, decimals: row.decimals,
      amount: row.netRaw !== null && /^\d+$/.test(row.netRaw) && row.decimals !== null ? displayRaw(row.netRaw, row.decimals) : null, basis: row.basis,
      evidenceLink: signature(row.signature) ? `https://solscan.io/tx/${row.signature}` : null,
      attribution: attributionOf(row),
    })),
    // Exclusion reasons over every excluded row; null rather than partial when the caller truncated the detail records.
    excludedReasons: complete ? reasons(excludedReasons) : null,
    assets: report.cumulative.assets.map(asset => {
      const rolling = report.rolling168h.assets.find(item => item.mint === asset.mint && item.decimals === asset.decimals);
      const evidence = signature(asset.evidenceSignature);
      return { mint: asset.mint, symbol: text(asset.symbol, 'TOKEN'), name: text(asset.name, 'Unknown token'),
        raw: asset.raw, decimals: asset.decimals, amount: asset.amount, currentUsd: asset.currentUsd,
        sevenDayRaw: rolling?.raw ?? '0', sevenDayAmount: rolling?.amount ?? '0', sevenDayUsd: rolling?.currentUsd ?? null,
        receipts: asset.receipts, lastRewardTime: asset.lastRewardTime, ...priceOf(asset),
        evidenceLink: evidence ? `https://solscan.io/tx/${evidence}` : null };
    }),
    // Schema v2 groups, projected separately. Null attributed values mean not evaluated, never zero.
    verifiedTotals: { label: report.totals.verified.label, explanation: report.totals.verified.explanation,
      rows: report.totals.verified.rows, signatures: report.totals.verified.signatures },
    attribution: {
      evaluated: report.attribution.evaluated, modelVersion: text(report.attribution.modelVersion, 'unavailable'),
      // Rows demoted by new trust evidence and awaiting reclassification; they also make `evaluated` false.
      recheckPending: report.reasonCounts.attribution_recheck_pending ?? 0,
      // The dashboard names the tier Attributed alone; the report's own label and the CLI wording are unchanged.
      label: 'Attributed', explanation: report.totals.attributed.explanation,
      rows: report.totals.attributed.rows, signatures: report.totals.attributed.signatures,
      basisCounts: report.attributionBasisCounts,
      trustSources: {
        feed_witnessed_identity: report.attribution.trustSources.feed_witnessed_identity,
        published_withdraw_authority: report.attribution.trustSources.published_withdraw_authority,
      },
      cumulative: report.totals.attributed.cumulative ? summary(report.totals.attributed.cumulative) : null,
      rolling168h: report.totals.attributed.rolling168h ? summary(report.totals.attributed.rolling168h) : null,
      latest24h: report.totals.attributed.latest24h ? summary(report.totals.attributed.latest24h) : null,
      utcDays: report.totals.attributed.utcDays?.map(day => ({ day: day.day, currentUsd: day.currentUsd, unpricedCount: day.unpriced.length })) ?? null,
      assets: report.totals.attributed.cumulative?.assets.map(asset => ({ mint: asset.mint, symbol: text(asset.symbol, 'TOKEN'),
        name: text(asset.name, 'Unknown token'), raw: asset.raw, decimals: asset.decimals, amount: asset.amount, currentUsd: asset.currentUsd,
        receipts: asset.receipts, lastRewardTime: asset.lastRewardTime, ...priceOf(asset),
        evidenceLink: txLink(asset.evidenceSignature),
        // Exact only when every attributed row is among the detail records; null rather than a partial list.
        trustSources: report.detailsTruncated ? null : TRUST_ORDER.filter(source => trust.get(assetKey(asset.mint, asset.decimals))?.has(source)) })) ?? null,
      // The report's own per-day, per-mint aggregation, highest USD first and unpriced last, for the chart tooltip.
      dayTokens: report.totals.attributed.utcDays?.map(day => ({ day: day.day, currentUsd: day.currentUsd, unpricedCount: day.unpriced.length,
        receipts: day.assets.reduce((sum, asset) => sum + asset.receipts, 0),
        tokens: day.assets.map(asset => ({ key: assetKey(asset.mint, asset.decimals), mint: asset.mint, mintAddress: address(asset.mint), symbol: text(asset.symbol, 'TOKEN'),
          decimals: asset.decimals, raw: asset.raw, amount: asset.amount, currentUsd: asset.currentUsd, receipts: asset.receipts, ...priceOf(asset) }))
          .sort((a, b) => byUsd(a.currentUsd, b.currentUsd) || a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key)) })) ?? null,
      // Individual attributed receipts, newest first, each with its full evidence. `receiptsComplete` is false when the
      // list stops at RECEIPT_LIMIT or the caller truncated the detail records.
      receipts: evaluated ? receipts : null,
      receiptsComplete: evaluated ? complete && attributed.length <= RECEIPT_LIMIT : null,
      // Per-token detail lists in `assets` order: the listed receipt ids, newest first, and the first receipt time.
      tokenDetails: evaluated ? report.totals.attributed.cumulative?.assets.map(asset => {
        const key = assetKey(asset.mint, asset.decimals); const mint = address(asset.mint);
        return { key, mint: asset.mint, decimals: asset.decimals, mintAddress: mint, tokenLink: mint ? `https://solscan.io/token/${mint}` : null,
          receipts: asset.receipts, receiptIds: listed.get(key) ?? [], firstReceiptTime: firstReceipt.get(key) ?? null };
      }) ?? null : null,
      // Each sending identity behind the attributed rows, most rows first: trust sources, witnesses and snapshot times.
      identities: evaluated && complete ? [...identities.values()].sort((a, b) => b.rows - a.rows || (a.owner ?? '').localeCompare(b.owner ?? '')).map(item => ({
        owner: item.owner, accountLink: item.owner ? `https://solscan.io/account/${item.owner}` : null, rows: item.rows, tokens: item.tokens.size,
        trustSources: TRUST_ORDER.filter(source => item.sources.has(source)),
        rowsBySource: { feed_witnessed_identity: item.sources.get('feed_witnessed_identity') ?? 0,
          published_withdraw_authority: item.sources.get('published_withdraw_authority') ?? 0 },
        firstReceiptTime: item.firstReceiptTime, lastReceiptTime: item.lastReceiptTime,
        witnesses: item.firstWitness && item.lastWitness ? { countMin: Math.min(...item.counts), countMax: Math.max(...item.counts),
          firstTime: item.firstWitness.time, firstLink: item.firstWitness.link, lastTime: item.lastWitness.time, lastLink: item.lastWitness.link } : null,
        snapshots: [...item.snapshots].sort(([a], [b]) => a.localeCompare(b)).map(([retrievedAt, rows]) => ({ retrievedAt, rows })),
      })) : null,
      // Rows refused attribution because their sender's identity is conflicted or locally revoked. Owners are null when truncated.
      conflicts: { rows: report.reasonCounts.distributor_identity_conflicted ?? 0, revokedRows: report.reasonCounts.distributor_attribution_revoked ?? 0,
        owners: complete ? [...conflicted.values()].sort((a, b) => b.rows - a.rows || (a.owner ?? '').localeCompare(b.owner ?? '')) : null },
    },
    unknownTotals: { label: report.totals.unknown.label, explanation: report.totals.unknown.explanation,
      rows: report.totals.unknown.rows, signatures: report.totals.unknown.signatures,
      provenCredits: report.totals.unknown.provenCredits ? { credits: report.totals.unknown.provenCredits.credits, mints: report.totals.unknown.provenCredits.mints,
        assets: report.totals.unknown.provenCredits.assets.map(asset => ({ mint: asset.mint, symbol: text(asset.symbol, 'TOKEN'),
          decimals: asset.decimals, raw: asset.raw, amount: asset.amount, credits: asset.credits })) } : null },
    unpriced: { label: report.totals.unpriced.label, explanation: report.totals.unpriced.explanation,
      verified: report.totals.unpriced.verified.map(asset => ({ mint: asset.mint, symbol: text(asset.symbol, 'TOKEN'), decimals: asset.decimals, raw: asset.raw, amount: asset.amount })),
      attributed: report.totals.unpriced.attributed?.map(asset => ({ mint: asset.mint, symbol: text(asset.symbol, 'TOKEN'), decimals: asset.decimals, raw: asset.raw, amount: asset.amount })) ?? null },
    pricingCoverage: { verified: report.totals.verified.cumulative.pricingCoverage, attributed: report.totals.attributed.cumulative?.pricingCoverage ?? null },
  };
}
export type DashboardReport = ReturnType<typeof reportView>;

export { walletHoldings } from '../scanner/holdings.js';
export type { WalletTokenBalance } from '../scanner/holdings.js';
/** Retained data behind the likely-source launches. Nothing here is fetched: it is read from saved evidence. */
export interface RetainedLaunchData {
  /** For each of the wallet's reward quote mints, the launches that retained /rewards summaries name, with the latest retrieval. */
  summaries: ReadonlyMap<string, readonly { launchMint: string; retrievedAt: string }[]>;
  /** What the wallet's retained transactions show it holding, per mint: stored by the last refresh, or computed from them. */
  holdings: ReadonlyMap<string, HistoryHolding>;
  /** The wallet's holdings as the last complete snapshot read them, when a refresh stored one. */
  snapshot: HoldingsSnapshot | null;
  /** A launch mint's retained symbol and name, when a metadata record exists for it. */
  launchMetadata: (mint: string) => { symbol?: string | undefined; name?: string | undefined } | undefined;
  /** The official feed rows retained for a confirmed receipt's signature: each names a launch and the quote mint it paid. */
  feedRows: (signature: string) => readonly { launchMint: string; quoteMint: string }[];
}
export { stonkfunTokenLink } from './links.js';
/** A snapshot's on-chain name or symbol, when it is plain text. */
const plain = (value: string | null | undefined) => typeof value === 'string' && /^[\p{L}\p{N} $._()+-]{1,100}$/u.test(value) ? value : null;
/** For each attributed and verified token, the launches it may have come from. The likely ones are reward-mode launches whose
 * retained /rewards summary names the token as their quote mint, among the launch mints the wallet's retained transactions show
 * it holding at some point. The exact ones are launches the official feed names for the token's confirmed receipts. Null when
 * the store cannot supply the retained data; attributed tokens are listed only while the tier is evaluated. */
export function sourcesView(report: RewardsReport, retained: RetainedLaunchData | null) {
  if (!retained) return null;
  const { holdings, snapshot } = retained;
  const current = new Map(snapshot?.tokens.map(token => [token.mint, token]) ?? []);
  const snapshotTime = snapshot ? Math.floor(Date.parse(snapshot.takenAt) / 1000) : null;
  /** A launch's symbol and name: retained StonkFun metadata first, then the snapshot's on-chain metadata. */
  const names = (mint: string) => {
    const meta = retained.launchMetadata(mint); const held = current.get(mint);
    return { symbol: meta?.symbol !== undefined ? text(meta.symbol, 'TOKEN') : plain(held?.symbol),
      name: meta?.name !== undefined ? text(meta.name, 'Unknown token') : plain(held?.name) };
  };
  const launch = (mint: string) => {
    const valid = address(mint);
    return { mint: valid ?? mint, ...names(mint), stonkfunLink: valid ? stonkfunTokenLink(valid) : null, tokenLink: valid ? `https://solscan.io/token/${valid}` : null };
  };
  /** Holding now when the snapshot holds it, or, without a snapshot as recent as the wallet's last trade of it, when its retained
   * transactions end with a balance. Held earlier and sold when only the transactions show a balance. */
  const held = (mint: string) => {
    const now = current.get(mint); const past = holdings.get(mint);
    if (now) return { raw: now.raw, decimals: now.decimals, amount: displayRaw(now.raw, now.decimals), holding: true, source: 'snapshot' as const,
      lastSeen: snapshotTime, evidenceLink: past ? txLink(past.signature) : null };
    if (!past?.everHeld) return null;
    const sold = past.raw === 0n || (snapshotTime !== null && (past.time === null || past.time <= snapshotTime));
    const raw = sold ? '0' : past.raw.toString();
    return { raw, decimals: past.decimals, amount: displayRaw(raw, past.decimals), holding: !sold, source: 'history' as const,
      lastSeen: past.time, evidenceLink: txLink(past.signature) };
  };
  // Without a snapshot, the holdings are as of the latest retained transaction they rest on.
  const historyTime = [...holdings.values()].reduce<number | null>((latest, item) => item.time !== null && (latest === null || item.time > latest) ? item.time : latest, null);
  // Launch mints the official feed names for each token's confirmed exact-feed receipts, with how many receipts name each.
  const exact = new Map<string, Map<string, number>>();
  for (const row of report.details) {
    if (row.status !== 'confirmed' || row.basis !== 'official_feed' || row.mint === null || row.decimals === null) continue;
    const key = `${row.mint}:${row.decimals}`;
    const named = new Set(retained.feedRows(row.signature).filter(item => item.quoteMint === row.mint).map(item => item.launchMint));
    const counts = exact.get(key) ?? new Map<string, number>();
    for (const mint of named) counts.set(mint, (counts.get(mint) ?? 0) + 1);
    exact.set(key, counts);
  }
  const tokens = new Map<string, { mint: string; decimals: number; symbol: string; group: 'attributed' | 'verified' }>();
  for (const asset of report.cumulative.assets) tokens.set(`${asset.mint}:${asset.decimals}`, { mint: asset.mint, decimals: asset.decimals, symbol: text(asset.symbol, 'TOKEN'), group: 'verified' });
  for (const asset of report.totals.attributed.cumulative?.assets ?? []) tokens.set(`${asset.mint}:${asset.decimals}`, { mint: asset.mint, decimals: asset.decimals, symbol: text(asset.symbol, 'TOKEN'), group: 'attributed' });
  return { tokens: [...tokens].map(([key, token]) => {
    const summaries = retained.summaries.get(token.mint) ?? [];
    const exactLaunches = [...exact.get(key) ?? []].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([mint, receipts]) => ({ ...launch(mint), receipts }));
    const known = new Set(exactLaunches.map(item => item.mint));
    const likely = summaries.flatMap(summary => {
      const holding = known.has(summary.launchMint) ? null : held(summary.launchMint);
      return holding ? [{ ...launch(summary.launchMint), summaryRetrievedAt: instant(summary.retrievedAt), held: holding }] : [];
    }).sort((a, b) => Number(b.held.holding) - Number(a.held.holding) || (b.held.lastSeen ?? 0) - (a.held.lastSeen ?? 0) || a.mint.localeCompare(b.mint));
    const retrieved = summaries.map(summary => instant(summary.retrievedAt)).filter(value => value !== null).sort();
    // Every launch the summaries name, for the full list: named ones first, then by mint. Names are left out when unknown.
    const launches = summaries.map(summary => ({ mint: summary.launchMint, ...names(summary.launchMint) }))
      .sort((a, b) => Number(b.symbol !== null) - Number(a.symbol !== null) || (a.symbol ?? '').localeCompare(b.symbol ?? '') || a.mint.localeCompare(b.mint))
      .map(item => ({ mint: item.mint, ...item.symbol === null ? {} : { symbol: item.symbol }, ...item.name === null ? {} : { name: item.name } }));
    return { key, mint: token.mint, symbol: token.symbol, group: token.group,
      // Whether any retained /rewards summary names this quote mint at all; false reads "not in retained StonkFun data".
      covered: summaries.length > 0, summaryLaunches: summaries.length, summaryRetrievedAt: retrieved.at(-1) ?? null, likely, exact: exactLaunches, launches };
  }).filter(token => token.group === 'verified' || report.attribution.evaluated),
  // When the holdings are from: the snapshot's time, or else the latest retained transaction they rest on (UTC seconds).
  holdingsAt: snapshot?.takenAt ?? (historyTime === null ? null : new Date(historyTime * 1000).toISOString()),
  holdingsSource: snapshot ? 'snapshot' as const : 'history' as const };
}
export type LaunchSources = NonNullable<ReturnType<typeof sourcesView>>;
