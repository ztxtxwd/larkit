---
topic: 卡片 JSON 2.0 全局结构与 chart_spec
verified_at: 2026-11-15T00:00:00.000Z
source: doc
confidence: high
tags: [card, json2.0, chart_spec, card_link]
---

## 结论

飞书卡片 JSON 2.0 通过顶层 `"schema": "2.0"` 声明；全局字段包括 `config`、`card_link`、`header`、`body`。
图表组件位于 `body.elements[]`，`tag` 为 `"chart"`，其图表定义字段名为 `chart_spec`（VChart spec）。
平台会对 `chart_spec` 自动追加媒体查询；在 `chart_spec` 中设置 `"media": []` 可禁用默认追加。

## card_link 结构

```json
{
  "card_link": {
    "url": "https://www.example.com",
    "android_url": "https://developer.android.com/",
    "ios_url": "https://developer.apple.com/",
    "pc_url": "https://www.windows.com"
  }
}
```

## chart 组件骨架

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      {
        "tag": "chart",
        "element_id": "custom_id",
        "aspect_ratio": "16:9",
        "color_theme": "brand",
        "chart_spec": {
          "type": "bar",
          "data": [{ "x": "A", "y": 1 }],
          "media": []
        }
      }
    ]
  }
}
```

## 证据

- 卡片 JSON 2.0 结构：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure
- 图表组件（含 `chart_spec` 说明）：https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/chart
- 通过 `document_portal/v1/document/get_detail?fullPath=...` 读取官方正文，确认 `chart_spec` 与 `card_link` 字段存在。
