# Tool & CLI reference

All MCP tools are also available as CLI commands returning the same JSON. Prefer MCP when it is
mounted; use the CLI for scripts, CI, or when MCP is not configured.

## MCP tools

### `lark_doc` — official documentation (zero config)

| Param | Notes |
| --- | --- |
| `action` | `search` \| `read` \| `categories` |
| `query` | title/path keyword for `search` |
| `category` | taxonomy key, e.g. `服务端 API_即时通讯` |
| `path` | document path returned by `search` |
| `offset` / `limit` | line window for large docs (`limit <= 400`) |

CLI: `larkit doc search 卡片`, `larkit doc read "<path>" --limit 80`, `larkit doc categories`.

### `lark_truth_search` — local truth engine

| Param | Notes |
| --- | --- |
| `query` | keyword, API path, card field, error code, IPC channel, command name |
| `scope` | `all` \| `verified` \| `protocol` \| `web` \| `electron` |
| `limit` | 1–50, default 10 |

Returns compact hits with `kind`, coordinates (`file_path`, `line_number`, `line_start`), a
320-char `context`/`snippet`, and protocol schema summaries. Always start with `scope=verified`.

CLI: `larkit search card_link --scope electron --limit 5`.

### `lark_truth_inspect` — read code / persist knowledge

| Param | Notes |
| --- | --- |
| `action` | `read_slice` \| `save_verified` |
| `file_path` | path from search results (`formatted`-relative or `verified_truths/...`) |
| `line_number` | target line |
| `mode` | `context` \| `function` (function prefers the enclosing body) |
| `max_lines` | default 120, hard cap 200 |
| `topic`, `content`, `evidence`, `source`, `confidence`, `tags` | for `save_verified` |

CLI: `larkit inspect web/network/foo.js 120 --mode=function --max-lines=80`,
`larkit save "topic" --content "..." --evidence "..." --source probe`.

### `lark_auth` — local Feishu identity

Actions: `whoami`, `check`, `list`, `use`, `cookie`, `login`, `login_status`, `import`, `logout`.

- `login` is detached: it returns a status file; `login_status` returns `qr_path` to show the user.
- `import` accepts a cookie string or a JSON file.
- Profiles live in `~/.larkit/credentials.json`; the active profile in `~/.larkit/config.json`.

CLI: `larkit auth check --profile geren`, `larkit auth login geren`, `larkit auth login_status geren`.

### `lark_console` — developer console control

| Action | Purpose |
| --- | --- |
| `list_apps`, `get_app` | inventory |
| `create_app`, `update_app_info` | app lifecycle (`dry_run` supported) |
| `get_credentials` | app_secret (never persist in knowledge files) |
| `list_scopes`, `applied_scopes`, `grant_scopes` | permissions |
| `enable_bot_ws` | robot + event WS + card callback WS |
| `list_versions`, `publish` | versioning/release |
| `browser_fallback` | Chrome + CDP fallback, captures internal APIs |

Always `dry_run:true` first for writes. Full endpoint table: `console.md`.

CLI: `larkit console enable_bot_ws --app cli_xxx --profile geren --dry-run`.

### `lark_probe` — real traffic

`mode="openapi"`:
`app_id`, `app_secret` (or env), `method`, `path`, `query`, `body`, `timeout`.
Automatically obtains/caches `tenant_access_token` (60s early expiry).

`mode="client"`:
`command` (e.g. `PUT_MESSAGE`), `payload`, `transport` (`ws` | `gateway`), `profile`,
`wait_push`, `timeout`. Uses the bundled protobuf schema so it works without the deb.

CLI: `larkit probe openapi --path=/im/v1/chats --app-id=... --app-secret=...`,
`larkit probe client --command=PUSH_MESSAGES --wait-push --timeout=8000`.

## CLI bootstrap commands

```bash
npx larkit                 # init on first run; status afterwards
larkit init                # idempotent bootstrap
larkit status --json
larkit update              # refresh outdated truth/skill/CLI
larkit skills list|install|remove [--target=agents,claude,project] [--project]
larkit pack build|verify|embed|path|stats
larkit doctor
larkit mcp                 # stdio MCP server
larkit mcp config          # print the MCP client JSON
```

## Environment

| Variable | Purpose |
| --- | --- |
| `LARKIT_HOME` | override `~/.larkit` (state, CLI, skill records, downloads) |
| `LARKIT_DATA_DIR` | truth.db + formatted corpus location |
| `LARKIT_VERIFIED_DIR` | writable `verified_truths` directory |
| `LARKIT_PACK_MANIFEST` | default truth pack manifest URL/path |
| `LARKIT_DEB` / `LARKIT_WEB_DUMP` | inputs for `init --from-assets` |
| `LARKIT_BIN_DIR` | where the `larkit` shim is written (default `~/.local/bin`) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | default probe credentials |
| `CHROME_PATH` | Chrome for `browser_fallback` |
| `LARKIT_PROFILE` | default auth profile |
| `LARKIT_GATEWAY_HEADERS` | extra client gateway headers (JSON) |

Config layers: `<data>/config.json` < `~/.larkit/config.json` < `./larkit.config.json`.
