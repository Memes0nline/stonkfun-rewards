import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'], restoreMocks: true },
});
