# verified_truths

这里存放**经过实测或逆向确认**的飞书事实。每条结论使用一个 Markdown 文件，建议包含：

```md
---
topic: 卡片 chart_spec 字段
verified_at: 2026-01-01T00:00:00.000Z
source: probe | reverse | doc | console
confidence: high | medium | low
---

## 结论
...

## 证据
- 探针命令 / 文件路径:行号 / 抓包 URL

## 可复用代码
```ts
...
```
```

`larkit` 会把这些文件同步进 `truth.db` 的 `verified_truths` 表（仓库态 `.larkit-data/`，
安装态 `~/.larkit/data/`），`lark_truth_search(scope="verified")` 优先检索这里。

> 约定：不要把未经验证的猜测写进来。猜测请留在 Agent 会话里，用 `lark_probe` 验证后再沉淀。
