#!/usr/bin/env bash
# Builds a runnable, source-free distribution of Harness for macOS (Apple silicon).
#
#   ./scripts/package.sh <name> <out-dir>
#
# Produces <out-dir>/<name>/ (staging) and <out-dir>/<name>.zip. The layout mirrors the
# repository so the bundled CLI/daemon resolve web/, plugins/ and .runtime/ unchanged:
#   bin/harness                      launcher (pinned Node 26)
#   .runtime/node/bin/node           bundled Node 26 runtime
#   apps/cli/src/main.mjs            CLI bundle
#   apps/daemon/src/main.mjs         daemon bundle
#   apps/web/dist/                   Web UI build
#   plugins/<id>/                    built plugins (manifest + dist only)
#   examples/                        demo/test plugins (fault injection, panel isolation probe)
#   node_modules/                    native/externals only (@napi-rs/keyring, sandbox-runtime)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:?usage: package.sh <name> <out-dir>}"
OUT="$(mkdir -p "${2:?usage: package.sh <name> <out-dir>}" && cd "$2" && pwd)"
case "$NAME" in
  ""|.|..|*[!a-zA-Z0-9_-]*) echo "name must contain only letters, digits, underscores and hyphens" >&2; exit 1 ;;
esac
STAGE="$OUT/$NAME"
RT="$ROOT/scripts/rt.sh"

echo "==> clean $STAGE"
rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$STAGE"

echo "==> build plugins and Web UI"
"$RT" node "$ROOT/scripts/build-plugins.ts" >/dev/null
(cd "$ROOT/apps/web" && "$RT" vite build --logLevel warn)

echo "==> bundle CLI and daemon"
BANNER="import { createRequire as __hxCreateRequire } from 'node:module'; const require = __hxCreateRequire(import.meta.url);"
for app in cli daemon; do
  "$RT" esbuild "$ROOT/apps/$app/src/main.ts" --bundle --platform=node --format=esm --target=node26 \
    --outfile="$STAGE/apps/$app/src/main.mjs" \
    --external:@napi-rs/keyring --external:@anthropic-ai/sandbox-runtime \
    --banner:js="$BANNER" --legal-comments=eof --log-level=warning
done
# The CLI spawns the daemon by path; point it at the bundle.
sed -i '' 's/"src", "main\.ts")/"src", "main.mjs")/' "$STAGE/apps/cli/src/main.mjs"
grep -q '"src", "main.mjs")' "$STAGE/apps/cli/src/main.mjs" || { echo "daemon entry rewrite failed" >&2; exit 1; }

echo "==> launcher"
mkdir -p "$STAGE/bin"
sed 's#apps/cli/src/main\.ts#apps/cli/src/main.mjs#' "$ROOT/bin/harness" >"$STAGE/bin/harness"
chmod +x "$STAGE/bin/harness"
mkdir -p "$STAGE/scripts" && cp "$ROOT/scripts/fetch-runtime.sh" "$STAGE/scripts/"

echo "==> Node runtime"
mkdir -p "$STAGE/.runtime/node/bin"
cp "$ROOT/.runtime/node/bin/node" "$STAGE/.runtime/node/bin/node"
for f in LICENSE README.md CHANGELOG.md; do [[ -f "$ROOT/.runtime/node/$f" ]] && cp "$ROOT/.runtime/node/$f" "$STAGE/.runtime/node/" || true; done
[[ -f "$ROOT/.runtime/node/.version" ]] && cp "$ROOT/.runtime/node/.version" "$STAGE/.runtime/node/" || true

echo "==> Web UI"
mkdir -p "$STAGE/apps/web" && cp -R "$ROOT/apps/web/dist" "$STAGE/apps/web/dist"

echo "==> plugins"
for dir in "$ROOT"/plugins/*/; do
  id="$(basename "$dir")"
  mkdir -p "$STAGE/plugins/$id"
  cp "$dir/harness.plugin.json" "$STAGE/plugins/$id/"
  cp -R "$dir/dist" "$STAGE/plugins/$id/dist"
  for f in README.md LICENSE; do [[ -f "$dir/$f" ]] && cp "$dir/$f" "$STAGE/plugins/$id/" || true; done
done
mkdir -p "$STAGE/examples"
for ex in misbehave panel-probe; do cp -R "$ROOT/test/fixtures/plugins/$ex" "$STAGE/examples/$ex"; done
mkdir -p "$STAGE/packages/manifest/schema"
cp "$ROOT/packages/manifest/schema/harness.plugin.schema.json" "$STAGE/packages/manifest/schema/" 2>/dev/null || true

echo "==> native dependencies"
KEYRING_VER="$(node -p 'require(process.argv[1]).version' "$ROOT/apps/daemon/node_modules/@napi-rs/keyring/package.json")"
SRT_VER="$(node -p 'require(process.argv[1]).version' "$ROOT/apps/daemon/node_modules/@anthropic-ai/sandbox-runtime/package.json")"
cat >"$STAGE/package.json" <<EOF
{
  "name": "harness-dist",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "author": "Yuki Li",
  "license": "MIT",
  "dependencies": { "@napi-rs/keyring": "$KEYRING_VER", "@anthropic-ai/sandbox-runtime": "$SRT_VER" }
}
EOF
(cd "$STAGE" && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error >/dev/null)

echo "==> docs"
cp "$ROOT/scripts/dist-README.md" "$STAGE/README.md"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
mkdir -p "$STAGE/docs"
cp "$ROOT/docs/architecture-design.md" "$STAGE/docs/"

echo "==> zip"
(cd "$OUT" && ditto -c -k --keepParent --norsrc "$NAME" "$NAME.zip")
du -sh "$STAGE" "$OUT/$NAME.zip"
