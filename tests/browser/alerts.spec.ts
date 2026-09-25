import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DashboardJob } from '../../src/web/service.js';

// Failure classes, the rate-limit banner, the empty state and the wallet input against the synthetic fixtures
// (scripts/fixture-dashboard.mjs). A job's failure fields are fixture responses: the demo wallet's saved job, changed as the
// service reports a job that stopped on that class, so no provider is asked anything.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const DEMO_WALLET = '8'.repeat(32);
const EMPTY_WALLET = 'BiVgQajm9XRKkUoDKH3JD8JEEf5mxRJvrZH7drjMYH5E'; // Derived from the fixture label 'empty-history-wallet'.

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Serves the demo wallet's job with `change` applied, on every poll. */
async function serveJob(page: Page, change: (job: DashboardJob) => DashboardJob) {
  await page.route(`${CONFIGURED}/api/v1/wallets/${DEMO_WALLET}/job`, async route => {
    const response = await route.fetch(); const job = await response.json() as DashboardJob;
    await route.fulfill({ response, json: change(job) });
  });
}
/** A Load earlier batch that stopped after three of its seven days on `failureClass`. */
const stopped = (failureClass: DashboardJob['failureClass'], failureDetail: string | null = null) => (job: DashboardJob): DashboardJob => ({
  ...job, status: 'paused', runningLocally: false, canResume: true, resumeBlocked: false, cancelled: false, failure: 'Scan interrupted; acknowledged work is saved',
  kind: 'earlier', batch: { kind: 'earlier', startTime: Date.parse('2026-09-04T14:13:00Z') / 1000, endTime: Date.parse('2026-09-11T14:13:00Z') / 1000 },
  failureClass, failureMessage: null, failureDetail, savedDays: { completed: 3, planned: 7 }, savedNote: 'Completed days are saved: 3 of 7.',
  progress: { ...job.progress, finishedAt: job.progress.serverNow } });
async function openProgress(page: Page) {
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  await page.locator('.status-button').click();
  await page.getByRole('dialog', { name: 'Status' }).getByRole('button', { name: /^View scan progress/ }).click();
  const dialog = page.locator('dialog[open]'); await expect(dialog).toBeVisible(); return dialog;
}

