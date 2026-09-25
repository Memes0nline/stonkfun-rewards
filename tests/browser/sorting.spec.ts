import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// USD sorting against the synthetic stacked wallet (scripts/fixture-dashboard.mjs): fourteen priced tokens worth $15 down to $2
// on each of two days, and one unpriced token each day.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const OFFLINE = 'http://127.0.0.1:4321';
const STACKED_WALLET = 'GdQqT7k7Br6WCTMFKZGnRMwLsk1tRYT8eRh8zK926uuK'; // Derived from the fixture label 'stacked-wallet'.

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${OFFLINE}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
/** The stacked wallet on the offline server, where no scan elsewhere sends its synthetic rows to a recheck. */
const stacked = async (page: Page, tab = 'overview') => {
  await page.goto(`${OFFLINE}/#${tab}`);
  await expect(page.locator('.tabs')).toBeVisible();
  await page.getByLabel('Saved wallets').selectOption(STACKED_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(STACKED_WALLET);
};

test('Payouts sorts by USD from its header, highest then lowest first with unpriced last, over every row, and keeps the sort in the hash', async ({ page }) => {
  const errors = errorsOf(page); await stacked(page, 'payouts');
  const rows = page.locator('.receipt-table tbody tr');
  await expect(rows).toHaveCount(30);
  const caption = page.locator('.payouts-panel .panel-heading > .muted');
  const usdCell = (at: 'first' | 'last') => rows[at]().locator('td').nth(3);
  const header = (name: string) => page.locator('.receipt-table th').filter({ hasText: name });
  // Newest first by default.
  await expect(caption).toHaveText('NEWEST FIRST · EACH OPENS ITS EVIDENCE');
  await expect(header('Date')).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first().locator('td').first()).toContainText('2026-09-20');
  const usd = page.getByRole('button', { name: 'USD', exact: true });
  await usd.click();
  await expect(page).toHaveURL(/#payouts\?sort=usd-desc$/);
  await expect(header('USD')).toHaveAttribute('aria-sort', 'descending');
  await expect(header('USD')).toContainText('USD ▼');
  await expect(caption).toHaveText('HIGHEST USD FIRST · UNPRICED LAST · EACH OPENS ITS EVIDENCE');
  await expect(usdCell('first')).toHaveText('$15.00'); await expect(rows.first()).toContainText('$XBTC');
  await expect(usdCell('last')).toHaveText('Unpriced');
  await usd.click();
  await expect(page).toHaveURL(/#payouts\?sort=usd-asc$/);
  await expect(header('USD')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header('USD')).toContainText('USD ▲');
  await expect(caption).toHaveText('LOWEST USD FIRST · UNPRICED LAST · EACH OPENS ITS EVIDENCE');
  // Equal USD: the newer day first.
  await expect(usdCell('first')).toHaveText('$2.00'); await expect(rows.first()).toContainText('$TAIL'); await expect(rows.first()).toContainText('2026-09-20');
  await expect(usdCell('last')).toHaveText('Unpriced');
  const values = await rows.locator('td:nth-child(4)').allTextContents();
  expect(values.slice(-2)).toEqual(['Unpriced', 'Unpriced']);
  const priced = values.slice(0, -2).map(text => Number(text.replace(/[$,]/g, '')));
  expect(priced).toEqual([...priced].sort((a, b) => a - b));
  await page.screenshot({ path: screenshot('ux-sort-payouts.png') });
  // A filter keeps the sort, and a reload keeps both.
  await page.getByLabel('Price').selectOption('priced');
  await expect(page).toHaveURL(/#payouts\?price=priced&sort=usd-asc$/);
  await expect(rows).toHaveCount(28);
  await expect(usdCell('last')).toHaveText('$15.00');
  await page.reload();
  await expect(caption).toHaveText('LOWEST USD FIRST · UNPRICED LAST · EACH OPENS ITS EVIDENCE');
  await expect(usdCell('first')).toHaveText('$2.00');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/#payouts\?sort=usd-asc$/);
  // Date starts newest first again, which the hash leaves out; a second click turns it oldest first.
  const date = page.getByRole('button', { name: 'Date · UTC', exact: true });
  await date.click();
  await expect(page).toHaveURL(/#payouts$/);
  await expect(caption).toHaveText('NEWEST FIRST · EACH OPENS ITS EVIDENCE');
  await date.click();
  await expect(page).toHaveURL(/#payouts\?sort=date-asc$/);
  await expect(caption).toHaveText('OLDEST FIRST · EACH OPENS ITS EVIDENCE');
  await expect(rows.first().locator('td').first()).toContainText('2026-09-19');
  await expect(rows.last().locator('td').first()).toContainText('2026-09-20');
  expect(errors).toEqual([]);
});

test('a pinned tooltip sorts its tokens by USD from its header, keeps Other after them, and keeps the direction from day to day', async ({ page }) => {
  const errors = errorsOf(page); await stacked(page);
  const days = page.locator('.chart-day');
  await expect(days).toHaveCount(2);
  await days.first().locator('.day-hit').click({ position: { x: 3, y: 3 } });
  const tooltip = page.locator('#day-tooltip');
  await expect(tooltip).toHaveClass(/is-pinned/);
  const rows = tooltip.locator('.tooltip-tokens > li');
  const sort = tooltip.locator('.tooltip-sort .sort');
  await expect(rows).toHaveCount(13);
  // Highest first by default; Other, $5 of $LATE and $TAIL, follows the named tokens.
  await expect(sort).toHaveText('USD ▼');
  await expect(rows.first()).toHaveText('$XBTC12.6%$15.0015.000000Copy CA');
  await expect(rows.last()).toHaveText('Other · 2 tokens ▸4.2%$5.002 receipts');
  await sort.click();
  await expect(tooltip).toHaveClass(/is-pinned/);
  await expect(sort).toHaveText('USD ▲');
  await expect(sort).toHaveAccessibleName('USD, lowest first. Sort highest first');
  await expect(rows.first().locator('> .tooltip-usd')).toHaveText('$4.00');
  await expect(rows.last()).toHaveText('Other · 2 tokens ▸4.2%$5.002 receipts');
  const usd = (await rows.locator('> .tooltip-usd').allTextContents()).slice(0, -1).map(text => Number(text.replace('$', '')));
  expect(usd).toEqual([...usd].sort((a, b) => a - b));
  // Other's own tokens follow the same direction.
  await tooltip.getByRole('button', { name: /^Other · 2 tokens/ }).click();
  await expect(tooltip.locator('.tooltip-others > li .ticker')).toHaveText(['$TAIL', '$LATE']);
  await page.screenshot({ path: screenshot('ux-sort-tooltip.png') });
  await sort.click();
  await expect(sort).toHaveText('USD ▼');
  await expect(rows.first()).toHaveText('$XBTC12.6%$15.0015.000000Copy CA');
  await expect(rows.last()).toContainText('Other · 2 tokens');
  await expect(tooltip.locator('.tooltip-others > li .ticker')).toHaveText(['$LATE', '$TAIL']);
  // Lowest first again, then the other day, which the pinned tooltip covers until Escape closes it: the direction holds, and
  // it holds after a reload for the session.
  await sort.click();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await days.nth(1).locator('.day-hit').click({ position: { x: 3, y: 3 } });
  await expect(tooltip).toContainText('2026-09-20 UTC');
  await expect(sort).toHaveText('USD ▲');
  await expect(rows.first().locator('> .tooltip-usd')).toHaveText('$4.00');
  await page.reload();
  await expect(days).toHaveCount(2);
  await days.first().locator('.day-hit').click({ position: { x: 3, y: 3 } });
  await expect(sort).toHaveText('USD ▲');
  expect(errors).toEqual([]);
});
