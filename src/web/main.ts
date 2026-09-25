import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SqliteRewardsStore } from '../storage/sqlite.js';
import { createRealProviders } from '../providers/real.js';
import { scanSpeed } from '../providers/limiter.js';
import { createKeyIntake } from './key.js';
import { DashboardService } from './service.js';
import { createDashboardServer } from './server.js';

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(value => value !== '--'), options: {
    'no-open': { type: 'boolean' }, offline: { type: 'boolean' }, db: { type: 'string' }, port: { type: 'string' },
    'helius-rps': { type: 'string' }, 'helius-burst': { type: 'string' }, 'stonkfun-rps': { type: 'string' }, 'stonkfun-burst': { type: 'string' },
    concurrency: { type: 'string' },
  } });
  const speedFlags = { heliusRps: values['helius-rps'], heliusBurst: values['helius-burst'], stonkfunRps: values['stonkfun-rps'],
    stonkfunBurst: values['stonkfun-burst'], concurrency: values.concurrency };
  // Validated at startup so a bad setting is reported before any scan; read again with the loaded environment when scanning.
  scanSpeed(speedFlags, process.env);
  const port = Number(values.port ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
  const path = values.db ? resolve(values.db) : join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'stonkfun-rewards', 'scanner.sqlite');
  let store: SqliteRewardsStore | undefined; let writable = false;
  // A key entered in the page lives here for the server's lifetime; remembering writes the same ignored .env scans load.
  const keys = createKeyIntake(process.cwd());
  const service = new DashboardService({ offline: values.offline ?? false, store(write = false) {
    if (write && !writable) { store?.close(); store = undefined; writable = true; }
    store ??= new SqliteRewardsStore(writable ? path : existsSync(path) ? path : ':memory:', { readOnly: !writable && existsSync(path) });
    return store;
  }, prepareProviders() {
    // This callback runs only after an explicit scan/resume mutation. Never during report viewing.
    let apiKey = keys.current();
    if (!apiKey) {
      if (!process.env.HELIUS_API_KEY) { try { process.loadEnvFile(); } catch { /* optional local file */ } }
      apiKey = process.env.HELIUS_API_KEY;
    }
    if (!apiKey) throw new Error('provider_not_configured');
    const { limits } = scanSpeed(speedFlags, process.env);
    const key = apiKey;
    return (job, signal, progress, waiting) => createRealProviders({ store: store!, job, apiKey: key, signal, limits, waiting,
      progress: (stage, count) => { progress(stage as 'stonkfun' | 'helius', count); } });
  }, concurrency: () => scanSpeed(speedFlags, process.env).concurrency,
  acceptProviderKey: (key, remember) => { keys.accept(key, remember); } });
  const app = createDashboardServer(service, fileURLToPath(new URL('../dashboard', import.meta.url)));
  const origin = await app.listen(port);
  console.log(`Rewards dashboard: ${origin}${values.offline ? ' (offline viewing)' : ''}\nKeep this window open while using the dashboard. Close it to stop the server.`);
  if (!values['no-open']) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin] : [origin];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { console.log('Open the local URL above in your browser.'); }); child.unref();
  }
  let closing = false;
  const close = () => { if (closing) return; closing = true; void app.close().finally(() => { store?.close(); }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message === 'invalid_speed_option'
    ? 'Dashboard could not start: a scan speed setting is invalid. See README for the SCANNER_* rates and bursts. Saved data is retained.'
    : (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
      ? 'Dashboard could not start: its port is already in use. Close the other dashboard window, or start again with --port 4327. Saved data is retained.'
      : 'Dashboard could not start. Check Node 24.15+, installed dependencies, and whether port 4317 is already in use. Saved data is retained.');
  process.exitCode = 1;
});
