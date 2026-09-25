// Synthetic fixtures based on DATA_SOURCES.md shapes; no wallet history or credentials.
export const at = '2026-09-20T00:00:00.000Z';
export const mint = (letter: string): string => letter.repeat(32);
export const signature = '3'.repeat(88);
export const huge = '184467440737095516159876543210123456789';
export const launch = (id: string, quote = 'Q') => ({
  mint: mint(id), quote: { mint: mint(quote), symbol: 'SAME' }, mode: 'reward',
  launchpad: 'launchlab', transferFee: { bps: 100 }, createdAt: at,
});
export const page = (ids: string[], current = 1, total = ids.length, pageSize = 2, quote = 'Q') => ({
  data: { launches: ids.map((id) => launch(id, quote)), pagination: {
    page: current, pageSize, total, totalPages: Math.ceil(total / pageSize),
  } }, meta: { generatedAt: at },
});
export const summary = (id = 'R', quote = 'Z') => ({
  mint: mint(id), quote: { mint: mint(quote), symbol: 'SAME', decimals: 6 },
  distributedRaw: huge, payoutCount: 3, holderCount: 2, lastPayoutAt: at,
});
export const distribution = (id = 'A', amountRaw = huge) => ({
  signature, mint: mint(id), quoteMint: mint('Q'), amountRaw, holderCount: 2, distributedAt: at,
});
export const rewards = () => ({
  data: { launches: [summary()], recentDistributions: [distribution(), distribution('B', '000123'), distribution()] },
  meta: { generatedAt: at },
});
export const pair = (quote = 'Q') => ({
  mint: mint(quote), symbol: 'SAME', name: 'Synthetic quote', decimals: 9,
  category: 'future-unfamiliar-category', tokenProgram: mint('T'), launchable: false, launchLabReady: false,
});
export const pairs = () => ({ data: { pairs: [pair(), pair('U')] }, meta: { generatedAt: at } });
export const config = () => ({ data: { modes: { reward: { withdrawWithheldAuthority: mint('W') } } }, meta: { generatedAt: at } });
