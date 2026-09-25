import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { DashboardJob } from '../../src/web/service.js';

// Ignored test output by default; reviewers refresh review/ explicitly with REVIEW_SCREENSHOTS=1.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
// Synthetic attributed tier (scripts/fixture-dashboard.mjs): verified $394.415 / $388.165 / $55.452143 and attributed
// $33.75 / $33.75 / $4.821429 must never appear added together, exactly or to the cents the page shows, nor 8 + 5 rows.
const COMBINED = ['428.165', '421.915', '60.273572', '428.17', '421.92', '60.27', '13 rows'];
const NOT_EVALUATED_WALLET = '9ZwUE4c6zvUBqY5Hc1fKsMQMt4LeyAXiXPCDaCzB4CUj'; // Derived from the fixture label 'not-evaluated-wallet'.
const PUBLISHED_AUTHORITY = 'CQVHwSaZnvV5gfck2TbPmEHg4nh6Abp7tfnSqTbZgm7e'; // Derived from 'published-withdraw-authority'.
const ATTRIBUTED_ONLY_WALLET = 'DgtfZZU9DX3zF9bSxXZAeySDbDGozvgcFW4CYFS2b1xC'; // Derived from 'attributed-only-wallet'.
const TWO_DAY_WALLET = 'CJ95Y7bPnexzZuq7QHktg9Mnav4fqDC6388eQdER8t2Z'; // Derived from 'two-day-boundary-wallet'.
const LONG_WALLET = 'CQoAc2qm84xKDQvN98DGRx4QTobQvfkNSY5qd8MwNXHQ'; // Derived from 'long-history-wallet'.
const TABS = ['overview', 'tokens', 'payouts', 'trust', 'coverage'] as const;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4318/') ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const ready = async (page: Page, hash = '') => { await page.goto(`/${hash}`); await expect(page.locator('.status-button')).toBeVisible(); await expect(page.locator('.tabs')).toBeVisible(); };
/** Opens the header status panel. */
const openStatus = async (page: Page) => {
  await page.locator('.status-button').click();
  const panel = page.getByRole('dialog', { name: 'Status' }); await expect(panel).toBeVisible(); return panel;
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** The day tooltip beside the chart. */
const dayTooltip = (page: Page) => page.locator('#day-tooltip');
/** Pins a chart column with a click just right of its bar, where no tooltip lies, then opens the whole day from the pinned tooltip. */
const openDay = async (page: Page, column: Locator) => {
  const hit = (await column.locator('.day-hit').boundingBox())!;
  await column.locator('.day-hit').click({ position: { x: Math.min(hit.width - 1, hit.width / 2 + 25), y: 3 } });
  await dayTooltip(page).locator('.tooltip-day').click();
};
/** Every external link is a Solscan link that opens without a referrer. */
const safeLinks = (page: Page) => page.locator('a[target="_blank"]').evaluateAll(links => links.every(link => link.getAttribute('rel') === 'noreferrer'
  && link.getAttribute('href')?.startsWith('https://solscan.io/')));

test('the period figure leads the overview, and the status panel opens each group onto its report wording', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  await expect(page.locator('.status-button .status-tag')).toHaveText('SYNTHETIC');
  const hero = page.getByRole('region', { name: 'Reward summary' }).locator('.period-hero');
  await expect(hero.locator('.hero-label .eyebrow')).toHaveText('Attributed');
  await expect(hero.locator('.hero-figure')).toHaveText('$33.75');
  await expect(hero.locator('strong')).toHaveCount(1);
  await expect(hero.locator('.period-caption')).toHaveText('2026-09-15 → 2026-09-21 · 7 days');
  await expect(hero.locator('.hero-figures dt')).toHaveText(['Payouts', 'Tokens', 'Daily average', 'Unpriced · excluded from USD']);
  await expect(hero.locator('.hero-figures dd')).toHaveText(['5', '3', '$4.82', '1 receipt']);
  // Nothing sits between the header and the tabs; the status panel follows no period: the last sync and one row per other group.
  const panel = await openStatus(page);
  await expect(panel.locator('dd').nth(3)).toHaveText(/^2026-/);
  await expect(panel.locator('.status-count summary')).toHaveText(['Verified8 rows', 'Unknown · not counted1 row', 'Excluded1 row', 'Unpriced · excluded from USDverified 1 · attributed 1']);
  // A row opens onto the fixed explanation and exact counts.
  await panel.locator('.status-count summary').filter({ hasText: /^Verified/ }).click();
  const verified = panel.locator('.status-count[open]');
  await expect(verified).toContainText('Confirmed by an exact official StonkFun distribution record');
  await expect(verified.locator('.popover-figures dd')).toHaveText(['8', '8', '$394.42', '$388.17', '$55.45', '1']);
  await panel.locator('.status-count summary').filter({ hasText: /^Excluded/ }).click();
  await expect(panel.locator('.status-count').nth(2).locator('.reason-lines li')).toHaveCount(1);
  await panel.locator('.status-count summary').filter({ hasText: /^Unpriced/ }).click();
  await expect(panel.locator('.status-count').nth(3)).toContainText('Shown in token units only');
  await page.screenshot({ path: screenshot('ux-popover.png') });
  // Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'About Attributed' }).click();
  await expect(page.getByRole('dialog', { name: 'Attributed' })).toContainText('in a snapshot taken after the payouts it covers');
  const text = await page.locator('main').textContent();
  for (const combined of COMBINED) expect(text).not.toContain(combined);
  expect(errors).toEqual([]);
});

