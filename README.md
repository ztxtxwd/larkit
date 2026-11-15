# larkit

飞书全栈「真相」引擎与一站式 Agent 开发工具包：**官方文档 + 客户端/网页端逆向代码 + 开发者后台全生命周期 + 真实发包探针 + 活体知识库**，统一为一个 MCP Server 和一套 CLI。

目标：Agent 挂载 `larkit` 后，不需要人类切终端或手动开浏览器，即可完成：

```
查官方文档 -> 查逆向源码/私有协议 -> 创建/配置/发布飞书应用
           -> 发真实 API / 长连接探针验证 -> 沉淀 verified_truths
```

---

## 0. 安装（用户）

```bash
npx larkit
```

首次运行会在这台机器上完成四件事，并把状态写入 `~/.larkit/install.json`：

| 步骤 | 产物 |
| --- | --- |
| 真相源 | `~/.larkit/data/truth.db`（SQLite FTS5：2020 条命令 / 23.7 万条锚点 / verified 章节） |
| Agent skill | `~/.agents/skills/larkit` 和/或 `~/.claude/skills/larkit`（`SKILL.md` + `references/`） |
| CLI | `~/.larkit/cli` 持久安装 + `~/.local/bin/larkit` shim（不需要 sudo） |
| MCP | `~/.larkit/mcp.json`（stdio server 配置，可粘贴到任意 MCP 客户端） |

之后直接用 `larkit ...`。再次运行 `npx larkit` 显示状态；`larkit init` 可幂等重跑。
升级到新版本用 `npx larkit@latest update`（或 `npm i -g larkit`）。

### 真相源

**只有一个包**：`larkit-truth-full-<tag>.tar.gz`，约 161 MB，里面是 `truth.db` + `verified_truths/` +
`formatted/` 代码语料。**没有可选组件** —— 装上就有搜索、文档、协议、后台、探针、`save_verified`，
以及 `read_slice` 按行号读客户端代码的能力。

- npm 包本身只有 **1.2 MB**（没有任何内嵌数据）。首次运行从固定 API
  `https://larkit.tapeless.eu.org/v1/truth/latest` 读取当前版本，下载那一个归档，sha256 校验 + 断点续传；
- 之后每次命令启动都会读一次同一个 URL（6 小时一次），**发现新版本自动更新**，不需要重新发 npm 包；
- 完全离线/内网：`larkit init --pack=<manifest.json|pack-dir|.tar.gz>` 从本地文件安装；
- 维护者重建真相源（需要 Linux + deb + web dump，约 10 分钟）：
  ```bash
  larkit init --from-assets --deb=./feishu-linux.deb --web-dump=./feishu-web-dump
  ```

`--pack=<manifest.json|目录|.tar.gz|https://...>` 可指定任意 truth pack；`LARKIT_PACK_MANIFEST` 可设置默认源。

### 常用命令

```bash
larkit status            # 安装 / 索引状态（--check 顺带查上游新版）
larkit update            # 检查并刷新真相源 / skill / CLI
larkit init --channel    # 采纳官方真相源通道（默认就是这个）
larkit skills list       # 已安装 skill
larkit mcp config        # 输出 MCP 客户端配置
larkit doctor            # 认证 / 探针 / 环境自检
```

### 本机目录

```
~/.larkit/
├── data/truth.db         # 真相库
├── data/formatted/       # 代码语料（随真相源整包安装）
├── verified_truths/      # 活体知识（用户可写）
├── cli/                  # 持久 CLI 安装（npm prefix）
├── install.json          # 初始化状态
├── mcp.json              # MCP 配置
├── config.json           # profile / 应用凭据（用户级）
└── credentials.json      # 登录态
```

用户级 `~/.larkit/config.json` 会被项目目录的 `larkit.config.json` 覆盖。仓库开发态继续使用 `./.larkit-data` 与 `./verified_truths`，`pnpm index` / `pnpm verify` 行为不变。

---

## 1. 目录结构

```
larkit/
├── bin/
│   ├── larkit.js              # CLI 入口（init/status/search/inspect/...）
│   └── larkit-mcp.js          # MCP stdio server
├── src/
│   ├── bootstrap/             # npx larkit 初始化：pack 下载/校验/tar、skill、CLI、状态
│   ├── indexer/               # deb/asar 解包、Prettier 格式化、锚点扫描、FTS5 建库
│   ├── truth/                 # truth.db 查询、read_slice、save_verified
│   ├── docs/                  # 4800+ 官方文档检索/读取（自有实现，复用公开接口路径）
│   ├── console/               # 开发者后台 HTTP 控制器 + CDP 浏览器兜底/抓包
│   ├── probe/                 # OpenAPI 探针 + 客户端私有协议探针（自有 protobuf/WS）
│   ├── protocol/              # descriptor 解析、protobufjs registry、WS/gateway、命令数据快照
│   ├── mcp/                   # 6 个聚合 MCP 工具
│   ├── auth/                  # 自有 ~/.larkit cookie/profile 存储 + QR 登录 + 导入
│   └── shared/                # 路径、配置、工具函数
├── skills/larkit/             # 可安装 Agent skill（SKILL.md + references/）
├── workers/truth-api/         # 真相源 API（Cloudflare Worker：/v1/truth/latest）
├── .github/workflows/         # release.yml（只发 1.2 MB 的 lean 包）
├── scripts/
│   ├── build-index.mjs        # Phase 1 构建管线
│   ├── publish-pack.mjs       # 真相源打包上传 R2（tag 注册表 + 不可变守卫）
│   ├── verify-bootstrap.mjs   # init/pack/skill 端到端验证
│   ├── verify-index.mjs       # 索引/查询验证
│   ├── verify-mcp.mjs         # JSON-RPC 模拟 tools/list + tools/call
│   ├── verify-console.mjs     # 后台/凭据/探针验证
│   ├── login-worker.mjs       # detached QR 登录 worker
│   └── check-syntax.mjs
├── verified_truths/           # 活体知识库（Markdown，自动索引）
├── .larkit-data/              # 仓库开发态生成物（gitignore）
│   ├── raw/                   # deb 解包、web/electron 索引、anchors.jsonl
│   ├── extracted/electron/    # asar/loose JS 抽取
│   ├── formatted/             # 多行格式化代码（web + electron）
│   ├── truth.db               # SQLite FTS5 真相库
│   ├── cache/                 # 文档、token、截图、登录日志
│   └── console-api-recipes.json
├── larkit.config.example.json
├── package.json
└── README.md
```

