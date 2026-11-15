# Protocol data snapshots

These are **data**, not executable code from the reference projects:

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `commands.json` | 客户端 jssdk worklet 命令注册表（2020 条） | cmd / requestType / responseType / version / name |
| `bundle.json` | 客户端 protobuf bundle（protobufjs JSON root） | 补充原生 desc 缺失的类型 |
| `schema.json.gz` | 由 `bundle.json` + 客户端 `pb.desc` / `pb_server.desc` 合并生成 | 无 deb 运行时的完整 schema 兜底 |
| `constants.json` | 网页版 WS 握手公开常量 | appKey / salt / URL / SDK version |
| `reference/PROTOCOL.md` | 逆向协议笔记 | 协议文档索引 |
| `reference/endpoints.json` | 客户端网关/卡片端点笔记 | 端点与默认请求头 |

`src/protocol/descriptor.js` 是 larkit 自己的 FileDescriptorSet parser；
`src/protocol/schema.js` 负责把上述 JSON 合并成 protobufjs registry。
