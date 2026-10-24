#!/usr/bin/env bash
# Downloads the pinned Node.js runtime that Harness uses for the daemon, the CLI
# and every Node plugin process. The runtime lives in .runtime/ (git-ignored) so
# the user's system Node installation is never touched.
set -euo pipefail

NODE_VERSION="${HARNESS_NODE_VERSION:-v26.12.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.runtime"
[[ "$(uname -s)" == Darwin ]] || { echo "Harness requires macOS" >&2; exit 1; }
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) PLATFORM="darwin-arm64" ;;
  x86_64) PLATFORM="darwin-x64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

NAME="node-${NODE_VERSION}-${PLATFORM}"
if [[ -x "$DEST/node/bin/node" ]] && [[ "$("$DEST/node/bin/node" -v)" == "$NODE_VERSION" ]]; then
  echo "runtime already present: $NODE_VERSION"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://nodejs.org/dist/${NODE_VERSION}"
curl -fsSL "$BASE/${NAME}.tar.gz" -o "$TMP/${NAME}.tar.gz"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
(cd "$TMP" && grep " ${NAME}.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c -)

mkdir -p "$DEST"
rm -rf "$DEST/node"
tar -xzf "$TMP/${NAME}.tar.gz" -C "$TMP"
mv "$TMP/$NAME" "$DEST/node"
echo "installed runtime $("$DEST/node/bin/node" -v) at $DEST/node"
