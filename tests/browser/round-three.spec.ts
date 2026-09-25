import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// UX round 3 against the synthetic fixtures (scripts/fixture-dashboard.mjs): the day tooltip beside its column with its grace
// and Copy CA, stale saved prices, and a finished job's status. The likely source launches are in sources.spec.ts.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318'; const OFFLINE = 'http://127.0.0.1:4321';
const STACKED_WALLET = 'GdQqT7k7Br6WCTMFKZGnRMwLsk1tRYT8eRh8zK926uuK'; // Derived from the fixture label 'stacked-wallet'.
const XBTC = '9K86JPJ8MmAjdPRMrd53r2AXon9cgXWHGgJ3vtgHqMd7'; // Derived from 'stacked-quote-XBTC'.
const UTC_TIME = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC`;

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => [CONFIGURED, OFFLINE].some(origin => route.request().url().startsWith(`${origin}/`)) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const ready = async (page: Page, url = `${CONFIGURED}/`) => { await page.goto(url); await expect(page.locator('.status-button')).toBeVisible(); await expect(page.locator('.tabs')).toBeVisible(); };
/** The stacked wallet on the offline server, where no scan elsewhere sends its synthetic rows to a recheck. */
const stacked = async (page: Page, tab = 'overview') => {
  await ready(page, `${OFFLINE}/#${tab}`);
  await page.getByLabel('Saved wallets').selectOption(STACKED_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(STACKED_WALLET);
};
const dayTooltip = (page: Page) => page.locator('#day-tooltip');
interface Box { x: number; y: number; width: number; height: number }

/** A day's drawn bar: its first segment, or its unpriced baseline. */
const barOf = (day: Locator) => day.locator('rect.bar-segment, rect.unpriced-bar').first();
/** The space between a bar and the tooltip beside it, on whichever side it opened. */
const gapBetween = (bar: Box, box: Box) => box.x >= bar.x + bar.width ? { side: 'right', gap: box.x - (bar.x + bar.width) } : { side: 'left', gap: bar.x - (box.x + box.width) };