---

## 2. 快速开始

### 用户：一条命令

```bash
npx larkit                  # 首次：下载真相源整包（161 MB）+ skill + CLI + MCP 配置
npx larkit status           # 之后：查看状态（--check 查上游新版）
```

### 仓库开发态

```bash
cd /root/code/larkit
pnpm install

# Phase 1：解包 + 格式化 + 锚点 + 协议目录 + FTS5 建库（仓库内 .larkit-data）
pnpm index

# 验证
pnpm verify                 # verify-index + verify-mcp
pnpm verify:bootstrap       # tar/pack/init/skill/status 端到端

# 环境自检
node bin/larkit.js doctor
```

首次构建会解包 338 MB 的 `feishu-linux.deb`，格式化 9000+ 个 JS/CSS 文件，并生成约 286 MB 的 `truth.db`。后续重跑会命中内容哈希缓存。

### 构建 truth pack（发布/私有分发）

```bash
# 单个归档：truth.db + verified_truths + formatted/（约 161 MB，解压 923 MB）
node bin/larkit.js pack build --out=dist/truth-pack --tag=2026.11.15 \
  --base-url=https://larkit.tapeless.eu.org

node bin/larkit.js pack verify dist/truth-pack/manifest.json
```

清单格式：只有一个 `tiers.full`（`file` / `bytes` / `sha256` / `url` / `unpackedBytes` / `codeFiles`），
外层带 `packVersion`（真相源自己的不可变 tag）与 `larkitVersion`（兼容信息）。
客户端按 sha256 校验、断点续传、原子落盘。

### 实测构建规模

| 项 | 数值 |
| --- | --- |
| Web 去重资源 | **531** 个（`summary.json` 索引；514 个唯一 sha1） |
| Electron loose | 1016 个 JS/CSS/JSON |
| Electron asar | 7516 个（messenger / main-window / messenger-modals / space / setting / search / resource / lark-api / jssdk-mf / js-worker / shared-libs） |
| 格式化输出 | 9063 个文件，约 **647 MB**，1470 万行 |
| 协议命令 | **2020** 条（request 1665 / push 350 / control 5） |
| 代码锚点 | **237,729** 条 |
| 已验证知识 | `verified_truths/` 自动同步（12 个章节 / 3 个知识文件） |

> 桌面客户端没有单一大 `app.asar`：主进程是原生 `feishu` + `libiron`，窗口代码在 `webcontent/*.asar`。`larkit` 抽取了 `resource.asar/js/*`（最接近 preload/bootstrap）以及所有非 i18n 的核心渲染 chunk。详见 `.larkit-data/extracted/electron/README.md`。

---

## 3. MCP Server 启动配置

`larkit-mcp` 通过 **stdio** 提供 6 个聚合工具，不额外监听端口。`larkit init` 会写好
`~/.larkit/mcp.json`；`larkit mcp config` 可随时打印：

```bash
larkit mcp config
```

```json
{
  "mcpServers": {
    "larkit": {
      "command": "/home/you/.local/bin/larkit-mcp",
      "args": [],
      "env": {
        "LARKIT_HOME": "/home/you/.larkit"
      }
    }
  }
}
```

把这段 JSON 放进 Claude Code / Cursor / 任意 MCP 客户端即可。仓库开发态可以用：

```json
{
  "mcpServers": {
    "larkit": {
      "command": "node",
      "args": ["/root/code/larkit/bin/larkit-mcp.js"],
      "env": {
        "LARKIT_DATA_DIR": "/root/code/larkit/.larkit-data"
      }
    }
  }
}
```

### 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `LARKIT_HOME` | 覆盖 `~/.larkit`（data、verified_truths、CLI、skill 记录） |
| `LARKIT_DATA_DIR` | 覆盖 `truth.db` / `formatted` / `cache` 位置 |
| `LARKIT_VERIFIED_DIR` | 覆盖可写的 `verified_truths` 目录 |
| `LARKIT_PACK_MANIFEST` | 默认 truth pack 清单（URL 或本地路径） |
| `LARKIT_DEB` / `LARKIT_WEB_DUMP` | `init --from-assets` 的本地输入 |
| `LARKIT_BIN_DIR` | `larkit` shim 目录（默认 `~/.local/bin`） |
| `LARKIT_PROFILE` | 默认 profile（优先级低于显式参数、高于配置文件） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 默认探针应用凭据 |
| `CHROME_PATH` | `browser_fallback` 使用的 Chrome |
| `LARKIT_GATEWAY_HEADERS` | 额外客户端网关请求头（JSON） |

