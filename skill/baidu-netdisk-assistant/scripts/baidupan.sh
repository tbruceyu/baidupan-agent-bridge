#!/usr/bin/env bash
# baidupan.sh — CLI wrapper for the Baidu Netdisk MCP bridge (all 12 tools).
# Talks to the MCP server injected into the local Baidu Netdisk macOS client.
set -euo pipefail

TOKEN_FILE="$HOME/Library/Application Support/baidunetdisk/agent-bridge-token"
URL="http://127.0.0.1:8765/mcp"

die() { echo "ERROR: $*" >&2; exit 1; }

# pick a JSON interpreter
if command -v python3 >/dev/null 2>&1; then
  JSON_BIN=python3
elif [ -x /opt/homebrew/bin/node ]; then
  JSON_BIN=/opt/homebrew/bin/node
else
  die "need python3 or node for JSON handling"
fi

json_dump() { # json_dump KEY TYPE VALUE...  (TYPE: s=string, i=int)
  if [ "$JSON_BIN" = python3 ]; then
    python3 - "$@" <<'PY'
import json, sys
out = {}
args = sys.argv[1:]
for i in range(0, len(args), 3):
    k, t, v = args[i], args[i+1], args[i+2]
    out[k] = int(v) if t == "i" else v
print(json.dumps(out, ensure_ascii=False))
PY
  else
    /opt/homebrew/bin/node - "$@" <<'JS'
let out = {};
let a = process.argv.slice(2);
for (let i = 0; i + 2 < a.length + 1; i += 3) out[a[i]] = a[i+1] === "i" ? Number(a[i+2]) : a[i+2];
console.log(JSON.stringify(out));
JS
  fi
}

mcpcall() { # mcpcall <tool> <json-args>
  local tool="$1" args="${2:-{\}}" body
  body=$(json_dump __tool__ s "$tool" 2>/dev/null || true)
  if [ "$JSON_BIN" = python3 ]; then
    body=$(python3 -c '
import json, sys
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$tool" "$args")
  else
    body=$(/opt/homebrew/bin/node -e '
const a = process.argv.slice(1);
console.log(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
  params:{name:a[0],arguments:JSON.parse(a[1])}}))' "$tool" "$args")
  fi
  [ -f "$TOKEN_FILE" ] || die "token file missing: $TOKEN_FILE (start the app once first)"
  local TOKEN; TOKEN=$(cat "$TOKEN_FILE")
  local resp rc=0
  resp=$(curl -s -m 600 -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body") || rc=$?
  if [ "$rc" != 0 ]; then
    echo "ERROR: cannot reach the MCP bridge at $URL" >&2
    if ! pgrep -f "BaiduNetdisk_mac.app/Contents/MacOS" >/dev/null 2>&1; then
      echo "The Baidu Netdisk client is not running. Start it (e.g." >&2
      echo "  open /Applications/BaiduNetdisk_mac.app" >&2
      echo "), make sure you are logged in, and retry." >&2
    else
      echo "The client is running but the bridge is not answering — the" >&2
      echo "installed client may be un-injected (reinstalled/upgraded) or" >&2
      echo "still starting. Check:" >&2
      echo "  ~/Library/Application Support/baidunetdisk/agent-bridge.log" >&2
    fi
    exit 2
  fi
  if [ "$JSON_BIN" = python3 ]; then
    printf '%s' "$resp" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    if "error" in d and d["error"]:
        print("MCP error:", json.dumps(d["error"], ensure_ascii=False)); sys.exit(3)
    r = d.get("result") or {}
    print("".join(c.get("text", "") for c in r.get("content", [])))
    sys.exit(1 if r.get("isError") else 0)
except Exception:
    print(raw[:600] or "empty response", file=sys.stderr); sys.exit(2)'
  else
    printf '%s' "$resp" | /opt/homebrew/bin/node -e '
let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
  try {
    const d = JSON.parse(raw);
    if (d.error) { console.log("MCP error:", JSON.stringify(d.error)); process.exit(3); }
    const r = d.result || {};
    process.stdout.write((r.content || []).map(c => c.text || "").join(""));
    process.exit(r.isError ? 1 : 0);
  } catch (e) { console.error(raw.slice(0, 600) || "empty response"); process.exit(2); }
});'
  fi
}

