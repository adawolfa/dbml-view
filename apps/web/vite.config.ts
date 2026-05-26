import { defineConfig } from 'vite';
import { version } from '../../scripts/version.mjs';

export default defineConfig({
  root: '.',
  // Asset base path. Default '/' is correct for the desktop (Tauri) build —
  // the custom-protocol webview serves from tauri://localhost/ — and for any
  // root-hosted browser deployment (including the dbml.adawolfa.cz Pages
  // site). For sub-path deployments, set VITE_BASE=/sub/path/ in the build
  // environment.
  //
  // Keep this the single source of truth. Do NOT pass --base on the CLI from
  // call sites; set VITE_BASE instead so intent is explicit and visible here.
  //
  // If you add code that constructs URLs from string literals (fetch, new URL,
  // pushState), remember Vite rewrites only HTML/asset imports — runtime
  // string URLs must prefix with import.meta.env.BASE_URL themselves.
  base: process.env.VITE_BASE ?? '/',
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
  // Surface the git-derived version to the runtime as a compile-time constant.
  define: {
    __APP_VERSION__: JSON.stringify(version()),
  },
});
