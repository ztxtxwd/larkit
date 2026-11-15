import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import {
  ANCHORS_JSONL,
  FORMATTED_DIR,
  RAW_DIR,
} from "../shared/paths.js";
import {
  ensureDir,
  log,
  oneLine,
  relativeTo,
  truncate,
  writeJson,
} from "../shared/util.js";

const CARD_KEYS = new Set(
  `schema config card card_link chart_spec chart_id elements body header
   card_id open_card template_id data_source element_id behaviors action_id
   refresh_token card_entity card_json json_card json_body basic_card i18n
   form form_field table chart column_set interactive_container collapsible_panel
   markdown image_key multi_image_layout person_list overflow date_picker
   time_picker datetime_picker image_picker checker audio video note divider
   button select input placeholder options default_value required disabled
   checked loading repeated fold visibility border corner_radius background font
   text_align weight lines max_lines show_icon icon token direction
   horizontal_spacing vertical_spacing flex_mode row_height freeze_first_column
   page_size pagination page_number page_title total_count current_page records
   series xField yField dataId data_id theme_key colors legend tooltip crosshair
   axes label animation media aspect_ratio color_theme preview streaming
   update_multi summary fallback`
    .split(/\s+/)
    .filter(Boolean),
);

const API_PATH_RE =
  /\/(?:open-apis|space\/api|im\/gateway|internal-api(?:-lark-api)?|lark\/card|document_portal|developers|passport|frontier_ticket|api\/tools|openplatform|im\/v\d|application\/v\d|contact\/v\d|docx\/v\d|sheets\/v\d|bitable\/v\d|calendar\/v\d|task\/v\d|wiki\/v\d|drive\/v\d|approval\/v\d|mail\/v\d|vc\/v\d|aily\/v\d|cardkit\/v\d|baike\/v\d|search\/v\d|tenant\/v\d|ehr\/v\d)\/[A-Za-z0-9_\-./{}$:%?&=+#@~]+/g;
const URL_RE = /https?:\/\/[^\s"'`<>\\]+/g;
const SDK_CALL_RE =
  /\b(?:tt|h5sdk|LarkAPI|ShellAPI)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5}/g;
const QUOTED_KEY_RE = /["']([a-z][a-z0-9_]{2,48})["']\s*:/g;
const QUOTED_VALUE_RE = /["']([a-z][a-z0-9_]{2,48})["']/g;
const BARE_KEY_RE = /\b([a-z][a-z0-9_]{2,48})\s*:/g;
const UPPER_CMD_RE = /\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g;
const ERROR_CODE_RE =
  /\b(?:err(?:or)?_?code|code|status_code|errcode)\s*[:=]\s*["']?(-?\d{3,8})/gi;
const DOTTED_KEY_RE = /["']([A-Za-z][\w-]*(?:\.[\w-]+){2,})["']/g;
const IPC_CHANNEL_RE =
  /\.(?:on|once|send|sendSync|invoke|handle|emit)\(\s*["']([^"']{2,120})["']/g;
const IPC_CONST_RE = /\b([A-Z][A-Z0-9_]{3,})\b/g;

const PROTOCOL_PATTERNS = [
  /X-Command(?:-Version)?/g,
  /improto\.Packet/g,
  /application\/x-protobuf/g,
  /frontier_ticket/g,
  /\/im\/gateway\//g,
  /\/ws\/v2/g,
  /card\.action\.trigger/g,
  /PUSH_MESSAGES|PUT_MESSAGE|PULL_MESSAGES|MGET_MESSAGES/g,
  /cardEntity|card_entity|CardContent|json_card|jsonCard/g,
  /schema\s*2\.0|cardSchema|card_schema/g,
];

const FIELD_NAME_RE =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,5}$/;
const FIELD_HINT_RE =
  /(spec|link|schema|card|element|component|template|entity|payload|action|callback|event|scope|permission|webhook|websocket|long_conn|tenant|token|secret|encrypt|decrypt|chart|table|column|form|input|button|image|text)/;

function cleanLiteral(value) {
  return String(value)
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\\+$/g, "")
    .trim();
}

function addAnchor(anchors, seen, base) {
  const key = `${base.line_number}\u0000${base.anchor_type}\u0000${base.literal_value}`;
  if (seen.has(key)) return;
  seen.add(key);
  anchors.push(base);
}

function contextFor(lines, index) {
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return oneLine(lines.slice(start, end).join(" "), 320);
}

function scanLine(line, lineNumber, lines, anchors, seen) {
  if (!line || line.length < 3) return;
  const text = line.length > 4000 ? line.slice(0, 4000) : line;
  const context = contextFor(lines, lineNumber - 1);

  // API paths and URLs
  for (const match of text.matchAll(API_PATH_RE)) {
    const literal = cleanLiteral(match[0]);
    if (literal.length < 5) continue;
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "api_path",
      literal_value: truncate(literal, 300),
      context_snippet: context,
    });
  }
  for (const match of text.matchAll(URL_RE)) {
    const literal = cleanLiteral(match[0]);
    if (!/(?:feishu|larksuite|larkoffice|feishucdn|bytedance)/i.test(literal)) {
      continue;
    }
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "url",
      literal_value: truncate(literal, 300),
      context_snippet: context,
    });
  }

  // IPC / bridge surface
  if (
    /\b(?:ipcMain|ipcRenderer|contextBridge|ShellAPI\.app\.ipc|LarkAPI\.ipc|\.ipc\.(?:on|send|invoke))\b/.test(
      text,
    )
  ) {
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "ipc",
      literal_value: truncate(oneLine(text, 300), 300),
      context_snippet: context,
    });
    for (const match of text.matchAll(IPC_CHANNEL_RE)) {
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "ipc_channel",
        literal_value: truncate(match[1], 200),
        context_snippet: context,
      });
    }
    // Channels are frequently enum constants, e.g.
    // this.ipc.on(d.$.JS_RUNTIME_IPC_MESSAGE, handler)
    for (const match of text.matchAll(IPC_CONST_RE)) {
      if (!/IPC|RUNTIME|CHANNEL|MESSAGE|BROADCAST/.test(match[1])) continue;
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "ipc_channel",
        literal_value: truncate(match[1], 200),
        context_snippet: context,
      });
    }
  }

  // SDK calls
  for (const match of text.matchAll(SDK_CALL_RE)) {
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "sdk_call",
      literal_value: truncate(match[0], 200),
      context_snippet: context,
    });
  }

  // Card JSON keys (quoted or bare object keys)
  for (const match of text.matchAll(QUOTED_KEY_RE)) {
    const key = match[1];
    if (!CARD_KEYS.has(key)) continue;
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "card_schema_key",
      literal_value: key,
      context_snippet: context,
    });
  }
  for (const match of text.matchAll(BARE_KEY_RE)) {
    const key = match[1];
    if (!CARD_KEYS.has(key)) continue;
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "card_schema_key",
      literal_value: key,
      context_snippet: context,
    });
  }
  // Enum/string values such as e.CardLink = "card_link" or tag = "chart".
  for (const match of text.matchAll(QUOTED_VALUE_RE)) {
    const key = match[1];
    if (!CARD_KEYS.has(key)) continue;
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "card_schema_key",
      literal_value: key,
      context_snippet: context,
    });
  }

  // Hidden/undocumented field names, kept narrow to avoid flooding the index.
  if (FIELD_HINT_RE.test(text)) {
    const keys = new Set();
    for (const match of text.matchAll(QUOTED_KEY_RE)) keys.add(match[1]);
    for (const match of text.matchAll(BARE_KEY_RE)) keys.add(match[1]);
    let count = 0;
    for (const key of keys) {
      if (!FIELD_NAME_RE.test(key) || CARD_KEYS.has(key)) continue;
      if (!FIELD_HINT_RE.test(key)) continue;
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "field_name",
        literal_value: key,
        context_snippet: context,
      });
      if (++count >= 8) break;
    }
  }

  // Error codes
  for (const match of text.matchAll(ERROR_CODE_RE)) {
    addAnchor(anchors, seen, {
      line_number: lineNumber,
      anchor_type: "error_code",
      literal_value: `code=${match[1]}`,
      context_snippet: context,
    });
  }

  // i18n keys
  if (/(?:i18n|locale|intl|useIntl|\bt\()/i.test(text)) {
    let count = 0;
    for (const match of text.matchAll(DOTTED_KEY_RE)) {
      const key = match[1];
      if (key.length < 8 || key.length > 120) continue;
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "i18n_key",
        literal_value: key,
        context_snippet: context,
      });
      if (++count >= 6) break;
    }
  }

  // Protocol constants
  for (const pattern of PROTOCOL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "protocol_literal",
        literal_value: truncate(match[0], 200),
        context_snippet: context,
      });
    }
  }

  // Command names near command-like lines
  if (/(?:cmd|command|Command|method)/.test(text)) {
    let count = 0;
    for (const match of text.matchAll(UPPER_CMD_RE)) {
      addAnchor(anchors, seen, {
        line_number: lineNumber,
        anchor_type: "command_name",
        literal_value: match[1],
        context_snippet: context,
      });
      if (++count >= 4) break;
    }
  }
}

