import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const required = ['node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js'];
if (required.some(path => !existsSync(path))) {
  console.error('Dashboard dependencies are missing. Run pnpm install in this folder once, then reopen the launcher.');
  process.exit(1);
}
for (const args of [[required[0], '-p', 'tsconfig.build.json'], [required[1], 'build', '--config', 'vite.config.ts']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) { console.error('Dashboard build failed. Check the installed dependencies and try again.'); process.exit(1); }
}
const result = spawnSync(process.execPath, [resolve('dist/web/main.js'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
