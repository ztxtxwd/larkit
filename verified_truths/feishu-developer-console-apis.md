---
topic: 飞书开发者后台内部 REST API（Console）
verified_at: 2026-11-15T07:00:00.000Z
source: probe
confidence: high
tags: [console, developer, app, scopes, websocket, publish]
---

## 结论

飞书开发者后台（`https://open.feishu.cn/app`）的内部 API 前缀是
`https://open.feishu.cn/developers`，默认 `POST application/json`，返回
`{ code, msg, data }`。带 Cookie 登录后，还必须带 `x-csrf-token`，其值取自
后台 HTML 的 `window.csrfToken`（88 字符），并且 Cookie 中要有页面响应下发的
`lark_oapi_csrf_token`（44 字符）。只带 `swp_csrf_token` 会返回
`{"code":9499,"msg":"lark_oapi_csrf_token not exist in cookie"}`。

## 应用

```http
POST /developers/v1/app/list
body: {"Count":20,"Cursor":0}
# data.apps[] -> appID/name/ability/version/owner...

POST /developers/v1/app/create
body: {"fromProduct":0,"appSceneType":0,"name":"x","desc":"","avatar":"",
       "primaryLang":"zh_cn","i18n":{"zh_cn":{"name":"x","description":""}}}
# data.ClientID / data.Avatar

POST /developers/v1/app/:clientId
body: {}

POST /developers/v1/secret/:clientId
body: {}
# data.secret

POST /developers/v1/base_info/:clientId
body: {"clientId":"cli_x","name":"new","desc":"...","i18n":{"zh_cn":{"name":"new"}}}
```

## 权限

```http
POST /developers/v1/scope/all/:clientId
body: {"clientId":"cli_x"}
# data.scopes[] {id,name,bizId,status,levels,...}, data.scopeBizs[]

POST /developers/v1/scope/update/:clientId
body: {"clientId":"cli_x","operation":"add","scopeIds":[],
       "appScopeIDs":["20001"],"userScopeIDs":[]}
```

`im:message` 的 scope id 是 `20001`（实测）。批量开通时按 scope 名称从
`scope/all` 解析 id，再放入 `appScopeIDs`（应用身份）或 `userScopeIDs`（用户身份）。

## 机器人 / 事件 / 卡片回调（长连接）

```http
POST /developers/v1/robot/:clientId          # data.enable, data.cardCallbackMode
POST /developers/v1/robot/switch/:clientId   # {"clientId":"cli_x","enable":true}

POST /developers/v1/event/:clientId          # data.eventMode; 4 = WebSocket
POST /developers/v1/event/switch/:clientId   # {"clientId":"cli_x","eventMode":4}

POST /developers/v1/callback/:clientId       # data.callbackMode; 4 = WebSocket
POST /developers/v1/callback/switch/:clientId# {"clientId":"cli_x","callbackMode":4}
```

- `eventMode=4` 与 `callbackMode=4` 即事件订阅/卡片回调的 WebSocket 长连接模式。
- `robot.cardCallbackMode` 是卡片请求地址模式（1=Webhook），不是长连接开关；
  不要把它当成 `callbackMode`。实测向 `/v2/robot/push_mode/switch/:clientId`
  传 `callbackMode:4` 会返回 `ParamInvalid`。

## 版本与发布

```http
POST /developers/v1/app_version/list/:clientId
body: {"clientId":"cli_x"}
# data.versions[] {versionId,appVersion,versionStatus,publishTime,...}

POST /developers/v1/app_version/create/:clientId
body: {"clientId":"cli_x","appVersion":"1.0.0","updateRemark":"...",
       "visibleSuggest":{},"changeLog":"..."}
# data.versionId

POST /developers/v1/publish/commit/:clientId/:versionId
body: {"clientId":"cli_x","versionId":"...","is_full_release":false}

POST /developers/v1/publish/release/:clientId/:versionId
body: {"clientId":"cli_x","versionId":"...","is_full_release":false}
```

## 证据

- 2026-11-15 使用 `geren` profile 实测：`POST /developers/v1/app/list` 返回 `code:0`，15 个应用。
- 创建测试应用 `larkit-e2e-20261115` -> `cli_aa73eb66fcb89cf4`，返回 `code:0`。
- `POST /developers/v1/secret/:clientId` 返回 32 字符 secret。
- `switch_robot` / `switch_event` / `switch_callback` 均返回 `code:0`；
  复查 `eventMode=4`、`callbackMode=4`。
- `scope/update` 添加 `im:message` 返回 `code:0`。
- `app_version/create` + `publish/commit` 返回 `code:0`，版本 `1.0.0` 进入提交状态。
- 浏览器兜底实测捕获到 `/developers/v1/tenant_app/auth_info/get`、
  `/developers/v1/message/unread_list` 等真实请求，并写入
  `.larkit-data/console-api-recipes.json`。
