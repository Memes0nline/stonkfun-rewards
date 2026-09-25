import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Rescan dates against the synthetic fixtures (scripts/fixture-dashboard.mjs). The demo wallet was loaded with the range check,
// so every day is Checked. The read-once wallet's seven days were saved before it: its history holds a payout on 2026-09-16 that
// was saved and one on 2026-09-19 that was missed, which a rescan of that week finds.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const READ_ONCE_WALLET = 'EHksg99zC3NhBjL3dp5fNVHC4giGN4HtcxDjkAZnwAb5'; // Derived from the fixture label 'read-once-wallet'.
const SUMMARY = 'Rescan 2026-09-14 → 2026-09-20 (7 days). Checks these days again and adds anything missed. Payouts already saved are not counted twice.';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const dayRows = (page: Page) => page.locator('.day-list li');
const picker = (page: Page) => page.getByRole('dialog', { name: 'Rescan dates' });
const toCheck = (page: Page) => picker(page).getByRole('group', { name: 'To check' }).getByRole('button');
const confirmed = (page: Page) => picker(page).getByRole('group', { name: 'Already confirmed' }).getByRole('button');
/** Nothing scrolls sideways, and every button of the dialog fits the phone's width. */
async function fitsPhone(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const boxes = await picker(page).getByRole('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(375); }
}

test('Coverage shows each loaded day as Checked or Read once, and a rescan moves its week from To check to Already confirmed', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/#coverage`); await expect(page.locator('.tabs')).toBeVisible();
  // The demo wallet was read with the range check: every loaded day is Checked, and none offers a rescan.
  await expect(page.locator('.day-list li.checked').first()).toBeVisible();
  await expect(page.locator('.day-list li.read_once')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rescan to double-check' })).toHaveCount(0);

  await page.getByLabel('Saved wallets').selectOption(READ_ONCE_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(READ_ONCE_WALLET);
  // The header counts the loaded days still to check.
  const rescanButton = page.locator('.rescan-button');
  await expect(rescanButton).toHaveText('Rescan dates · 8 days to check');
  await page.getByRole('tab', { name: 'Overview' }).click();
  const hero = page.locator('.period-hero');
  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  // Before: the one saved payout, 3 tokens at $0.50.
  await expect(hero.locator('.hero-figure')).toHaveText('$1.50');
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.locator('.day-states h3')).toHaveText('Loaded days · 0 checked · 8 read once · newest first');
  await expect(dayRows(page)).toHaveText([
    '2026-09-21Read onceRescan to double-check', '2026-09-20Read onceRescan to double-check', '2026-09-19Read onceRescan to double-check',
    '2026-09-18Read onceRescan to double-check', '2026-09-17Read onceRescan to double-check', '2026-09-16Read onceRescan to double-check',
    '2026-09-15Read onceRescan to double-check', '2026-09-14Read onceRescan to double-check']);
  await expect(page.locator('main')).not.toContainText(/not verified/i);
  await page.screenshot({ path: screenshot('rescan-coverage-before.png'), fullPage: true });

  // Rescan to double-check opens Rescan dates on that day's week, with the exact range before anything starts. Both weeks are
  // to check, and no week is confirmed yet.
  await dayRows(page).filter({ hasText: '2026-09-19' }).getByRole('button', { name: 'Rescan to double-check' }).click();
  await expect(picker(page)).toBeVisible();
  await expect(toCheck(page)).toHaveText(['2026-09-21 → 2026-09-21 · 1 day to check', '2026-09-14 → 2026-09-20 · 7 days to check']);
  await expect(toCheck(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(confirmed(page)).toHaveCount(0);
  await expect(picker(page).locator('.rescan-section').nth(1)).toContainText('No week is fully checked yet.');
  // The day fields wait, collapsed, under Check other dates.
  await expect(picker(page).getByLabel('Start day (UTC)')).toBeHidden();
  await expect(picker(page).locator('.rescan-summary')).toHaveText(SUMMARY);
  await page.screenshot({ path: screenshot('rescan-dialog.png') });
  await picker(page).getByRole('button', { name: 'Rescan', exact: true }).click();

  // The same progress dialog as every job: its days, its request counts, then what the checks found.
  const dialog = page.getByRole('dialog', { name: 'Rescanning 2026-09-14 → 2026-09-20' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.progress-range')).toHaveText('Rescanned 2026-09-14 → 2026-09-20: 1 new payout found, 1 already saved. Every day in this range is now checked.', { timeout: 20_000 });
  // One listing per day and one full read of the missed payout; no StonkFun request.
  await expect(dialog.locator('.progress-requests')).toHaveText('Requests so far: Helius 8 · StonkFun 0');
  await expect(dialog.locator('.progress-days')).toHaveText('7 of 7 days done');
  await page.screenshot({ path: screenshot('rescan-done.png') });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();

  // After: the week is Checked, the day after it is still read once, and the missed payout counts once.
  await expect(page.locator('.day-states h3')).toHaveText('Loaded days · 7 checked · 1 read once · newest first');
  await expect(dayRows(page).first()).toHaveText('2026-09-21Read onceRescan to double-check');
  await expect(dayRows(page).nth(1)).toHaveText('2026-09-20Checked');
  await expect(page.locator('.range-list li')).toHaveText(['COMPLETE2026-09-14 14:13 UTC → 2026-09-21 14:13 UTC']);
  await expect(rescanButton).toHaveText('Rescan dates · 1 day to check');
  await page.screenshot({ path: screenshot('rescan-coverage-after.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(hero.locator('.hero-figure')).toHaveText('$4.00');

  // The rescanned week moved to Already confirmed: shaded grey, disabled, and a click picks nothing.
  await rescanButton.click();
  await expect(toCheck(page)).toHaveText(['2026-09-21 → 2026-09-21 · 1 day to check']);
  await expect(toCheck(page).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(confirmed(page)).toHaveText(['2026-09-14 → 2026-09-20 · confirmed']);
  const week = confirmed(page).first();
  await expect(week).toBeDisabled();
  await expect(week).toHaveAttribute('aria-disabled', 'true');
  await expect(week).not.toHaveAttribute('aria-pressed');
  await expect(week).toHaveCSS('background-color', 'rgb(18, 26, 33)');
  await expect(week).toHaveCSS('color', 'rgb(131, 145, 160)');
  await expect(week).toHaveCSS('cursor', 'not-allowed');
  await week.click({ force: true });
  await expect(toCheck(page).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(picker(page).locator('.rescan-summary')).toHaveText('Rescan 2026-09-21 → 2026-09-21 (1 day). Checks these days again and adds anything missed. Payouts already saved are not counted twice.');
  await page.screenshot({ path: screenshot('rescan-sections.png') });

  // A confirmed week can still be checked again through Check other dates: it finds nothing new and changes no total.
  await picker(page).getByText('Check other dates').click();
  await picker(page).getByLabel('Start day (UTC)').fill('2026-09-14');
  await picker(page).getByLabel('End day (UTC)').fill('2026-09-20');
  await expect(picker(page).locator('.rescan-summary')).toHaveText(SUMMARY);
  await picker(page).getByRole('button', { name: 'Rescan', exact: true }).click();
  await expect(dialog.locator('.progress-range')).toHaveText('Rescanned 2026-09-14 → 2026-09-20: 0 new payouts found, 2 already saved. Every day in this range is now checked.', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await expect(hero.locator('.hero-figure')).toHaveText('$4.00');

  // At phone width both sections fit, one week a line.
  await page.setViewportSize({ width: 375, height: 812 });
  await rescanButton.click();
  await expect(toCheck(page)).toHaveText(['2026-09-21 → 2026-09-21 · 1 day to check']);
  await expect(confirmed(page)).toHaveText(['2026-09-14 → 2026-09-20 · confirmed']);
  await fitsPhone(page);
  await page.screenshot({ path: screenshot('rescan-sections-mobile.png') });

  // Rescanning the last week to check leaves every loaded day checked: the header drops its count and To check says so.
  await picker(page).getByRole('button', { name: 'Rescan', exact: true }).click();
  const last = page.getByRole('dialog', { name: 'Rescanning 2026-09-21 → 2026-09-21' });
  await expect(last.locator('.progress-range')).toHaveText('Rescanned 2026-09-21 → 2026-09-21: 0 new payouts found, 0 already saved. Every day in this range is now checked.', { timeout: 20_000 });
  await last.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await expect(rescanButton).toHaveText('Rescan dates');
  await rescanButton.click();
  await expect(toCheck(page)).toHaveCount(0);
  await expect(picker(page).locator('.rescan-section').first()).toContainText('Every loaded day is checked.');
  await expect(confirmed(page)).toHaveText(['2026-09-21 → 2026-09-21 · confirmed', '2026-09-14 → 2026-09-20 · confirmed']);
  // Nothing is picked until days are chosen under Check other dates.
  await expect(picker(page).getByRole('button', { name: 'Rescan', exact: true })).toBeDisabled();
  await fitsPhone(page);
  await picker(page).getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('Rescan dates fits a phone, limits a choice to seven loaded days and says why', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  // Every day of the demo wallet is checked: the header names no count, To check says so, and every week back to the floor is
  // confirmed, newest first.
  await expect(page.locator('.rescan-button')).toHaveText('Rescan dates');
  await page.locator('.rescan-button').click();
  await expect(picker(page)).toBeVisible();
  await expect(toCheck(page)).toHaveCount(0);
  await expect(picker(page).locator('.rescan-section').first()).toContainText('Every loaded day is checked.');
  await expect(confirmed(page).first()).toHaveText('2026-09-21 → 2026-09-21 · confirmed');
  await expect(confirmed(page).last()).toHaveText('2026-08-01 → 2026-08-02 · confirmed');
  for (const week of await confirmed(page).all()) await expect(week).toBeDisabled();
  await expect(picker(page).getByRole('button', { name: 'Rescan', exact: true })).toBeDisabled();
  await fitsPhone(page);
  await page.screenshot({ path: screenshot('rescan-all-checked-mobile.png') });
  await picker(page).getByText('Check other dates').click();
  await picker(page).getByLabel('Start day (UTC)').fill('2026-09-10');
  await picker(page).getByLabel('End day (UTC)').fill('2026-09-17');
  await expect(picker(page).locator('.rescan-error')).toHaveText('Rescan at most 7 days at a time; this is 8.');
  await expect(picker(page).getByRole('button', { name: 'Rescan', exact: true })).toBeDisabled();
  await picker(page).getByLabel('Start day (UTC)').fill('2026-07-30');
  await picker(page).getByLabel('End day (UTC)').fill('2026-08-02');
  await expect(picker(page).locator('.rescan-error')).toHaveText('Rescan only loaded days, 2026-08-01 → 2026-09-21.');
  await picker(page).getByLabel('Start day (UTC)').fill('2026-09-11');
  await picker(page).getByLabel('End day (UTC)').fill('2026-09-17');
  await expect(picker(page).locator('.rescan-summary')).toHaveText('Rescan 2026-09-11 → 2026-09-17 (7 days). Checks these days again and adds anything missed. Payouts already saved are not counted twice.');
  await expect(picker(page).getByRole('button', { name: 'Rescan', exact: true })).toBeEnabled();
  await fitsPhone(page);
  await page.screenshot({ path: screenshot('rescan-dialog-mobile.png') });
  await picker(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(picker(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
