---
topic: 客户端 WS / gateway 探针实测边界
verified_at: 2026-11-15T07:05:00.000Z
source: probe
confidence: high
tags: [client, websocket, gateway, probe]
---

## 结论

- `connect()` 用网页版 Cookie（必须含 `passport_web_did`）可以建立
  `wss://msg-frontier.feishu.cn/ws/v2` 长连接；实测收到 `cmd=7001`
  （`device.PushDeviceOnlineStatus`）与 `cmd=7017`
  （`device.PushDeviceNetworkAccessEvent`），protobuf 能解出业务字段。
- `PUSH_MESSAGES(6)` 是推送命令，不应主动发送；发送会收到
  `packet.status=200, sid="command: 6 not found"`。探针应使用
  `wait_push=true` 只监听。
- 客户端 pb 网关 `POST https://internal-api-lark-api.feishu.cn/im/gateway/`
  可以发送请求命令并解回 `improto.Packet`。读命令 `GET_CHAT_MESSAGES(1020)`
  实测返回 HTTP 400，`sid="PullFeedGroups invalid request"`，说明读消息不在
  这个网关路由；读消息走开放 API 或网页版另一条 HTTP 通道。
- 官方 OpenAPI 探针可用应用凭据换 `tenant_access_token`，再请求
  `/open-apis/im/v1/chats`；有权限时返回 `code:0`，无权限时返回真实错误码
  （如 `99991672`），适合验证隐藏字段与权限边界。

## 证据

- `lark_probe(mode=client, command=PUSH_MESSAGES, transport=ws, wait_push=true)`
  -> `handshake=true`，events 含 7001/7017 解码结果。
- `lark_probe(mode=client, command=GET_CHAT_MESSAGES, transport=gateway)`
  -> HTTP 400，decoded packet sid `PullFeedGroups invalid request`。
- `lark_probe(mode=openapi, path=/im/v1/chats)` -> token 换取成功，返回真实
  `code/msg/log_id`。
