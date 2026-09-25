import { DEMO_CUTOFF, demoData, demoTransaction } from '../../src/cli/demo.js';
import type { DemoData } from '../../src/cli/demo.js';

/** The twelve synthetic reward quote mints of `feedHeavy`, in feed order. */
export const FEED_HEAVY_MINTS = [...'ADEGHJKLMNPQ'].map(char => char.repeat(32));
/** Twelve official distributions to the demo wallet, none in its history, so all twelve are hydrated; each pays a different
 * reward quote mint, and StonkFun prices every other one while the rest fall through to DAS. */
export function feedHeavy(): DemoData {
  const data = demoData();
  data.transactions = [];
  data.official = [...'abcdefghijkm'].map((char, index) =>
    demoTransaction(char, DEMO_CUTOFF - 3600 - index * 60, String((index + 1) * 1_000_000), FEED_HEAVY_MINTS[index]));
  data.prices = Object.fromEntries(FEED_HEAVY_MINTS.map((mint, index) => [mint, index % 2 === 0 ? `${index + 1}.25` : null]));
  return data;
}
