---
name: larkit
description: >
  Feishu/Lark full-stack development and reverse-engineering with a local truth engine. Use when the
  task involves Feishu/Lark official docs, cards (卡片/JSON 2.0/chart_spec/card_link), messages,
  bots or event subscriptions, WebSocket long connections, app creation and publishing in the
  developer console (open.feishu.cn/app), permission scopes, tenant_access_token, OpenAPI probing,
  client private protocol commands (PUT_MESSAGE/PUSH_MESSAGES/2020 commands), protobuf schemas,
  hidden fields, error codes (99991672/9499), or reading reverse-engineered web/Electron client code.
  Provides MCP tools `lark_doc`, `lark_truth_search`, `lark_truth_inspect`, `lark_auth`,
  `lark_console`, `lark_probe` and the equivalent `larkit` CLI.
---

# Larkit — Feishu full-stack truth engine

Larkit answers Feishu questions from **evidence**, not guesses: 4800+ official docs, 2020 client
protocol commands, 237k code anchors from the web/Electron client, and a `verified_truths`
knowledge base that grows as you verify things. It can also create/configure/publish real apps in
the developer console and send real API/protocol probes.

## 1. Preflight (do this once per session)

```bash
larkit status --json          # fastest: truth.db? code corpus? skill? MCP config?
larkit doctor                 # auth profiles, tokens, Chrome, install state
```

- `truth.installed=false` → have the user run `npx larkit` (or `larkit init`).
- `code.installed=false` → the truth pack is half-extracted; rerun `larkit init` (the code corpus
  ships in the same archive, there is nothing optional to add).
- If the MCP tools are not mounted, use the CLI equivalents in `references/tools.md`; they return
  the same JSON.

Never invent Feishu behavior when the truth engine or the official docs can answer it.

## 2. Route the question

| User asks | Start with | Then |
| --- | --- | --- |
| "Is card field X supported?" / card JSON 2.0 | `lark_truth_search(scope="verified")` | `lark_doc search` → `read` → code anchors |
| "What does this error code mean?" | `lark_truth_search(scope="all")` | doc error-code pages → `lark_probe` |
| "Create a bot that receives events over WebSocket" | `references/playbooks.md` §B | `lark_auth` → `lark_console` → `lark_probe` |
| "Why does this OpenAPI call fail?" | `lark_probe(mode="openapi")` | read `code/msg/log_id`, then scope/CSRF checks |
| "What is command N / PUT_MESSAGE?" | `lark_truth_search(scope="protocol")` | `read_slice` on protocol docs or client code |
| "Show me the client implementation" | search `scope="web"`/`"electron"` | `read_slice` with `mode="function"` |
| "Configure/publish an app" | `lark_console` (`dry_run` first) | `references/console.md` |
| "Log me in / switch account" | `lark_auth(action="list")` | `check` → QR login → `check` |
| "Set up larkit / install the skill" | §6 below | |

Full playbooks: `references/playbooks.md`. Console API recipes and failure matrix:
`references/console.md`. Tool/CLI/env reference: `references/tools.md`.

## 3. Token discipline (hard rules)

1. **Always try `scope="verified"` first.** If a prior conclusion exists, stop there.
2. `limit <= 10`; results contain coordinates + a 320-char snippet, not whole files.
3. Never read a formatted client file end-to-end. `search` → `read_slice`.
4. `read_slice`: prefer `mode="function"`, `max_lines <= 120`.
5. Docs: `lark_doc search` → `read` with `offset/limit`; use returned `headings` to jump.
6. Probes: `GET` before `POST`; `dry_run=true` before every console write; `wait_push=true` for
   listener-only protocol commands.
7. `save_verified` only with evidence (probe output/log_id, doc URL, `file:line`). No secrets,
   cookies or tokens in the knowledge base.
8. Never echo credentials or auth headers back to the user.

## 4. Standard loop

```
lark_auth check
  → lark_truth_search(scope=verified)
  → lark_doc search/read
  → lark_truth_search(scope=protocol|web|electron)
  → lark_truth_inspect(read_slice)
  → lark_probe(openapi|client)
  → lark_truth_inspect(save_verified)
  → lark_console(dry_run → apply)
  → lark_probe re-verify
```

Stop as soon as the answer is certain. Each step exists only to cover the previous step's gap.

## 5. Evidence boundaries

- Desktop client main process is a native binary (`feishu`/`libiron`); the corpus covers renderer,
  preload, JSSDK, worker and protocol assets, not native main-process logic.
- `read_slice` paths are relative to `formatted/` (web/electron) or `verified_truths/`.
- i18n bundles are not indexed; search specific keys if needed.
- Feishu internal console APIs and private protocol routes drift between client versions. Record
  what you verified, with the client/doc version, in `verified_truths`.
- Official doc endpoints and console APIs are rate-limited; back off instead of retrying blindly.

## 6. Installing / repairing larkit (when the user asks)

```bash
npx larkit                     # init on first run, status afterwards
npx larkit init --channel      # (re)install from the official truth channel
npx larkit init --pack=<manifest.json|dir|.tar.gz>   # offline / pinned install
npx larkit init --from-assets --deb=./feishu-linux.deb --web-dump=./feishu-web-dump
# ↑ 构建资产不随包分发，需自备 deb + web dump；常规安装用上面两条命令即可
npx larkit status              # verify truth.db / skill / CLI / MCP
npx larkit update              # refresh outdated pieces
npx larkit skills install      # reinstall the agent skill
npx larkit pack verify <manifest.json>   # maintainers: verify a truth pack
```

Layout: `~/.larkit/{data/truth.db, verified_truths, cli, install.json, mcp.json}`. The MCP client
config is written to `~/.larkit/mcp.json`; the skill lands in existing agent skill directories
(`~/.agents/skills/larkit`, `~/.claude/skills/larkit`) or `--target=`/`--project`.

## 7. When a tool fails

| Symptom | Action |
| --- | --- |
| `truth.db not found` | `npx larkit` (or `larkit init`) |
| `file not found: formatted/...` | `larkit init` (corpus ships with the truth pack) |
| `needs_login` / `9499` | `lark_auth(action="login")` then poll `login_status`; or `import` cookies |
| `99991672` | missing scope → `lark_console grant_scopes` → re-probe |
| `command: N not found` | re-check cmd/kind with `lark_truth_search(scope="protocol")` |
| `PullFeedGroups invalid request` | read operations belong on OpenAPI, not the private gateway |
| MCP tool missing | use the CLI (`larkit search/inspect/doc/console/probe`) |
