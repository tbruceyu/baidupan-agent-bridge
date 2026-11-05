#!/usr/bin/env bash
# build.sh — inject agent-bridge.js into the installed Baidu Netdisk app bundle.
#
# Target: /Applications/BaiduNetdisk_mac.app (override with APP=/path/app).
# Before touching anything the script verifies the client version and asar
# layout (this bridge supports client 8.9.7+ only) and whether the bundle is
# already injected.
#
# Flow: (re)create pristine extraction from the original backup asar,
# add the bridge module, append a require to entry.js, repack with the same
# unpacked set, reinstall into the .app, re-sign (ad-hoc), and install the skill.
#
# Toolchain note: this machine's `node`/`npx` shell functions are broken nvm
# shims in non-interactive shells, so we use absolute homebrew paths.
# Backup naming: asar extract expects <archive>.unpacked next to the archive,
# so the backup pair lives at backup/app.asar + backup/app.asar.unpacked.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP:-/Applications/BaiduNetdisk_mac.app}"
RESOURCES="$APP/Contents/Resources"
ASAR="$RESOURCES/app.asar"
BACKUP_DIR="$PROJECT_DIR/backup"
BUILD_DIR="$PROJECT_DIR/build"
EXTRACTED="$BUILD_DIR/extracted"
NPX=/opt/homebrew/bin/npx
NPM=/opt/homebrew/bin/npm
NODE=/opt/homebrew/bin/node
# Minimum client version this bridge supports (obfuscated entry.js layout).
MIN_VERSION="8.9.7"
# NOTE: the asar CLI mangles brace globs in --unpack-dir (only the first
# alternative matches); the library API handles them correctly, so packing
# goes through a small node script that imports @electron/asar directly.
UNPACK_DIR_GLOB='node_modules/{@baidu,electron-clipboard-ex,koffi,macos-notification-state,uiohook-napi,windows-notification-state,windows-quiet-hours}'
SKILL_SOURCE="$PROJECT_DIR/skill/baidu-netdisk-assistant"
SKILL_INSTALL_DIR="$HOME/.agents/skills/baidu-netdisk-assistant"
OLD_SKILL_INSTALL_DIR="$HOME/.agents/skills/baidu-netdisk"

# Install the Agent Skill in the cross-agent canonical location, then expose it
# to agents that use their own skill directory. Existing non-symlink entries at
# link locations are preserved as timestamped backups.
install_skill() {
  echo "==> Installing 百度云盘助手 skill (baidu-netdisk-assistant)"
  [ -f "$SKILL_SOURCE/SKILL.md" ] || {
    echo "ERROR: skill source not found at $SKILL_SOURCE" >&2
    exit 1
  }

  mkdir -p "$(dirname "$SKILL_INSTALL_DIR")"
  SKILL_STAGE="$(mktemp -d "$(dirname "$SKILL_INSTALL_DIR")/.baidu-netdisk-assistant.XXXXXX")"
  cp -R "$SKILL_SOURCE/." "$SKILL_STAGE/"
  # Keep the matching source checkout discoverable for future skill-driven
  # updates. A downloaded installer uses a persistent checkout so its pristine
  # asar backup remains available across runs.
  printf '%s\n' "$PROJECT_DIR" > "$SKILL_STAGE/.source-repo"
  rm -rf "$SKILL_INSTALL_DIR"
  mv "$SKILL_STAGE" "$SKILL_INSTALL_DIR"
  echo "    installed -> $SKILL_INSTALL_DIR"

  AGENT_SKILL_DIRS=(
    "$HOME/.claude/skills"
    "$HOME/.gemini/skills"
    "$HOME/.cursor/skills"
    "$HOME/.config/opencode/skills"
  )
  AGENT_NAMES=("Claude Code" "Gemini CLI" "Cursor" "OpenCode")

  i=0
  while [ "$i" -lt "${#AGENT_SKILL_DIRS[@]}" ]; do
    agent_dir="${AGENT_SKILL_DIRS[$i]}"
    link="$agent_dir/baidu-netdisk-assistant"
    mkdir -p "$agent_dir"
    if [ -L "$link" ]; then
      rm "$link"
    elif [ -e "$link" ]; then
      backup="$link.backup-$(date +%Y%m%d%H%M%S)-$$"
      mv "$link" "$backup"
      echo "    preserved existing ${AGENT_NAMES[$i]} skill -> $backup"
    fi
    ln -s "$SKILL_INSTALL_DIR" "$link"
    echo "    linked ${AGENT_NAMES[$i]} -> $link"

    old_link="$agent_dir/baidu-netdisk"
    if [ -L "$old_link" ]; then
      rm "$old_link"
      echo "    removed old ${AGENT_NAMES[$i]} link -> $old_link"
    fi
    i=$((i + 1))
  done

  # Migrate installations created before the skill was renamed. Only remove the
  # old canonical directory when it identifies itself as our former package.
  if [ -f "$OLD_SKILL_INSTALL_DIR/SKILL.md" ] \
    && grep -q '^name: baidu-netdisk$' "$OLD_SKILL_INSTALL_DIR/SKILL.md"; then
    rm -rf "$OLD_SKILL_INSTALL_DIR"
    echo "    removed old skill package -> $OLD_SKILL_INSTALL_DIR"
  fi
}

# version_ge <installed> <required> — dotted-numeric semver compare.
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, ".");
    for (i = 1; i <= n || i <= m; i++) {
      dx = (i <= n) ? x[i] + 0 : 0; dy = (i <= m) ? y[i] + 0 : 0;
      if (dx > dy) exit 0; if (dx < dy) exit 1;
    }
    exit 0
  }'
}