配置优先级：`<data>/config.json` < `~/.larkit/config.json` < `./larkit.config.json`。项目配置可复制 `larkit.config.example.json`，该文件已加入 `.gitignore`。`lark_auth action=use` 会更新 larkit 的活跃 profile 与 `defaultProfile`。

---

## 4. 六个 MCP 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| **`lark_doc`** | 4800+ 官方文档检索/读取，零配置 | `action: search\|read\|categories`, `query`, `category`, `path`, `offset`, `limit` |
| **`lark_truth_search`** | 查 `verified_truths`、2020 命令/Schema、协议笔记、Web/Electron 代码锚点 | `query`, `scope: all\|verified\|protocol\|web\|electron`, `limit` |
| **`lark_truth_inspect`** | 按文件:行号读取局部代码，或把验证结论写入 `verified_truths` 并同步 SQLite | `action: read_slice\|save_verified`, `file_path`, `line_number`, `mode`, `max_lines`, `topic`, `content` |
| **`lark_auth`** | 自有认证：whoami/check/list/use/cookie/login/login_status/import/logout | `action`, `profile`, `cookie`, `file` |
| **`lark_console`** | 开发者后台：应用列表/创建、凭据、改信息、权限、机器人+事件/卡片长连接、发布、浏览器兜底 | `action`, `app_id`, `dry_run`, `scopes`, `version`, `actions` |
| **`lark_probe`** | 真实发包：OpenAPI（自动 tenant token）或客户端私有协议（WS/网关） | `mode: openapi\|client`, `path`, `body`, `command`, `transport`, `profile` |

工具设计目标是 **渐进式披露**：搜索只返回坐标 + 摘要；读代码最多 120 行；不会把单行混淆代码直接丢给模型。

---

## 5. CLI

```bash
# 初始化 / 状态 / 更新
npx larkit
larkit init [--pack=...] [--channel[=<url>]] [--from-assets --deb=... --web-dump=...]
larkit init --only=truth,skill,cli,mcp [--dry-run] [--json]
larkit status [--json] [--check]        --check: 对比已安装真相源与通道最新版
larkit update [--channel[=<url>]]     --channel: 采纳官方真相源通道（R2）
larkit skills list|install|remove [--target=agents,claude,project] [--project] [--force]
larkit pack build|verify|path|stats [--tag=<tag>] [--base-url=...]
larkit mcp config

# 索引
node bin/larkit.js index
node bin/larkit.js index --only=anchors,db
node bin/larkit.js index --force

# 真相检索
node bin/larkit.js search chart_spec --limit 5
node bin/larkit.js search PUT_MESSAGE --scope protocol
node bin/larkit.js search card_link --scope electron

# 局部代码（行号来自 search）
node bin/larkit.js inspect electron/asar/messenger/35983/f7adb73684.js 8145 \
  --context 2 --max-lines 20

# 保存活体知识
node bin/larkit.js save "某个隐藏字段" --content "## 结论..." \
  --evidence "probe: ..." --source probe --confidence high

# 官方文档
node bin/larkit.js doc search 图表 --limit 5
node bin/larkit.js doc read "/uAjLw4CM/.../chart" --limit 80

# 认证
node bin/larkit.js auth list
node bin/larkit.js auth check --profile geren
node bin/larkit.js auth login geren          # detached QR worker
node bin/larkit.js auth login_status geren   # read qr_path from status
node bin/larkit.js auth import --name geren --file /tmp/cookies.json

# 开发者后台
node bin/larkit.js console list_apps --profile geren --limit 10
node bin/larkit.js console get_credentials --app cli_xxx --profile geren
node bin/larkit.js console grant_scopes --app cli_xxx --scopes im:message --dry-run
node bin/larkit.js console enable_bot_ws --app cli_xxx --profile geren
node bin/larkit.js console publish --app cli_xxx --version 1.0.0 --remark "..." --profile geren

# 探针
node bin/larkit.js probe openapi --path /im/v1/chats --app-id cli_xxx --app-secret xxx
node bin/larkit.js probe client --command PUSH_MESSAGES --wait-push --timeout 8000
node bin/larkit.js probe client --command GET_CHAT_MESSAGES --transport gateway

# 其他
node bin/larkit.js doctor
node bin/larkit.js mcp
```

所有命令输出 JSON，方便管道和 Agent 解析。

---

## 6. Phase 1：离线资产与真相索引

> 以下路径描述**仓库开发态**（`.larkit-data/`、`verified_truths/`）。用户安装态对应 `~/.larkit/data/` 与 `~/.larkit/verified_truths/`，内容结构相同。

### 6.1 Web 资源去重与格式化

- 以 `feishu-web-dump/summary.json` 的 **531 条** 记录为准，不扫描 `debugger/`、`stylesheet/`、`network/` 的重复副本。
- 输出到 `.larkit-data/formatted/web/<kind>/...`。
- Prettier 3 为主；超大文件用 `js-beautify` 兜底；内容哈希去重（247 个别名直接复用格式化结果）。
- 每个文件都是多行缩进代码，`line_number` 具有精确切片意义。

### 6.2 Electron 解包

- 构建管线直接从 `feishu-linux.deb` 读取 `pb.desc` / `pb_server.desc`，由 larkit 自有 descriptor parser 生成 `schema.json`（实测 V7.72.23）。
- `dpkg-deb -x` 解包到 `.larkit-data/raw/deb-root`。
- 抽取 `webcontent/*.asar` 的非 i18n JS/CSS/JSON 到 `.larkit-data/extracted/electron/asar/...`。
- 同时保留 `webcontent/jssdk/`、`js-worker/`、`openplatform/`、`lark-api/` 等 loose 资源。
- 不含 `app.asar`/`package.json`；主进程为原生二进制。`resource.asar/js/*` 是 preload/bootstrap 的最接近证据。

