import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // Honour the PORT env var injected by the preview harness; fall back to
    // port 0 so the OS picks a free one when running standalone.
    port: process.env['PORT'] ? Number(process.env['PORT']) : 0,
    strictPort: !!process.env['PORT'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
