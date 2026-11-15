# larkit 协议笔记（逆向自飞书客户端）

> 从 Linux 客户端 `/opt/bytedance/feishu/webcontent/` 提取。用于 headless 客户端 SDK 开发。

## 1. 传输面总览

```
业务请求 ──┬─ HTTP pb 网关（写操作）── internal-api-lark-api.feishu.cn/im/gateway/
           ├─ WS frontier 长连接（信令/推送）── cookie 认证 connect
           └─ 开放 API（JSON）── open.feishu.cn/open-apis/...（应用/用户 token）
```

## 2. frame / packet 编解码

- **frame**：WS 字节流外层帧（详见 `src/codec/frame.ts`）。
- **packet**：`improto.Packet`
  - 字段：`cmd`(命令号)、`cid`(requestId，网关必填，否则 "extract packet fail")、`payloadType`、`payload`、`status`
  - `payloadType=1(PB2)` 时 `payload` 是业务 protobuf 字节
  - 网关响应是**裸 packet**（不是 frame 包 packet）

## 3. HTTP pb 网关

- `POST https://internal-api-lark-api.feishu.cn/im/gateway/`
- `Content-Type: application/x-protobuf`
- body = `encodePacket({cmd, cid=requestId, payloadType: PB2, payload})`
- 头：`Cookie`(larkit 登录 cookie) + `gatewayHeaders()` 全套（见 endpoints.json）
- 命令级版本：`x-command-version` / `x-web-version`（见 endpoints.json.commandWebVersions）

### 已验证路由
| cmd | 名称 | 结果 |
|---|---|---|
| 5 | PUT_MESSAGE | ✅ 发文本/richText 卡片 |
| 13 | PUT_CHAT | ✅ 建群 |
| 7004/7025/7026 | 卡片相关 | ⚠️ 网关接受，wire 组错时报 "PB payload unmarshal failed" |

### 不路由（读操作）
- 1 MGET_MESSAGES / 7 PULL_CHAT_MESSAGES / 33 PULL_RECENT_CHATS / 1020 GET_CHAT_MESSAGES
- 报 `command: N not found` 或 fallback 到 `PullFeedGroups invalid request`
- **结论：读消息走开放 API 或网页版另一个 HTTP 通道，不在此 pb 网关**

## 4. WS frontier 长连接

- 实现见 `src/connect.ts`（逆向移植网页版 cookie 认证建连）
- cookie 登录后 connect，绑定 `LarkClient`
- **当前只收信令/设备状态**（7001/7017/6000/1105079），**不收 PUSH_MESSAGES(6)/5053**
- 网页版消息推送走另一条通道（待挖）

## 5. 消息 / 卡片

- `entities.Message.Type`：TEXT=4，CARD=14
- `entities.CardContent.Type`：UNKNOWN=0 / VOTE=1 / TEXT=2 / VCHAT=3 / **OPEN_CARD=4**
- 个人账号 PUT_MESSAGE：type=14 + `Content{cardType, richText}` 可发 richText 元素卡片（BUTTON/MARKDOWN/DIV/...）；open-card(4) 发不了（系统错误）
- 开放 API 发 open-card（schema 2.0）成功；PATCH `/open-apis/im/v1/messages/{om_xxx}` 更新卡片成功

## 6. 卡片交互 actionv2

- 端点：`POST https://internal-api.feishu.cn/lark/card/api/actionv2`（v2_2，cookie 认证）
- body 见 `endpoints.json.actionCardActionV2Body`
- **三个关键参数 `card_id / action_id / refresh_token` 由服务端在卡片消息推送的 `cardEntity` 里下发**
- 推送通道（PUSH_MESSAGES 6）当前 SDK 收不到 → 端到端点击验证待打通读消息链路

## 7. 凭证

- 用户 cookie：`larkit auth cookie`（`~/.larkit/credentials.json`）
- 应用：`cli_aa69ba6ab1389ce2`，tenant_access_token 走 `/open-apis/auth/v3/tenant_access_token/internal`
- 开放 API 读群消息需 scope `im:message.group_msg`（当前未授权）
