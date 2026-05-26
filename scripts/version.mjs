// Derives the app version from git so both web and desktop builds inherit it.
//
// Rules:
//   - HEAD is exactly on a `[v]X.Y.Z` tag      → version is `X.Y.Z`
//   - HEAD is N commits past a `[v]X.Y.Z` tag  → display is `X.Y.Z-dev.N+gSHA`, semver is `X.Y.Z`
//   - No tags reachable                        → display is `0.0.0-dev+gSHA`, semver is `0.0.0`
//   - Not a git checkout                       → both fall back to `0.0.0-dev`
//
// The leading `v` on the tag is optional — both `1.2.3` and `v1.2.3` work.
//
// `version()` returns a user-friendly string for UI display. `semver()` returns
// a strict X.Y.Z that Tauri / MSI / NSIS accept (they reject pre-release suffixes).

import { execFileSync } from 'node:child_process';

const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

function git(args) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function describe() {
  // --abbrev=8 keeps the commit SHA short and stable in the display string.
  const exact = git(['describe', '--tags', '--exact-match', 'HEAD']);
  if (exact && SEMVER_TAG.test(exact)) {
    return { tag: exact, ahead: 0, sha: null };
  }

  const long = git(['describe', '--tags', '--long', '--abbrev=8']);
  if (long) {
    // Format: <tag>-<ahead>-g<sha>
    const m = /^(.+)-(\d+)-g([0-9a-f]+)$/.exec(long);
    if (m && SEMVER_TAG.test(m[1])) {
      return { tag: m[1], ahead: Number(m[2]), sha: m[3] };
    }
  }

  const sha = git(['rev-parse', '--short=8', 'HEAD']);
  return { tag: null, ahead: 0, sha: sha ?? null };
}

function stripV(tag) {
  const m = SEMVER_TAG.exec(tag);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : tag;
}

/** Strict semver (X.Y.Z) — safe for Tauri / MSI / Cargo. */
export function semver() {
  const { tag } = describe();
  if (tag) return stripV(tag);
  return '0.0.0';
}

/** Display version — may include a `-dev.N+gSHA` suffix for untagged builds. */
export function version() {
  const { tag, ahead, sha } = describe();
  if (tag && ahead === 0) return stripV(tag);
  if (tag) return `${stripV(tag)}-dev.${ahead}+g${sha}`;
  if (sha) return `0.0.0-dev+g${sha}`;
  return '0.0.0-dev';
}
