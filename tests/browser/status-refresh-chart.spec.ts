import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// UX round 2 against the synthetic fixtures (scripts/fixture-dashboard.mjs): the header status dropdown, the refresh control
// in each of its states with in-page key entry, and the token-stacked attributed chart.
const screenshot = (name: string) => `${process.env.REVIEW_SCREENSHOTS === '1' ? 'review' : '.cache/dashboard/screenshots'}/${name}`;
const CONFIGURED = 'http://127.0.0.1:4318'; const UNCONFIGURED = 'http://127.0.0.1:4320'; const OFFLINE = 'http://127.0.0.1:4321';
const STACKED_WALLET = 'GdQqT7k7Br6WCTMFKZGnRMwLsk1tRYT8eRh8zK926uuK'; // Derived from the fixture label 'stacked-wallet'.
const XBTC = '9K86JPJ8MmAjdPRMrd53r2AXon9cgXWHGgJ3vtgHqMd7'; // Derived from 'stacked-quote-XBTC'.
/** The twelve validated token colors, in slot order, and the Other gray. */
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#08a4bd', '#945701', '#a519cb', '#838503'];
const LEGEND = ['$XBTC', '$BONK', '$DOGE', '$NEET', '$XMR', '$SPCX', '$STNK', '$USDC', '$WIF', '$JUP', '$PYTH', '$RAY'];
const OTHER = '#6b7885';
const SYNTHETIC_KEY = 'synthetic-browser-key-0001';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => [CONFIGURED, UNCONFIGURED, OFFLINE].some(origin => route.request().url().startsWith(`${origin}/`)) ? route.continue() : route.abort());
});
const errorsOf = (page: Page) => { const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); }); return errors; };
const ready = async (page: Page, url = `${CONFIGURED}/`) => { await page.goto(url); await expect(page.locator('.status-button')).toBeVisible(); await expect(page.locator('.tabs')).toBeVisible(); };
/** The stacked wallet, viewed on the offline server: a scan elsewhere stores a new withdraw-authority snapshot, which sends every
 * attributed row to a recheck, and these synthetic rows have no retained transaction to recheck. Offline, nothing scans. */