### 6.3 `truth.db`（`node:sqlite` + FTS5）

表：

| 表 | 内容 |
| --- | --- |
| `protocol_catalog` + FTS | 2020 条客户端命令：cmd/name/requestType/responseType/schema 摘要 |
| `code_anchors` + FTS | web/electron 代码锚点：API 路径、URL、IPC 通道、`tt.*`/`h5sdk.*`/`LarkAPI.*`、卡片字段、错误码、i18n key、协议常量、命令名 |
| `verified_truths` + FTS | `verified_truths/*.md` 的章节级索引 |
| `protocol_docs` + FTS | `PROTOCOL.md` 章节 + `endpoints.json` 顶层键 |
| `meta` | 构建统计 |

锚点示例：

```json
{
  "scope": "electron",
  "file_path": "electron/asar/messenger/35983/f7adb73684.js",
  "line_number": 8145,
  "anchor_type": "card_schema_key",
  "literal_value": "card_link",
  "context_snippet": "(i.Markdown = \"markdown\"), (i.CardLink = \"card_link\"),"
}
```

查询性能实测（本机）：

| 查询 | 结果 | 耗时 |
| --- | --- | --- |
| `chart_spec` | verified_truths 章节 | **8.5 ms** |
| `card_link` | electron 代码锚点 | **1.8 ms** |
| `PUT_MESSAGE` | protocol cmd=5 + 代码 | **3.3 ms** |
| `PUSH_MESSAGES` | protocol cmd=6 + 代码 | **2.2 ms** |

`chart_spec` 在当前客户端代码中未出现，因此由官方卡片文档的 `verified_truths/card-json-2.0-official.md` 提供精确出处；`card_link` 在 Electron 代码与官方文档中均有命中。

---

## 7. Phase 2：开发者后台控制器

### 7.1 凭据与 CSRF

- 读取 `~/.larkit/credentials.json` 的活跃/指定 profile；不再调用外部 CLI。
- 打开 `https://open.feishu.cn/app`，从 HTML 提取 `window.csrfToken`，并合并响应下发的 `lark_oapi_csrf_token` / `sl_session`。
- 请求头：`Cookie` + `x-csrf-token` + `Origin/Referer/User-Agent/X-Timezone-Offset`。
- 仅带 `swp_csrf_token` 会得到 `9499 lark_oapi_csrf_token not exist in cookie`；token 不匹配会得到 `9499 csrf token check fail`。

### 7.2 已固化的后台内部 API

| 能力 | 方法 / 路径 | 关键 body |
| --- | --- | --- |
| 应用列表 | `POST /developers/v1/app/list` | `{Count,Cursor}` |
| 创建应用 | `POST /developers/v1/app/create` | `{name,desc,avatar,primaryLang,i18n,appSceneType}` |
| 应用详情 | `POST /developers/v1/app/:clientId` | `{}` |
| 应用凭据 | `POST /developers/v1/secret/:clientId` | `{}` → `data.secret` |
| 改信息 | `POST /developers/v1/base_info/:clientId` | `{name,desc,i18n,avatar,languages}` |
| 全部权限 | `POST /developers/v1/scope/all/:clientId` | `{clientId}` |
| 批量开通 | `POST /developers/v1/scope/update/:clientId` | `{operation:"add",scopeIds:[],appScopeIDs:[...]}` |
| 机器人状态 | `POST /developers/v1/robot/:clientId` | `{clientId}` |
| 开机器人 | `POST /developers/v1/robot/switch/:clientId` | `{enable:true}` |
| 事件模式 | `POST /developers/v1/event/switch/:clientId` | `{eventMode:4}` |
| 卡片回调模式 | `POST /developers/v1/callback/switch/:clientId` | `{callbackMode:4}` |
| 版本列表 | `POST /developers/v1/app_version/list/:clientId` | `{clientId}` |
| 创建版本 | `POST /developers/v1/app_version/create/:clientId` | `{appVersion,updateRemark,visibleSuggest,changeLog}` |
| 提交发布 | `POST /developers/v1/publish/commit/:clientId/:versionId` | `{is_full_release}` |
| 发布 | `POST /developers/v1/publish/release/:clientId/:versionId` | `{is_full_release}` |

> `eventMode=4` / `callbackMode=4` = WebSocket 长连接。`robot.cardCallbackMode` 是卡片请求地址模式（1=Webhook），**不是**长连接开关；向 `/v2/robot/push_mode/switch` 传 `callbackMode:4` 实测返回 `ParamInvalid`。

### 7.3 浏览器兜底与自动录制

`lark_console action=browser_fallback`：

- 复用系统 Chrome + `puppeteer-core` + larkit Cookie。
- 打开指定后台页面，支持 `click_text`、`fill`、`wait_for_text`、`evaluate`、截图。
- CDP Network 层拦截 `/developers/` 与 `/open-apis/` 请求，记录 method/path/headers（脱敏）/body shape/status。
- 自动写入 `.larkit-data/console-api-recipes.json`，后续 `lark_console` 可直接复用毫秒级 HTTP 路径。

实测：打开 `https://open.feishu.cn/app`，4 秒内捕获 `/napi/check/login`、`/developers/v1/tenant_app/auth_info/get`、`/developers/v1/message/unread_list` 等真实请求并落盘。

