import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// One wallet in view and one clear action, against the synthetic fixtures (scripts/fixture-dashboard.mjs). The unscanned addresses
// below are synthetic and tracked by no fixture; a fixture scan of one reads the demo network and saves it like any first scan.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318';
const DEMO_WALLET = '8'.repeat(32);
const EMPTY_WALLET = 'BiVgQajm9XRKkUoDKH3JD8JEEf5mxRJvrZH7drjMYH5E'; // Derived from the fixture label 'empty-history-wallet'.
const LONG_WALLET = 'CQoAc2qm84xKDQvN98DGRx4QTobQvfkNSY5qd8MwNXHQ'; // Derived from 'long-history-wallet'.
const FRESH = `Fresh${'2'.repeat(39)}`;
const WAITING = `Waits${'4'.repeat(39)}`;
const THIRD = `Third${'5'.repeat(39)}`;
const PHONE = `Phone${'6'.repeat(39)}`;
const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const FIRST_SCAN_NOTE = 'The first scan covers the last 7 days and takes a few minutes. Older history loads afterwards in 7-day batches.';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const ready = async (page: Page) => { await page.goto(`${CONFIGURED}/`); await expect(page.locator('.tabs')).toBeVisible(); await expect(page.locator('.hero-figure')).toBeVisible(); };
const box = (page: Page) => page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' });
const state = (page: Page) => page.locator('.status-button .working-indicator');
/** Pastes `text` over the wallet box from the clipboard, as a person would. */
async function paste(page: Page, text: string) {
  await page.evaluate(async value => { await navigator.clipboard.writeText(value); }, text);
  await box(page).focus(); await box(page).press('ControlOrMeta+A'); await box(page).press('ControlOrMeta+V');
}

