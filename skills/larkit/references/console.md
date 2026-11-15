# Developer console (`open.feishu.cn/app`) — recipes and failure matrix

## Session / CSRF

- Read the active profile from `~/.larkit/credentials.json`.
- Open `https://open.feishu.cn/app`, extract `window.csrfToken`, and merge response cookies
  (`lark_oapi_csrf_token`, `sl_session`).
- Headers: `Cookie`, `x-csrf-token`, `Origin`, `Referer`, `User-Agent`, `X-Timezone-Offset`.
- `swp_csrf_token` alone → `9499 lark_oapi_csrf_token not exist in cookie`.
- Mismatched header token → `9499 csrf token check fail`.

## Internal HTTP recipes

| Capability | Method / path | Key body |
| --- | --- | --- |
| App list | `POST /developers/v1/app/list` | `{Count,Cursor}` |
| Create app | `POST /developers/v1/app/create` | `{name,desc,avatar,primaryLang,i18n,appSceneType}` |
| App detail | `POST /developers/v1/app/:clientId` | `{}` |
| Credentials | `POST /developers/v1/secret/:clientId` | `{}` → `data.secret` |
| Update info | `POST /developers/v1/base_info/:clientId` | `{name,desc,i18n,avatar,languages}` |
| All scopes | `POST /developers/v1/scope/all/:clientId` | `{clientId}` |
| Apply scopes | `POST /developers/v1/scope/update/:clientId` | `{operation:"add",scopeIds:[],appScopeIDs:[...]}` |
| Robot state | `POST /developers/v1/robot/:clientId` | `{clientId}` |
| Enable robot | `POST /developers/v1/robot/switch/:clientId` | `{enable:true}` |
| Event mode | `POST /developers/v1/event/switch/:clientId` | `{eventMode:4}` |
| Card callback mode | `POST /developers/v1/callback/switch/:clientId` | `{callbackMode:4}` |
| Version list | `POST /developers/v1/app_version/list/:clientId` | `{clientId}` |
| Create version | `POST /developers/v1/app_version/create/:clientId` | `{appVersion,updateRemark,visibleSuggest,changeLog}` |
| Commit release | `POST /developers/v1/publish/commit/:clientId/:versionId` | `{is_full_release}` |
| Release | `POST /developers/v1/publish/release/:clientId/:versionId` | `{is_full_release}` |

`eventMode=4` and `callbackMode=4` mean WebSocket long connection. `robot.cardCallbackMode` is the
card request-address mode (1=Webhook), not the long-connection switch. Sending `callbackMode:4` to
`/v2/robot/push_mode/switch` returns `ParamInvalid`.

## HTTP first, browser fallback second

Use plain HTTP when `lark_console` already has a recipe: milliseconds, dry-runnable, reproducible.
Use `browser_fallback` when:

- the internal endpoint is not covered (avatar upload, complex forms, review flows),
- HTTP returns 9499/403 while the session is known-good,
- you need to capture a new console API shape.

Example:

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

It reuses system Chrome (`CHROME_PATH`) with the larkit cookie and records `/developers/` +
`/open-apis/` requests (sanitized headers, body shape, status) into
`<data>/console-api-recipes.json`. Promote stable paths into `src/console/client.js`
`DEFAULT_RECIPES`, then reproduce via `lark_console` HTTP.

## Failure matrix

| Symptom | Cause | Fix |
| --- | --- | --- |
| `9499 lark_oapi_csrf_token not exist in cookie` | only `swp_csrf_token` sent | re-resolve session (`lark_auth check`), merge Set-Cookie |
| `9499 csrf token check fail` | header/page/cookie token mismatch | use page `window.csrfToken` + `lark_oapi_csrf_token` |
| `99991672` | app lacks scope | `grant_scopes` then re-probe |
| WS `timeout waiting for cmd=6` | push command was sent instead of listened | use `wait_push:true` |
| Gateway `PullFeedGroups invalid request` | read command not routed on the gateway | use OpenAPI for reads |
| `command: N not found` | wrong command id/name or wrong transport | re-check via `lark_truth_search(scope=protocol)` |
| `ParamInvalid` on `/v2/robot/push_mode/switch` | `callbackMode:4` misuse | use `/v1/callback/switch` |
| `truth.db not found` | no truth source installed | `npx larkit` / `larkit init` |
| `file not found` in `read_slice` | code corpus missing | `larkit init` |
| `needs_login` from browser fallback | cookie expired | `lark_auth login` |

## Evidence rules for console work

- Writes have real side effects (apps, versions, releases). Always dry-run first.
- Record `app_id`, action, `code`, `msg`, and verification fields in `save_verified`.
- Never persist credentials, tokens, or full auth headers.
