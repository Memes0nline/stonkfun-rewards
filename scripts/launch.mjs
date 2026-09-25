// First-run checks and start for the double-click launchers (Start Rewards Dashboard.cmd, start.sh). Each step says in plain
// words what it checked, and each failure what to do next. `--check` runs every check and exits without installing anything or
// starting the server; other arguments pass through to the dashboard (for example --port 4327 or --no-open).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const check = process.argv.includes('--check');
const passthrough = process.argv.slice(2).filter(value => value !== '--check');
const say = line => { console.log(line); };
/** Ends the launcher with a plain message. The process then exits once its handles close, never in the middle of closing them. */
class Stop extends Error { constructor(code) { super('launcher_stopped'); this.code = code; } }
const fail = lines => { console.error(['', ...lines].join('\n')); throw new Stop(1); };
// pnpm and Corepack are .cmd shims on Windows, which Node runs only through a shell, so each runs as one fixed command line.
const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
const run = (line, options = {}) => spawnSync(line, { shell: true, env, encoding: 'utf8', windowsHide: true, ...options });
const pnpmVersion = runner => { const result = run(`${runner} --version`); return result.status === 0 ? result.stdout.trim() : null; };
const usable = version => version !== null && Number(version.split('.')[0]) >= 10;
/** Whether something on the port answers as this dashboard's local server. */
const dashboardAt = origin => new Promise(resolve => {
  const request = get(`${origin}/api/v1/health`, { agent: false, timeout: 2000 }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
    response.on('end', () => { try { resolve(response.statusCode === 200 && 'providerConfigured' in JSON.parse(body)); } catch { resolve(false); } });
  });
  request.on('timeout', () => { request.destroy(); }); request.on('error', () => { resolve(false); });
});
const portFree = port => new Promise(resolve => {
  const probe = createServer(); probe.once('error', () => { resolve(false); });
  probe.listen(port, '127.0.0.1', () => { probe.close(() => { resolve(true); }); });
});
function openBrowser(origin) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin] : [origin], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { say(`Open ${origin} in your browser.`); }); child.unref();
}

async function main() {
  // 1. Node.js. The shell launchers check this before Node runs anything; it is repeated for a direct `node scripts/launch.mjs`.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    fail([`This needs Node.js 24.15 or newer, and this computer has ${process.versions.node}.`,
      'Install the LTS version from https://nodejs.org, then start the launcher again.']);
  }
  say(`Node.js ${process.versions.node}: OK`);

  // 2. pnpm, the package manager, at version 10 or newer. Corepack, which ships with Node.js, can provide it.
  let pnpm = 'pnpm';
  let version = pnpmVersion(pnpm);
  if (!usable(version)) {
    if (run('corepack --version').status !== 0) {
      fail([version ? `pnpm ${version} is too old; this needs pnpm 10 or newer.` : 'pnpm, the package manager this project uses, is not installed.',
        'Install it with this command, then start the launcher again:', '  npm install --global pnpm@10']);
    }
    if (check) {
      say(`pnpm: ${version ? `version ${version} is too old` : 'not installed'}; starting without --check enables pnpm 10 through Corepack.`);
      pnpm = null;
    } else {
      say(`pnpm ${version ? `${version} is too old` : 'is not installed'}: enabling it through Corepack...`);
      // Enabling adds a pnpm command beside Node.js; where that folder needs administrator rights, Corepack runs pnpm itself.
      pnpm = run('corepack enable pnpm').status === 0 && usable(pnpmVersion('pnpm')) ? 'pnpm' : 'corepack pnpm';
      version = pnpmVersion(pnpm);
      if (!usable(version)) {
        fail(['Corepack could not provide pnpm. Check your internet connection, or install pnpm with this command and start again:',
          '  npm install --global pnpm@10']);
      }
    }
  }
  if (pnpm) say(`pnpm ${version}: OK`);

  // 3. Dependencies: installed once, and again whenever the lockfile changes, as it can in an update.
  const lock = createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex');
  const marker = join('node_modules', '.stonkfun-lockfile-sha256');
  const installed = existsSync('node_modules') && existsSync(marker) && readFileSync(marker, 'utf8').trim() === lock;
  if (installed) say('Dependencies: installed and up to date');
  else if (check) {
    const state = !existsSync('node_modules') ? 'not installed yet' : existsSync(marker) ? 'the lockfile changed since the last install' : 'not yet checked against the lockfile';
    say(`Dependencies: ${state}; starting without --check runs pnpm install.`);
  } else {
    say('Installing dependencies (the first start takes a few minutes and needs the internet)...');
    if (run(`${pnpm} install --frozen-lockfile`, { stdio: 'inherit', encoding: undefined }).status !== 0) {
      fail(['Installing dependencies failed.', 'Check your internet connection and start the launcher again.',
        'If it keeps failing, delete the node_modules folder in this folder and try once more.']);
    }
    writeFileSync(marker, `${lock}\n`);
    say('Dependencies: installed');
  }

  // 4. The dashboard's port on this computer: free, or already serving this dashboard, which is then opened instead.
  const portAt = passthrough.indexOf('--port');
  const port = Number(portAt >= 0 ? passthrough[portAt + 1] : 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(['The --port value must be a whole number from 1024 to 65535.']);
  const origin = `http://127.0.0.1:${port}`;
  if (!await portFree(port)) {
    if (!await dashboardAt(origin)) {
      fail([`Port ${port} is already used by another program.`, 'Close that program, or start the dashboard on another port, for example:',
        process.platform === 'win32' ? '  "Start Rewards Dashboard.cmd" --port 4327' : '  sh start.sh --port 4327']);
    }
    say(`The dashboard is already running at ${origin}${check ? '.' : '; opening it.'}`);
    if (!check && !passthrough.includes('--no-open')) openBrowser(origin);
    return 0;
  }
  say(`Port ${port}: free`);
  if (check) { say('\nAll checks passed. Start the launcher without --check to open the dashboard.'); return 0; }

  // 5. Build and start. start-dashboard.mjs says what failed if the build or the server cannot start.
  say(`Starting the dashboard at ${origin} ...`);
  return spawnSync(process.execPath, ['scripts/start-dashboard.mjs', ...passthrough], { stdio: 'inherit', windowsHide: true }).status ?? 1;
}
main().then(code => { process.exitCode = code; }, error => { if (error instanceof Stop) process.exitCode = error.code; else throw error; });
