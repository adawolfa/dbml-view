import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: parseInt(process.env['PORT'] ?? '5173'),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
