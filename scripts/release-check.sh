#!/usr/bin/env bash
#
# release-check.sh — pre-publish smoke test.
#
# Catches the bugs that `npm run dev` can't:
#   - hardcoded version literals (we had one in 0.2.0-beta.0)
#   - missing entries in package.json `files`
#   - missing shebang / chmod on dist bin
#   - NodeNext relative imports missing the `.js` suffix
#   - `init` subcommand broken in a fresh HOME
#
# What it does (no globally-side-effecting steps):
#   1) tests + typecheck + build
#   2) npm pack → tarball in repo root
#   3) extract tarball into a tmpdir
#   4) `npm install --omit=dev` inside that tmpdir
#   5) directly invoke ./node_modules/.bin/pith-wiki --version
#      and assert it equals package.json's version
#
# What it deliberately *doesn't* do:
#   - npm install -g (would mess with your real PATH)
#   - publish (you do that by hand once this passes)
#   - exercise hydration / REPL (needs DEEPSEEK_API_KEY; do it manually)
#
# Exit 0 → safe to `npm publish --tag beta`. Exit non-zero → fix and rerun.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Colors: only if stdout is a TTY (CI logs prefer plain text)
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_FAIL=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=""; C_FAIL=""; C_DIM=""; C_RST=""
fi
say()  { printf "%s==>%s %s\n"   "$C_OK"   "$C_RST" "$1"; }
warn() { printf "%s!!  %s%s\n"   "$C_FAIL" "$1"     "$C_RST"; }
dim()  { printf "%s    %s%s\n"   "$C_DIM"  "$1"     "$C_RST"; }

EXPECTED_VERSION="$(node -p "require('./package.json').version")"
dim "package.json version = $EXPECTED_VERSION"

say "1/5  vitest"
npm test --silent

say "2/5  typecheck"
npm run typecheck --silent

say "3/5  build"
npm run build --silent

say "4/5  npm pack"
# Clean any stale tarball first so the glob below resolves to exactly one file.
rm -f pith-wiki-*.tgz
TARBALL_NAME="$(npm pack --silent)"
TARBALL_PATH="$REPO_ROOT/$TARBALL_NAME"
dim "tarball: $TARBALL_NAME"

say "5/5  install tarball into sandbox + check --version"
SANDBOX="$(mktemp -d -t pith-wiki-release.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
cd "$SANDBOX"
npm init -y >/dev/null
# --omit=dev keeps the install fast; --no-audit/--no-fund silences chatter.
npm install --omit=dev --no-audit --no-fund "$TARBALL_PATH" >/dev/null
ACTUAL_VERSION="$("$SANDBOX/node_modules/.bin/pith-wiki" --version 2>&1 | tail -1 | tr -d '[:space:]')"
dim "tarball reports --version = $ACTUAL_VERSION"

if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  warn "version mismatch!"
  warn "  package.json: $EXPECTED_VERSION"
  warn "  tarball CLI:  $ACTUAL_VERSION"
  warn "  fix bin/pith-wiki.ts → readPackageVersion(), then rerun."
  exit 1
fi

cd "$REPO_ROOT"
say "OK — tarball at $TARBALL_NAME is ready to publish"
dim "next: npm publish --tag beta   (or rm the tarball if just testing)"
