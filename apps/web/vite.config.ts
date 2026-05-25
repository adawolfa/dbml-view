import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
