#!/usr/bin/env node
/**
 * Wraps the `tauri` CLI with two responsibilities:
 *
 *  1. Windows MSVC toolchain — sources vcvars64.bat before invoking Tauri so
 *     cargo can find the x64 linker libraries (avoids LNK1104: msvcrt.lib).
 *
 *  2. `tauri dev` build step — runs `pnpm --filter @dbml-view/web build`
 *     synchronously first, then launches `tauri dev --features custom-protocol`
 *     so the webview serves the built dist/ via the custom URI scheme, exactly
 *     like a release build.  No dev server is involved.
 *
 * For fast UI iteration use the browser (`pnpm dev`); restart `pnpm desktop dev`
 * whenever you want to verify something in the actual Tauri window.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// ── Windows MSVC toolchain lookup ────────────────────────────────────────────

const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

function findVcvars() {
  if (!existsSync(VSWHERE)) return null;
  const stdout = execFileSync(
    VSWHERE,
    [
      '-prerelease',
      '-all',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  for (const path of stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const vcvars = join(path, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    if (existsSync(vcvars)) return vcvars;
  }
  return null;
}

// ── Tauri runner ─────────────────────────────────────────────────────────────

function runTauri(tauriArgs) {
  if (process.platform !== 'win32') {
    const r = spawnSync('tauri', tauriArgs, { stdio: 'inherit', shell: true });
    return r.status ?? 1;
  }

  const vcvars = findVcvars();
  if (!vcvars) {
    console.error(
      'Could not find a Visual Studio install with the x64 C++ build tools.\n' +
        'Install or repair "Desktop development with C++" via the Visual Studio Installer.',
    );
    return 1;
  }

  const quoted = tauriArgs.map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
  const r = spawnSync(`call "${vcvars}" >nul && tauri ${quoted}`, {
    stdio: 'inherit',
    shell: true,
  });
  return r.status ?? 1;
}

// ── main ─────────────────────────────────────────────────────────────────────

if (args[0] === 'dev') {
  // Build the web app so dist/ is ready before Tauri starts.
  const build = spawnSync('pnpm', ['--filter', '@dbml-view/web', 'build'], {
    stdio: 'inherit',
    shell: true,
  });
  if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);

  // custom-protocol serves dist/ via tauri:// (same as release; no dev server).
  // tauri dev normally strips this feature via --no-default-features, so we
  // re-add it explicitly.
  process.exit(runTauri(['dev', '--features', 'custom-protocol', ...args.slice(1)]));
} else {
  process.exit(runTauri(args));
}
