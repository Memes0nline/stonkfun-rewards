import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('Live network is disabled in fixture tests'); });
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => { throw new Error('Environment loading is disabled in fixture tests'); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