### 7.4 端到端实测

在 `geren` profile 上完成：

1. `create_app` → 创建 `larkit-e2e-20261115`（`cli_aa73eb66fcb89cf4`），`code:0`。
2. `get_credentials` → 返回 32 字符 secret。
3. `enable_bot_ws` → `switch_robot` / `switch_event(eventMode=4)` / `switch_callback(callbackMode=4)` 全部 `code:0`。
4. `grant_scopes(['im:message'])` → `code:0`（scope id 20001）。
5. `publish` → 创建版本 `1.0.0` + `publish/commit`，`code:0`。

`verified_truths/feishu-developer-console-apis.md` 记录了完整证据。

---

## 8. Phase 3：实时探针

### 8.1 OpenAPI 探针

```json
{
  "mode": "openapi",
  "app_id": "cli_xxx",
  "app_secret": "xxx",
  "method": "GET",
  "path": "/im/v1/chats",
  "query": { "page_size": 1 }
}
```

- 自动换取并缓存 `tenant_access_token`（`.larkit-data/cache/tokens.json`，提前 60 秒过期）。
- 返回 `status/code/msg/log_id/data/body/elapsed_ms`。
- 适合探测隐藏卡片字段、未公开接口边界、权限错误码（如 `99991672`）。

### 8.2 客户端私有协议探针

```json
{
  "mode": "client",
  "command": "PUSH_MESSAGES",
  "transport": "ws",
  "profile": "geren",
  "wait_push": true,
  "timeout": 8000
}
```

- 使用 larkit 自有的 descriptor 解析、protobufjs registry、WS/gateway 传输和 2020 命令数据快照。
- `ws`：cookie 建连 `wss://msg-frontier.feishu.cn/ws/v2`，解 gzip 帧、ACK、protobuf → JSON。
- `gateway`：`POST internal-api-lark-api.feishu.cn/im/gateway/`，`X-Command` + `improto.Packet`。
- 推送命令自动只监听不发送（发送 `PUSH_MESSAGES` 会得到 `command: 6 not found`）。
- 读消息命令在网关实测返回 `PullFeedGroups invalid request`，读操作请走 OpenAPI。

`verified_truths/client-ws-gateway-boundaries.md` 记录了边界。

---

## 9. 省 Token 铁律

1. **先 `scope=verified`**：命中已沉淀结论时，不要再去翻代码/文档。
2. **搜索只取坐标**：`lark_truth_search` 默认 `limit=10`，每条只带 320 字符上下文。
3. **读代码切片**：`lark_truth_inspect(action=read_slice)` 默认 12 行上下文，`max_lines<=120`；优先 `mode=function`。
4. **不要整文件读取** 14M 行的格式化语料；用 `search` → `inspect`。
5. **文档先 search 再 read**：`read` 大文档默认只回 120 行 + 标题索引 + 本地路径。
6. **探针只发最小请求**：能 `GET` 不 `POST`；能 `dry_run` 先 `dry_run`；客户端推送用 `wait_push`。
7. **结论沉淀**：验证成功后立刻 `save_verified`，下次优先命中。

完整 Agent SOP 见 [`skills/larkit/SKILL.md`](./skills/larkit/SKILL.md)（`npx larkit` 会自动安装到本机 agent skill 目录）。

---

## 10. 安全与限制

- Cookie/secret 只存在本机 `~/.larkit/credentials.json`、`larkit.config.json` 或环境变量；`console-api-recipes.json` 对 Cookie/Authorization/CSRF 做了脱敏。
- `lark_console` 的写操作默认没有二次确认；先 `dry_run=true`，确认 plan 后再执行。创建应用/发布版本会产生真实副作用。
- `browser_fallback` 可以执行 `evaluate`，属于本地高权限能力；只对可信页面使用。
- 桌面端没有 `app.asar`，主进程逻辑不在 JS 中；`larkit` 覆盖的是渲染层/preload/协议资产。
- 格式化时跳过 `i18n` 目录和 >15 MB 的 loose 文件；这些不是协议/卡片逻辑的主要证据。
- `truth.db` 由 `node:sqlite` 构建，Node 会打印 `ExperimentalWarning`；不影响功能。
- `~/.larkit` 会以 0700 权限创建；truth pack 下载走 sha256 校验，tar 解压拒绝绝对路径、`..` 和 symlink 穿越。
- `--from-assets` 会把 `dpkg-deb` 解包结果写入数据目录；请只在可信的客户端安装包上使用。

---

## 11. 刷新与重建

```bash
# 用户：刷新真相源 / skill / CLI（只更新过期部分）
larkit update
larkit init --channel                       # 采纳官方通道（记住后 update 自动跟进）
larkit init --pack=<new-manifest-url>       # 切到指定 truth pack（钉版本）

# 维护者：客户端升级后重新解包/格式化/建库
node scripts/build-index.mjs --force
node scripts/build-index.mjs --only=protocol,db
node scripts/build-index.mjs --only=anchors,protocol,db

# 打一个真相源整包（tag 是真相源自己的版本号），然后发布到 R2
node bin/larkit.js pack build --out=dist/truth-pack --tag=2026.11.15 \
  --base-url=https://larkit.tapeless.eu.org
node scripts/publish-pack.mjs --pack-dir=dist/truth-pack --bucket=larkit-truth \
  --base-url=https://larkit.tapeless.eu.org

# 新增 verified_truths 后增量同步（MCP save_verified 会自动做）
node bin/larkit.js save "topic" --content "..." --evidence "..."
```

---

