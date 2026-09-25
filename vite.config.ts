import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web', envDir: false, envPrefix: [],
  build: { outDir: '../dist/dashboard', emptyOutDir: true, sourcemap: false },
});
