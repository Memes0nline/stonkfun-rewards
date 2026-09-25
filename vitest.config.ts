import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  // Windows CI runners are several times slower than a local run; the 5 s defaults timed out six database tests there.
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'], restoreMocks: true, testTimeout: 30_000, hookTimeout: 30_000 },
});
