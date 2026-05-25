#!/usr/bin/env node
/**
 * Wraps the `tauri` CLI with two responsibilities:
 *
 *  1. Windows MSVC toolchain — sources vcvars64.bat before invoking Tauri so
 *     cargo can find the x64 linker libraries (avoids LNK1104: msvcrt.lib).
 *
 *  2. Random-port Vite for `tauri dev` — starts the Vite dev server as a
 *     child process on an OS-assigned free port (port:0 in vite.config.ts),
 *     discovers the actual URL from Vite's stdout, then injects it into the
 *     Tauri invocation via `--config` so the webview loads the right address.
 *     This avoids hardcoding a port that may already be in use and removes the
 *     need for tauri.conf.json's beforeDevCommand to start Vite at all.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);

// ── Vite launcher ────────────────────────────────────────────────────────────

/**
 * Spawn `pnpm --filter @dbml-view/web dev`, tee its stdout to the terminal,
 * and resolve once Vite announces the local URL it is listening on.
 */
function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn('pnpm', ['--filter', '@dbml-view/web', 'dev'], {
      // pipe stdout so we can scan it; inherit stderr so errors show directly
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: true,
    });

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      process.stdout.write(chunk); // tee to terminal
      buf += chunk.toString();
      // Vite prints "  ➜  Local:   http://localhost:XXXX/"
      const m = buf.match(/Local:\s+(http:\/\/localhost:\d+)/);
      if (m) resolve({ url: m[1], proc });
    });

    proc.on('exit', (code) => {
      reject(new Error(`Vite exited early with code ${code}`));
    });
  });
}

// ── Windows MSVC toolchain lookup ────────────────────────────────────────────

const VSWHERE =
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

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
  for (const path of stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
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

async function main() {
  if (args[0] === 'dev') {
    // 1. Start Vite on an OS-assigned random port.
    const { url, proc: viteProc } = await startVite();

    // 2. Kill Vite when this process exits (normal exit, Ctrl-C, or SIGTERM).
    const killVite = () => {
      try {
        viteProc.kill();
      } catch {}
    };
    process.on('exit', killVite);
    process.on('SIGINT', () => {
      killVite();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      killVite();
      process.exit(0);
    });

    // 3. Write a temporary config override that:
    //    - sets devUrl to the port Vite actually chose
    //    - clears beforeDevCommand so Tauri doesn't spawn a second Vite
    //    Using a file avoids quoting JSON on the Windows command line.
    const tmpConfig = join(tmpdir(), `tauri-dev-${Date.now()}.json`);
    writeFileSync(
      tmpConfig,
      JSON.stringify({ build: { devUrl: url, beforeDevCommand: '' } }),
    );
    process.on('exit', () => {
      try {
        unlinkSync(tmpConfig);
      } catch {}
    });

    // 4. Run tauri dev.
    //    --no-dev-server-wait: Vite is already listening, no need to poll.
    //    --config <file>: merge our overrides on top of tauri.conf.json.
    const tauriArgs = [
      'dev',
      '--no-dev-server-wait',
      '--config',
      tmpConfig,
      ...args.slice(1), // forward any extra flags (e.g. --release, --features)
    ];

    process.exit(runTauri(tauriArgs));
  } else {
    // build, info, plugin, … — pass straight through.
    process.exit(runTauri(args));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
