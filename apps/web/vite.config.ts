import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // Use PORT env var if set (preview harness injects it); otherwise let the OS
    // pick a free port to avoid conflicts between concurrent dev agents.
    port: process.env['PORT'] ? Number(process.env['PORT']) : 0,
    strictPort: !!process.env['PORT'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
