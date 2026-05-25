import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 0, // OS picks a free port — avoids conflicts between concurrent dev agents
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
