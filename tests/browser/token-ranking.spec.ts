import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// The overview's "Tokens you were paid in" ranking against the synthetic stacked wallet (scripts/fixture-dashboard.mjs): fourteen
// priced tokens worth $15 down to $2 on each of 2026-09-19 and 2026-09-20, and one unpriced token each day.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const OFFLINE = 'http://127.0.0.1:4321';
const STACKED_WALLET = 'GdQqT7k7Br6WCTMFKZGnRMwLsk1tRYT8eRh8zK926uuK'; // Derived from the fixture label 'stacked-wallet'.
const XBTC = '9K86JPJ8MmAjdPRMrd53r2AXon9cgXWHGgJ3vtgHqMd7'; // Derived from 'stacked-quote-XBTC'.
/** The twelve validated token colors, in slot order, and the Other gray. */
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#08a4bd', '#945701', '#a519cb', '#838503'];
const OTHER = '#6b7885';
const LEGEND = ['$XBTC', '$BONK', '$DOGE', '$NEET', '$XMR', '$SPCX', '$STNK', '$USDC', '$WIF', '$JUP', '$PYTH', '$RAY'];

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${OFFLINE}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
/** The stacked wallet on the offline server, where no scan elsewhere sends its synthetic rows to a recheck. Loading it after the
 * remembered wallet clears the period, so the overview opens on 7D, which holds both days. */
const stacked = async (page: Page, hash = '#overview') => {
  await page.goto(`${OFFLINE}/${hash}`);
  await expect(page.locator('.tabs')).toBeVisible();
  await page.getByLabel('Saved wallets').selectOption(STACKED_WALLET);
  await expect(page.locator('.chart-day')).toHaveCount(2);
};
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
const parts = (page: Page) => {
  const ranking = page.locator('.token-ranking');
  return { ranking, heading: ranking.locator('h3'), rows: ranking.locator('tbody').first().locator('tr'), unpriced: ranking.locator('tbody.ranking-unpriced tr'),
    sort: ranking.getByRole('button', { name: /^USD, / }) };
};
const tenths = async (rows: Locator) => (await rows.locator('.ranking-share').allTextContents()).reduce((sum, text) => sum + Math.round(Number(text.replace('%', '')) * 10), 0);
const barColors = (rows: Locator) => rows.locator('.ranking-bar i').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));

