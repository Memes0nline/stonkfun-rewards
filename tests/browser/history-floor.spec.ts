import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Layered scanning against the synthetic fixtures (scripts/fixture-dashboard.mjs): a wallet first scanned under the ten-day rule
// is loaded from its first covered day, a refresh keeps that loaded range, and Scan more loads the days before it batch by batch.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const LATER_DAY_WALLET = 'GX3dvx4c9VKFZUW8iDV2RMgCwrKGQnhKtsJkYFKuzAd6'; // Derived from the fixture label 'later-day-wallet'.

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };

test('a wallet covered from a later day keeps its loaded range on refresh, with no gap before it', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  // The default wallet is loaded back to the floor.
  await expect(page.locator('.refresh-floor')).toHaveText('Full history since 2026-08-01');
  await expect(page.locator('.refresh .more-button')).toHaveText(/^Scan more(\d+ days? to check|All caught up)$/);
  await page.getByLabel('Saved wallets').selectOption(LATER_DAY_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(LATER_DAY_WALLET);
  const hero = page.locator('.period-hero');
  // Before: ALL starts at the oldest loaded day and holds the one retained receipt, 4 tokens at $0.50.
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(hero.locator('.period-caption')).toHaveText('2026-09-11 → 2026-09-21 · 11 days');
  await expect(hero.locator('.hero-figure')).toHaveText('$2.00');
  await expect(page.locator('.chart-day')).toHaveCount(1);
  await expect(page.locator('.attributed-chart .day-axis text').first()).toHaveText('09-11');
  // The Coverage target is the loaded range, so the days before it are not loaded yet rather than a gap.
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.locator('.range-target')).toHaveText('Target 2026-09-11 14:13 UTC → 2026-09-21 14:13 UTC');
  await expect(page.locator('.range-list li')).toHaveText(['COMPLETE2026-09-11 14:13 UTC → 2026-09-21 14:13 UTC']);
  await page.screenshot({ path: screenshot('floor-coverage-before.png'), fullPage: true });

  // The refresh plans only the newest minutes; it is not a first scan and loads nothing before the oldest loaded day.
  await page.getByRole('button', { name: 'Check latest data' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('COMPLETE', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('.progress-days')).toHaveText('1 of 1 day done');
  await expect(dialog.locator('.progress-first')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();

  // After: one complete range from the oldest loaded day and no gap.
  await expect(page.locator('.range-list li.warning')).toHaveCount(0);
  await expect(page.locator('.range-list li')).toHaveText([/^COMPLETE2026-09-11 14:13 UTC → 2026-09-21 \d\d:\d\d UTC$/]);
  await page.screenshot({ path: screenshot('floor-coverage-after.png'), fullPage: true });
  // ALL and the hero keep the loaded range; the early receipt two days after the floor waits for Scan more.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(hero.locator('.period-caption')).toHaveText('2026-09-11 → 2026-09-21 · 11 days');
  await expect(hero.locator('.hero-figure')).toHaveText('$2.00');
  await expect(page.locator('.chart-day')).toHaveCount(1);
  await expect(page.locator('.chart-day[aria-label^="2026-08-03 UTC"]')).toHaveCount(0);
  await page.screenshot({ path: screenshot('floor-overview-after.png'), fullPage: true });
  expect(errors).toEqual([]);
});

const picker = (page: Page) => page.getByRole('dialog', { name: 'Scan more' });
const progress = (page: Page) => page.locator('dialog[open]').filter({ has: page.locator('#progress-title') });

test('Scan more loads every batch back to a chosen row, one after another, showing Batch n of m, down to the floor', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  await page.getByLabel('Saved wallets').selectOption(LATER_DAY_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(LATER_DAY_WALLET);
  const header = page.locator('.refresh');
  await expect(header.locator('.refresh-floor')).toHaveText('Loaded 2026-09-11 → today');
  const more = header.locator('.more-button');
  await expect(more).toHaveText('Scan more42 days left to Aug 1');
  await expect(header.getByRole('button', { name: /Load earlier|Rescan/ })).toHaveCount(0);
  // A period the loaded range is too short for, but the days back to the floor would cover, opens Scan more on the batch holding
  // its first day.
  await expect(page.locator('#period-reason-14d')).toHaveText('Scan more to enable');
  await expect(page.locator('#period-reason-30d')).toHaveText('Scan more to enable');
  await expect(page.locator('#period-reason-60d')).toHaveText('needs 60 days of tracked history');
  await page.getByRole('button', { name: '30D', exact: true }).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.more-summary')).toHaveText('Loaded 2026-09-11 → today · 42 days left to Aug 1');
  await expect(picker(page).locator('.more-row .more-dates')).toHaveText([/^2026-09-18 → 2026-09-21 \d\d:\d\d$/,'2026-09-11 14:13 → 2026-09-17',
    '2026-09-04 14:13 → 2026-09-11 14:13', '2026-08-28 14:13 → 2026-09-04 14:13', '2026-08-21 14:13 → 2026-08-28 14:13', '2026-08-14 14:13 → 2026-08-21 14:13',
    '2026-08-07 14:13 → 2026-08-14 14:13', '2026-08-01 → 2026-08-07 14:13']);
  await expect(picker(page).locator('.more-row.highlight .more-dates')).toHaveText('2026-08-21 14:13 → 2026-08-28 14:13');
  await expect(picker(page).locator('.more-row.not_loaded .more-action')).toHaveText(['Load', 'Load', 'Load', 'Load', 'Load', 'Load']);
  await expect(picker(page).locator('input')).toHaveCount(0);
  await picker(page).locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
  // Coverage lists the days not loaded yet apart from gaps; its Scan more opens the list on the batch before the oldest loaded day.
  await page.getByRole('tab', { name: 'Coverage' }).click();
  const notLoaded = page.locator('.not-loaded');
  await expect(notLoaded.locator('p').first()).toHaveText('NOT LOADED YET2026-08-01 00:00 UTC → 2026-09-11 14:13 UTC · 42 days');
  await expect(page.locator('.range-list li.warning')).toHaveCount(0);
  await page.screenshot({ path: screenshot('earlier-coverage-before.png'), fullPage: true });
  await notLoaded.getByRole('button', { name: 'Scan more' }).click();
  await expect(picker(page).locator('.more-row.highlight .more-dates')).toHaveText('2026-09-04 14:13 → 2026-09-11 14:13');
  await page.screenshot({ path: screenshot('more-list.png') });

  // Load on the second row not loaded reads two batches, the newest first, in the usual scan dialog.
  await picker(page).getByRole('button', { name: 'Load, 2026-08-28 14:13 → 2026-09-04 14:13' }).click();
  await expect(picker(page)).toHaveCount(0);
  const dialog = progress(page);
  await expect(dialog.locator('#progress-title')).toHaveText('Loading 2026-09-04 → 2026-09-11 (7 days)');
  await expect(dialog.locator('.progress-sequence')).toHaveText('Batch 1 of 2');
  await expect(dialog.locator('.progress-range')).toHaveText(/^(Reading|Done:) 2026-09-04 → 2026-09-11/);
  await expect(dialog.locator('.progress-requests')).toHaveText(/^Requests so far: Helius \d+ · StonkFun \d+$/);
  await page.screenshot({ path: screenshot('more-batch-1.png') });
  await expect(dialog.locator('#progress-title')).toHaveText('Loading 2026-08-28 → 2026-09-04 (7 days)', { timeout: 60_000 });
  await expect(dialog.locator('.progress-sequence')).toHaveText('Batch 2 of 2');
  await expect(dialog.getByText('COMPLETE', { exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(dialog.locator('.progress-days')).toHaveText('7 of 7 days done');
  await expect(dialog.locator('.progress-range')).toHaveText(/^Done: 2026-08-28 → 2026-09-04 · \d+ new payouts?$/);
  await page.screenshot({ path: screenshot('more-batch-2.png') });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await expect(header.locator('.refresh-floor')).toHaveText('Loaded 2026-08-28 → today');
  await expect(more).toHaveText('Scan more28 days left to Aug 1');
  await expect(notLoaded.locator('p').first()).toHaveText('NOT LOADED YET2026-08-01 00:00 UTC → 2026-08-28 14:13 UTC · 28 days');
  await expect(page.locator('.range-list li.warning')).toHaveCount(0);

  // The oldest row reads the four batches left, the last clipped at the floor, and names the last batch's time.
  await more.click();
  await expect(picker(page).locator('.more-row.not_loaded .more-dates')).toHaveText(['2026-08-21 14:13 → 2026-08-28 14:13', '2026-08-14 14:13 → 2026-08-21 14:13',
    '2026-08-07 14:13 → 2026-08-14 14:13', '2026-08-01 → 2026-08-07 14:13']);
  await picker(page).getByRole('button', { name: 'Load, 2026-08-01 → 2026-08-07 14:13' }).click();
  await expect(dialog.locator('.progress-sequence')).toHaveText('Batch 1 of 4');
  await expect(dialog.locator('#progress-title')).toHaveText('Loading 2026-08-01 → 2026-08-07 (7 days)', { timeout: 150_000 });
  await expect(dialog.locator('.progress-sequence')).toHaveText('Batch 4 of 4');
  await expect(dialog.locator('.progress-batch-time')).toHaveText(/^Last batch: 7 days in \d+ (min|s)/);
  await expect(dialog.getByText('COMPLETE', { exact: true })).toBeVisible({ timeout: 40_000 });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();

  // At the floor: the full history, nothing not loaded, and the receipt two days after the floor is on the chart.
  await expect(header.locator('.refresh-floor')).toHaveText('Full history since 2026-08-01');
  await expect(more).toHaveText(/^Scan more(\d+ days? to check|All caught up)$/);
  await expect(notLoaded).toHaveCount(0);
  await expect(page.locator('.range-list li.warning')).toHaveCount(0);
  await page.screenshot({ path: screenshot('earlier-coverage-after.png'), fullPage: true });
  await more.click();
  await expect(picker(page).locator('.more-row.not_loaded')).toHaveCount(0);
  await expect(picker(page).locator('.more-row .more-dates').last()).toHaveText('2026-08-01 → 2026-08-07');
  await picker(page).locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.locator('#period-reason-14d')).toHaveCount(0);
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(page.locator('.period-hero .period-caption')).toHaveText(/^2026-08-01 → 2026-09-21 · 52 days$/);
  await expect(page.locator('.chart-day[aria-label^="2026-08-03 UTC"]')).toHaveCount(1);
  await page.screenshot({ path: screenshot('earlier-overview-after.png'), fullPage: true });
  expect(errors).toEqual([]);
});
