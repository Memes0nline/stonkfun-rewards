import { rm } from 'node:fs/promises';

/** Removes a test's temporary folder. Close every database in it first: Windows keeps open files locked, and a slow runner can
 * hold one briefly after it closes, so the removal retries. */
export function removeTempFolder(path: string) {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