test('a pasted unscanned address becomes the view with Scan wallet, and its first scan shows its report and saves it', async ({ page, context }) => {
  const errors = errorsOf(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CONFIGURED });
  const scans: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1/scans')) scans.push(request.postData() ?? ''); });
  await ready(page);
  await expect(page.locator('.status-wallet')).toHaveText(short(DEMO_WALLET));
  await paste(page, FRESH);
  // The view switches at once, with no button pressed: the header, its status, the button and every tab name the new wallet.
  await expect(box(page)).toHaveValue(FRESH);
  await expect(page.locator('.status-wallet')).toHaveText(short(FRESH));
  await expect(state(page)).toHaveText('Not scanned yet');
  await expect(page.locator('.status-refresh')).toHaveCount(0);
  const button = page.locator('.refresh-button');
  await expect(button).toHaveText(/^Scan wallet/); await expect(button).toBeEnabled();
  await expect(page.locator('.refresh-last')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check latest data' })).toHaveCount(0);
  const panel = page.locator('.unscanned');
  await expect(panel.locator('h2')).toHaveText(`${short(FRESH)} has not been scanned yet.`);
  await expect(panel.getByRole('button', { name: 'Scan wallet' })).toBeEnabled();
  await expect(panel.locator('p')).toHaveText(FIRST_SCAN_NOTE);
  for (const tab of ['Tokens', 'Payouts', 'Trust', 'Coverage', 'Overview']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(panel.locator('h2')).toHaveText(`${short(FRESH)} has not been scanned yet.`);
  }
  await expect(page.getByLabel('Saved wallets').locator('option')).not.toContainText([short(FRESH)]);
  await page.screenshot({ path: screenshot('wallet-unscanned.png'), fullPage: true });
  expect(scans).toEqual([]);
  // Scan wallet scans the wallet in view, and the dialog names it.
  await panel.getByRole('button', { name: 'Scan wallet' }).click();
  const dialog = page.getByRole('dialog', { name: `Scanning ${short(FRESH)}: last 7 days` });
  await expect(dialog).toBeVisible();
  expect(scans).toEqual([JSON.stringify({ wallet: FRESH })]);
  await page.screenshot({ path: screenshot('wallet-first-scan.png') });
  await page.keyboard.press('Escape');
  await expect(button).toHaveText(/^Scan running…/);
  await expect(state(page)).toHaveText(/^WORKING · \d{4}-\d{2}-\d{2}$/);
  // Finished, its report replaces the panel, it joins the saved list, and the button becomes Check latest data.
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect(button).toHaveText(/^Check latest data/); await expect(button).toBeEnabled();
  await expect(state(page)).toHaveText('COMPLETE');
  await expect(page.locator('.refresh-last')).toHaveText(/^Last refresh 2026-\d\d-\d\d \d\d:\d\d UTC$/);
  await expect(page.locator('.refresh-floor')).toContainText(/^Loaded 2026-\d\d-\d\d → today/);
  await expect(page.locator('.tabs')).toBeVisible();
  await expect(page.getByLabel('Saved wallets')).toHaveValue(FRESH);
  await page.screenshot({ path: screenshot('wallet-first-scan-report.png'), fullPage: true });
  expect(scans).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('choosing a saved wallet, or typing one, views it with Check latest data and its last refresh', async ({ page }) => {
  const errors = errorsOf(page);
  await ready(page);
  await page.getByLabel('Saved wallets').selectOption(LONG_WALLET);
  await expect(box(page)).toHaveValue(LONG_WALLET);
  await expect(page.locator('.status-wallet')).toHaveText(short(LONG_WALLET));
  await expect(page.locator('.refresh-button')).toHaveText(/^Check latest data/);
  await expect(page.locator('.refresh-button')).toBeEnabled();
  await expect(page.locator('.refresh-last')).toHaveText(/^Last refresh 2026-/);
  await expect(state(page)).not.toHaveText('Not scanned yet');
  await expect(page.locator('.unscanned')).toHaveCount(0);
  // A typed address, trimmed, switches the view the same way.
  await box(page).fill(`  ${EMPTY_WALLET}  `);
  await expect(page.locator('.status-wallet')).toHaveText(short(EMPTY_WALLET));
  await expect(page.getByLabel('Saved wallets')).toHaveValue(EMPTY_WALLET);
  await expect(page.locator('.refresh-button')).toHaveText(/^Check latest data/);
  await expect(page.locator('.empty-history')).toBeVisible();
  expect(errors).toEqual([]);
});

test('while one wallet scans the view can switch, and every other wallet waits, naming the one that runs', async ({ page }) => {
  const errors = errorsOf(page);
  await ready(page);
  await box(page).fill(WAITING);
  await page.locator('.unscanned').getByRole('button', { name: 'Scan wallet' }).click();
  await expect(page.getByRole('dialog', { name: `Scanning ${short(WAITING)}: last 7 days` })).toBeVisible();
  await page.keyboard.press('Escape');
  // Another saved wallet: in view, but its Check latest data and Scan more wait.
  await page.getByLabel('Saved wallets').selectOption(EMPTY_WALLET);
  await expect(page.locator('.status-wallet')).toHaveText(short(EMPTY_WALLET));
  const button = page.locator('.refresh-button');
  await expect(button).toHaveText(/^Check latest data/); await expect(button).toBeDisabled();
  await expect(page.locator('.refresh .running-elsewhere')).toHaveText(`A scan is running for ${short(WAITING)}`);
  await expect(button).toHaveAttribute('aria-describedby', /running-elsewhere/);
  await expect(page.locator('.refresh .more-button')).toBeDisabled();
  await expect(page.locator('.empty-history').getByRole('button', { name: 'Scan more' })).toBeDisabled();
  await page.screenshot({ path: screenshot('wallet-running-elsewhere.png') });
  // Another unscanned wallet: its panel's Scan wallet waits too.
  await box(page).fill(THIRD);
  const scan = page.locator('.unscanned').getByRole('button', { name: 'Scan wallet' });
  await expect(scan).toBeDisabled();
  await expect(page.locator('.unscanned .running-elsewhere')).toHaveText(`A scan is running for ${short(WAITING)}`);
  await expect(button).toBeDisabled();
  // Back on the running wallet, its own button says it is running, and no other wallet is named.
  await box(page).fill(WAITING);
  await expect(page.locator('.status-wallet')).toHaveText(short(WAITING));
  await expect(button).toHaveText(/^Scan running…/);
  await expect(page.locator('.running-elsewhere')).toHaveCount(0);
  // Once it finishes, every wallet can start again.
  await expect(button).toHaveText(/^Check latest data/, { timeout: 30_000 });
  await box(page).fill(THIRD);
  await expect(scan).toBeEnabled();
  await expect(page.locator('.running-elsewhere')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a first launch with no saved wallet focuses the empty wallet box and scans nothing until an address is given', async ({ page }) => {
  const errors = errorsOf(page);
  const scans: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1/scans')) scans.push(request.url()); });
  // The fixture server holds saved wallets; this page is told there are none, as on a new install.
  await page.route(`${CONFIGURED}/api/v1/wallets`, route => route.fulfill({ json: { wallets: [] } }));
  await page.goto(`${CONFIGURED}/`);
  const input = box(page);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', 'Paste a Solana wallet address');
  await expect(page.locator('.welcome h2')).toHaveText('Start with a wallet address.');
  await expect(page.locator('.status-wallet')).toHaveCount(0);
  await expect(page.locator('.tabs')).toHaveCount(0);
  await expect(page.locator('.refresh-button')).toHaveText(/^Scan wallet/);
  await expect(page.getByRole('button', { name: 'Check latest data' })).toHaveCount(0);
  await page.screenshot({ path: screenshot('wallet-first-launch.png') });
  await page.locator('.refresh-button').click();
  await expect(page.locator('#wallet-error')).toHaveText('Enter a public Solana wallet address.');
  // The first address typed becomes the view with its panel.
  await input.fill(FRESH.replace('Fresh', 'First'));
  await expect(page.locator('.unscanned h2')).toHaveText(`${short(FRESH.replace('Fresh', 'First'))} has not been scanned yet.`);
  await expect(page.locator('#wallet-error')).toHaveCount(0);
  expect(scans).toEqual([]);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('at phone width the header names the wallet in view and the panel fits', async ({ page }) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await ready(page);
  await box(page).fill(PHONE);
  const panel = page.locator('.unscanned');
  await expect(panel.locator('h2')).toHaveText(`${short(PHONE)} has not been scanned yet.`);
  await expect(page.locator('.status-wallet')).toHaveText(short(PHONE));
  await expect(page.locator('.status-wallet')).toBeInViewport();
  await expect(state(page)).toHaveText('Not scanned yet');
  await expect(page.locator('.refresh-button')).toHaveText(/^Scan wallet/);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  const scan = (await panel.getByRole('button', { name: 'Scan wallet' }).boundingBox())!;
  expect(scan.x).toBeGreaterThanOrEqual(bounds.x); expect(scan.x + scan.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  await page.screenshot({ path: screenshot('wallet-unscanned-mobile.png'), fullPage: true });
  // A scanned wallet's header keeps its address, status and last refresh within the width.
  await page.getByLabel('Saved wallets').selectOption(DEMO_WALLET);
  await expect(page.locator('.status-wallet')).toHaveText(short(DEMO_WALLET));
  await expect(page.locator('.refresh-button')).toHaveText(/^Check latest data/);
  await expect(page.locator('.status-refresh')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: screenshot('wallet-scanned-mobile.png') });
  expect(errors).toEqual([]);
});