test('a rejected key says so, keeps the saved days, reopens the key form and retries by resuming', async ({ page }) => {
  const errors = errorsOf(page);
  await serveJob(page, stopped('key_rejected'));
  const resumed: string[] = [];
  await page.route(`${CONFIGURED}/api/v1/jobs/*/resume`, async route => {
    resumed.push(route.request().url());
    const response = await page.request.get(`${CONFIGURED}/api/v1/wallets/${DEMO_WALLET}/job`);
    await route.fulfill({ status: 200, json: stopped('key_rejected')(await response.json() as DashboardJob) });
  });
  const dialog = await openProgress(page);
  await expect(dialog.locator('#progress-title')).toHaveText('Loading 2026-09-04 → 2026-09-11 (7 days)');
  const notice = dialog.locator('.failure-notice');
  await expect(notice).toHaveText('Helius rejected your API key. Check the key and try again.Completed days are saved: 3 of 7.Re-enter API keyRetry');
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(dialog.getByRole('button', { name: 'RESUME', exact: true })).toHaveCount(0);
  await page.screenshot({ path: screenshot('alert-key-rejected.png') });
  await notice.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => resumed.length).toBe(1);
  await notice.getByRole('button', { name: 'Re-enter API key' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const form = page.getByRole('dialog', { name: 'Helius API key' });
  await expect(form.locator('.key-form-lead')).toHaveText('Helius rejected your API key. Enter the key again, then Retry.');
  await expect(form.getByLabel('Helius API key')).toBeFocused();
  // The status panel names the job and its failure.
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.status-button').click();
  const panel = page.getByRole('dialog', { name: 'Status' });
  await expect(panel.locator('.status-failure')).toHaveText('Helius rejected your API key. Check the key and try again. Completed days are saved: 3 of 7.');
  await expect(panel.getByLabel('Last job', { exact: true })).toContainText('JobLoad earlier · 2026-09-04 → 2026-09-11');
  await expect(panel.getByLabel('Last job', { exact: true })).toContainText(/RequestsHelius \d+ · StonkFun \d+/);
  expect(errors).toEqual([]);
});

test('a quota refusal quotes Helius and points to the Helius dashboard, at desktop and phone width', async ({ page }) => {
  const errors = errorsOf(page);
  await serveJob(page, stopped('helius_quota', 'Plan credit limit reached for this key'));
  const dialog = await openProgress(page);
  const notice = dialog.locator('.failure-notice');
  await expect(notice.locator('b')).toHaveText('Helius refused the request: Plan credit limit reached for this key. A free plan may have used its monthly credits. '
    + 'Check usage in your Helius dashboard.');
  await expect(notice).toContainText('Completed days are saved: 3 of 7.');
  await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Re-enter API key' })).toHaveCount(0);
  await page.screenshot({ path: screenshot('alert-quota.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(notice).toBeInViewport();
  const box = (await notice.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: screenshot('alert-quota-mobile.png') });
  expect(errors).toEqual([]);
});

test('a Helius rate limit on a running job is a banner, and the scan keeps going', async ({ page }) => {
  const errors = errorsOf(page);
  await serveJob(page, job => ({ ...job, status: 'running', runningLocally: true, canResume: false, failure: null, failureClass: 'helius_rate_limited',
    failureMessage: 'Helius is rate limiting requests.', failureDetail: null, savedNote: null,
    progress: { ...job.progress, finishedAt: null, lastActivityAt: job.progress.serverNow, waiting: { provider: 'helius', reason: 'rate_limit' } } } as DashboardJob));
  const dialog = await openProgress(page);
  await expect(dialog.locator('.rate-limit')).toHaveText('Helius is limiting requests, slowing down.');
  await expect(dialog.locator('.failure-notice')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'CANCEL SCAN' })).toBeVisible();
  await expect(dialog.getByText('WORKING', { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshot('alert-rate-limit.png') });
  expect(errors).toEqual([]);
});

test('a loaded range with no payouts says what was checked and offers Scan more, at desktop and phone width', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  await page.getByLabel('Saved wallets').selectOption(EMPTY_WALLET);
  const empty = page.locator('.empty-history');
  await expect(empty.locator('h2')).toHaveText('No StonkFun payouts found between 2026-09-14 and today.');
  await expect(empty).toContainText('Days before 2026-09-14 are not loaded yet. Scan more to check them.');
  await expect(empty.getByRole('button', { name: 'Scan more' })).toBeEnabled();
  await expect(page.locator('.reward-chart')).toHaveCount(0);
  await expect(page.locator('.refresh-floor')).toHaveText('Loaded 2026-09-14 → today');
  await expect(page.locator('.refresh .more-button')).toHaveText('Scan more45 days left to Aug 1');
  await page.screenshot({ path: screenshot('empty-history.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(empty.locator('h2')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: screenshot('empty-history-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('an invalid address gets an inline message and no request', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible();
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !request.url().endsWith('/health') && !request.url().endsWith(`/wallets/${DEMO_WALLET}/job`)) requests.push(request.url()); });
  const input = page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' });
  await input.fill('0xNotASolanaWallet');
  await input.press('Enter');
  const message = page.locator('#wallet-error');
  await expect(message).toHaveText('That is not a Solana address: addresses use letters and digits, without 0, O, I or l.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('aria-describedby', 'wallet-error');
  await input.fill('abc');
  await expect(message).toHaveCount(0);
  await page.getByRole('button', { name: 'Check latest data' }).click();
  await expect(message).toHaveText('That is not a Solana address: addresses are 32 to 44 characters, and this has 3.');
  await page.screenshot({ path: screenshot('wallet-invalid.png') });
  // The report on screen stays, and nothing was asked of the server.
  await expect(page.locator('.tabs')).toBeVisible();
  expect(requests).toEqual([]);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(message).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
