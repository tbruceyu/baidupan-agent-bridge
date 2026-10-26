#!/usr/bin/env bash
# restore.sh — restore the original (unmodified) app.asar into the app bundle.
#
# macOS TCC "App Management" denies writing into the installed bundle, so
# this assembles a repaired copy from the backup and swaps the whole bundle.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT_DIR/BaiduNetdisk_mac.app"
BACKUP_DIR="$PROJECT_DIR/backup"
BUILD_DIR="$PROJECT_DIR/build"

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "ERROR: $APP is currently running. Quit it first." >&2
  exit 1
fi
[ -f "$BACKUP_DIR/app.asar" ] || { echo "No backup found at $BACKUP_DIR/app.asar" >&2; exit 1; }

NEW_APP="$BUILD_DIR/restored-BaiduNetdisk_mac.app"
rm -rf "$NEW_APP"
cp -R "$APP" "$NEW_APP"
cp "$BACKUP_DIR/app.asar" "$NEW_APP/Contents/Resources/app.asar"
rm -rf "$NEW_APP/Contents/Resources/app.asar.unpacked"
cp -R "$BACKUP_DIR/app.asar.unpacked" "$NEW_APP/Contents/Resources/app.asar.unpacked"
if [ -f "$NEW_APP/Contents/Resources/app-update.yml.disabled" ]; then
  mv "$NEW_APP/Contents/Resources/app-update.yml.disabled" "$NEW_APP/Contents/Resources/app-update.yml"
fi

# Top-level ad-hoc re-sign only; nested signatures remain original/valid.
codesign --force --sign - "$NEW_APP" >/dev/null 2>&1
codesign -dv "$NEW_APP" 2>&1 | grep "Signature=adhoc" >/dev/null

OLD_APP="$BUILD_DIR/old-BaiduNetdisk_mac.app"
rm -rf "$OLD_APP"
mv "$APP" "$OLD_APP"
mv "$NEW_APP" "$APP"
rm -rf "$OLD_APP"

echo "Restored original app.asar and re-signed the bundle."
