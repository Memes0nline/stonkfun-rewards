import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A Helius API key as the local page may submit it: letters, digits, dot, dash and underscore, which also keeps the `.env`
 * line unambiguous. Helius issues UUID-shaped keys. */
export const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]{8,256}$/;

/**
 * A key entered in the local page. It is kept in memory for this server's lifetime and, only when the user asks to remember
 * it, written to the ignored `.env` in `directory`, the file scans already load. It is never logged, never returned to a
 * caller and never written anywhere else. Errors carry fixed codes, never the key.
 */
export function createKeyIntake(directory: string) {
  let key: string | undefined;
  return {
    current: () => key,
    accept(value: string, remember: boolean) {
      if (!PROVIDER_KEY_PATTERN.test(value)) throw new Error('invalid_request');
      if (remember) rememberKey(directory, value);
      key = value;
    },
  };
}
export type KeyIntake = ReturnType<typeof createKeyIntake>;

/** Sets `HELIUS_API_KEY` in `directory/.env`, keeping every other line, and replaces the file in one rename. */
export function rememberKey(directory: string, key: string) {
  if (!PROVIDER_KEY_PATTERN.test(key)) throw new Error('invalid_request');
  const path = join(directory, '.env');
  // Failures surface as one fixed code; the underlying error, which can name the path, is not passed on.
  let text = '';
  let unreadable = false;
  try { text = readFileSync(path, 'utf8'); } catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  if (unreadable) throw new Error('key_not_saved');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const entry = `HELIUS_API_KEY=${key}`;
  let written = false;
  const next = lines.flatMap(line => {
    if (!/^\s*(?:export\s+)?HELIUS_API_KEY\s*=/.test(line)) return [line];
    if (written) return [];
    written = true; return [entry];
  });
  if (!written) next.push(entry);
  const temporary = `${path}.${process.pid}.tmp`;
  let saved = false;
  try {
    writeFileSync(temporary, `${next.join('\n')}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    saved = true;
  } catch { /* reported below as a fixed code */ }
  if (!saved) throw new Error('key_not_saved');
}
