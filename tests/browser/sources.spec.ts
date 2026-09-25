import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The Tokens tab's launch expansion against the synthetic fixtures (scripts/fixture-dashboard.mjs). The stacked wallet's stored
// refresh holds launches A and C (C since before tracking) and a zero balance of E; its transactions show B bought and sold.
// Summaries name A, B and C for $XBTC, E for $NEET and nothing for $DOGE.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const OFFLINE = 'http://127.0.0.1:4321';
const STACKED_WALLET = 'GdQqT7k7Br6WCTMFKZGnRMwLsk1tRYT8eRh8zK926uuK'; // Derived from the fixture label 'stacked-wallet'.
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UTC_TIME = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC`;
const LOADING = 'Checking launches you hold…';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => route.request().url().startsWith(`${OFFLINE}/`) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
/** The stacked wallet's Tokens tab, once the launches it prefetched on opening have arrived. */
async function tokensTab(page: Page) {
  const prefetched = page.waitForResponse(response => response.url().endsWith(`/wallets/${STACKED_WALLET}/sources`) && response.ok());
  await page.goto(`${OFFLINE}/#tokens`);
  await expect(page.locator('.tabs')).toBeVisible();
  await page.getByLabel('Saved wallets').selectOption(STACKED_WALLET);
  await expect(page.getByRole('textbox', { name: 'PUBLIC WALLET ADDRESS' })).toHaveValue(STACKED_WALLET);
  await prefetched;
}
/** Opens a token row's launches and returns them, checking they rendered straight away rather than loading. */
async function expand(page: Page, symbol: string) {
  await page.locator('.token-table tbody tr').filter({ hasText: symbol }).getByRole('button', { name: `Launches you hold that pay in ${symbol}` }).click();
  const section = page.getByRole('region', { name: `Launches you hold that pay in ${symbol}` });
  await expect(section.locator('h4')).toBeVisible();
  expect(await section.innerText()).not.toContain(LOADING);
  return section;
}

test('a token with matches opens at once on its held and sold launches, named, with Copy CA, StonkFun pages and the full list', async ({ page, context }) => {
  const errors = errorsOf(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await tokensTab(page);
  const section = await expand(page, '$XBTC');
  await expect(section.locator('.sources-asof')).toHaveText(new RegExp(`^Holdings as of ${UTC_TIME}$`));
  const launches = section.locator('.source-list > .source-launch');
  await expect(launches).toHaveCount(3);
  // Holding now, first: A with its retained name, and C, held since before tracking, named by the snapshot's metadata.
  const held = launches.filter({ hasText: 'Holding now' });
  await expect(held).toHaveCount(2);
  await expect(launches.nth(2).locator('.source-state')).toHaveText('Held earlier, sold');
  const a = held.filter({ hasText: '$LNCHA' }); const c = held.filter({ hasText: '$LNCHC' });
  await expect(a.locator('.source-name')).toHaveText('$LNCHASynthetic held launch AHolding now');
  await expect(a.locator('.source-held')).toHaveText('Holds 125.000000 Transaction ↗');
  await expect(c.locator('.source-name')).toHaveText('$LNCHCSynthetic launch C held before trackingHolding now');
  await expect(c.locator('.source-held')).toHaveText('Holds 9.500000');
  // B, bought and sold inside the window, has no name: its short address stands in.
  await expect(launches.nth(2).locator('.source-state')).toHaveText('Held earlier, sold');
  await expect(launches.nth(2).locator('.source-name b')).toHaveText(/^\w{5}…\w{5}$/);
  await expect(launches.nth(2).locator('.source-held')).toHaveText(new RegExp(`^None held now · last traded ${UTC_TIME} Transaction ↗$`));
  // Every StonkFun link opens the launch's token page, and Copy CA copies the full mint.
  const mint = (await c.locator('abbr.source-short').first().getAttribute('title'))!;
  expect(mint).toMatch(ADDRESS);
  await expect(c.getByRole('link', { name: 'StonkFun ↗' })).toHaveAttribute('href', `https://www.stonkfun.xyz/token/${mint}`);
  const copy = c.getByRole('button', { name: /^Copy .* launch contract address$/ });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mint);
  for (const href of await section.getByRole('link', { name: 'StonkFun ↗' }).evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    expect(href).toMatch(/^https:\/\/www\.stonkfun\.xyz\/token\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }
  await page.screenshot({ path: screenshot('ux-sources.png'), fullPage: true });
  // The full list: every summary launch, named ones first.
  await section.getByRole('button', { name: 'Show all 3 launches that pay in $XBTC' }).click();
  const all = section.getByRole('group', { name: 'All launches that pay in $XBTC' });
  await expect(all.locator('li')).toHaveCount(3);
  await expect(all.locator('.sources-foot')).toContainText('1–3 of 3.');
  await expect(all.locator('li').first()).toContainText('$LNCHA');
  await expect(all.getByRole('button', { name: /Copy .* launch contract address/ })).toHaveCount(3);
  await page.screenshot({ path: screenshot('ux-sources-all.png'), fullPage: true });
  // The chevron opens the launches, never the drawer.
  await expect(page).toHaveURL(/#tokens$/);
  expect(errors).toEqual([]);
});

test('a token without matches says so at once, says why, and still lists the launches that pay in it', async ({ page }) => {
  const errors = errorsOf(page);
  await tokensTab(page);
  // $NEET's one launch, E, is not held: its zero balance was never stored.
  const neet = await expand(page, '$NEET');
  await expect(neet.locator('.source-list > .source-launch')).toHaveCount(0);
  await expect(neet.locator('.sources-empty')).toHaveText('No launch you hold was found that pays in $NEET.');
  await expect(neet.locator('.sources-why')).toHaveText('This can happen when a launch was held and sold before tracking started, or when the paying launch is not in StonkFun\'s summaries.');
  await neet.getByRole('button', { name: 'Show the one launch that pays in $NEET' }).click();
  const all = neet.getByRole('group', { name: 'All launches that pay in $NEET' });
  await expect(all.locator('li')).toHaveCount(1);
  await expect(all.locator('li .source-name b')).toHaveText(/^\w{5}…\w{5}$/);
  await expect(all.getByRole('link', { name: 'StonkFun ↗' })).toHaveAttribute('href', /^https:\/\/www\.stonkfun\.xyz\/token\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  // No summary names $DOGE: the same empty state, and no list.
  const doge = await expand(page, '$DOGE');
  await expect(doge.locator('.sources-empty')).toHaveText('No launch you hold was found that pays in $DOGE.');
  await expect(doge.locator('.sources-foot')).toHaveText('No retained StonkFun /rewards summary names $DOGE as the token a launch pays in.');
  await expect(doge.getByRole('button', { name: /^Show/ })).toHaveCount(0);
  await page.screenshot({ path: screenshot('ux-sources-empty.png'), fullPage: true });
  // A row still opens its drawer.
  await page.locator('.token-table tbody tr').filter({ hasText: '$NEET' }).locator('.row-open').click();
  await expect(page.getByRole('dialog', { name: '$NEET' })).toBeVisible();
  expect(errors).toEqual([]);
});