## 12. 五个原始资产（仅作参考/物证）

> **当前状态**：这五个资产只在开发期使用，2026-11-15 已从工作目录清理、不入库。需要重建 `truth.db`（§3 路线 3）或复核证据时再自行准备：`feishu-cli` / `openbird` / `feishu-doc-mcp` 从 GitHub 克隆（代码均已推到各自远端），`feishu-linux.deb` 取飞书官网 Linux 客户端 V7.72.23，`feishu-web-dump/` 为开发期抓取的 Web 资源快照（无公开下载源，可用 DevTools 重新抓取）。

> **运行时独立性**：`larkit` 的 `src/`、`bin/`、`scripts/` 不 import / require / spawn `feishu-cli`、`openbird`、`feishu-doc-mcp` 的代码。
> 协议命令目录、descriptor schema、协议笔记作为 **JSON/Markdown 数据快照** 放在 `src/protocol/data/`；`schema.json.gz` 让 `lark_probe(client)` 在没有 deb 的机器上也能启动。
> 这些原始资产**不会进入 npm 包**：用户侧只需内置核心包，或在自备资产时走 `--from-assets`。

| 资产 | 用途 |
| --- | --- |
| `feishu-linux.deb` (338 MB) | 官方 Linux 客户端 V7.72.23；`pb.desc`、`webcontent/*.asar`、jssdk/js-worker 证据源 |
| `feishu-web-dump/` (170 MB) | Web 客户端 531 条去重资源快照；卡片/消息/前端逻辑 |
| `feishu-cli/` (0.2.0) | 参考物证：扫码登录与 Cookie 管理；最终实现改为自有 `~/.larkit` 存储与 QR 登录 |
| `openbird/` (@openbird/sdk 0.2.0) | 参考物证：2020 条命令目录、descriptor 解析、WS/REST 行为；最终实现不 import 其代码 |
| `feishu-doc-mcp/` (1.0.7) | 参考物证：官方文档目录/URI/正文接口；`lark_doc` 为自有实现并做缓存 |

---

## 13. 验证清单

```bash
pnpm check              # JS/MJS 语法检查
pnpm verify:index       # chart_spec/card_link/PUT_MESSAGE/PUSH_MESSAGES <50ms
pnpm verify:mcp         # JSON-RPC initialize + tools/list + 6 个 tools/call
pnpm verify:bootstrap   # tar 长路径 + pack build + init + skill + search/status
pnpm verify:console     # 认证 + 应用列表 + 凭据 + OpenAPI 探针 + dry-run
node bin/larkit.js doctor
```

已验证通过：

- `truth.db`：2020 命令 / 237,729 锚点 / 12 个 verified 章节 / 17 段 protocol docs。
- `chart_spec` 8.5 ms，`card_link` 1.8 ms，`PUT_MESSAGE` 3.3 ms，`PUSH_MESSAGES` 2.2 ms。
- MCP：6 个工具、`lark_truth_search`、`read_slice`、`lark_auth whoami`、`lark_doc search/read`、`lark_console list_apps/get_credentials/dry-run`、`lark_probe openapi/client` 全部跑通。
- 开发者后台：创建应用、取 secret、开机器人/事件/卡片长连接、加权限、发版本均返回 `code:0`。
- 浏览器兜底：CDP 抓包并写入 recipes；无登录态时能返回 `needs_login`。
- 初始化：`npx larkit` 在空 `LARKIT_HOME` 下下载真相源整包（161 MB）+ skill + MCP 配置（约 25 秒）；`pnpm verify:bootstrap` 覆盖 tar 长路径、pack build、init、search/status。

---

## 14. 发布（两条互不依赖的通道）

真相源和 npm 包**分开发布**：

| 通道 | 在哪做 | 频率 | 产物 |
| --- | --- | --- | --- |
| 真相源（truth pack） | 维护者本机 | 想更就更新，一周多次也行 | R2 对象 + `manifest.json` |
| npm 发版 | GitHub Actions | 代码有变化时 | `larkit@x.y.z`（1.2 MB 的 lean 包） |

为什么必须分开：真相源构建需要 **飞书 Linux deb（338 MB）+ 登录态抓的 web dump**（见 §12），
这两样都不适合塞进 runner —— 前者每次都要从 CN CDN 拉、后者需要人类登录态。而 npm 发版只是
「把已发布的真相源重新封装 + `npm publish`」，21 秒量级、零登录态、零 deb。分开之后：

- 真相库可以随时更新，用户 `larkit init --pack=<url>` 或 `larkit update` 即可拿到，不必等 npm 发版；
- npm 发版不需要 3 GB 磁盘、不需要 cookie、不需要 indexer，失败面极小；
- 两边独立回滚：npm 回滚不影响 R2 上的真相源，反之亦然。

### 14.1 真相源（本机）

```bash
# 0. 一次性/按需：重建索引（需要 deb + web dump，见 §3 路线 3）
node bin/larkit.js init --from-assets --deb=./feishu-linux.deb --web-dump=./feishu-web-dump

# 1. 打 truth pack。--tag 是真相源自己的版本号（date / 序号），与 npm 版本解耦。
#    一个归档装下 truth.db + verified_truths + formatted/（约 161 MB）：
#    一个 URL、一个 sha256、一个版本号，自动更新只认它。
node bin/larkit.js pack build \
  --out=dist/truth-pack \
  --tag=2026.11.15 \
  --base-url=https://larkit.tapeless.eu.org

# 2. 上传到 R2（本机，需要 wrangler 凭据）
node scripts/publish-pack.mjs \
  --pack-dir=dist/truth-pack \
  --bucket=larkit-truth \
  --base-url=https://larkit.tapeless.eu.org
```

