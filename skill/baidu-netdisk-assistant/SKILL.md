---
name: baidu-netdisk-assistant
version: 2.2.0
description: "百度云盘助手：百度网盘（Baidu Netdisk）的本地集成、安装与操作。可自动安装/更新 skill、向 macOS 客户端注入 Bridge，并查看登录态与配额、浏览/搜索云端文件、上传、下载、新建文件夹、重命名、移动、删除（进回收站）、创建分享链接、查询上传下载队列。当用户提到安装/更新百度网盘 skill 或 Bridge，以及百度网盘、百度云盘、网盘、云盘、pan.baidu.com、上传/下载/整理/分享云盘文件时使用。"
metadata:
  requires:
    bins: ["curl", "python3"]
  cliHelp: "baidupan.sh help"
---

# 百度云盘助手（baidu-netdisk-assistant）

通过本地百度网盘 macOS 客户端内注入的 MCP bridge，操作当前登录账号的网盘文件。
所有操作经由本 skill 的 CLI 脚本完成：

```bash
~/.agents/skills/baidu-netdisk-assistant/scripts/baidupan.sh <command> [args...]
```

（下文简写为 `baidupan.sh`）

## 安装或更新 Bridge

当用户要求安装、更新、重新注入，或客户端运行但 Bridge 无响应时，使用：

```bash
~/.agents/skills/baidu-netdisk-assistant/scripts/baidupan.sh install --yes
```

安装器会依次执行：

1. 检查 macOS 和 `/Applications/BaiduNetdisk_mac.app`（可用 `--app PATH` 覆盖）。
2. 优先使用当前仓库源码；独立安装的 skill 会从
   `https://github.com/tbruceyu/baidupan-agent-bridge.git` 获取最新源码。
3. 正常退出正在运行的客户端，校验版本与 asar 布局，备份原始 asar。
4. 注入并 ad-hoc 重签名客户端，同时禁用会覆盖注入的自动更新。
5. 安装/更新 `~/.agents/skills/baidu-netdisk-assistant` 及其他 agent 的符号链接。
6. 重新启动客户端并运行只读 `status` 验证。

此操作会修改已安装的应用、退出正在运行的客户端并禁用客户端自动更新，属于
需要用户明确同意的操作。用户已经明确要求安装/更新时可传 `--yes`；否则先说明
这些影响并取得确认。不要在可能有传输任务进行时擅自退出客户端。其他选项：

```bash
baidupan.sh install --help
baidupan.sh install --yes --no-launch
baidupan.sh install --yes --app /path/to/BaiduNetdisk_mac.app
```

我们主推 skill；原生 MCP 注册是可选项，不是安装的必要步骤。

## 使用前提（重要）

1. **客户端必须运行且已登录**。正常启动已安装的客户端即可
   （如 `open /Applications/BaiduNetdisk_mac.app`，或从启动台/Spotlight 打开）。
   启动后 bridge 约 5 秒内就绪（监听 `127.0.0.1:8765`）。
2. 用 `baidupan.sh status` 验证：能返回登录态/配额即说明当前运行的是
   注入后的客户端；连接失败时脚本会给出明确提示（未运行 / 未注入）。
3. Token 位于 `~/Library/Application Support/baidunetdisk/agent-bridge-token`，
   脚本自动读取，无需手动传。

## 命令一览

| 命令 | 说明 |
|---|---|
| `install [options]` | 安装/更新 Bridge 与 skill；用 `install --help` 查看选项 |
| `status` | 登录态 / 账号信息 / 配额 |
| `quota` | 存储配额 |
| `list [dir] [start] [limit]` | 列目录，默认 `/` 0 100 |
| `search <key> [dir]` | 关键字搜索（默认根目录） |
| `download <remote> [local]` | 下载文件，默认存 `~/Downloads/baidupan-mcp/<文件名>` |
| `upload <local> [remote_dir]` | 上传本地文件（入原生上传队列，支持秒传/断点） |
| `transfers` | 上传/下载队列计数（running/waiting/paused/failed） |
| `mkdir <path>` | 新建目录（父目录必须已存在） |
| `rename <path> <new_name>` | 重命名（new_name 为不含斜杠的纯文件名） |
| `move <dest_dir> <path>...` | 把一个或多个路径移入目标目录 |
| `delete <path>...` | 删除（进入云盘回收站，可恢复） |
| `share <path> [pwd] [days]` | 创建分享链接，返回链接 + 提取码；pwd 缺省随机生成 |

## 使用示例

```bash
baidupan.sh status
baidupan.sh list /docs
baidupan.sh search 入户申请表
baidupan.sh download /入户申请表1789881381.pdf ~/Desktop/
baidupan.sh upload ~/Desktop/photo.jpg /来自：iPhone
baidupan.sh transfers                        # 上传是异步的，用它确认完成
baidupan.sh mkdir /工作备份/2026
baidupan.sh rename /工作备份/旧名.txt 新名.txt
baidupan.sh move /工作备份 /a.txt /b.txt     # 把 a.txt、b.txt 移入 /工作备份
baidupan.sh delete /tmp_test_dir
baidupan.sh share /工作备份/报告.pdf         # 或 share <path> abcd 7
```

## 行为要点

- **远程路径**一律以 `/` 开头的绝对路径；中文文件名直接使用，无需转义。
- **上传是异步入队**：命令立即返回 `queued: true`，之后轮询 `transfers`
  或用 `list` 确认文件出现；相同内容的文件会触发秒传（瞬间完成）。
- **下载是同步**的：命令会等下载完成并校验大小后返回。
- **删除进回收站**，不是永久删除；用户要求"彻底删除"时需说明回收站机制。
- **share** 返回 `link` + 提取码 `pwd`（4 位），默认永久有效；传天数参数可设有效期。
- 目录列出的 `count` 是总数，`files` 受 `start/limit` 分页控制。

## 故障排查

| 现象 | 处理 |
|---|---|
| 连接被拒 | 先 `baidupan.sh status` 看提示：客户端没运行就启动它并登录后重试；提示已运行但 Bridge 无响应，说明客户端可能未注入或被升级覆盖，经用户确认后运行 `baidupan.sh install --yes` 重新安装 |
| 提示未登录 | 在客户端 UI 里登录，凭证会自动跟随（30 秒缓存） |
| 上传长时间不动 | 先 `baidupan.sh transfers` 看 failed 计数；本地文件是否被移动 |
| 其他 | 看日志：`~/Library/Application Support/baidunetdisk/agent-bridge.log` |

## 实现说明（维护者参考）

- 底层是注入到客户端主进程的 MCP 服务（Streamable HTTP，Bearer 鉴权）。
  源码与构建脚本见仓库 `agent-bridge/`（注入目标：
  `/Applications/BaiduNetdisk_mac.app`，构建前会校验客户端版本 ≥ 8.9.7）。
- MCP 注册（Claude Code 等原生 MCP 客户端可直接用，与 skill 并行不冲突）：
  ```bash
  claude mcp add --transport http baidupan http://127.0.0.1:8765/mcp \
    --header "Authorization: Bearer $(cat ~/Library/Application\ Support/baidunetdisk/agent-bridge-token)"
  ```
- 客户端自动升级已禁用（`app-update.yml` → `.disabled`）；手动升级/重装客户端后
  需重跑 `agent-bridge/build.sh` 重新注入。