export async function scanAnchors() {
  if (!fs.existsSync(FORMATTED_DIR)) {
    throw new Error(`missing ${FORMATTED_DIR}; run format first`);
  }
  ensureDir(RAW_DIR);
  const out = fs.createWriteStream(ANCHORS_JSONL, { encoding: "utf8" });
  const counts = {};
  const scopeCounts = {};
  let files = 0;
  let anchorsTotal = 0;
  let skipped = 0;

  const stack = [FORMATTED_DIR];
  const fileList = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (![".js", ".css", ".json", ".mjs", ".cjs"].includes(ext)) continue;
        fileList.push(full);
      }
    }
  }
  fileList.sort();

  for (const file of fileList) {
    const rel = relativeTo(FORMATTED_DIR, file);
    const scope = rel.startsWith("web/") ? "web" : "electron";
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size === 0) continue;
      content = fs.readFileSync(file, "utf8");
    } catch {
      skipped++;
      continue;
    }
    if (!content) continue;
    const lines = content.split("\n");
    const anchors = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      scanLine(lines[i], i + 1, lines, anchors, seen);
      if (anchors.length >= 8000) break;
    }
    for (const anchor of anchors) {
      const row = {
        scope,
        file_path: rel,
        line_number: anchor.line_number,
        anchor_type: anchor.anchor_type,
        literal_value: anchor.literal_value,
        context_snippet: anchor.context_snippet,
      };
      if (!out.write(`${JSON.stringify(row)}\n`)) {
        await once(out, "drain");
      }
      counts[anchor.anchor_type] = (counts[anchor.anchor_type] || 0) + 1;
      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      anchorsTotal++;
    }
    files++;
    if (files % 250 === 0) {
      log(
        `[anchors] ${files}/${fileList.length} files, ${anchorsTotal} anchors`,
      );
    }
  }
  out.end();
  await once(out, "close");

  const meta = {
    generatedAt: new Date().toISOString(),
    files,
    skipped,
    anchors: anchorsTotal,
    byType: counts,
    byScope: scopeCounts,
  };
  writeJson(path.join(RAW_DIR, "anchors.meta.json"), meta);
  log(
    `[anchors] scanned ${files} files, ${anchorsTotal} anchors (${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")})`,
  );
  return meta;
}
