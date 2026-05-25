import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // PORT env var is set by the Claude preview harness (port:0 in launch.json →
    // OS-assigned port, discovered from stdout). Falls back to 0 so the OS
    // picks a free port — avoids conflicts between concurrent dev agents.
    // tauri dev is handled by scripts/tauri.mjs which discovers Vite's actual
    // port from stdout and injects it via --config, so no fixed port is needed.
    port: process.env.PORT ? Number(process.env.PORT) : 0,
    strictPort: !!process.env.PORT,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
