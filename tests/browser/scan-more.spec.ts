import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Scan more against the synthetic fixtures (scripts/fixture-dashboard.mjs). The demo wallet was loaded with the range check, so
// every day is Checked. The read-once wallet's seven days were saved before it: its history holds a payout on 2026-09-16 that was
// saved and one on 2026-09-19 that was missed, which checking that batch finds.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const READ_ONCE_WALLET = 'EHksg99zC3NhBjL3dp5fNVHC4giGN4HtcxDjkAZnwAb5'; // Derived from the fixture label 'read-once-wallet'.

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const dayRows = (page: Page) => page.locator('.day-list li');
const picker = (page: Page) => page.getByRole('dialog', { name: 'Scan more' });
const rows = (page: Page) => picker(page).locator('.more-row');
/** Nothing scrolls sideways, and every button of the dialog fits the phone's width. */
async function fitsPhone(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const boxes = await picker(page).getByRole('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(375); }
}

test('Coverage opens Scan more on a read-once day, and a checked batch turns Confirmed and is not clickable', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/#coverage`); await expect(page.locator('.tabs')).toBeVisible();
  // The demo wallet was read with the range check: every loaded day is Checked, and none offers Scan more.
  await expect(page.locator('.day-list li.checked').first()).toBeVisible();
  await expect(page.locator('.day-list li.read_once')).toHaveCount(0);
  await expect(dayRows(page).getByRole('button', { name: 'Scan more' })).toHaveCount(0);

  await page.getByLabel('Saved wallets').selectOption(READ_ONCE_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(READ_ONCE_WALLET);
  // The header counts the days left to the floor, which come first.
  const moreButton = page.locator('.refresh .more-button');
  await expect(moreButton).toHaveText('Scan more45 days left to Aug 1');
  await page.getByRole('tab', { name: 'Overview' }).click();
  const hero = page.locator('.period-hero');
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  // Before: the one saved payout, 3 tokens at $0.50.
  await expect(hero.locator('.hero-figure')).toHaveText('$1.50');
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.locator('.day-states h3')).toHaveText('Loaded days · 0 checked · 8 read once · newest first');
  await expect(dayRows(page)).toHaveText(['2026-09-21Read onceScan more', '2026-09-20Read onceScan more', '2026-09-19Read onceScan more', '2026-09-18Read onceScan more',
    '2026-09-17Read onceScan more', '2026-09-16Read onceScan more', '2026-09-15Read onceScan more', '2026-09-14Read onceScan more']);
  await expect(page.locator('main')).not.toContainText(/not verified|Rescan/i);
  await page.screenshot({ path: screenshot('more-coverage-before.png'), fullPage: true });

  // A read-once day opens Scan more with its batch highlighted: one summary line, then every batch back to the floor, newest first.
  await dayRows(page).filter({ hasText: '2026-09-19' }).getByRole('button', { name: 'Scan more' }).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.more-summary')).toHaveText('Loaded 2026-09-14 → today · 45 days left to Aug 1');
  await expect(rows(page).first()).toHaveText('2026-09-21 → 2026-09-21 14:13LoadedCheck · 1 day');
  await expect(rows(page).nth(1)).toHaveText('2026-09-14 14:13 → 2026-09-20LoadedCheck · 7 days');
  await expect(rows(page).nth(2)).toHaveText('2026-09-07 14:13 → 2026-09-14 14:13Not loadedLoad');
  await expect(rows(page).last()).toHaveText('2026-08-01 → 2026-08-03 14:13Not loadedLoad');
  await expect(rows(page)).toHaveCount(9);
  await expect(picker(page).locator('.more-row.highlight')).toHaveText('2026-09-14 14:13 → 2026-09-20LoadedCheck · 7 days');
  await expect(picker(page).locator('input')).toHaveCount(0);
  await page.screenshot({ path: screenshot('more-dialog.png') });
  await rows(page).nth(1).getByRole('button', { name: 'Check · 7 days' }).click();

  // The same progress dialog as every job: its days, its request counts, then what the check found.
  const dialog = page.getByRole('dialog', { name: 'Rescanning 2026-09-14 → 2026-09-20' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.progress-sequence')).toHaveCount(0);
  await expect(dialog.locator('.progress-range')).toHaveText('Rescanned 2026-09-14 → 2026-09-20: 1 new payout found, 1 already saved. Every day in this range is now checked.', { timeout: 20_000 });
  // One listing per day and one full read of the missed payout; no StonkFun request.
  await expect(dialog.locator('.progress-requests')).toHaveText('Requests so far: Helius 8 · StonkFun 0');
  await expect(dialog.locator('.progress-days')).toHaveText('7 of 7 days done');
  await page.screenshot({ path: screenshot('more-check-done.png') });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();

  // After: the batch is Checked, the day after it is still read once, and the missed payout counts once.
  await expect(page.locator('.day-states h3')).toHaveText('Loaded days · 7 checked · 1 read once · newest first');
  await expect(dayRows(page).first()).toHaveText('2026-09-21Read onceScan more');
  await expect(dayRows(page).nth(1)).toHaveText('2026-09-20Checked');
  await expect(page.locator('.range-list li')).toHaveText(['COMPLETE2026-09-14 14:13 UTC → 2026-09-21 14:13 UTC']);
  await page.screenshot({ path: screenshot('more-coverage-after.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(hero.locator('.hero-figure')).toHaveText('$4.00');

  // The checked batch is Confirmed: shaded grey, disabled, and a click starts nothing.
  await moreButton.click();
  const confirmed = rows(page).nth(1);
  await expect(confirmed).toHaveText('2026-09-14 14:13 → 2026-09-20CheckedConfirmed');
  const action = confirmed.getByRole('button', { name: 'Confirmed' });
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await expect(action).toHaveCSS('background-color', 'rgb(18, 26, 33)');
  await expect(action).toHaveCSS('color', 'rgb(131, 145, 160)');
  await expect(action).toHaveCSS('cursor', 'not-allowed');
  await action.click({ force: true });
  await expect(picker(page)).toBeVisible();
  await expect(page.locator('#progress-title')).toHaveCount(0);
  await page.screenshot({ path: screenshot('more-confirmed.png') });

  // At phone width the list fits, one batch a row.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(rows(page).first()).toHaveText('2026-09-21 → 2026-09-21 14:13LoadedCheck · 1 day');
  await fitsPhone(page);
  await page.screenshot({ path: screenshot('more-dialog-mobile.png') });

  // Checking the last batch leaves every loaded day checked.
  await rows(page).first().getByRole('button', { name: 'Check · 1 day' }).click();
  const last = page.getByRole('dialog', { name: 'Rescanning 2026-09-21 → 2026-09-21' });
  await expect(last.locator('.progress-range')).toHaveText('Rescanned 2026-09-21 → 2026-09-21: 0 new payouts found, 0 already saved. Every day in this range is now checked.', { timeout: 20_000 });
  await last.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await moreButton.click();
  await expect(picker(page).locator('.more-row.loaded')).toHaveCount(0);
  await expect(picker(page).locator('.more-row.checked .more-action')).toHaveText(['Confirmed', 'Confirmed']);
  await fitsPhone(page);
  await picker(page).locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
  await expect(picker(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Scan more on a wallet loaded to the floor and fully checked reads All caught up, every batch Confirmed, at phone width', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  const moreButton = page.locator('.refresh .more-button');
  await expect(moreButton).toHaveText('Scan moreAll caught up');
  await moreButton.click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.more-summary')).toHaveText('Full history since 2026-08-01 · All caught up');
  await expect(rows(page).first()).toHaveText(/^2026-09-19 → 2026-09-21 \d\d:\d\dCheckedConfirmed$/);
  await expect(rows(page).last()).toHaveText('2026-08-01 → 2026-08-07CheckedConfirmed');
  await expect(picker(page).locator('.more-row.not_loaded, .more-row.loaded')).toHaveCount(0);
  for (const action of await picker(page).locator('.more-action').all()) await expect(action).toBeDisabled();
  await expect(picker(page).locator('input, details')).toHaveCount(0);
  await fitsPhone(page);
  await page.screenshot({ path: screenshot('more-all-checked-mobile.png') });
  await picker(page).locator('.dialog-actions').getByRole('button', { name: 'Close' }).click();
  await expect(picker(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
