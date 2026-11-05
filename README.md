# Baidu Netdisk Agent Bridge

在百度网盘 macOS 客户端（Electron）主进程内注入的 Agent 控制服务，
让 Agent（Claude Code 或其他）直接操作已登录账号的网盘文件。

> ⚠️ 本仓库只包含注入方案（bridge 源码、构建/恢复脚本、skill），
> **不包含百度网盘客户端本体**（专有软件且超过 GitHub 单文件上限）。
> 使用前请自行安装官方客户端，然后运行 `build.sh` 完成注入。

## 组成

| 目录 | 说明 |
|---|---|
| `agent-bridge/` | 注入模块源码 + 一键构建/回滚脚本（v2.1.0，仅适配客户端 [8.9.7](https://a2087d-2029999431.antpcdn.com:19001/b/pkg-ant.baidu.com/issue/netdisk/MACguanjia/8.9.7/BaiduNetdisk_mac_8.9.7_arm64.dmg)） |
| `skill/baidu-netdisk-assistant/` | **百度云盘助手** Agent Skill / CLI 封装层（任何 agent 可用，不限于 Claude Code） |

`build.sh` 会把“百度云盘助手”skill 安装到跨 agent 的标准目录
`~/.agents/skills/baidu-netdisk-assistant/`，并为 Claude Code、Gemini CLI、Cursor 和
OpenCode 建立各自 skill 目录下的符号链接。**推荐使用 skill**；MCP 接入仍然支持，
适合希望直接注册原生 MCP 工具的客户端。安装后的 skill 也内置安装器，客户端升级、
重装或注入失效后可让 agent 运行 `baidupan.sh install --yes` 自动重新注入并验证。

## 快速开始

```bash
# 1) 确认官方客户端已安装在 /Applications/BaiduNetdisk_mac.app（8.9.7+，
#    build.sh 会先校验版本与 asar 布局再注入）
# 2) 注入并自动安装 skill（会自动备份原始 asar 到 backup/）
cd agent-bridge && ./build.sh

# 3) 启动客户端并登录
open /Applications/BaiduNetdisk_mac.app

# 4) 推荐：任何兼容 Agent Skills 的 agent 直接使用 skill/CLI
~/.agents/skills/baidu-netdisk-assistant/scripts/baidupan.sh status

# 可选：也可以为原生 MCP 客户端安装 MCP 配置
claude mcp add --transport http baidupan http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer $(cat ~/Library/Application\ Support/baidunetdisk/agent-bridge-token)"
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
