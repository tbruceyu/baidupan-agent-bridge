# Baidu Netdisk Agent Bridge (MCP)

在百度网盘 macOS 客户端（Electron）主进程内注入的本地 MCP 服务，让 Agent（Claude Code 等）
通过已登录的客户端会话直接操作百度网盘文件。

## 组成

- `agent-bridge.js` — 注入模块（零外部依赖），在主进程内启动 MCP Streamable HTTP 服务
- `build.sh` — 备份 → 解包 → 注入 → 重打包 → ad-hoc 重签名，一键完成
- `restore.sh` — 从备份恢复原始 `app.asar`

## 构建

```bash
cd agent-bridge
./build.sh
```

默认注入 `/Applications/BaiduNetdisk_mac.app`（可用 `APP=/path/app` 覆盖）。
脚本会先校验客户端版本（需 ≥ 8.9.7，从 Info.plist 读取）和 asar 布局
（混淆入口 `dist/electron/entry.js`），不匹配则拒绝注入；
已注入过但缺少原始备份时也会拒绝（无法重建干净的 asar）。

构建完成后启动 `/Applications/BaiduNetdisk_mac.app`（必须处于登录状态），
服务监听 `http://127.0.0.1:8765/mcp`。

## Claude Code 接入

```bash
claude mcp add --transport http baidupan http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer $(cat ~/Library/Application\ Support/baidunetdisk/agent-bridge-token)"
```

- Token 首次启动时自动生成，位于 `~/Library/Application Support/baidunetdisk/agent-bridge-token`
- 日志：`~/Library/Application Support/baidunetdisk/agent-bridge.log`（含可直接复制的接入命令）

## 可用工具

| 工具 | 说明 |
|---|---|
| `baidu_status` | 登录态 / 账号信息 / 配额 |
| `baidu_get_quota` | 存储配额 |
| `baidu_list_files` | 列目录（dir/start/limit） |
| `baidu_search_files` | 关键字搜索（key/dir） |
| `baidu_download_file` | 下载到本地（remote_path/local_path，默认存 `~/Downloads/baidupan-mcp/`） |
| `baidu_upload_file` | 上传本地文件（走客户端原生上传队列，local_path/remote_dir） |
| `baidu_transfer_status` | 查询上传/下载任务队列 |
| `baidu_mkdir` | 新建目录 |
| `baidu_rename` | 重命名 |
| `baidu_move` | 移动（paths/dest_dir） |
| `baidu_delete` | 删除（进云盘回收站） |
| `baidu_create_share` | 创建分享链接（返回链接 + 提取码 pwd） |

## 工作原理（v2，适配 8.9.7）

8.9.7 的主进程代码已被 javascript-obfuscator 混淆、app.$xxx 全局对象不复存在，
v2 采用以下方案（12 个工具）：

- 凭证：从 Electron 会话 cookie jar（session.defaultSession 及 Partitions）读取
  .baidu.com 的 BDUSS/BDUSS_BFESS 和 .pan.baidu.com 的 STOKEN，30 秒缓存，
  重新登录后自动跟随最新凭证
- bdstoken：写接口（delete/rename/move 等）需要 bdstoken，通过
  /api/gettemplatevariable 获取并缓存 10 分钟（缺省时接口报 errno 8001）
- 读接口（quota/list/search/filemetas）与写接口（create、filemanager、share）
  用 Node 原生 https 直接请求，携带 cookie + netdisk UA + Referer
- 上传：走客户端原生引擎 —— 直接 koffi 加载
  Contents/Frameworks/libbrowserengine.dylib，调用 browser_engine_upload_files，
  与手动上传共用同一队列/UI/秒传逻辑（xpan precreate 在 web 会话下返回
  errno 9019 need verify，因此上传必须走原生引擎）
- 队列状态：同一 dylib 的 browser_engine_get_task_count
  （输出参数用 koffi.inout 声明以回写计数）
- 下载：/api/filemetas（web 参数）解析 dlink 后 Node https 流式下载并校验大小
- mkdir 走旧版 /api/create?a=commit（xpan creates 在 web 会话下报 31296）
- 状态徽标（v2.1）：主窗口左下角显示 Agent Bridge 状态（绿点 + 账号名 + 传输计数），
  点击展开访问日志面板（最近 200 条，与 agent-bridge.log 同源），再点击收起
- 服务仅绑定 127.0.0.1，校验 Host 头（防 DNS rebinding）、Content-Type（防 CSRF）、
  Bearer Token
- 注入点：混淆后的 dist/electron/entry.js 文件末尾追加 require；
  unpacked 目录集合（@baidu 等 native 模块）见 build.sh

## 注意事项

- 客户端自动更新已禁用（app-update.yml 改名 .disabled），否则更新会覆盖注入；
  手动升级/重装客户端后：把新版 app 放到工程目录，删掉 backup/ 重新执行 ./build.sh
- 未登录时所有工具返回明确提示，登录客户端后即可使用
- 排查问题先看日志：~/Library/Application Support/baidunetdisk/agent-bridge.log
