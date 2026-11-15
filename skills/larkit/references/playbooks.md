# Playbooks

Each playbook is a closed loop: evidence → action → verification → `save_verified`.
Load only the one that matches the task.

## A. Card field / hidden property support (e.g. `chart_spec`, `card_link`, `streaming_mode`)

1. `lark_truth_search({query:"chart_spec", scope:"verified"})`
   - Hit in `verified_truths/card-json-2.0-official.md` → read that section and stop.
2. Miss → official docs:
   - `lark_doc({action:"search", query:"卡片 JSON 2.0"})`
   - `lark_doc({action:"read", path, limit:120})`, jump with `offset` from `headings`.
3. Docs ambiguous → client code:
   - `lark_truth_search({query:"chart_spec", scope:"all"})`
   - `lark_truth_inspect({action:"read_slice", file_path, line_number, mode:"function", max_lines:80})`
4. Need server truth → `lark_probe({mode:"openapi", method:"POST", path:"/im/v1/messages", body:{...}})`
   or `PATCH /open-apis/im/v1/messages/:message_id` to update a card; inspect `code/msg`.
5. Persist:
   ```
   lark_truth_inspect({
     action:"save_verified",
     topic:"卡片 chart_spec 的 media 行为",
     content:"## 结论 ...\n## 最小 JSON ...",
     evidence:"doc URL + probe log_id/response",
     source:"doc|probe",
     confidence:"high"
   })
   ```

Note: `chart_spec` is **not** present in the current desktop/Web code; only the official docs
describe it. Do not claim a code location you have not seen.

## B. Create a bot that receives events over WebSocket (from zero)

### B1. Auth

```
lark_auth({action:"check", profile:"geren"})
```

- `needs_login` → `lark_auth({action:"login", name:"geren"})`, then poll
  `lark_auth({action:"login_status", name:"geren"})` and show the user `qr_path`.
- Headless/import path: `lark_auth({action:"import", name:"geren", cookie:"..."})`.
- `lark_auth list` to find a non-expired profile. Do not use stale `tapeless-*` profiles.

### B2. Create the app (dry-run first)

```
lark_console({action:"create_app", profile:"geren", name:"my-agent-app", desc:"...", dry_run:true})
```

Review the plan, then run without `dry_run`. Capture `app_id` (`cli_xxx`).

### B3. Credentials

```
lark_console({action:"get_credentials", app_id:"cli_xxx", profile:"geren"})
```

Store in `larkit.config.json` / env vars, never in `verified_truths`.

### B4. Scopes

```
lark_console({action:"list_scopes", app_id:"cli_xxx", profile:"geren"})
lark_console({action:"grant_scopes", app_id:"cli_xxx",
  scopes:["im:message","im:chat:readonly","im:message:send_as_bot"],
  scope_type:"app", dry_run:true})
```

Check `resolved.missing` is empty before applying.

### B5. Robot + event/card WebSocket

```
lark_console({action:"enable_bot_ws", app_id:"cli_xxx", profile:"geren", dry_run:true})
lark_console({action:"enable_bot_ws", app_id:"cli_xxx", profile:"geren"})
```

It performs three writes:

- `/developers/v1/robot/switch/:id` → `{enable:true}`
- `/developers/v1/event/switch/:id` → `{eventMode:4}`
- `/developers/v1/callback/switch/:id` → `{callbackMode:4}`

Verification must show `bot_enabled=true, event_mode=4, callback_mode=4`.
`robot.cardCallbackMode` is the card request-address mode (1=Webhook), **not** the long-connection
switch. Do not send `callbackMode:4` to `/v2/robot/push_mode/switch` (returns `ParamInvalid`).

### B6. Publish

```
lark_console({action:"publish", app_id:"cli_xxx", version:"1.0.0",
  remark:"agent bootstrap", full_release:false, dry_run:true})
```

Apply after reviewing. `commit.code=0` means submitted; `list_versions` confirms status.

### B7. Probe

```
lark_probe({mode:"openapi", app_id:"cli_xxx", app_secret:"...",
  method:"GET", path:"/im/v1/chats", query:{page_size:1}})
```

`code:0` = credentials + scope OK. `99991672` = missing scope (back to B4). `9499` = CSRF/login
(back to B1).

### B8. Persist

```
lark_truth_inspect({action:"save_verified", topic:"my-agent-app 的长连接配置",
  content:"## 结论\napp_id=... eventMode=4 / callbackMode=4 ...",
  evidence:"enable_bot_ws verification=...; probe log_id=...",
  source:"console", confidence:"high"})
```

## C. Verify an undocumented API / error code

1. `lark_truth_search({query:"99991672", scope:"all"})` (or the path/field).
2. `lark_doc` for permission/error-code pages.
3. Send the minimal request:
   ```
   lark_probe({mode:"openapi", app_id, app_secret, method:"POST",
     path:"/open-apis/...", query:{...}, body:{...}})
   ```
   Keep `status/code/msg/log_id/body` verbatim. Do not retry dozens of times; read `msg` to
   distinguish permission vs parameter vs route errors.
4. Not an OpenAPI capability → search the private protocol:
   `lark_truth_search({query:"COMMAND_OR_ENDPOINT", scope:"protocol"})`.
5. `lark_probe({mode:"client", command:"...", transport:"gateway"|"ws", profile})`.
6. Save conclusion + evidence.

## D. Reverse-engineer the private client protocol

1. `lark_truth_search({query:"PUT_MESSAGE", scope:"protocol"})`
   → `cmd=5`, `messages.PutMessageRequest`, schema summary.
2. Field details:
   - `lark_truth_search({query:"PutMessageRequest", scope:"protocol", limit:5})`
   - or read `src/protocol/data/reference/PROTOCOL.md`.
3. Client implementation evidence:
   ```
   lark_truth_search({query:"PUT_MESSAGE", scope:"electron"})
   lark_truth_inspect({action:"read_slice", file_path, line_number, mode:"function", max_lines:100})
   ```
4. Send:
   ```
   lark_probe({mode:"client", command:"PUT_MESSAGE", transport:"gateway",
     profile:"geren", payload:{...}})
   ```
   - Writes go through `gateway`; pushes/signals through `ws`.
   - `PUSH_MESSAGES` is listen-only: `wait_push:true`, never send it.
   - `GET_CHAT_MESSAGES` over the gateway returns `PullFeedGroups invalid request`; use OpenAPI for reads.
5. Save new commands/fields/boundaries.

## E. Inspect the developer console / capture a new internal API

Use `lark_console action=browser_fallback` only when the HTTP recipes are insufficient:

```
lark_console({
  action:"browser_fallback",
  profile:"geren",
  url:"https://open.feishu.cn/app",
  wait_ms:3000,
  actions:[
    {type:"click_text", text:"创建应用"},
    {type:"fill", fields:[{placeholder:"应用名称", value:"my-app"}]}
  ],
  screenshot:true,
  record_as:"create_app"
})
```

Returns `network[]` (sanitized headers/body shape), `recipes_recorded`, `needs_login`,
`screenshot_path`. Add stable paths to `src/console/client.js` `DEFAULT_RECIPES`, then reproduce
over plain HTTP.
