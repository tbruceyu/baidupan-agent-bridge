#!/usr/bin/env bash
# install.sh — install/update the bridge and this skill from a local checkout or GitHub.
set -euo pipefail

REPO_URL="${BAIDUPAN_AGENT_BRIDGE_REPO_URL:-https://github.com/tbruceyu/baidupan-agent-bridge.git}"
APP_PATH="${APP:-/Applications/BaiduNetdisk_mac.app}"
ASSUME_YES=0
LAUNCH=1
SOURCE_ROOT="${BAIDUPAN_AGENT_BRIDGE_REPO:-}"
SOURCE_CACHE="$HOME/Library/Application Support/baidupan-agent-bridge/source"

usage() {
  cat <<'EOF'
Install or update Baidu Netdisk Agent Bridge and its skill.

Usage:
  install.sh [--yes] [--app PATH] [--source REPO] [--no-launch]

Options:
  --yes          Confirm quitting and modifying the installed client.
  --app PATH     Baidu Netdisk .app path (default: /Applications/BaiduNetdisk_mac.app).
  --source REPO  Use a local baidupan-agent-bridge checkout instead of GitHub.
  --no-launch    Do not restart the client or run the status check afterward.
  -h, --help     Show this help.

The installer modifies the app bundle, disables its auto-updater, creates a
pristine backup in the source checkout, and installs the skill under
~/.agents/skills/. Run it again after manually upgrading/reinstalling the app.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --app) [ $# -ge 2 ] || die "--app requires a path"; APP_PATH="$2"; shift 2 ;;
    --source) [ $# -ge 2 ] || die "--source requires a repository path"; SOURCE_ROOT="$2"; shift 2 ;;
    --no-launch) LAUNCH=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "this bridge supports macOS only"
[ -d "$APP_PATH" ] || die "Baidu Netdisk app not found: $APP_PATH"

if [ "$ASSUME_YES" != 1 ]; then
  if [ -t 0 ]; then
    echo "This will quit Baidu Netdisk, modify and ad-hoc re-sign its app bundle,"
    echo "disable its auto-updater, and install/update 百度云盘助手 (baidu-netdisk-assistant)."
    printf "Continue? [y/N] "
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
  else
    die "confirmation required; rerun with --yes after the user approves app modification"
  fi
fi

# Prefer an explicitly selected or nearby development checkout. An installed
# skill has no bridge payload, so it falls back to a fresh HTTPS clone.
if [ -z "$SOURCE_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SOURCE_MARKER="$SCRIPT_DIR/../.source-repo"
  BUNDLED_CANDIDATE="$(cd "$SCRIPT_DIR/../../.." 2>/dev/null && pwd || true)"
  if [ -f "$SOURCE_MARKER" ] && [ -x "$(cat "$SOURCE_MARKER")/agent-bridge/build.sh" ]; then
    SOURCE_ROOT="$(cat "$SOURCE_MARKER")"
  elif [ -x "$BUNDLED_CANDIDATE/agent-bridge/build.sh" ]; then
    SOURCE_ROOT="$BUNDLED_CANDIDATE"
  elif [ -x "$PWD/agent-bridge/build.sh" ]; then
    SOURCE_ROOT="$PWD"
  fi
fi

if [ -z "$SOURCE_ROOT" ]; then
  command -v git >/dev/null 2>&1 || die "git is required to download $REPO_URL"
  mkdir -p "$(dirname "$SOURCE_CACHE")"
  if [ -d "$SOURCE_CACHE/.git" ]; then
    echo "==> Updating cached installer source"
    git -C "$SOURCE_CACHE" fetch --depth 1 --quiet origin main
    git -C "$SOURCE_CACHE" reset --hard --quiet origin/main
  else
    [ ! -e "$SOURCE_CACHE" ] || die "installer source cache is not a git checkout: $SOURCE_CACHE"
    echo "==> Downloading installer source"
    git clone --depth 1 --quiet "$REPO_URL" "$SOURCE_CACHE"
  fi
  SOURCE_ROOT="$SOURCE_CACHE"
else
  SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd)"
  echo "==> Using local installer source: $SOURCE_ROOT"
fi

BUILD_SCRIPT="$SOURCE_ROOT/agent-bridge/build.sh"
[ -x "$BUILD_SCRIPT" ] || die "invalid source checkout: $BUILD_SCRIPT is missing or not executable"
[ -f "$SOURCE_ROOT/agent-bridge/agent-bridge.js" ] || die "invalid source checkout: bridge payload is missing"
[ -f "$SOURCE_ROOT/skill/baidu-netdisk-assistant/SKILL.md" ] || die "invalid source checkout: skill package is missing"

if pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1; then
  echo "==> Quitting Baidu Netdisk"
  osascript -e 'tell application id "com.baidu.netdisk" to quit' 2>/dev/null \
    || osascript -e 'tell application "BaiduNetdisk_mac" to quit' 2>/dev/null \
    || true
  stopped=0
  i=0
  while [ "$i" -lt 20 ]; do
    if ! pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  [ "$stopped" = 1 ] || die "Baidu Netdisk did not quit within 20 seconds"
fi

APP="$APP_PATH" "$BUILD_SCRIPT"

if [ "$LAUNCH" = 1 ]; then
  echo "==> Starting Baidu Netdisk"
  open "$APP_PATH"
  STATUS_CLI="$HOME/.agents/skills/baidu-netdisk-assistant/scripts/baidupan.sh"
  verified=0
  status_output=""
  i=0
  while [ "$i" -lt 20 ]; do
    if [ -x "$STATUS_CLI" ] && status_output="$("$STATUS_CLI" status 2>/dev/null)"; then
      printf '%s\n' "$status_output"
      verified=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  if [ "$verified" = 1 ]; then
    echo "==> Bridge and skill verification succeeded"
  else
    echo "WARNING: the client started, but status was not ready within 20 seconds." >&2
    echo "         Sign in if needed, then run: $STATUS_CLI status" >&2
  fi
fi
