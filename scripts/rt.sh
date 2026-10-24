#!/usr/bin/env bash
# Runs a command with the pinned Harness Node runtime first on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -x "$ROOT/.runtime/node/bin/node" ]]; then
  "$ROOT/scripts/fetch-runtime.sh" >&2
fi
export PATH="$ROOT/.runtime/node/bin:$ROOT/node_modules/.bin:$PATH"
exec "$@"