test.describe('day tooltip', () => {
  test('opens 8px from its day\'s bar, to the right unless that overflows the chart, on the first, a middle and the last day', async ({ page }) => {
    const errors = errorsOf(page); await ready(page);
    const days = page.locator('.chart-day');
    await expect(days).toHaveCount(5);
    const chart = (await page.locator('svg.attributed-chart').boundingBox())!;
    const sides: string[] = [];
    for (const index of [0, 2, 4]) {
      // Start each hover from outside the chart, so no open tooltip holds the pointer.
      await page.mouse.move(0, 0);
      await expect(dayTooltip(page)).toHaveCount(0);
      const bar = (await barOf(days.nth(index)).boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + Math.min(10, bar.height / 2));
      await expect(days.nth(index)).toHaveAttribute('aria-expanded', 'true');
      const box = (await dayTooltip(page).boundingBox())!;
      const { side, gap } = gapBetween(bar, box);
      sides.push(side);
      // Right next to the bar: at most 12px from its edge (8px, plus rounding), and never over it.
      expect(gap).toBeGreaterThanOrEqual(0); expect(gap).toBeLessThanOrEqual(12);
      // Inside the chart area and the viewport.
      expect(box.x).toBeGreaterThanOrEqual(chart.x - 1); expect(box.x + box.width).toBeLessThanOrEqual(chart.x + chart.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(1000);
      if (index === 0) await page.screenshot({ path: screenshot('ux-tooltip-side.png') });
    }
    expect(sides).toEqual(['right', 'right', 'left']);
    expect(errors).toEqual([]);
  });

  test('moving the pointer from the bar into the tooltip keeps the same day open, even over the neighbouring day it covers', async ({ page }) => {
    const errors = errorsOf(page); await ready(page);
    const days = page.locator('.chart-day');
    await expect(days).toHaveCount(5);
    const tooltip = dayTooltip(page);
    const columns = await Promise.all((await days.all()).map(day => day.locator('.day-hit').boundingBox()));
    let coveredDays = 0;
    for (const index of [0, 2, 4]) {
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
      const bar = (await barOf(days.nth(index)).boundingBox())!;
      await page.mouse.move(bar.x + bar.width / 2, bar.y + Math.min(10, bar.height / 2));
      const title = (await tooltip.locator('.tooltip-title b').textContent())!;
      const box = (await tooltip.boundingBox())!;
      const { side } = gapBetween(bar, box);
      // A point deep in the tooltip over another day's column: one with receipts where the tooltip covers one.
      const covered = columns.filter((column, at) => at !== index && column!.x + 4 < box.x + box.width && column!.x + column!.width - 4 > box.x);
      const over = covered[0];
      const x = over ? (Math.max(over.x, box.x) + Math.min(over.x + over.width, box.x + box.width)) / 2 : side === 'right' ? box.x + box.width - 20 : box.x + 20;
      const own = columns[index]!;
      expect(x < own.x || x > own.x + own.width).toBe(true);
      if (over) coveredDays++;
      await page.mouse.move(x, box.y + Math.min(60, box.height / 2), { steps: 16 });
      // Well past the grace, the same day is open.
      await page.waitForTimeout(400);
      await expect(tooltip.locator('.tooltip-title b')).toHaveText(title);
      await expect(days.nth(index)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(coveredDays).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('stays while hovered, closes once left, and a neighbouring day opens once the pointer rests on it', async ({ page }) => {
    await stacked(page);
    const days = page.locator('.chart-day');
    await expect(days).toHaveCount(2);
    const first = await days.first().locator('.day-hit').boundingBox();
    const bar = (await barOf(days.nth(1)).boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 20);
    const tooltip = dayTooltip(page);
    await expect(tooltip).toContainText('2026-09-20 UTC');
    // Near the right edge it opens to the left, 8px from the bar, over 2026-09-19.
    const box = (await tooltip.boundingBox())!;
    expect(gapBetween(bar, box)).toMatchObject({ side: 'left' });
    expect(gapBetween(bar, box).gap).toBeLessThanOrEqual(12);
    await page.mouse.move(box.x + 40, box.y + 30, { steps: 12 });
    await expect(tooltip).toContainText('2026-09-20 UTC');
    // It stays while hovered, well past the grace.
    await page.waitForTimeout(500);
    await expect(tooltip).toContainText('2026-09-20 UTC');
    await expect(tooltip).not.toHaveClass(/is-pinned/);
    // Leaving the chart closes it once the grace runs out.
    await page.mouse.move(box.x + box.width / 2, 5);
    await expect(tooltip).toHaveCount(0);
    // Resting on the neighbouring day opens it instead.
    await page.mouse.move(first!.x + first!.width / 2, first!.y + 20);
    await expect(tooltip).toContainText('2026-09-19 UTC');
  });

  test('copies a token\'s full mint with Copy CA and shows Copied; Escape and a click elsewhere close a pinned day', async ({ page, context }) => {
    const errors = errorsOf(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stacked(page);
    await page.locator('.chart-day').first().locator('.day-hit').click({ position: { x: 3, y: 3 } });
    const tooltip = dayTooltip(page);
    await expect(tooltip).toHaveClass(/is-pinned/);
    const copy = tooltip.getByRole('button', { name: 'Copy $XBTC contract address' });
    await expect(copy).toHaveText('Copy CA');
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(XBTC);
    await page.screenshot({ path: screenshot('ux-tooltip-copy.png') });
    // Every named row carries its own; the list scrolls inside the tooltip when it is taller than the plot.
    await expect(tooltip.locator('.tooltip-tokens > li .copy-button')).toHaveCount(12);
    expect(await tooltip.locator('.tooltip-tokens').evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await page.locator('.chart-day').first().locator('.day-hit').click({ position: { x: 3, y: 3 } });
    await expect(tooltip).toHaveClass(/is-pinned/);
    await page.locator('.brand').click();
    await expect(tooltip).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('a stale saved price reads "stale · <age>" in the period figure\'s popover, the token table and the drawer', async ({ page }) => {
  const errors = errorsOf(page); await stacked(page);
  // $PYTH's only valued price was saved three days and an hour before the cutoff; a later lookup found none.
  await page.getByRole('button', { name: 'About Attributed' }).click();
  const popover = page.getByRole('dialog', { name: 'Attributed' });
  await expect(popover.locator('.price-ages p').first()).toContainText(new RegExp(`^Saved prices ${UTC_TIME} → ${UTC_TIME}\\.`));
  await expect(popover.locator('.stale-list li')).toHaveText([new RegExp(`^\\$PYTHstale · 3\\.0 d${UTC_TIME}$`)]);
  await page.screenshot({ path: screenshot('ux-stale-popover.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Tokens' }).click();
  const row = page.locator('.token-table tbody tr').filter({ hasText: '$PYTH' });
  await expect(row.locator('.stale-label')).toHaveText('stale · 3.0 d');
  await expect(page.locator('.token-table .stale-label')).toHaveCount(1);
  // The stale price still values the token: $10.00 for its ten tokens.
  await expect(row.locator('td').nth(2)).toHaveText('$10.00');
  await expect(row.locator('td').nth(2)).toHaveAttribute('title', new RegExp(`^Saved price: ${UTC_TIME} · stale · 3\\.0 d$`));
  await page.screenshot({ path: screenshot('ux-stale-prices.png') });
  await row.locator('td').nth(2).click();
  const drawer = page.getByRole('dialog', { name: '$PYTH' });
  await expect(drawer.locator('.sheet-figures')).toContainText(new RegExp(`Saved price${UTC_TIME} · stale · 3\\.0 d`));
  expect(errors).toEqual([]);
});

test('a finished job reads "finished <UTC time>" in the status panel and the progress dialog, not "last activity just now"', async ({ page }) => {
  const errors = errorsOf(page); await ready(page);
  await page.locator('.status-button').click();
  const panel = page.getByRole('dialog', { name: 'Status' });
  await expect(panel.locator('.status-job')).toContainText(new RegExp(`· finished ${UTC_TIME}$`));
  await expect(panel.locator('.status-job')).not.toContainText('last activity');
  await page.screenshot({ path: screenshot('ux-status-finished.png') });
  await panel.getByRole('button', { name: 'View scan progress →' }).click();
  await expect(page.locator('.progress-meta')).toHaveText(new RegExp(`^Finished ${UTC_TIME}$`));
  await expect(page.locator('.progress-days')).toHaveText(/^\d+ of \d+ days? done$/);
  expect(errors).toEqual([]);
});
