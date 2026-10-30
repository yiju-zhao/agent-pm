#!/usr/bin/env bash
# Builds the single-file collector binary with bun (cross-compiling is fine, so build everything on the laptop).
#
#   scripts/build-collector.sh                          # both targets
#   scripts/build-collector.sh bun-linux-arm64          # one target
#
# Output: dist/herdr-pm-<target>   (dist/ is gitignored)
#   bun-darwin-arm64  laptop, mac-mini (macOS, Apple silicon)
#   bun-linux-arm64   gx10-090e, gx10-c757 (Linux, `uname -m` = aarch64)
#
# --splitting is required: cli.ts loads the server (node:sqlite, which bun does not have) with a dynamic
# import, and without splitting bun hoists that import to the top of the single bundle, so even
# `herdr-pm collect` would die at startup with "No such built-in module: node:sqlite". With splitting the
# server code is a separate chunk that only the `server` command loads (run the server with node, not this binary).
#
# The Claude Agent SDK (used only by the server's understanding layer, behind dynamic imports) is marked --external:
# it bundles a native Claude Code binary and must not end up in the collector. The collector never imports it.
#
# bun leaves a broken code signature on macOS binaries and Apple silicon kills them on launch (exit 137),
# so the darwin build is re-signed ad hoc afterwards (needs `codesign`, i.e. build it on a Mac).
set -euo pipefail

cd "$(dirname "$0")/.."

# bun leaves a ~60MB temp file (.<hash>.bun-build) in the working directory after a native macOS build.
trap 'rm -f .*.bun-build' EXIT

if ! command -v bun >/dev/null 2>&1; then
  echo "build-collector: bun not found in PATH (brew install oven-sh/bun/bun)" >&2
  exit 1
fi

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(bun-darwin-arm64 bun-linux-arm64)
fi

for target in "${targets[@]}"; do
  case "$target" in
    bun-darwin-arm64 | bun-linux-arm64) ;;
    *)
      echo "build-collector: unsupported target '$target' (use bun-darwin-arm64 or bun-linux-arm64)" >&2
      exit 2
      ;;
  esac
  echo "building dist/herdr-pm-$target"
  bun build src/cli.ts --compile --splitting --external @anthropic-ai/claude-agent-sdk --target="$target" --outfile "dist/herdr-pm-$target"
  if [ "$target" = bun-darwin-arm64 ]; then
    if ! command -v codesign >/dev/null 2>&1; then
      echo "build-collector: codesign not found; dist/herdr-pm-$target will be killed by macOS until it is signed on a Mac" >&2
      exit 1
    fi
    codesign --remove-signature "dist/herdr-pm-$target"
    codesign --force --sign - "dist/herdr-pm-$target"
  fi
done