test('tabs live in the hash: refresh, links and Back keep them, and arrow keys move between them', async ({ page }) => {
  await ready(page, '#trust');
  await expect(page.getByRole('tab', { name: 'Trust' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-trust');
  await page.reload(); await expect(page.locator('.status-button')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Trust' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await expect(page).toHaveURL(/#tokens$/);
  await page.goBack();
  await expect(page).toHaveURL(/#trust$/);
  await expect(page.getByRole('tab', { name: 'Trust' })).toHaveAttribute('aria-selected', 'true');
  // One tab stop; arrows, Home and End select and focus.
  expect(await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('tabindex')))).toEqual(['-1', '-1', '-1', '0', '-1']);
  await page.getByRole('tab', { name: 'Trust' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Coverage' })).toBeFocused();
  await expect(page).toHaveURL(/#coverage$/);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Coverage' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  // A link with filters lands on the filtered list; malformed hashes fall back to the overview.
  await ready(page, '#payouts?day=2026-09-19&price=priced');
  await expect(page.getByLabel('Day · UTC')).toHaveValue('2026-09-19');
  await expect(page.getByLabel('Price')).toHaveValue('priced');
  await expect(page.locator('.receipt-table tbody tr')).toHaveCount(1);
  await ready(page, '#nowhere?day=<script>');
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
});

test('the overview tooltip lists a day\'s tokens, and the pinned day lists its payouts', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  const day = page.locator('.chart-day').nth(2);
  await expect(page.locator('.chart-day')).toHaveCount(5);
  await day.hover();
  const tooltip = dayTooltip(page);
  await expect(tooltip).toContainText('2026-09-19 UTC');
  await expect(tooltip.locator('.tooltip-total')).toHaveText('$20.00');
  await expect(tooltip.locator('.tooltip-tokens li')).toHaveText(['$ATTRA100.0%$20.0040.000000Copy CA']);
  await expect(tooltip).toContainText('1 receipt');
  // Right beside its bar, never over it, within the plot's height.
  const [plot, bar, box] = await Promise.all([day.locator('.day-hit').boundingBox(), day.locator('.bar-segment').first().boundingBox(), tooltip.boundingBox()]);
  expect(box!.y + box!.height).toBeLessThanOrEqual(plot!.y + plot!.height + 1);
  expect(box!.x - (bar!.x + bar!.width)).toBeGreaterThanOrEqual(0); expect(box!.x - (bar!.x + bar!.width)).toBeLessThanOrEqual(12);
  await page.screenshot({ path: screenshot('ux-tooltip.png') });
  await openDay(page, day);
  await expect(page).toHaveURL(/#payouts\?day=2026-09-19$/);
  await expect(page.getByRole('tab', { name: 'Payouts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.receipt-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.receipt-table tbody tr')).toContainText('40.000000');
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  // Keyboard: focus opens the same tooltip and Enter lists the day. The pointer rests off the chart, so no hover competes.
  await page.mouse.move(0, 0);
  await page.locator('.chart-day').nth(3).focus();
  await expect(dayTooltip(page)).toContainText('2026-09-20 UTC');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#payouts\?day=2026-09-20$/);
  await page.goBack();
  // The overview ends with the period panel: no Top tokens list duplicates the ranking under the daily chart.
  await expect(page.locator('.top-tokens')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Top tokens/ })).toHaveCount(0);
  await page.screenshot({ path: screenshot('ux-fixture-overview.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('a chart day opens only that UTC day\'s payouts, as many as its tooltip counts, and keeps the day until cleared', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  await page.getByLabel('Saved wallets').selectOption(TWO_DAY_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(TWO_DAY_WALLET);
  const days = page.locator('.chart-day');
  await expect(days).toHaveCount(2);
  const rows = page.locator('.receipt-table tbody tr');
  // Three receipts from the first to the last second of 2026-09-19, then two from midnight on 2026-09-20.
  for (const [index, day, expected] of [[0, '2026-09-19', 3], [1, '2026-09-20', 2]] as const) {
    await days.nth(index).hover();
    const tooltip = dayTooltip(page);
    await expect(tooltip).toContainText(`${day} UTC`);
    const count = Number(/^(\d+) receipts?\b/.exec((await tooltip.locator('.tooltip-sub').textContent())!)![1]);
    expect(count).toBe(expected);
    await openDay(page, days.nth(index));
    await expect(page).toHaveURL(new RegExp(`#payouts\\?day=${day}$`));
    await expect(page.locator('.day-banner')).toContainText(`Showing ${day} · ${count} payouts`);
    await expect(page.locator('#payouts-title .count-label')).toHaveText(String(count));
    await expect(rows).toHaveCount(count);
    for (const text of await rows.locator('td:first-child').allTextContents()) expect(text.startsWith(`${day} `)).toBe(true);
    await expect(page.getByLabel('Day · UTC')).toHaveValue(day);
    // Selecting the open tab again keeps the day; Back returns to the chart.
    await page.getByRole('tab', { name: 'Payouts' }).click();
    await expect(page).toHaveURL(new RegExp(`#payouts\\?day=${day}$`));
    await expect(rows).toHaveCount(count);
    await page.goBack();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  }
  // A refreshed link keeps the day; the banner's Clear lists every payout again.
  await openDay(page, days.first());
  await page.reload(); await expect(page.locator('.day-banner')).toContainText('Showing 2026-09-19 · 3 payouts');
  await page.screenshot({ path: screenshot('ux-day-filter.png') });
  await page.getByRole('button', { name: 'Clear the 2026-09-19 day filter' }).click();
  await expect(page).toHaveURL(/#payouts$/);
  await expect(page.locator('.day-banner')).toHaveCount(0);
  await expect(rows).toHaveCount(5);
  await expect(page.locator('#payouts-title .count-label')).toHaveText('5');
  expect(errors).toEqual([]);
});

test('each period moves the hero figures and the chart together, lives in the hash, and a day in it opens only that day', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  await page.getByLabel('Saved wallets').selectOption(LONG_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(LONG_WALLET);
  const hero = page.locator('.period-hero');
  // One noon receipt inside each period and none shorter: $1, $2, $4, $8, $16 and $32, one per day.
  for (const [label, total, caption, payouts, average] of [
    ['7D', '$1.00', '2026-09-15 → 2026-09-21 · 7 days', 1, '$0.14'], ['14D', '$3.00', '2026-09-08 → 2026-09-21 · 14 days', 2, '$0.21'],
    ['30D', '$7.00', '2026-08-23 → 2026-09-21 · 30 days', 3, '$0.23'], ['60D', '$15.00', '2026-07-24 → 2026-09-21 · 60 days', 4, '$0.25'],
    ['90D', '$31.00', '2026-06-24 → 2026-09-21 · 90 days', 5, '$0.34'], ['ALL', '$63.00', '2026-06-13 → 2026-09-21 · 101 days', 6, '$0.62'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#overview\\?period=${label.toLowerCase()}$`));
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(hero.locator('.hero-figure')).toHaveText(total);
    await expect(hero.locator('.period-caption')).toHaveText(caption);
    await expect(hero.locator('.hero-figures dd')).toHaveText([String(payouts), '1', average, '0 receipts']);
    // The chart draws the same calendar days: its axis starts on the period's first day, one bar per receipt day.
    await expect(page.locator('.chart-day')).toHaveCount(payouts);
    await expect(page.locator('.attributed-chart .day-axis text').first()).toHaveText(caption.slice(5, 10));
  }
  await page.screenshot({ path: screenshot('ux-period-all.png'), fullPage: true });
  await page.reload(); await expect(hero.locator('.hero-figure')).toHaveText('$63.00');
  // A day inside the period opens only that day's payouts; Back returns to the same period.
  await openDay(page, page.locator('.chart-day[aria-label^="2026-08-01 UTC"]'));
  await expect(page).toHaveURL(/#payouts\?day=2026-08-01$/);
  await expect(page.locator('.day-banner')).toContainText('Showing 2026-08-01 · 1 payout');
  await expect(page.locator('.receipt-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.receipt-table tbody tr')).toContainText('8.000000');
  await page.goBack();
  await expect(page).toHaveURL(/#overview\?period=all$/);
  await expect(hero.locator('.hero-figure')).toHaveText('$63.00');
  // Payouts follow no period, and the overview tab returns to the period it showed.
  await page.getByRole('tab', { name: 'Payouts' }).click();
  await expect(page.locator('.receipt-table tbody tr')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/#overview\?period=all$/);
  expect(errors).toEqual([]);
});

test('fixed periods stay disabled with their reason until tracked history covers them', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  // The demo wallet tracks 52 UTC days from the history floor: 7D, 14D, 30D, ALL and Custom apply; the longer periods wait.
  for (const label of ['60D', '90D']) await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  for (const label of ['7D', '14D', '30D', 'ALL', 'CUSTOM']) await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  const sixty = page.getByRole('button', { name: '60D', exact: true });
  await expect(sixty).toHaveAccessibleDescription('needs 60 days of tracked history');
  await sixty.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'needs 60 days of tracked history' })).toBeVisible();
  await page.screenshot({ path: screenshot('ux-period-disabled.png') });
  await sixty.click({ force: true });
  await expect(page).not.toHaveURL(/period=60d/);
  await expect(page.getByRole('button', { name: '7D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // A link to a period tracked history cannot cover falls back to 7D and says why.
  await ready(page, '#overview?period=60d');
  await expect(page.locator('.period-notice')).toHaveText('60D needs 60 days of tracked history; showing 7D.');
  await expect(page.locator('.period-caption')).toHaveText('2026-09-15 → 2026-09-21 · 7 days');
  // With 101 tracked days every period is available.
  await page.getByLabel('Saved wallets').selectOption(LONG_WALLET);
  await expect(page.locator('.period-hero .hero-figure')).toHaveText('$1.00');
  for (const label of ['7D', '14D', '30D', '60D', '90D', 'ALL', 'CUSTOM']) await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  await expect(page.locator('.period-tip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a custom UTC range inside tracked history drives the figures and the chart, and an invalid one says why', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  await page.getByLabel('Saved wallets').selectOption(LONG_WALLET);
  const hero = page.locator('.period-hero');
  await expect(hero.locator('.hero-figure')).toHaveText('$1.00');
  await page.getByRole('button', { name: 'CUSTOM', exact: true }).click();
  // Custom opens on the range on screen, bounded to tracked history.
  const from = page.getByLabel('From · UTC'); const to = page.getByLabel('To · UTC');
  await expect(from).toHaveValue('2026-09-15'); await expect(to).toHaveValue('2026-09-21');
  await expect(from).toHaveAttribute('min', '2026-06-13'); await expect(to).toHaveAttribute('max', '2026-09-21');
  await expect(page).toHaveURL(/#overview\?period=custom&from=2026-09-15&to=2026-09-21$/);
  await from.fill('2026-08-01'); await to.fill('2026-09-10');
  await expect(page).toHaveURL(/#overview\?period=custom&from=2026-08-01&to=2026-09-10$/);
  await expect(hero.locator('.hero-figure')).toHaveText('$14.00');
  await expect(hero.locator('.period-caption')).toHaveText('2026-08-01 → 2026-09-10 · 41 days');
  await expect(hero.locator('.hero-figures dd')).toHaveText(['3', '1', '$0.34', '0 receipts']);
  await expect(page.locator('.chart-day')).toHaveCount(3);
  await page.screenshot({ path: screenshot('ux-period-custom.png') });
  // An end before the start, or a day outside tracked history, changes nothing and says why.
  await to.fill('2026-07-01');
  await expect(page.getByRole('alert')).toHaveText('The start must be on or before the end.');
  await expect(hero.locator('.hero-figure')).toHaveText('$14.00');
  await expect(page).toHaveURL(/from=2026-08-01&to=2026-09-10$/);
  await to.fill('2026-09-10'); await expect(page.getByRole('alert')).toHaveCount(0);
  await from.fill('2026-06-01');
  await expect(page.getByRole('alert')).toHaveText('Choose days within tracked history, 2026-06-13 → 2026-09-21.');
  await expect(hero.locator('.hero-figure')).toHaveText('$14.00');
  // A refreshed link keeps the range.
  await page.reload();
  await expect(hero.locator('.period-caption')).toHaveText('2026-08-01 → 2026-09-10 · 41 days');
  expect(errors).toEqual([]);
});

test('tokens sort exactly, search, and open a drawer whose full mint copies with a visible Copied state', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page, '#tokens');
  const names = page.locator('.token-table tbody .token-name b');
  await expect(names).toHaveText(['$ATTRA', '$DUAL', '$ATTRB']);
  await expect(page.locator('.token-table th[aria-sort="descending"]')).toHaveText(/^USD/);
  await page.getByRole('button', { name: /^Quantity/ }).click();
  await expect(names).toHaveText(['$ATTRA', '$ATTRB', '$DUAL']);
  await expect(page.locator('.token-table th[aria-sort="descending"]')).toHaveText(/^Quantity/);
  await page.getByRole('button', { name: /^Quantity/ }).click();
  await expect(names).toHaveText(['$DUAL', '$ATTRB', '$ATTRA']);
  await page.getByRole('searchbox', { name: 'Search tokens' }).fill('dual');
  await expect(names).toHaveText(['$DUAL']);
  await page.getByRole('searchbox', { name: 'Search tokens' }).fill('');
  await expect(page.locator('.token-table tfoot')).toHaveCount(0);
  await expect(page.locator('#token-title')).toContainText('Reward tokens');
  await page.screenshot({ path: screenshot('ux-fixture-tokens.png'), fullPage: true });
  await page.locator('.token-table tbody tr').filter({ hasText: '$ATTRA' }).locator('td').nth(2).click();
  const drawer = page.getByRole('dialog', { name: '$ATTRA' });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/#tokens\?token=[1-9A-HJ-NP-Za-km-z]+%3A6$/);
  const mint = (await drawer.locator('code.address').textContent())!;
  expect(mint).toMatch(ADDRESS);
  await expect(drawer.getByRole('link', { name: 'Solscan ↗' })).toHaveAttribute('href', `https://solscan.io/token/${mint}`);
  await expect(drawer.locator('.sheet-figures dd').first()).toHaveText('54.500000');
  await expect(drawer).toContainText('in a snapshot taken after the payouts it covers');
  await expect(drawer.locator('.receipt-list li')).toHaveCount(3);
  await expect(drawer.locator('.receipt-list abbr.sender').first()).toHaveAttribute('title', ADDRESS);
  const copy = drawer.getByRole('button', { name: 'Copy mint address' });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mint);
  await page.screenshot({ path: screenshot('ux-drawer.png') });
  await expect(copy).toHaveText('Copy', { timeout: 4000 });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/#tokens$/);
});

test('payouts filter through the hash and each receipt opens evidence with every address in full', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = errorsOf(page); await ready(page, '#payouts');
  const rows = page.locator('.receipt-table tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(page.locator('.list-status')).toHaveText('Showing 1–5 of 5 receipts');
  await page.getByLabel('Trust source').selectOption('published_withdraw_authority');
  await expect(page).toHaveURL(/#payouts\?trust=published_withdraw_authority$/);
  await expect(rows).toHaveCount(2);
  await page.getByLabel('Price').selectOption('unpriced');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('7.000000');
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page).toHaveURL(/#payouts$/);
  await expect(rows).toHaveCount(5);
  await page.screenshot({ path: screenshot('ux-fixture-payouts.png'), fullPage: true });
  await rows.filter({ hasText: '12.500000' }).locator('td').nth(3).click();
  const modal = page.getByRole('dialog', { name: /^\$ATTRA/ });
  await expect(modal).toBeVisible();
  const addresses = await modal.locator('code.address').allTextContents();
  expect(addresses).toHaveLength(4);
  expect(addresses[0]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  for (const address of addresses.slice(1)) expect(address).toMatch(ADDRESS);
  expect(addresses[2]).toBe(PUBLISHED_AUTHORITY);
  expect(await modal.textContent()).not.toContain('…');
  // Rendered in full: no address box is clipped.
  expect(await modal.locator('code.address').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true);
  await expect(modal.getByRole('button', { name: /^Copy / })).toHaveCount(4);
  await expect(modal).toContainText('taken after this payout');
  await expect(modal).toContainText('Primary trust source');
  await expect(modal).toContainText('4 outer transfers from source · 4 transfers from source · 4 recipient owners');
  const copy = modal.getByRole('button', { name: 'Copy source owner' });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PUBLISHED_AUTHORITY);
  await page.screenshot({ path: screenshot('ux-modal.png') });
  expect(await safeLinks(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  // From a token drawer, a receipt's evidence opens on top; Escape closes only the top dialog.
  await ready(page, '#tokens');
  await page.locator('.token-table .row-open').first().click();
  await page.locator('dialog.sheet.drawer .receipt-list .link-button').first().click();
  await expect(page.locator('dialog[open]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('dialog.sheet.drawer[open]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('trust names both identities in full with their counts, witnesses and snapshot, and reports conflicts', async ({ page }) => {
  await ready(page, '#trust');
  const feed = page.getByRole('article', { name: 'Feed-witnessed distributor' });
  const published = page.getByRole('article', { name: 'Published withdraw authority' });
  await expect(feed.locator('.badge')).toHaveText('Feed-witnessed distributor · 3');
  await expect(published.locator('.badge')).toHaveText('Published withdraw authority · 2');
  await expect(published.locator('code.address')).toHaveText(PUBLISHED_AUTHORITY);
  await expect(feed.locator('code.address')).toHaveText(ADDRESS);
  await expect(feed.locator('.identity-figures dd').nth(1)).toHaveText('3');
  await expect(published.locator('.identity-figures dd').nth(1)).toHaveText('2');
  await expect(feed).toContainText('Witnessed in 3 official StonkFun distributions');
  await expect(feed.locator('.identity-evidence a')).toHaveCount(2);
  await expect(published.locator('.snapshot-list li')).toContainText(['taken after the payouts it covers · nearest snapshot for 2 rows']);
  await expect(page.getByRole('region', { name: 'Identity conflicts' })).toContainText('NONE');
  await expect(page.locator('main')).toContainText('5 attributed rows from 2 sending identities');
  expect(await safeLinks(page)).toBe(true);
  await page.screenshot({ path: screenshot('ux-fixture-trust.png'), fullPage: true });
});

test('coverage holds counts by status, ranges, plain unknown reasons, reclassify and the samples', async ({ page }) => {
  await ready(page, '#coverage');
  await expect(page.locator('.status-counts dt')).toHaveText(['Verified', 'Attributed', 'Excluded', 'Unknown · not counted']);
  await expect(page.locator('.status-counts dd b')).toHaveText(['8', '5', '1', '1']);
  await expect(page.getByText('PARTIAL CLASSIFICATION', { exact: true })).toBeVisible();
  await expect(page.locator('.range-list li').first()).toContainText('COMPLETE');
  await expect(page.getByRole('button', { name: 'RECLASSIFY LOCALLY' })).toBeVisible();
  const reasons = page.locator('.reason-list li');
  await expect(reasons).toHaveCount(3);
  for (const text of await reasons.locator('p').allTextContents()) expect(text).toMatch(/^[A-Z].+\.$/);
  await page.getByText('UNKNOWN CANDIDATE SAMPLE', { exact: false }).click();
  await expect(page.locator('.sample-table code.address').first()).toHaveText(ADDRESS);
  await expect(page.getByRole('cell', { name: 'UNKNOWN Evidence', exact: false })).toBeVisible();
  await page.getByText('CONFIRMATION EVIDENCE', { exact: false }).click();
  expect(await safeLinks(page)).toBe(true);
  await page.screenshot({ path: screenshot('ux-fixture-coverage.png'), fullPage: true });
});

test('fixture exact amounts, verified chart controls and exact chart data render without browser errors', async ({ page }) => {
  const errors = errorsOf(page); await ready(page, '#tokens');
  await expect(page.getByRole('cell', { name: '315.532000', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '0.970000', exact: true })).toBeVisible();
  await ready(page, '#overview');
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Cumulative' }).check();
  await expect(page.locator('.cumulative-line')).toBeVisible();
  await page.getByText('View exact chart data', { exact: true }).click();
  await expect(page.getByRole('cell', { name: '2026-09-13', exact: true })).toBeVisible();
  await page.getByText('View exact attributed chart data').click();
  await expect(page.locator('.attributed-plot tbody td')).toHaveText(['2026-09-17', 'Unavailable', '1', '—', '2026-09-18', '$6.50', '0', '$DUAL 100.0% $6.50',
    '2026-09-19', '$20.00', '0', '$ATTRA 100.0% $20.00', '2026-09-20', '$6.25', '0', '$ATTRA 100.0% $6.25', '2026-09-21', '$1.00', '0', '$ATTRA 100.0% $1.00']);
  // Two separate series, never stacked on each other or combined: one column per UTC day each.
  const attributed = page.locator('svg.attributed-chart'); const verified = page.locator('svg.reward-chart');
  await expect(attributed.locator('.reward-bar')).toHaveCount(0);
  await expect(verified.locator('.bar-segment')).toHaveCount(0);
  for (const chart of [attributed, verified]) {
    // One column per day: a day's token segments share one x, and no two days share one.
    const columns = await chart.locator('.bar-segment, .reward-bar, .unpriced-bar').evaluateAll(rects => rects.map(rect =>
      ({ day: rect.closest('.chart-day')?.getAttribute('aria-label') ?? rect.getAttribute('x'), x: rect.getAttribute('x') })));
    const positions = [...new Map(columns.map(column => [column.day, column.x])).values()];
    expect(new Set(positions).size).toBe(positions.length);
  }
  expect(await safeLinks(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('every tab fits within one extra viewport on desktop and never scrolls sideways', async ({ page }) => {
  for (const tab of TABS) {
    await ready(page, `#${tab}`);
    await expect(page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') })).toHaveAttribute('aria-selected', 'true');
    const size = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: window.innerHeight }));
    expect(size.height, tab).toBeLessThanOrEqual(2 * size.viewport);
    expect(await overflow(page), tab).toBeLessThanOrEqual(0);
  }
  // The header stays in view while the page scrolls.
  await page.mouse.wheel(0, 900);
  await expect(page.locator('.topbar')).toBeInViewport();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('stacked period figures, a full-width status control, segmented tabs, a tap-to-pin day sheet, full-screen sheets, and no sideways scroll on any tab', async ({ page }) => {
    const errors = errorsOf(page); await page.emulateMedia({ reducedMotion: 'reduce' }); await ready(page);
    // The status control spans the header on its own row; the period figure, on one line, sits above its small figures, two by two.
    const status = await page.locator('.status-button').boundingBox();
    expect(status!.x).toBeGreaterThanOrEqual(16); expect(status!.x + status!.width).toBeLessThanOrEqual(390 - 16 + 1);
    const [lead, figures, figure] = await Promise.all(['.period-hero .hero-lead', '.period-hero .hero-figures', '.hero-figure'].map(selector => page.locator(selector).boundingBox()));
    expect(figures!.y).toBeGreaterThan(lead!.y + lead!.height - 1);
    expect(figure!.height).toBeLessThan(40);
    const small = await page.locator('.period-hero .hero-figures > div').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(small).size).toBe(2);
    // The period control wraps into rows inside the viewport.
    expect(await page.locator('.period-segments button').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= window.innerWidth))).toBe(true);
    // The tabs form one segmented row inside the viewport.
    const tabs = await page.getByRole('tab').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [Math.round(box.top), box.right]; }));
    expect(new Set(tabs.map(([top]) => top)).size).toBe(1);
    expect(Math.max(...tabs.map(([, right]) => right!))).toBeLessThanOrEqual(390);
    for (const tab of TABS) {
      await ready(page, `#${tab}`);
      expect(await overflow(page), tab).toBeLessThanOrEqual(0);
      await page.screenshot({ path: screenshot(`ux-mobile-${tab}.png`), fullPage: true });
    }
    // A tap opens the status panel as a sheet inside the viewport; a tap elsewhere closes it.
    await ready(page);
    await page.locator('.status-button').tap();
    const sheet = await page.getByRole('dialog', { name: 'Status' }).boundingBox();
    expect(sheet!.x).toBeGreaterThanOrEqual(0); expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(390);
    expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(844);
    await page.locator('.brand').tap();
    await expect(page.getByRole('dialog', { name: 'Status' })).toHaveCount(0);
    // A tap on a token's segment pins the day as a bottom sheet with that token chosen, the same rows as on a desktop.
    const segment = page.locator('.chart-day').nth(2).locator('.bar-segment').first();
    await segment.tap();
    const pinned = dayTooltip(page);
    await expect(pinned).toHaveClass(/is-sheet/);
    await expect(pinned).toContainText('2026-09-19 UTC');
    await expect(pinned).toContainText('Pinned · Esc or a click outside closes it');
    await expect(pinned.locator('.tooltip-tokens li.is-selected')).toHaveText('$ATTRA100.0%$20.0040.000000Copy CA');
    const sheetBox = (await pinned.boundingBox())!;
    expect(sheetBox.x).toBe(0); expect(sheetBox.width).toBe(390); expect(Math.round(sheetBox.y + sheetBox.height)).toBe(844);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: screenshot('ux-mobile-tooltip.png') });
    await expect(page).not.toHaveURL(/#payouts/);
    // The sheet closes with its own button; tapping the day again pins it again, and its ticker lists that token's payouts that day.
    await pinned.getByRole('button', { name: 'Close this day' }).tap();
    await expect(pinned).toHaveCount(0);
    await segment.tap();
    await pinned.getByRole('button', { name: '$ATTRA: list its payouts on 2026-09-19' }).tap();
    await expect(page).toHaveURL(/#payouts\?day=2026-09-19&token=[1-9A-HJ-NP-Za-km-z]+%3A6$/);
    await expect(page.locator('.day-banner')).toContainText('Showing 2026-09-19 · $ATTRA · 1 payout');
    await page.goBack();
    await page.locator('svg.attributed-chart .day-axis text[data-day="2026-09-19"]').tap();
    await expect(page).toHaveURL(/#payouts\?day=2026-09-19$/);
    // The evidence modal and the token drawer are full-screen sheets with a close button.
    await page.locator('.receipt-table .row-open').first().tap();
    const modal = page.locator('dialog.sheet.modal .sheet-body');
    await expect(modal).toBeVisible();
    expect(await modal.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(await page.locator('dialog.sheet.modal code.address').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth
      && node.getBoundingClientRect().right <= window.innerWidth))).toBe(true);
    await page.screenshot({ path: screenshot('ux-mobile-modal.png') });
    await page.getByRole('button', { name: 'Close' }).tap();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await ready(page, '#tokens');
    await page.locator('.token-table .row-open').first().tap();
    const drawer = page.locator('dialog.sheet.drawer .sheet-body');
    expect(await drawer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await page.screenshot({ path: screenshot('ux-mobile-drawer.png') });
    await page.getByRole('button', { name: 'Close' }).tap();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await ready(page);
    expect(await page.locator('.bar-segment').first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
    expect(errors).toEqual([]);
  });

  test('keyboard focus stays visible and the wallet controls keep their order', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await ready(page);
    const wallet = page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' }); await wallet.focus();
    await expect(wallet).toBeFocused(); expect(await wallet.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Tab'); await expect(page.getByLabel('Saved wallets')).toBeFocused();
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test('a wallet saved before classifier v3 reads Not evaluated on every tab, never zero', async ({ page }) => {
  await ready(page); await expect(page.locator('.status-button .status-tag')).toHaveText('SYNTHETIC');
  await page.getByLabel('Saved wallets').selectOption(NOT_EVALUATED_WALLET);
  await expect(page.locator('.hero-figure')).toHaveText('Not evaluated');
  await expect(page.locator('.period-hero')).toContainText('Saved rows predate classifier v3 or await an attribution recheck.');
  await expect(page.locator('.period-hero .hero-figures')).toHaveCount(0);
  await expect(page.locator('.period-caption')).toHaveCount(0);
  const status = await openStatus(page);
  await expect(status.locator('dt').filter({ hasText: 'Last sync' })).toHaveCount(1);
  await expect(status.locator('.status-count summary').filter({ hasText: 'Unpriced' })).toHaveText('Unpriced · excluded from USDverified 0 · attributed Not evaluated');
  const statusText = (await status.textContent())!;
  await page.keyboard.press('Escape');
  await expect(page.locator('.attributed-plot .chart-empty')).toContainText('Not evaluated');
  await expect(page.locator('.top-tokens')).toHaveCount(0);
  await page.screenshot({ path: screenshot('ux-not-evaluated.png'), fullPage: true });
  // Only the attributed panels are checked: the verified table on the tokens tab keeps its own figures.
  const stateful: string[] = [(await page.locator('.period-hero').textContent())!];
  for (const tab of ['tokens', 'payouts', 'trust'] as const) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') }).click();
    const panel = page.getByRole('tabpanel').locator('.attributed-panel, .trust-panel');
    await expect(panel.locator('.state-box')).toContainText('Not evaluated');
    stateful.push((await panel.textContent())!);
  }
  await expect(page.getByRole('region', { name: 'Identity conflicts' })).toContainText('NONE');
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.locator('.status-counts dd').nth(1)).toHaveText('Not evaluated');
  for (const text of [...stateful, statusText]) {
    expect(text).not.toMatch(/\$0(\.0+)?(?!\d)|\battributed 0\b|of 0 attributed|Unavailable/);
  }
});

test('Verified shows with verified rows and is left out without them, on the overview and the tokens tab', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  // The demo wallet has verified rows: its own chart beneath the attributed one, and its token table.
  await expect(page.locator('.verified-plot')).toBeVisible();
  await expect(page.locator('#verified-chart-title')).toHaveText('Daily verified receipts / USD · own scale');
  const order = await page.evaluate(() => ['.attributed-plot', '.verified-plot'].map(selector => document.querySelector(selector)!.getBoundingClientRect().top));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  await expect(page.locator('.top-tokens')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await expect(page.locator('#token-title')).toContainText('Reward tokens');
  await page.getByRole('tab', { name: 'Overview' }).click();
  // A wallet with no verified row has no Verified section at all: no chart, no note, no empty-state line.
  await page.getByLabel('Saved wallets').selectOption(ATTRIBUTED_ONLY_WALLET);
  await expect(page.locator('.hero-figure')).toHaveText('$6.00');
  await expect((await openStatus(page)).locator('.status-count summary').first()).toHaveText('Verified0 rows');
  await page.keyboard.press('Escape');
  for (const absent of ['.verified-plot', '.verified-note', 'svg.reward-chart', '.empty-bars']) await expect(page.locator(absent)).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('No confirmed priced rewards yet');
  await expect(page.locator('svg.attributed-chart .bar-segment')).toHaveCount(3);
  await page.screenshot({ path: screenshot('ux-collapsed.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await expect(page.locator('#attributed-token-title')).toBeVisible();
  for (const absent of ['#token-title', '.verified-note']) await expect(page.locator(absent)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('no tab, panel or popover reads not verified, with verified rows or without', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  const notVerified = /not verified/i;
  /** Visible text, and every accessible name or tooltip the page carries. */
  const words = async () => `${await page.locator('body').innerText()}\n${(await page.evaluate(() => [...document.querySelectorAll('[aria-label], [title]')]
    .map(node => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`).join('\n')))}`;
  for (const wallet of [null, ATTRIBUTED_ONLY_WALLET]) {
    if (wallet) { await page.getByLabel('Saved wallets').selectOption(wallet); await expect(page.locator('.hero-figure')).toHaveText('$6.00'); }
    for (const tab of TABS) {
      await page.locator(`#tab-${tab}`).click();
      await expect(page.locator(`#panel-${tab}`)).toBeVisible();
      expect(await words(), `${wallet ?? 'demo wallet'} · ${tab}`).not.toMatch(notVerified);
    }
    // The status panel and the period figure's (i) popover, where the tier's explanation now lives.
    await openStatus(page); expect(await words()).not.toMatch(notVerified); await page.keyboard.press('Escape');
    await page.locator('#tab-overview').click();
    await page.getByRole('button', { name: 'About Attributed' }).click();
    const popover = page.getByRole('dialog', { name: 'Attributed' });
    await expect(popover).toContainText('Paid from a trusted StonkFun distributor');
    expect(await words()).not.toMatch(notVerified);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});

test('dismiss and browser close leave the background scan running; reopening sees completion', async ({ page, context }) => {
  await ready(page); await page.getByRole('button', { name: 'Check latest data' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'CANCEL SCAN' })).toBeVisible();
  await expect(dialog.getByText('Waiting for provider response — scan still active.')).toBeVisible({ timeout: 6000 });
  await page.screenshot({ path: screenshot('progress-active.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.locator('.status-button')).toContainText('WORKING');
  await page.screenshot({ path: screenshot('progress-background.png'), fullPage: true });
  await page.close(); const next = await context.newPage(); await next.goto('/');
  await expect(next.locator('.status-button')).toContainText('COMPLETE', { timeout: 12_000 });
  await (await openStatus(next)).getByRole('button', { name: /^View scan progress/ }).click();
  await expect(next.getByRole('dialog')).toContainText('Duration');
  await next.screenshot({ path: screenshot('progress-complete.png'), fullPage: true });
});
test('explicit Cancel pauses; Resume is explicit and keeps the job identity', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Check latest data' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'CANCEL SCAN' }).click();
  await expect(dialog.getByRole('button', { name: 'RESUME', exact: true })).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await page.getByRole('button', { name: 'Check latest data' }).click();
  await expect(dialog.getByRole('button', { name: 'RESUME', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'RESUME', exact: true }).click();
  await expect(dialog.getByText('COMPLETE', { exact: true })).toBeVisible({ timeout: 12_000 });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();
});
test('invalid wallet never dispatches a scan', async ({ page }) => {
  let scans = 0; page.on('request', request => { if (request.url().endsWith('/api/v1/scans')) scans++; });
  await ready(page); await expect(page.locator('.status-button .status-tag')).toHaveText('SYNTHETIC');
  await page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' }).fill('invalid-wallet');
  await page.getByRole('button', { name: 'Check latest data' }).click();
  await expect(page.locator('.wallet-error')).toContainText('That is not a Solana address'); expect(scans).toBe(0);
});
test('paused failure displays saved work and resume guidance', async ({ page }) => {
  await page.route('**/api/v1/wallets/*/job', async route => {
    const response = await route.fetch(); const raw: unknown = await response.json(); const job = raw as DashboardJob | null;
    if (job) {
      job.status = 'paused'; job.runningLocally = false; job.failure = 'Scan interrupted; acknowledged work is saved';
      job.progress.phase = 'history'; job.progress.action = 'Provider response interrupted';
      job.progress.awaitingProvider = false; job.progress.finishedAt = job.progress.serverNow;
      job.progress.completedPhases = ['preparing', 'registry', 'metadata', 'planning'];
      if (job.ranges[0]) job.ranges[0].status = 'pending';
    }
    await route.fulfill({ response, json: job });
  });
  await ready(page); await expect(page.locator('.status-button')).toContainText('PAUSED');
  await (await openStatus(page)).getByRole('button', { name: /^View scan progress/ }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Resume is unavailable');
  await page.screenshot({ path: screenshot('progress-error.png'), fullPage: true });
});
test('mobile progress remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page);
  await page.getByRole('button', { name: 'Check latest data' }).click();
  await expect(page.getByRole('dialog').getByText('WORKING')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: screenshot('progress-mobile.png'), fullPage: true });
});
test('reduced motion keeps progress content and disables animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await ready(page);
  await page.getByRole('button', { name: 'Check latest data' }).click();
  const indicator = page.getByRole('dialog').locator('.working-indicator');
  await expect(indicator).toContainText('WORKING');
  expect(await indicator.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none');
  await page.screenshot({ path: screenshot('progress-reduced-motion.png'), fullPage: true });
});
test('completed scan refreshes the report once', async ({ page }) => {
  let reports = 0;
  page.on('request', request => { if (request.url().endsWith(`/api/v1/wallets/${'8'.repeat(32)}/report`)) reports++; });
  await ready(page); await expect(page.locator('.status-button .status-tag')).toHaveText('SYNTHETIC');
  await page.getByRole('button', { name: 'Check latest data' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const beforeCompletion = reports;
  await expect(page.locator('.status-button')).toContainText('COMPLETE', { timeout: 12_000 });
  await expect.poll(() => reports).toBe(beforeCompletion + 1);
  await page.waitForTimeout(2500);
  expect(reports).toBe(beforeCompletion + 1);
});