const stacked = async (page: Page, hash = '#overview?period=all') => {
  await ready(page, `${OFFLINE}/${hash}`);
  await page.getByLabel('Saved wallets').selectOption(STACKED_WALLET);
  await expect(page.locator('.chart-day')).toHaveCount(2);
};
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
const fill = (node: Locator) => node.getAttribute('fill');
/** The day tooltip beside the chart. */
const dayTooltip = (page: Page) => page.locator('#day-tooltip');
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test.describe('status dropdown', () => {
  test('holds everything the strip and banners showed, opens by click or keyboard, and closes by Escape or a click elsewhere', async ({ page }) => {
    const errors = errorsOf(page); await ready(page);
    // Nothing between the header and the tabs.
    expect(await page.locator('main').evaluate(node => node.firstElementChild?.className)).toBe('tabs');
    for (const gone of ['.status-line', '.summary-strip', '.strip-chips', '.job-chip', '.job-notice']) await expect(page.locator(gone)).toHaveCount(0);
    const button = page.locator('.status-button');
    await expect(button).toContainText('COMPLETE');
    await expect(button).toContainText(/Last refresh 2026-\d\d-\d\d \d\d:\d\d UTC/);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    const panel = page.getByRole('dialog', { name: 'Status' });
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.status-figures').first().locator('dt')).toHaveText(['Mode', 'Data', 'Provider', 'Last sync', 'Fixed cutoff']);
    await expect(panel.locator('.status-figures').first().locator('dd')).toHaveText(['Local · read only', 'Synthetic fixture · deterministic test data · no real rewards',
      'Configured', /^2026-\d\d-\d\d \d\d:\d\d UTC$/, /^2026-09-21 \d\d:\d\d UTC$/]);
    await expect(panel.locator('.status-job')).toContainText('COMPLETE');
    await expect(panel.locator('.budgets dt')).toHaveText(['StonkFun requests', 'Helius requests', 'History pages']);
    await expect(panel.locator('.budgets dd').first()).toHaveText(/^\d+ of \d+$/);
    await expect(panel.locator('.status-count summary')).toHaveText(['Verified8 rows', 'Unknown · not counted1 row', 'Excluded1 row', 'Unpriced · excluded from USDverified 1 · attributed 1']);
    for (const [index, wording] of [[0, 'Confirmed by an exact official StonkFun distribution record'], [1, 'Not counted as rewards and not a verified zero'],
      [2, 'wallet participation'], [3, 'Shown in token units only']] as const) {
      await panel.locator('.status-count summary').nth(index).click();
      await expect(panel.locator('.status-count').nth(index)).toContainText(wording);
    }
    await page.screenshot({ path: screenshot('ux-status-dropdown.png') });
    // The progress dialog opens from the panel.
    await panel.getByRole('button', { name: 'View scan progress →' }).click();
    await expect(page.getByRole('dialog', { name: /^Refreshing 88888…88888$|^Loading 2026-/ })).toBeVisible();
    await page.keyboard.press('Escape');
    // Keyboard: Enter opens, Escape closes; a click elsewhere closes too.
    await button.focus(); await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await button.click(); await expect(panel).toBeVisible();
    await page.locator('.period-hero').click();
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('on a phone it spans the header and opens as a sheet inside the viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await context.route('**/*', route => route.request().url().startsWith(`${CONFIGURED}/`) ? route.continue() : route.abort());
    const page = await context.newPage(); await ready(page);
    await page.locator('.status-button').tap();
    const sheet = await page.getByRole('dialog', { name: 'Status' }).boundingBox();
    expect(sheet!.x).toBeGreaterThanOrEqual(0); expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(390); expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: screenshot('ux-mobile-status-dropdown.png') });
    await context.close();
  });
});

test.describe('refresh control', () => {
  test('reads Check latest data with the last refresh beneath, and says Scan running while this wallet scans', async ({ page }) => {
    await ready(page);
    const refresh = page.locator('.refresh-button');
    await expect(refresh).toHaveText(/^Check latest data/);
    await expect(refresh).toBeEnabled();
    await expect(page.locator('.refresh-last')).toHaveText(/^Last refresh 2026-\d\d-\d\d \d\d:\d\d UTC$/);
    await refresh.click();
    const progress = page.getByRole('dialog', { name: 'Refreshing 88888…88888' });
    await expect(progress).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(refresh).toHaveText(/^Scan running…/);
    await expect(refresh).toBeDisabled();
    await expect(page.locator('.status-button')).toContainText('WORKING');
    await page.screenshot({ path: screenshot('ux-refresh-running.png') });
    // The fixture scan completes; the button returns with the new last refresh.
    await expect(refresh).toHaveText(/^Check latest data/, { timeout: 20_000 });
    await expect(refresh).toBeEnabled();
    await expect(page.locator('.status-button')).toContainText('COMPLETE');
  });

  test('offline viewing disables it and says so, in the button and in the status panel', async ({ page }) => {
    const errors = errorsOf(page); await ready(page, `${OFFLINE}/`);
    const refresh = page.locator('.refresh-button');
    await expect(refresh).toHaveText('Offline · refresh disabled');
    await expect(refresh).toBeDisabled();
    await expect(page.locator('.refresh-last')).toHaveText(/^Last refresh 2026-/);
    await expect(page.locator('.status-button .status-tag')).toHaveText(['SYNTHETIC', 'OFFLINE']);
    await page.locator('.status-button').click();
    await expect(page.getByRole('dialog', { name: 'Status' }).locator('dd').first()).toHaveText('Offline viewing · saved data only · scans disabled');
    await page.screenshot({ path: screenshot('ux-refresh-offline.png') });
    expect(errors).toEqual([]);
  });

  test('with no provider it opens the key form; the key is posted once, kept by nobody in the page, and configures the next refresh', async ({ page }) => {
    const errors = errorsOf(page);
    const bodies: string[] = []; const answers: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') bodies.push(`${request.url()} ${request.postData() ?? ''}`); });
    page.on('response', response => { void response.text().then(text => { answers.push(text); }).catch(() => undefined); });
    await ready(page, `${UNCONFIGURED}/`);
    await expect(page.locator('.status-button')).toBeVisible();
    await page.locator('.refresh-button').click();
    const form = page.getByRole('dialog', { name: 'Helius API key' });
    await expect(form).toBeVisible();
    const input = form.getByLabel('Helius API key');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toBeFocused();
    await expect(form.getByLabel('Remember on this computer')).not.toBeChecked();
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await input.fill('not a key');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('alert')).toContainText('letters, digits');
    await input.fill(SYNTHETIC_KEY);
    await page.screenshot({ path: screenshot('ux-key-form.png') });
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('.refresh-note')).toHaveText('Provider configured. Check latest data when ready.');
    // Posted exactly once, to the key endpoint, with Remember off.
    const posts = bodies.filter(body => body.includes(SYNTHETIC_KEY));
    expect(posts).toEqual([`${UNCONFIGURED}/api/v1/provider-key {"key":"${SYNTHETIC_KEY}","remember":false}`]);
    // The status panel's provider indicator flips; the page stored nothing and no answer carries the key.
    await page.locator('.status-button').click();
    await expect(page.getByRole('dialog', { name: 'Status' }).locator('dd').nth(2)).toHaveText('Configured');
    await page.keyboard.press('Escape');
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
    expect(stored).not.toContain(SYNTHETIC_KEY);
    expect(await page.locator('input').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).not.toContain(SYNTHETIC_KEY);
    // The next refresh scans with it.
    await page.locator('.refresh-button').click();
    await expect(page.getByRole('dialog', { name: 'Refreshing 88888…88888' })).toBeVisible();
    await expect(page.locator('.status-button')).toContainText('COMPLETE', { timeout: 20_000 });
    for (const answer of answers) expect(answer).not.toContain(SYNTHETIC_KEY);
    expect(errors).toEqual([]);
  });
});

test.describe('token-stacked attributed chart', () => {
  test('splits each day by token in the period\'s twelve colors plus Other, with shares that sum to 100%', async ({ page }) => {
    const errors = errorsOf(page); await stacked(page);
    // Legend: twelve tokens by the period's USD in slot order, then Other, and the unpriced note.
    await expect(page.locator('.token-legend li')).toHaveText([...LEGEND, 'Other', 'Unpriced receipts are not drawn']);
    const swatches = await page.locator('.token-legend .token-swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    expect(swatches).toEqual([...COLORS, OTHER].map(rgb));
    for (const day of [0, 1]) {
      const segments = page.locator('.chart-day').nth(day).locator('.bar-segment');
      await expect(segments).toHaveCount(13);
      expect(await segments.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))).toEqual([...COLORS, OTHER]);
      // Stacked from the baseline in legend order: each segment sits above the one before it.
      const tops = await segments.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('y'))));
      expect(tops).toEqual([...tops].sort((a, b) => b - a));
    }
    await page.screenshot({ path: screenshot('ux-stacked-overview.png') });
    await page.locator('.chart-day').first().locator('.day-hit').hover({ position: { x: 3, y: 3 } });
    const tooltip = dayTooltip(page);
    await expect(tooltip).toContainText('2026-09-19 UTC');
    await expect(tooltip.locator('.tooltip-total')).toHaveText('$119.00');
    await expect(tooltip.locator('.tooltip-sub')).toHaveText('15 receipts · 1 unpriced receipt in 1 token, not in the bar');
    const rows = tooltip.locator('.tooltip-tokens > li');
    await expect(rows).toHaveCount(13);
    // $15 of $119 is 12.61%; Other is $LATE and $TAIL, $5 or 4.20%. Largest remainders make the thirteen shares sum to 100.0%.
    await expect(rows.first()).toHaveText('$XBTC12.6%$15.0015.000000Copy CA');
    await expect(rows.last()).toHaveText('Other · 2 tokens ▸4.2%$5.002 receipts');
    const shares = (await rows.locator('> .tooltip-share').allTextContents()).map(text => Math.round(Number(text.replace('%', '')) * 10));
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(1000);
    expect(await rows.locator('> .token-key').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))).toEqual([...COLORS, OTHER].map(rgb));
    await page.screenshot({ path: screenshot('ux-stacked-tooltip.png') });
    expect(errors).toEqual([]);
  });

  test('hovering a segment lights that token; the tooltip sits right beside its bar and takes the pointer', async ({ page }) => {
    await stacked(page);
    const second = page.locator('.chart-day').nth(1);
    const doge = second.locator('.bar-segment[data-token$=":6"]').nth(2);
    await doge.hover();
    const key = await doge.getAttribute('data-token');
    await expect(page.locator('svg.attributed-chart')).toHaveClass(/has-lit/);
    await expect(page.locator(`.bar-segment[data-token="${key}"]`)).toHaveCount(2);
    for (const node of await page.locator(`.bar-segment[data-token="${key}"]`).all()) await expect(node).toHaveClass(/is-lit/);
    await expect(page.locator('.bar-segment.is-dim')).toHaveCount(24);
    await expect(page.locator('.token-legend li.is-lit')).toHaveText(['$DOGE']);
    const tooltip = dayTooltip(page);
    await expect(tooltip.locator('li.is-selected')).toContainText('$DOGE');
    await page.screenshot({ path: screenshot('ux-stacked-hover.png') });
    expect(await tooltip.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('auto');
    // Right beside its own bar (2026-09-20, near the right edge, so to the left), inside the plot's height; it may cover the neighbouring column.
    const box = (await tooltip.boundingBox())!;
    const [own, bar] = await Promise.all([second.locator('.day-hit').boundingBox(), second.locator('.bar-segment').first().boundingBox()]);
    expect(overlaps(box, bar!)).toBe(false);
    expect(bar!.x - (box.x + box.width)).toBeGreaterThanOrEqual(0); expect(bar!.x - (box.x + box.width)).toBeLessThanOrEqual(12);
    expect(box.y).toBeGreaterThanOrEqual(own!.y - 13); expect(box.y + box.height).toBeLessThanOrEqual(own!.y + own!.height + 1);
    // Resting on the uncovered part of the neighbouring column opens it.
    await page.locator('.chart-day').first().locator('.day-hit').hover({ position: { x: 3, y: 3 } });
    await expect(tooltip).toContainText('2026-09-19 UTC');
    // The legend lights a token too.
    await page.locator('.token-legend li').filter({ hasText: '$XBTC' }).hover();
    await expect(page.locator('.bar-segment.is-lit')).toHaveCount(2);
  });

  test('a click pins the day; a ticker lists that day\'s payouts of its token, Other expands to its tokens, and the day opens whole', async ({ page }) => {
    const errors = errorsOf(page); await stacked(page);
    const xbtc = page.locator('.chart-day').first().locator(`.bar-segment[data-token="${XBTC}:6"]`);
    const color = await fill(xbtc);
    // A click pins the day with the clicked token chosen, and navigates nowhere.
    await xbtc.click();
    const tooltip = dayTooltip(page);
    await expect(tooltip).toHaveClass(/is-pinned/);
    await expect(tooltip.locator('li.is-selected')).toContainText('$XBTC');
    await expect(tooltip).toContainText('Pinned · Esc or a click outside closes it');
    await expect(page).toHaveURL(/#overview$/);
    await tooltip.getByRole('button', { name: '$XBTC: list its payouts on 2026-09-19' }).click();
    await expect(page).toHaveURL(new RegExp(`#payouts\\?day=2026-09-19&token=${XBTC}%3A6$`));
    const banner = page.locator('.day-banner');
    await expect(banner).toContainText('Showing 2026-09-19 · $XBTC · 1 payout');
    expect(await banner.locator('.token-swatch').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(rgb(color!));
    const rows = page.locator('.receipt-table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('$XBTC');
    await expect(rows.first()).toContainText('15.000000');
    expect(await rows.first().locator('.token-swatch').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(rgb(color!));
    await page.screenshot({ path: screenshot('ux-day-token.png') });
    // Clear lifts both the day and the token.
    await page.getByRole('button', { name: 'Clear the 2026-09-19 $XBTC filter' }).click();
    await expect(page).toHaveURL(/#payouts$/);
    await expect(rows).toHaveCount(30);
    // The day's label opens the day alone, and so does the pinned tooltip's day link.
    await page.goBack();
    await expect(page.locator('.chart-day')).toHaveCount(2);
    await page.locator('svg.attributed-chart .day-axis text[data-day="2026-09-20"]').click();
    await expect(page).toHaveURL(/#payouts\?day=2026-09-20$/);
    await expect(page.locator('.day-banner')).toContainText('Showing 2026-09-20 · 15 payouts');
    await page.goBack();
    await page.locator('.chart-day').first().locator('.day-hit').click({ position: { x: 3, y: 3 } });
    await tooltip.getByRole('button', { name: 'All 15 payouts that day →' }).click();
    await expect(page).toHaveURL(/#payouts\?day=2026-09-19$/);
    // Other pins its day and expands to its own tokens, each a ticker of its own.
    await page.goBack();
    await page.locator('.chart-day').nth(1).locator('.bar-segment[data-token="other"]').click();
    await expect(tooltip.locator('li.is-selected')).toContainText('Other · 2 tokens');
    const toggle = tooltip.getByRole('button', { name: /^Other · 2 tokens/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const members = tooltip.locator('.tooltip-others > li');
    await expect(members).toHaveText(['$LATE2.5%$3.003.000000Copy CA', '$TAIL1.7%$2.002.000000Copy CA']);
    await page.screenshot({ path: screenshot('ux-tooltip-other.png') });
    await members.first().getByRole('button', { name: '$LATE: list its payouts on 2026-09-20' }).click();
    await expect(page).toHaveURL(/#payouts\?day=2026-09-20&token=[1-9A-HJ-NP-Za-km-z]+%3A6$/);
    await expect(page.locator('.day-banner')).toContainText('Showing 2026-09-20 · $LATE · 1 payout');
    // Keyboard: arrows choose a token on the focused day; Enter opens it.
    await page.goBack();
    await page.mouse.move(0, 0);
    await page.locator('.chart-day').first().focus();
    await page.keyboard.press('ArrowUp');
    await expect(tooltip.locator('li.is-selected')).toContainText('$XBTC');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#payouts\\?day=2026-09-19&token=${XBTC}%3A6$`));
    expect(errors).toEqual([]);
  });

  test('the same token keeps its color on the Tokens tab, in its drawer and in Payouts, and the period sets the palette', async ({ page }) => {
    await stacked(page);
    const legend = await page.locator('.token-legend li').evaluateAll(nodes => nodes.flatMap(node => {
      const swatch = node.querySelector('.token-swatch'); return swatch ? [[node.textContent, getComputedStyle(swatch).backgroundColor]] : [];
    }));
    const colorOf = new Map(legend as [string, string][]);
    await page.getByRole('tab', { name: 'Tokens' }).click();
    const tokenRows = await page.locator('.token-table tbody .token-name b').evaluateAll(nodes => nodes.map(node =>
      [node.textContent, getComputedStyle(node.querySelector('.token-swatch')!).backgroundColor]));
    for (const [symbol, color] of tokenRows as [string, string][]) expect(color).toBe(colorOf.get(symbol) ?? rgb(OTHER));
    expect((tokenRows as [string, string][]).find(([symbol]) => symbol === '$LATE')![1]).toBe(rgb(OTHER));
    await page.locator('.token-table tbody tr').filter({ hasText: '$BONK' }).locator('.row-open').click();
    const drawer = page.getByRole('dialog', { name: '$BONK' });
    expect(await drawer.locator('.token-swatch').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(colorOf.get('$BONK'));
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Payouts' }).click();
    const payoutRows = await page.locator('.receipt-table tbody tr td:nth-child(2) b').evaluateAll(nodes => nodes.map(node =>
      [node.textContent, getComputedStyle(node.querySelector('.token-swatch')!).backgroundColor]));
    for (const [symbol, color] of payoutRows as [string, string][]) expect(color).toBe(colorOf.get(symbol) ?? rgb(OTHER));
    // Within a period the palette does not move: back on the overview the same colors hold.
    await page.getByRole('tab', { name: 'Overview' }).click();
    expect(await page.locator('.token-legend .token-swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))).toEqual([...COLORS, OTHER].map(rgb));
  });
});
