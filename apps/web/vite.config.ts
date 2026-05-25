import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // OS picks a free port by default — avoids conflicts between concurrent dev agents.
    // If PORT is set (e.g. by the Claude preview harness), honour it.
    port: process.env['PORT'] ? Number(process.env['PORT']) : 0,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
