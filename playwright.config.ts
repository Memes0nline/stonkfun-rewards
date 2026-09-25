import { defineConfig } from '@playwright/test';
// Three isolated synthetic servers: the configured fixture, one with no provider until a key is posted, and offline viewing.
// The first waits a minute before exiting on its own, so the other two can start before its first test; the extra two outlive
// the first spec file, so they wait longer.
const fixture = (port: number, flags = '') => ({
  command: `node --import ./scripts/offline-guard.mjs scripts/fixture-dashboard.mjs --port ${port}${flags}`,
  url: `http://127.0.0.1:${port}/api/v1/health`, reuseExistingServer: false,
});
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  outputDir: '.cache/dashboard/browser-results', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4318', channel: 'chrome', viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--disable-background-networking', '--disable-component-update', '--no-default-browser-check'] } },
  webServer: [fixture(4318, ' --idle-seconds 60'), fixture(4320, ' --unconfigured --idle-seconds 300'), fixture(4321, ' --offline --idle-seconds 300')],
});
