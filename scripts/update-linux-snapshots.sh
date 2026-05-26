#!/usr/bin/env bash
# Regenerate the Linux Playwright diagram snapshots inside the same image CI
# uses, so font metrics match what the runner sees. Writes
# `apps/web/e2e/diagram-snapshot.spec.ts-snapshots/diagram-*-chromium-linux.svg`
# directly into the working tree via a bind mount; host `node_modules` are
# shadowed with anonymous volumes so the container's Linux binaries don't
# stomp the host install.
#
# Requirements: Docker (Docker Desktop on Windows is fine — invoke this from
# Git Bash or WSL).
#
# Usage:
#   scripts/update-linux-snapshots.sh                # update everything in
#                                                    # diagram-snapshot.spec.ts
#   scripts/update-linux-snapshots.sh -g "small"     # narrow with -g
set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd)"

# Match the Playwright version pinned in apps/web/package.json (and the one
# CI's Ubuntu runner installs) so snapshots stay byte-stable across machines.
PLAYWRIGHT_VERSION="$(node -e "console.log(require('$REPO_ROOT/apps/web/node_modules/@playwright/test/package.json').version)")"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

# Match the pnpm version in package.json's packageManager field.
PNPM_VERSION="$(node -e "console.log(require('$REPO_ROOT/package.json').packageManager.split('@')[1])")"

# Disable Git Bash / MSYS path mangling so /work doesn't become C:/Program Files/Git/work.
export MSYS_NO_PATHCONV=1

exec docker run --rm \
  -v "$REPO_ROOT:/work" \
  -v /work/node_modules \
  -v /work/apps/web/node_modules \
  -v /work/apps/desktop/node_modules \
  -v /work/packages/parser/node_modules \
  -v /work/packages/layout/node_modules \
  -v /work/packages/components/node_modules \
  -v /work/packages/i18n/node_modules \
  -w /work \
  -e CI=1 \
  "$IMAGE" \
  bash -c "corepack enable \
    && corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm install --frozen-lockfile \
    && pnpm --filter @dbml-view/web exec playwright test diagram-snapshot --update-snapshots $*"