test('ranks the period\'s tokens under the daily chart in its colors, sorts by USD, shows every token, and follows the period control', async ({ page }) => {
  const errors = errorsOf(page); await stacked(page);
  const { ranking, heading, rows, unpriced, sort } = parts(page);
  // Directly below the daily chart, in the period's panel.
  await expect(page.locator('.period-panel > .attributed-plot + .token-ranking')).toHaveCount(1);
  await expect(heading).toHaveText('Tokens you were paid in / 7D · 2026-09-15 → 2026-09-21');
  await expect(ranking.locator('.plot-heading p')).toHaveText('Ranked by USD at current prices. A payout does not name the launch it came from, so this ranks reward tokens, not launches.');
  // The top twelve and Other, in the daily chart's colors; $XBTC's $30 of $238 is 12.6%, and Other holds $LATE and $TAIL, $10.
  await expect(rows).toHaveCount(13);
  await expect(rows.locator('.ticker')).toHaveText(LEGEND);
  await expect(rows.first()).toHaveText('$XBTC$30.0012.6%2 receiptsCopy CA');
  await expect(rows.last()).toHaveText('Other · 2 tokens$10.004.2%4 receipts');
  expect(await tenths(rows)).toBe(1000);
  expect(await barColors(rows)).toEqual([...COLORS, OTHER].map(rgb));
  expect(await page.locator('.token-legend .token-swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))).toEqual([...COLORS, OTHER].map(rgb));
  // The unpriced token follows the bars, marked, with no bar.
  await expect(unpriced).toHaveText(['$NOPRUNPRICED—2 receiptsCopy CA']);
  await expect(unpriced.locator('.ranking-bar')).toHaveCount(0);
  await expect(ranking.getByRole('button', { name: 'Copy $XBTC contract address' })).toBeVisible();
  await ranking.screenshot({ path: screenshot('ux-ranking.png') });
  // The USD header turns it lowest first, Other still after the tokens, and back.
  await expect(sort).toHaveText('USD ▼');
  await sort.click();
  await expect(sort).toHaveText('USD ▲');
  await expect(sort).toHaveAccessibleName('USD, lowest first. Sort highest first');
  await expect(rows.first()).toHaveText('$RAY$8.003.4%2 receiptsCopy CA');
  await expect(rows.last()).toContainText('Other · 2 tokens');
  await sort.click();
  await expect(rows.first()).toContainText('$XBTC');
  // Every token: the fourteen priced ones, the two past the twelfth in Other's gray, then the unpriced one.
  await ranking.getByRole('button', { name: 'Show all 15 tokens' }).click();
  await expect(rows).toHaveCount(14);
  await expect(rows.nth(12)).toHaveText('$LATE$6.002.5%2 receiptsCopy CA');
  await expect(rows.nth(13)).toHaveText('$TAIL$4.001.7%2 receiptsCopy CA');
  expect(await tenths(rows)).toBe(1000);
  expect((await barColors(rows)).slice(12)).toEqual([OTHER, OTHER].map(rgb));
  await expect(unpriced).toHaveCount(1);
  await ranking.screenshot({ path: screenshot('ux-ranking-all.png') });
  await ranking.getByRole('button', { name: 'Show the top 12 and Other' }).click();
  await expect(rows).toHaveCount(13);
  // The period control: ALL covers both days too; a custom range from 2026-09-20 holds the second day alone.
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(heading).toHaveText('Tokens you were paid in / ALL · 2026-08-01 → 2026-09-21');
  await expect(rows.first()).toHaveText('$XBTC$30.0012.6%2 receiptsCopy CA');
  await page.getByRole('button', { name: 'CUSTOM', exact: true }).click();
  await page.getByLabel('From · UTC').fill('2026-09-20');
  await expect(page).toHaveURL(/#overview\?period=custom&from=2026-09-20&to=2026-09-21$/);
  await expect(heading).toHaveText('Tokens you were paid in / Custom · 2026-09-20 → 2026-09-21');
  await expect(rows.first()).toHaveText('$XBTC$15.0012.6%1 receiptCopy CA');
  await expect(rows.last()).toHaveText('Other · 2 tokens$5.004.2%2 receipts');
  await expect(unpriced).toHaveText(['$NOPRUNPRICED—1 receiptCopy CA']);
  expect(await barColors(rows)).toEqual([...COLORS, OTHER].map(rgb));
  // A custom range with no receipts.
  await page.getByLabel('From · UTC').fill('2026-09-02');
  await page.getByLabel('To · UTC').fill('2026-09-03');
  await expect(heading).toHaveText('Tokens you were paid in / Custom · 2026-09-02 → 2026-09-03');
  await expect(ranking.locator('.ranking-empty')).toHaveText('No attributed receipts in this period.');
  expect(errors).toEqual([]);
});

test('a ranked ticker opens Payouts filtered to that token, highest USD first, and Copy CA copies its full mint', async ({ page, context }) => {
  const errors = errorsOf(page); await stacked(page);
  const { ranking } = parts(page);
  await ranking.getByRole('button', { name: '$BONK: list its payouts, highest USD first' }).click();
  await expect(page).toHaveURL(/#payouts\?token=[1-9A-HJ-NP-Za-km-z]+%3A6&sort=usd-desc$/);
  await expect(page.getByRole('combobox', { name: 'Token', exact: true }).locator('option:checked')).toHaveText(/^\$BONK · /);
  await expect(page.locator('.payouts-panel .panel-heading > .muted')).toHaveText('HIGHEST USD FIRST · UNPRICED LAST · EACH OPENS ITS EVIDENCE');
  const rows = page.locator('.receipt-table tbody tr');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) await expect(row).toContainText('$BONK');
  await expect(rows.first().locator('td').nth(3)).toHaveText('$14.00');
  await page.screenshot({ path: screenshot('ux-ranking-payouts.png') });
  // Back on the overview, each ranked token and the unpriced one copy their full mint.
  await page.goBack();
  await expect(ranking.getByRole('button', { name: /^Copy .* contract address$/ })).toHaveCount(13);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ranking.getByRole('button', { name: 'Copy $XBTC contract address' }).click();
  await expect(ranking.getByRole('button', { name: 'Copy $XBTC contract address' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(XBTC);
  expect(errors).toEqual([]);
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('stacks each ranked row across the full width without sideways scrolling, and a tapped ticker still opens its payouts', async ({ page }) => {
    const errors = errorsOf(page); await stacked(page);
    const { ranking, rows, sort } = parts(page);
    await ranking.scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(13);
    await expect(sort).toBeVisible();
    const scroll = (await ranking.locator('.ranking-scroll').boundingBox())!;
    for (const row of (await rows.all()).slice(0, 3)) {
      const [box, bar, token, value] = await Promise.all([row.boundingBox(), row.locator('.ranking-bar-cell').boundingBox(), row.locator('.ranking-token').boundingBox(), row.locator('.ranking-usd').boundingBox()]);
      expect(Math.abs(box!.width - scroll.width)).toBeLessThanOrEqual(1);
      // The bar takes its own line, the row's full width, under the ticker and USD.
      expect(Math.abs(bar!.width - box!.width)).toBeLessThanOrEqual(1);
      expect(bar!.y).toBeGreaterThanOrEqual(Math.max(token!.y + token!.height, value!.y + value!.height) - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ranking.screenshot({ path: screenshot('ux-ranking-mobile.png') });
    await ranking.getByRole('button', { name: '$XBTC: list its payouts, highest USD first' }).tap();
    await expect(page).toHaveURL(new RegExp(`#payouts\\?token=${XBTC}%3A6&sort=usd-desc$`));
    await expect(page.locator('.receipt-table tbody tr')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
});