`publish-pack.mjs` 的行为：

1. 上传前先校验本地 `bytes`/`sha256` 与清单一致，**不一致直接中止**；
2. 读 `index.json`（已发布 tag 注册表），**tag 已存在但字节不同 → 拒绝**（tar.gz 名字带 tag，是永久 URL）；
3. 顺序 `tar.gz → <tag>.json → manifest.json`，客户端永远看不到指向空对象的清单；已发布且 sha 相同的对象直接复用；
4. 上传后回读校验 `content-length`、`Range 206`、`sha256` 和 served manifest 的 tag。

开关：`--dry-run`、`--manifest-only`（tar.gz 已在时只刷新清单）、`--force`（故意重写同名 tag）、
`--prefix=larkit`（放子路径）、`--wrangler="npx wrangler@latest"`。

发布后可用的 URL：

| URL | 内容 |
| --- | --- |
| `https://larkit.tapeless.eu.org/v1/truth/latest` | **固定 API**：当前最新版的清单（含版本号 + 下载链接 + sha256），见 §14.4 |
| `https://larkit.tapeless.eu.org/manifest.json` | 同上，但直接来自 R2（Worker 的数据源） |
| `https://larkit.tapeless.eu.org/2026.11.15.json` | 钉住版本（immutable） |
| `https://larkit.tapeless.eu.org/index.json` | 所有 tag + sha256 + clientVersion |

安装就是「下载一个归档、解包一次」：

| 场景 | 下载 | 落盘 | 实测 |
| --- | --- | --- | --- |
| 首次 `larkit init`（cold） | 161 MB | 923 MB | 24.4 s |
| 从本地归档安装 | 0 | 923 MB | 9.4 s |
| 强制重装（归档已在 downloads 缓存） | 0 | 923 MB | ~10 s |

没有「只要核心」的选项：`formatted/` 和 `truth.db` 在同一个包里，一起装、一起升级。

### 14.2 npm 发版（GitHub Actions）

`.github/workflows/release.yml`，两条触发方式：

- push tag `v*`
- 手动 `workflow_dispatch`（可选 `dist_tag`、`truth_pack`）

包只有一种形态：**lean**，1.2 MB，72 个文件，没有任何内嵌数据。流水线里没有构建步骤：

```yaml
- run: pnpm install --frozen-lockfile
- run: node scripts/check-syntax.mjs
- run: npm pack --dry-run          # 1.2 MB
- run: curl -fsS "$TRUTH_CHANNEL"  # 确认通道上是 full 归档
- run: npm publish --provenance
```

需要配置：`NPM_TOKEN`（或 npm Trusted Publishing + `id-token: write`）；
可选 repo variable `LARKIT_TRUTH_PACK_URL` 覆盖通道地址。

### 14.3 只更新真相源（不发 npm）

这是两个通道分开后最有用的能力：**真相源可以随时更新，npm 包一动不动。**

维护者侧：走完 §14.1 的 `pack build --tag=<新tag>` + `publish-pack.mjs` 就结束了，不用碰
`package.json`、不用发 npm。

用户侧（三种等价入口，任选其一）：

```bash
larkit update --channel        # 采纳官方真相源通道（R2），之后每次 update 自动跟进
larkit init --pack=https://larkit.tapeless.eu.org/manifest.json   # 等价写法
larkit update                  # 已经用过上面的命令后，直接跑这个即可
larkit status --check          # 只检查有没有新版本，不改动任何东西
```

行为约定：

| 项 | 行为 |
| --- | --- |
| 通道记录 | 任何 `http(s)` 的 `--pack`/`--channel` 都会写进 `install.json` 的 `steps.truth.channel`，之后 `larkit update` / `larkit init` 默认沿用 |
| 幂等 | `update` 比对归档 `sha256` 与本地 `packSha`，相同就只打印 `already up to date`，不重新下载 |
| 版本显示 | `larkit status` 现在有两行：`truth pack <tag>` 和 `truth channel <url>` |
| 代码语料 | 和 `truth.db` 同一个包：换真相源就一定换语料，不存在「anchors 和文件对不上」的状态 |
| 没装过的机器 | 没有本地数据可用，**首跑即走通道**；通道不可达时给出 `larkit init --pack=<file>` 的兜底提示 |
| 通道临时不可达（已有数据） | 只打一条 warning（`truth channel unreachable … keeping the local truth`），命令照常执行 |
| 回退 | `larkit init --pack=<旧tag>.json --force=truth` 可钉住/回退到任意已发布 tag |
| 固定入口 | 这一整节不需要记 tag：`--channel` 默认指向 `https://larkit.tapeless.eu.org/v1/truth/latest`（§14.4） |
| 自动更新 | 采纳通道后，**普通命令启动时就会检查并按需自动更新**（6 小时一次，可 `LARKIT_NO_AUTO_UPDATE=1` 关掉） |

为什么用户不装新 npm 也能用：`truth.db` 和 CLI 代码是解耦的 —— 搜索/文档/协议/探针读的是
`truth.db` 的 schema（`PACK_SCHEMA_VERSION = 1`），只要 schema 不变，新的真相源就能被旧 CLI 读。
真到 schema 变更的那次，才需要发一个 npm 版本（此时 `packVersion` 与 `larkitVersion` 都会变）。

### 14.4 真相源 API（Cloudflare Worker）

固定入口，永远返回「当前最新版 + 下载链接」：