echo "==> Checking prerequisites"
[ -d "$APP" ] || { echo "App bundle not found: $APP" >&2; exit 1; }
[ -x "$NPX" ] || { echo "npx not found at $NPX" >&2; exit 1; }

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "ERROR: $APP is currently running. Quit it first (it will not pick up" >&2
  echo "       modifications until restarted, and hot-swapping files under a" >&2
  echo "       running app is unsafe)." >&2
  exit 1
fi

echo "==> Verifying client version"
VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")" || {
  echo "ERROR: cannot read CFBundleShortVersionString from $APP/Contents/Info.plist" >&2
  exit 1
}
if ! version_ge "$VERSION" "$MIN_VERSION"; then
  echo "ERROR: client version $VERSION is not supported (need >= $MIN_VERSION)." >&2
  echo "       This bridge targets the obfuscated dist/electron/entry.js layout" >&2
  echo "       introduced in $MIN_VERSION. Upgrade the official client first." >&2
  exit 1
fi
echo "    client version $VERSION (>= $MIN_VERSION), OK"

echo "==> Preparing asar tooling"
mkdir -p "$BUILD_DIR/pack-tools"
if [ ! -d "$BUILD_DIR/pack-tools/node_modules/@electron/asar" ]; then
  echo '{"name":"pack-tools","private":true}' > "$BUILD_DIR/pack-tools/package.json"
  (cd "$BUILD_DIR/pack-tools" && "$NPM" install --silent @electron/asar)
fi

echo "==> Verifying asar layout and injection state"
# v2 layout check: obfuscated entry at dist/electron/entry.js; also detect an
# existing injection (agent-bridge.js already inside the archive) so we know
# whether the on-disk asar can serve as a pristine backup source.
ASAR_STATE="$(cd "$BUILD_DIR/pack-tools" && ASAR="$ASAR" "$NODE" --input-type=module -e "
import { listPackage } from '@electron/asar';
const files = listPackage(process.env.ASAR).map(f => f.replace(/^\//, '').replace(/\/$/, ''));
const has = (p) => files.includes(p);
process.stdout.write(
  (has('dist/electron/entry.js') ? 'entry=yes' : 'entry=no') + ' ' +
  (has('dist/electron/agent-bridge.js') ? 'injected=yes' : 'injected=no'));
")"
case "$ASAR_STATE" in
  "entry=yes injected=no"|"entry=yes injected=yes") ;;
  *)
    echo "ERROR: unexpected asar layout ($ASAR_STATE): dist/electron/entry.js not" >&2
    echo "       found. This bridge supports client $MIN_VERSION+ only." >&2
    exit 1
    ;;
esac
ALREADY_INJECTED="${ASAR_STATE##*injected=}"
echo "    entry.js layout OK; injected=$ALREADY_INJECTED"

echo "==> Creating pristine backup"
# backup/app.version stamps the client version the backup was taken from, so
# a manual client upgrade (fresh pristine install) refreshes the backup.
mkdir -p "$BACKUP_DIR"
if [ "$ALREADY_INJECTED" = "yes" ]; then
  # The on-disk asar contains the injection, so it cannot serve as a backup
  # source; only the existing pristine backup lets us rebuild.
  if [ ! -f "$BACKUP_DIR/app.asar" ]; then
    echo "ERROR: app is already injected but no pristine backup exists at" >&2
    echo "       $BACKUP_DIR — reinstall the official client, then rerun." >&2
    exit 1
  fi
  if [ "$(cat "$BACKUP_DIR/app.version" 2>/dev/null || true)" != "$VERSION" ]; then
    echo "ERROR: app is injected but the backup is from a different client" >&2
    echo "       version (backup: $(cat "$BACKUP_DIR/app.version" 2>/dev/null || echo unknown), app: $VERSION)." >&2
    echo "       Reinstall the official client, then rerun." >&2
    exit 1
  fi
  echo "    keeping existing pristine backup ($BACKUP_DIR)"
else
  if [ ! -f "$BACKUP_DIR/app.asar" ] || [ "$(cat "$BACKUP_DIR/app.version" 2>/dev/null || true)" != "$VERSION" ]; then
    rm -rf "$BACKUP_DIR/app.asar" "$BACKUP_DIR/app.asar.unpacked"
    cp "$ASAR" "$BACKUP_DIR/app.asar"
    cp -R "$RESOURCES/app.asar.unpacked" "$BACKUP_DIR/app.asar.unpacked"
    echo "$VERSION" > "$BACKUP_DIR/app.version"
    echo "    backed up original asar ($VERSION) -> $BACKUP_DIR"
  else
    echo "    pristine backup for $VERSION already exists"
  fi
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

install_skill

echo "==> Done."
echo "    Start the app and sign in, then use the recommended skill:"
echo "      ~/.agents/skills/baidu-netdisk-assistant/scripts/baidupan.sh status"
echo ""
echo "    Optional: native MCP clients can also connect to the bridge:"
echo '      claude mcp add --transport http baidupan http://127.0.0.1:8765/mcp \'
echo '        --header "Authorization: Bearer $(cat ~/Library/Application\ Support/baidunetdisk/agent-bridge-token)"'
echo "    Skill is the recommended integration; MCP is optional."
echo "    Token file: ~/Library/Application Support/baidunetdisk/agent-bridge-token"
