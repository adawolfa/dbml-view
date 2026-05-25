import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // PORT env var is set by the Claude preview harness (port:0 in launch.json →
    // OS-assigned port, discovered from stdout).  Without it — e.g. during
    // `tauri dev` — fall back to 5173 so the hardcoded devUrl in tauri.conf.json
    // matches and the webview can actually load the page.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: !!process.env.PORT,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
