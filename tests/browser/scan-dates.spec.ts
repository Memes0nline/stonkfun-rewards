import { expect, test } from '@playwright/test';

// The UTC dates a scan reads, against the synthetic fixtures (scripts/fixture-dashboard.mjs): the primary button's second line
// idle and running, the status chip's day, and the scan dialog from its first line to the finished refresh.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const MINUTE = '2026-\\d\\d-\\d\\d \\d\\d:\\d\\d';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});

test('names the dates a refresh reads on its button, in the status chip and in the dialog', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.goto(`${CONFIGURED}/`);
  const button = page.locator('.refresh-button');
  await expect(button.locator('.button-label')).toHaveText('Refresh rewards');
  // Idle, the button says the refresh checks from the last cutoff to now.
  await expect(button.locator('.button-range')).toHaveText(new RegExp(`^Checks ${MINUTE} UTC → now$`));
  const from = /^Checks (.+) UTC → now$/.exec(await button.locator('.button-range').innerText())![1]!;
  const day = from.slice(0, 10);
  await button.click();

  // The dialog's first line is the span it reads, with times under a day, then the day it is on and the days done.
  const dialog = page.getByRole('dialog', { name: 'Refreshing 88888…88888' });
  await expect(dialog.locator('.progress-range')).toHaveText(new RegExp(`^Reading ${from} → ${MINUTE} UTC$`));
  await expect(dialog.locator('.progress-days')).toHaveText(`Now reading ${day} · 0 of 1 day done`);
  await page.screenshot({ path: screenshot('scan-dates-dialog.png') });
  await page.keyboard.press('Escape');

  // Running, the button names the span and the chip the day.
  await expect(button.locator('.button-label')).toHaveText('Scan running…');
  await expect(button.locator('.button-range')).toHaveText(new RegExp(`^Scanning ${from} → ${MINUTE}$`));
  await expect(page.locator('.status-button .working-indicator')).toHaveText(`WORKING · ${day}`);
  await page.screenshot({ path: screenshot('scan-dates-running.png') });

  // Finished, the dialog says what it read and the payouts it found, and the idle button checks from the new cutoff.
  await page.locator('.status-button').click();
  await page.getByRole('button', { name: 'View scan progress →' }).click();
  await expect(dialog.locator('.progress-range')).toHaveText(new RegExp(`^Done: ${from} → ${MINUTE} · \\d+ new payouts?$`), { timeout: 20_000 });
  await expect(dialog.locator('.progress-days')).toHaveText('1 of 1 day done');
  await page.screenshot({ path: screenshot('scan-dates-done.png') });
  const to = new RegExp(`^Done: ${from} → (${MINUTE}) · `).exec(await dialog.locator('.progress-range').innerText())![1]!;
  await dialog.getByRole('button', { name: 'DISMISS', exact: true }).click();
  await expect(button.locator('.button-range')).toHaveText(`Checks ${to} UTC → now`);
  await expect(page.locator('.status-button .working-indicator')).toHaveText('COMPLETE');
  expect(errors).toEqual([]);
});
