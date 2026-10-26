#!/usr/bin/env bash
# build.sh — inject agent-bridge.js into the Baidu Netdisk app bundle.
#
# Flow: (re)create pristine extraction from the original backup asar,
# add the bridge module, append a require to main.js, repack with the
# same unpacked set, reinstall into the .app and re-sign (ad-hoc).
#
# Toolchain note: this machine's `node`/`npx` shell functions are broken nvm
# shims in non-interactive shells, so we use absolute homebrew paths.
# Backup naming: asar extract expects <archive>.unpacked next to the archive,
# so the backup pair lives at backup/app.asar + backup/app.asar.unpacked.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT_DIR/BaiduNetdisk_mac.app"
RESOURCES="$APP/Contents/Resources"
ASAR="$RESOURCES/app.asar"
BACKUP_DIR="$PROJECT_DIR/backup"
BUILD_DIR="$PROJECT_DIR/build"
EXTRACTED="$BUILD_DIR/extracted"
NPX=/opt/homebrew/bin/npx
NPM=/opt/homebrew/bin/npm
NODE=/opt/homebrew/bin/node
# NOTE: the asar CLI mangles brace globs in --unpack-dir (only the first
# alternative matches); the library API handles them correctly, so packing
# goes through a small node script that imports @electron/asar directly.
UNPACK_DIR_GLOB='node_modules/{@baidu,electron-clipboard-ex,koffi,macos-notification-state,uiohook-napi,windows-notification-state,windows-quiet-hours}'

echo "==> Checking prerequisites"
[ -d "$APP" ] || { echo "App bundle not found: $APP" >&2; exit 1; }
[ -x "$NPX" ] || { echo "npx not found at $NPX" >&2; exit 1; }

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "ERROR: $APP is currently running. Quit it first (it will not pick up" >&2
  echo "       modifications until restarted, and hot-swapping files under a" >&2
  echo "       running app is unsafe)." >&2
  exit 1
fi

echo "==> Creating pristine backup (first run only)"
mkdir -p "$BACKUP_DIR"
if [ ! -f "$BACKUP_DIR/app.asar" ]; then
  cp "$ASAR" "$BACKUP_DIR/app.asar"
  echo "    backed up original asar -> $BACKUP_DIR/app.asar"
fi
if [ ! -d "$BACKUP_DIR/app.asar.unpacked" ]; then
  cp -R "$RESOURCES/app.asar.unpacked" "$BACKUP_DIR/app.asar.unpacked"
  echo "    backed up original app.asar.unpacked -> $BACKUP_DIR/app.asar.unpacked"
fi

echo "==> Extracting original asar"
rm -rf "$EXTRACTED"
mkdir -p "$EXTRACTED"
(cd "$EXTRACTED" && "$NPX" --yes @electron/asar extract "$BACKUP_DIR/app.asar" .)

echo "==> Injecting agent-bridge"
cp "$PROJECT_DIR/agent-bridge/agent-bridge.js" "$EXTRACTED/dist/electron/agent-bridge.js"
cat >> "$EXTRACTED/dist/electron/entry.js" <<'EOF'
;/* agent-bridge injection */
try{require("./agent-bridge.js")}catch(e){console.error("[agent-bridge] load failed:",e)}
EOF

echo "==> Repacking asar"
rm -rf "$BUILD_DIR/app.asar" "$BUILD_DIR/app.asar.unpacked"
mkdir -p "$BUILD_DIR/pack-tools"
if [ ! -d "$BUILD_DIR/pack-tools/node_modules/@electron/asar" ]; then
  echo '{"name":"pack-tools","private":true}' > "$BUILD_DIR/pack-tools/package.json"
  (cd "$BUILD_DIR/pack-tools" && "$NPM" install --silent @electron/asar)
fi
(cd "$BUILD_DIR/pack-tools" && UNPACK_DIR_GLOB="$UNPACK_DIR_GLOB" EXTRACTED="$EXTRACTED" OUTPUT="$BUILD_DIR/app.asar" "$NODE" --input-type=module -e "
import { createPackageWithOptions } from '@electron/asar';
await createPackageWithOptions(process.env.EXTRACTED, process.env.OUTPUT, { unpackDir: process.env.UNPACK_DIR_GLOB });
")
if [ ! -f "$BUILD_DIR/app.asar" ]; then
  echo "ERROR: pack did not produce $BUILD_DIR/app.asar" >&2
  exit 1
fi

echo "==> Verifying unpacked set matches the original"
# All originally-unpacked files must still be unpacked (natives must load).
# Extra files in the new unpacked dir are harmless (the archive header and
# the unpacked dir stay self-consistent), e.g. @sentry/cli/node_modules which
# the original build happened to keep inside the archive.
MISSING=$(diff -rq "$BUILD_DIR/app.asar.unpacked" "$BACKUP_DIR/app.asar.unpacked" 2>/dev/null | grep '^Only in '"$BACKUP_DIR" || true)
if [ -n "$MISSING" ]; then
  echo "ERROR: original unpacked files are missing from the repack:" >&2
  echo "$MISSING" | head -20 >&2
  exit 1
fi

echo "==> Assembling new app bundle"
# macOS TCC "App Management" denies writing into the installed bundle, so
# assemble a complete copy next to it and swap the whole bundle directory
# (moving bundles is permitted, unlike writing inside them).
NEW_APP="$BUILD_DIR/BaiduNetdisk_mac.app"
rm -rf "$NEW_APP"
cp -R "$APP" "$NEW_APP"
rm -rf "$NEW_APP/Contents/Resources/app.asar.unpacked"
cp "$BUILD_DIR/app.asar" "$NEW_APP/Contents/Resources/app.asar"
cp -R "$BUILD_DIR/app.asar.unpacked" "$NEW_APP/Contents/Resources/app.asar.unpacked"

echo "==> Disabling auto-update (would overwrite the injection)"
if [ -f "$NEW_APP/Contents/Resources/app-update.yml" ]; then
  mv "$NEW_APP/Contents/Resources/app-update.yml" "$NEW_APP/Contents/Resources/app-update.yml.disabled"
fi

echo "==> Verifying auto-update is disabled"
# electron-updater cannot run without its Resources/app-update.yml config
# (the feed URL lives only in that file); fail the build if it is present.
if [ -f "$NEW_APP/Contents/Resources/app-update.yml" ]; then
  echo "ERROR: app-update.yml still present — auto-update would be enabled" >&2
  exit 1
fi

echo "==> Re-signing (ad-hoc, top-level only)"
# NOTE: no --deep — the app ships with hybrid-layout frameworks that make
# `codesign --verify` report "bundle format is ambiguous" even in its
# original state, and the original nested signatures stay valid because
# only Resources/ changed. Signing the top bundle re-seals Resources.
codesign --force --sign - "$NEW_APP" >/dev/null 2>&1
# The shipped bundle layout makes full `codesign --verify` choke even in its
# original state, so sanity-check that an adhoc signature is present instead.
codesign -dv "$NEW_APP" 2>&1 | grep "Signature=adhoc" >/dev/null || {
  echo "codesign did not produce an adhoc signature" >&2; exit 1; }

echo "==> Swapping bundle into place"
OLD_APP="$BUILD_DIR/old-BaiduNetdisk_mac.app"
rm -rf "$OLD_APP"
mv "$APP" "$OLD_APP"
mv "$NEW_APP" "$APP"
rm -rf "$OLD_APP"

echo "==> Done."
echo "    Start the app, then connect an MCP client to http://127.0.0.1:8765/mcp"
echo "    Token file: ~/Library/Application Support/baidunetdisk/agent-bridge-token"
