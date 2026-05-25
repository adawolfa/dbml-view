import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // PORT env var is set by the Claude preview harness; fall back to 0 so the OS
    // picks a free port — avoids conflicts between concurrent dev agents.
    port: process.env.PORT ? Number(process.env.PORT) : 0,
    strictPort: !!process.env.PORT,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