```
GET https://larkit.tapeless.eu.org/v1/truth/latest   # 最新清单（= truth pack manifest）
GET https://larkit.tapeless.eu.org/v1/truth/<tag>    # 钉住版本（immutable, 1 年缓存）
GET https://larkit.tapeless.eu.org/v1/truth          # 所有 tag + sha256 + clientVersion
GET https://larkit.tapeless.eu.org/health
```

- 返回体就是 pack 清单（`schemaVersion: 1`），带 `packVersion`、`clientVersion`、`tiers.*.url/bytes/sha256`、
  `api.tag`、`channel`；所以客户端不需要第二套解析逻辑，`larkit` 直接把它当 `--pack` 用。
- `ETag` 是归档的 sha256 前缀，支持 `If-None-Match` → `304`。
- 缓存：`latest` 60 秒（`stale-while-revalidate=600`），钉住版本 1 年 immutable。
- 数据源就是 `publish-pack.mjs` 写的 R2 对象（`manifest.json` / `<tag>.json` / `index.json`），
  Worker 只做读取 + 重写下载域名，**不复制状态、不需要额外发布步骤**。

部署（`workers/truth-api/`）：

```bash
cd workers/truth-api
npx wrangler deploy
# https://larkit-truth-api.<account>.workers.dev   ← 备用入口
# larkit.tapeless.eu.org/v1/*                       ← 首选入口（和下载域名同一个 host）
```

`wrangler.toml` 里只有三样东西：R2 绑定 `TRUTH → larkit-truth`、`PUBLIC_BASE`（归档下载域名）、
`PUBLIC_API`（自己，用于 index 里的链接）。要换 bucket/域名只改这里。

客户端这一侧（`src/bootstrap/channel.js`）：

| 行为 | 规则 |
| --- | --- |
| 启动检查 | 任何命令（`mcp`/`pack`/`index`/`init`/`update`/`status` 除外）启动时读一次 `latest` |
| TTL | 6 小时（`LARKIT_TRUTH_TTL_MS` 可改），期间不重复请求 |
| 超时 | 查询 2.5 s，超时/失败只 warn 一行，命令继续用本地 truth |
| 自动更新 | `latest.sha256 != 已装 packSha` → 下整包装好（truth + 代码语料），然后才执行命令 |
| 关掉 | `LARKIT_NO_AUTO_UPDATE=1` 或 `--no-update`（`CI=true` 时自动关） |
| 钉住版本 | channel 指向 `<tag>.json` 时 sha 恒定 → 永远不会自动更新（回退/复现用） |

实测：`0.1.0` → `2026.11.15` 自动更新 19 s（161 MB 下载 + 装库 + 执行 search），
TTL 内的第二次命令 0.09 s；带 code 的机器 11.2 s（复用 downloads 缓存，只解包）。

### 14.5 托管：Cloudflare R2（一次性配置）

代码语料和 truth pack 都放在 R2：

| 项 | 值 |
| --- | --- |
| bucket | `larkit-truth`（account `6e9b1493…`） |
| 公开域名 | `https://larkit.tapeless.eu.org`（R2 自定义域名，zone `tapeless.eu.org`） |
| 对象 | `larkit-truth-full-<tag>.tar.gz`（161 MB）、`manifest.json`、`<tag>.json`、`index.json` |
| 缓存 | 版本化文件 `immutable`（1 年）；`manifest.json`/`index.json` 60s 重验证 |

为什么是 R2 而不是 GitHub Releases：出网免费（每次安装/自动更新都是 161 MB 流量）、支持 `Range`
断点续传、可挂自定义域名（`objects.githubusercontent.com` 在国内常年不稳）。GitHub 单文件 100 MB
限制也塞不进 git，只能用 Releases。清单里的 `sha256` 是内容寻址校验，托管在哪都不影响完整性。

```bash
npx wrangler login                       # 或 export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npx wrangler r2 bucket create larkit-truth
npx wrangler r2 bucket domain add larkit-truth \
  --domain=larkit.tapeless.eu.org --zone-id=<zone-id> --min-tls=1.2
```

### 14.6 注意事项

- **旧 tag 的 tar.gz 永远不要删**：已发布的 npm 版本、钉住版本的清单都指向那些对象名。
- `pack build --tag=<tag>` 的 tag 是**不可变**的；改了真相库要换新 tag，不要重名。
- npm 包不含任何数据（没有 `prepack`、没有 `assets/truth/`），所以任何「首跑」都需要网络
  或 `--pack=<file>`；内网分发请把 `.tar.gz` + `manifest.json` 一起拷过去。
- 每次自动更新都是整包 161 MB；想省流量就钉住 tag（`--pack=<tag>.json`），sha 恒定即不再更新。
- 老的双 tier 对象（`larkit-truth-core-*` / `larkit-truth-code-*`）连同 `0.1.0.json` 已从 R2 删除，
  `index.json` 里也不再列出。这些 URL 现在由 Worker 直接回 **410 Gone**（tombstone route），
  因为边缘可能还持有 `immutable` 缓存（最长 1 年），光删对象不够。

---

## License

[MIT](./LICENSE) © 2026 赵天雄 (ztxtxwd)。可自由使用、修改、商用，保留版权声明即可。

**使用边界（与许可证无关，是法律/合规层面的提醒）**：本工具包含对飞书 Web / Electron 客户端的
逆向分析产物与协议描述。使用前确认你有权操作目标飞书租户与应用；不要用它绕过任何授权、
访问你无权访问的数据，或将逆向语料用于侵犯他人权利的目的。
