#!/usr/bin/env node
// Wraps `tauri` on Windows so cargo can find a working MSVC toolchain.
// Rust's linker resolution may pick a VS install missing the x64 desktop C++
// libs (LNK1104: msvcrt.lib). We use vswhere to locate an install that has
// the x64 workload and source its vcvars64.bat before invoking tauri.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

if (process.platform !== 'win32') {
  const r = spawnSync('tauri', args, { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}

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
  for (const path of stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const vcvars = join(path, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    if (existsSync(vcvars)) return vcvars;
  }
  return null;
}

const vcvars = findVcvars();
if (!vcvars) {
  console.error(
    'Could not find a Visual Studio install with the x64 C++ build tools.\n' +
      'Install or repair "Desktop development with C++" via the Visual Studio Installer.',
  );
  process.exit(1);
}

const quoted = args.map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
const r = spawnSync(`call "${vcvars}" >nul && tauri ${quoted}`, {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