usage() {
  cat <<'EOF'
baidupan.sh — operate Baidu Netdisk via the local MCP bridge

Usage:
  baidupan.sh install [installer options]     install/update bridge and skill
  baidupan.sh status                          login state / account / quota
  baidupan.sh quota                           storage quota
  baidupan.sh list [dir] [start] [limit]      list a directory (default "/" 0 100)
  baidupan.sh search <key> [dir]              search by keyword (default "/")
  baidupan.sh download <remote> [local]       download a file (default ~/Downloads/baidupan-mcp/<name>)
  baidupan.sh upload <local> [remote_dir]     upload a file (default "/"; queued, see transfers)
  baidupan.sh transfers                       upload/download queue counts
  baidupan.sh mkdir <path>                    create a directory
  baidupan.sh rename <path> <new_name>       rename (new bare name, no slashes)
  baidupan.sh move <dest_dir> <path>...       move paths into a directory
  baidupan.sh delete <path>...               delete (goes to cloud recycle bin)
  baidupan.sh share <path> [pwd] [days]       create share link (+ extraction code)

Remote paths are absolute, e.g. "/docs/report.pdf".
EOF
}

[ $# -ge 1 ] || { usage; exit 1; }
cmd="$1"; shift

case "$cmd" in
  install)   exec "$(cd "$(dirname "$0")" && pwd)/install.sh" "$@" ;;
  status)    mcpcall baidu_status "$(json_dump)" ;;
  quota)     mcpcall baidu_get_quota "$(json_dump)" ;;
  transfers) mcpcall baidu_transfer_status "$(json_dump)" ;;
  list)
    dir="${1:-/}"; start="${2:-0}"; limit="${3:-100}"
    mcpcall baidu_list_files "$(json_dump dir s "$dir" start i "$start" limit i "$limit")" ;;
  search)
    [ $# -ge 1 ] || die "usage: baidupan.sh search <key> [dir]"
    key="$1"; dir="${2:-/}"
    mcpcall baidu_search_files "$(json_dump key s "$key" dir s "$dir")" ;;
  download)
    [ $# -ge 1 ] || die "usage: baidupan.sh download <remote_path> [local_path]"
    rp="$1"; lp="${2:-$HOME/Downloads/baidupan-mcp/$(basename "$rp")}"
    mkdir -p "$(dirname "$lp")"
    mcpcall baidu_download_file "$(json_dump remote_path s "$rp" local_path s "$lp")" ;;
  upload)
    [ $# -ge 1 ] || die "usage: baidupan.sh upload <local_path> [remote_dir]"
    lp="$1"; rd="${2:-/}"
    [ -f "$lp" ] || die "local file not found: $lp"
    mcpcall baidu_upload_file "$(json_dump local_path s "$lp" remote_dir s "$rd")" ;;
  mkdir)
    [ $# -ge 1 ] || die "usage: baidupan.sh mkdir <path>"
    mcpcall baidu_mkdir "$(json_dump path s "$1")" ;;
  rename)
    [ $# -ge 2 ] || die "usage: baidupan.sh rename <path> <new_name>"
    mcpcall baidu_rename "$(json_dump path s "$1" new_name s "$2")" ;;
  move)
    [ $# -ge 2 ] || die "usage: baidupan.sh move <dest_dir> <path>..."
    dest="$1"; shift
    if [ "$JSON_BIN" = python3 ]; then
      args=$(python3 - "$dest" "$@" <<'PY'
import json, sys
print(json.dumps({"dest_dir": sys.argv[1], "paths": sys.argv[2:]}, ensure_ascii=False))
PY
)
    else
      args=$(/opt/homebrew/bin/node - "$dest" "$@" <<'JS'
const a = process.argv.slice(2);
console.log(JSON.stringify({dest_dir: a[0], paths: a.slice(1)}));
JS
)
    fi
    mcpcall baidu_move "$args" ;;
  delete)
    [ $# -ge 1 ] || die "usage: baidupan.sh delete <path>..."
    if [ "$JSON_BIN" = python3 ]; then
      args=$(python3 - "$@" <<'PY'
import json, sys
print(json.dumps({"paths": sys.argv[1:]}, ensure_ascii=False))
PY
)
    else
      args=$(/opt/homebrew/bin/node -e '
console.log(JSON.stringify({paths: process.argv.slice(2)}));' "$@")
    fi
    mcpcall baidu_delete "$args" ;;
  share)
    [ $# -ge 1 ] || die "usage: baidupan.sh share <path> [pwd] [days]"
    p="$1"
    if [ "$JSON_BIN" = python3 ]; then
      args=$(python3 - "$@" <<'PY'
import json, sys
a = sys.argv[1:]
d = {"path": a[0]}
if len(a) > 1: d["pwd"] = a[1]
if len(a) > 2: d["period_days"] = int(a[2])
print(json.dumps(d, ensure_ascii=False))
PY
)
    else
      args=$(/opt/homebrew/bin/node -e '
const a = process.argv.slice(2); const d = {path: a[0]};
if (a.length > 1) d.pwd = a[1];
if (a.length > 2) d.period_days = parseInt(a[2]);
console.log(JSON.stringify(d));' "$@")
    fi
    mcpcall baidu_create_share "$args" ;;
  help|-h|--help) usage ;;
  *) die "unknown command: $cmd (see baidupan.sh help)" ;;
esac
