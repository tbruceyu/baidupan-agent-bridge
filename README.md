# Baidu Netdisk Agent Bridge

在百度网盘 macOS 客户端（Electron）主进程内注入的 Agent 控制服务，
让 Agent（Claude Code 或其他）直接操作已登录账号的网盘文件。

> ⚠️ 本仓库只包含注入方案（bridge 源码、构建/恢复脚本、skill），
> **不包含百度网盘客户端本体**（专有软件且超过 GitHub 单文件上限）。
> 使用前请自行安装官方客户端，然后运行 `build.sh` 完成注入。

## 组成

| 目录 | 说明 |
|---|---|
| `agent-bridge/` | 注入模块源码 + 一键构建/回滚脚本（v2.1.0，适配客户端 8.9.7+） |
| `skill/baidu-netdisk/` | Agent skill / CLI 封装层（任何 agent 可用，不限于 Claude Code） |

## 快速开始

```bash
# 1) 把官方客户端放进本目录（或把 .app 路径改到 build.sh 中）
# 2) 注入（会自动备份原始 asar 到 backup/）
cd agent-bridge && ./build.sh

# 3) 启动客户端并登录
open ../BaiduNetdisk_mac.app

# 4) Claude Code 接入（MCP）
claude mcp add --transport http baidupan http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer $(cat ~/Library/Application\ Support/baidunetdisk/agent-bridge-token)"

# 或者：任何 agent 走 skill/CLI
~/.agents/skills/baidu-netdisk/scripts/baidupan.sh status
```

## 能力（12 个工具）

`status` / `quota` / `list` / `search` / `download` / `upload` /
`transfers`（队列状态） / `mkdir` / `rename` / `move` / `delete` / `share`

## 工作原理（v2，客户端 8.9.7+）

- 主进程入口为混淆后的 `dist/electron/entry.js`，文件末尾追加 require 注入
- 凭证从 Electron 会话 cookie jar 读取 BDUSS/STOKEN（重新登录自动跟随）
- 写接口携带 bdstoken；读/写接口用 Node 原生 https + netdisk UA
- 上传/队列状态直接 FFI 调用客户端自带的 `libbrowserengine.dylib`
  （与手动上传共用同一队列/UI/秒传逻辑）
- 下载走旧版 `/api/filemetas`（web 参数）解析 dlink 后流式下载并校验大小
- v2.1.0 起在客户端主窗口左下角注入状态徽标（绿点 = 服务存活，
  点击展开访问日志面板；纯 DOM overlay，不改渲染层代码）

## 安全

- 服务仅绑定 `127.0.0.1:8765`，校验 Host 头（防 DNS rebinding）、
  Content-Type（防 CSRF）、Bearer Token（0600 权限文件存储）
- 自动更新已禁用（`app-update.yml` → `.disabled`），防止更新覆盖注入

## 回滚

```bash
cd agent-bridge && ./restore.sh   # 用 backup/ 里的原始 asar 恢复
```

详见 `agent-bridge/README.md`。
