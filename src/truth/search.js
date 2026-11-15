import fs from "node:fs";
import path from "node:path";
import {
  FORMATTED_DIR,
  PROTOCOL_REFERENCE_DIR,
  ROOT,
  VERIFIED_DIR,
  displayPath,
} from "../shared/paths.js";
import { safeJoin, truncate } from "../shared/util.js";
import { openTruthDb, syncVerifiedFile } from "../indexer/db.js";
import { buildFtsQuery, normalizeSearchText } from "./fts.js";
import { saveVerifiedTruth } from "./verified.js";

const SCOPES = new Set(["all", "verified", "protocol", "web", "electron"]);

function snippetAround(body, query, max = 320) {
  const text = String(body || "");
  const lower = text.toLowerCase();
  const candidates = [String(query || "").toLowerCase()];
  const normalized = normalizeSearchText(query);
  if (normalized) candidates.push(normalized.split(" ")[0] || "");
  for (const candidate of candidates) {
    if (!candidate) continue;
    const index = lower.indexOf(candidate);
    if (index >= 0) {
      const start = Math.max(0, index - Math.floor(max / 3));
      return truncate(
        text
          .slice(start, start + max)
          .replace(/\s+/g, " ")
          .trim(),
        max,
      );
    }
  }
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function exactCodeAnchors(db, query, scopes, limit) {
  if (!query) return [];
  const placeholders = scopes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, scope, file_path, line_number, anchor_type, literal_value, context_snippet
         FROM code_anchors
        WHERE (literal_value = ? OR file_path = ?)
          AND scope IN (${placeholders})
        ORDER BY CASE WHEN literal_value = ? THEN 0 ELSE 1 END
        LIMIT ?`,
    )
    .all(query, query, ...scopes, query, limit);
  return rows.map((row) => ({
    kind: "code",
    scope: row.scope,
    file_path: row.file_path,
    line_number: Number(row.line_number),
    anchor_type: row.anchor_type,
    literal: row.literal_value,
    context: truncate(row.context_snippet || "", 320),
    score: 0,
    _priority: 1,
    _rank: -1000,
  }));
}

function ftsCodeAnchors(db, ftsQuery, scopes, limit) {
  if (!ftsQuery) return [];
  const placeholders = scopes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id, a.scope, a.file_path, a.line_number, a.anchor_type,
              a.literal_value, a.context_snippet, bm25(code_anchors_fts) AS rank
         FROM code_anchors_fts
         JOIN code_anchors a ON a.id = code_anchors_fts.rowid
        WHERE code_anchors_fts MATCH ?
          AND a.scope IN (${placeholders})
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, ...scopes, limit);
  return rows.map((row) => ({
    kind: "code",
    scope: row.scope,
    file_path: row.file_path,
    line_number: Number(row.line_number),
    anchor_type: row.anchor_type,
    literal: row.literal_value,
    context: truncate(row.context_snippet || "", 320),
    score: Number(row.rank ?? 0),
    _priority: 2,
    _rank: Number(row.rank ?? 0),
  }));
}

function exactProtocol(db, query, limit) {
  if (!query) return [];
  const numeric = /^\d+$/.test(query) ? Number(query) : null;
  const rows = db
    .prepare(
      `SELECT * FROM protocol_catalog
        WHERE cmd = ? OR name = ? OR request_type = ? OR response_type = ?
        LIMIT ?`,
    )
    .all(numeric, query, query, query, limit);
  return rows.map((row) => protocolRow(row, -1000, 0));
}

function ftsProtocol(db, ftsQuery, limit) {
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT p.*, bm25(protocol_catalog_fts) AS rank
         FROM protocol_catalog_fts
         JOIN protocol_catalog p ON p.id = protocol_catalog_fts.rowid
        WHERE protocol_catalog_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, limit);
  return rows.map((row) => protocolRow(row, Number(row.rank ?? 0), 2));
}

function protocolRow(row, rank, priority) {
  return {
    kind: "protocol",
    cmd: row.cmd === null ? null : Number(row.cmd),
    name: row.name,
    request_type: row.request_type,
    response_type: row.response_type,
    command_kind: row.kind,
    version: row.version === null ? null : Number(row.version),
    schema_available: Boolean(row.schema_available),
    source: row.source,
    schema: truncate(row.schema_summary || "", 900),
    score: rank,
    _priority: priority,
    _rank: rank,
  };
}

function exactVerified(db, query, limit) {
  if (!query) return [];
  const rows = db
    .prepare(
      `SELECT * FROM verified_truths
        WHERE topic = ? OR section = ? OR path = ?
        LIMIT ?`,
    )
    .all(query, query, query, limit);
  return rows.map((row) => verifiedRow(row, query, -1000, 0));
}

function ftsVerified(db, ftsQuery, query, limit) {
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT v.*, bm25(verified_fts) AS rank
         FROM verified_fts
         JOIN verified_truths v ON v.id = verified_fts.rowid
        WHERE verified_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, limit);
  return rows.map((row) => verifiedRow(row, query, Number(row.rank ?? 0), 0));
}

function verifiedRow(row, query, rank, priority) {
  return {
    kind: "verified",
    topic: row.topic,
    section: row.section,
    file_path: row.path,
    line_start: Number(row.line_start || 1),
    line_end: Number(row.line_end || 1),
    verified_at: row.verified_at,
    source: row.source,
    confidence: row.confidence,
    snippet: snippetAround(row.body, query, 420),
    score: rank,
    _priority: priority,
    _rank: rank,
  };
}

function exactProtocolDocs(db, query, limit) {
  if (!query) return [];
  const rows = db
    .prepare(
      `SELECT * FROM protocol_docs WHERE title = ? OR path = ? LIMIT ?`,
    )
    .all(query, query, limit);
  return rows.map((row) => protocolDocRow(row, query, -1000, 1));
}

function ftsProtocolDocs(db, ftsQuery, query, limit) {
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT d.*, bm25(protocol_docs_fts) AS rank
         FROM protocol_docs_fts
         JOIN protocol_docs d ON d.id = protocol_docs_fts.rowid
        WHERE protocol_docs_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, limit);
  return rows.map((row) => protocolDocRow(row, query, Number(row.rank ?? 0), 2));
}

function protocolDocRow(row, query, rank, priority) {
  return {
    kind: "protocol_doc",
    title: row.title,
    file_path: row.path,
    line_start: Number(row.line_start || 1),
    line_end: Number(row.line_end || 1),
    snippet: snippetAround(row.body, query, 420),
    score: rank,
    _priority: priority,
    _rank: rank,
  };
}

export function searchTruth({ query, scope = "all", limit = 10 } = {}) {
  if (!query || !String(query).trim()) {
    throw new Error("query is required");
  }
  if (!SCOPES.has(scope)) {
    throw new Error(`invalid scope: ${scope}; expected ${[...SCOPES].join("|")}`);
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const t0 = performance.now();
  const db = openTruthDb({ readonly: true });
  try {
    const wantCode = scope === "all" || scope === "web" || scope === "electron";
    const wantProtocol = scope === "all" || scope === "protocol";
    const wantVerified = scope === "all" || scope === "verified";
    const codeScopes =
      scope === "web" ? ["web"] : scope === "electron" ? ["electron"] : ["web", "electron"];
    // Identifier-like searches (card_link, PUT_MESSAGE, /open-apis/...) are
    // best served by exact anchors.  Running bm25 over the enormous generic
    // "card"/"link" token space is wasteful and can blow the 50ms budget.
    const identifierLike =
      /[_./:\\-]/.test(query) ||
      /^[A-Z0-9_]+$/.test(query) ||
      /^\//.test(query);
    const ftsQuery = buildFtsQuery(query);
    const ftsQueryAnd = buildFtsQuery(query, { conjunction: true });
    const results = [];
    const exactResults = [];

    if (wantVerified) {
      exactResults.push(...exactVerified(db, query, safeLimit));
    }
    if (wantProtocol) {
      exactResults.push(...exactProtocol(db, query, safeLimit));
      exactResults.push(...exactProtocolDocs(db, query, safeLimit));
    }
    if (wantCode) {
      exactResults.push(...exactCodeAnchors(db, query, codeScopes, safeLimit));
    }
    results.push(...exactResults);

    const skipFts = identifierLike && exactResults.length > 0;
    if (!skipFts && identifierLike) {
      // Identifier-like with no exact anchor: use conjunctive FTS.  OR over
      // generic tokens (js/runtime/ipc/message) is expensive and noisy.
      if (wantVerified) {
        results.push(...ftsVerified(db, ftsQueryAnd, query, safeLimit));
      }
      if (wantProtocol) {
        results.push(...ftsProtocol(db, ftsQueryAnd, safeLimit));
        results.push(...ftsProtocolDocs(db, ftsQueryAnd, query, safeLimit));
      }
      if (wantCode) {
        results.push(...ftsCodeAnchors(db, ftsQueryAnd, codeScopes, safeLimit));
      }
    } else if (!skipFts) {
      if (wantVerified) {
        results.push(...ftsVerified(db, ftsQuery, query, safeLimit));
      }
      if (wantProtocol) {
        results.push(...ftsProtocol(db, ftsQuery, safeLimit));
        results.push(...ftsProtocolDocs(db, ftsQuery, query, safeLimit));
      }
      if (wantCode) {
        results.push(...ftsCodeAnchors(db, ftsQuery, codeScopes, safeLimit));
      }
    }

    const seen = new Set();
    const deduped = [];
    for (const result of results) {
      const key =
        result.kind === "protocol"
          ? `protocol:${result.cmd}:${result.name}`
          : `${result.kind}:${result.file_path}:${result.line_number ?? result.line_start}:${result.literal ?? result.section ?? result.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
    }
    deduped.sort((a, b) => {
      if (a._priority !== b._priority) return a._priority - b._priority;
      if (a._rank !== b._rank) return a._rank - b._rank;
      return 0;
    });
    const trimmed = deduped.slice(0, safeLimit).map((item) => {
      const { _priority, _rank, ...rest } = item;
      return rest;
    });
    return {
      query,
      scope,
      elapsed_ms: Math.round((performance.now() - t0) * 100) / 100,
      total: trimmed.length,
      results: trimmed,
    };
  } finally {
    db.close();
  }
}

export function getProtocolEntry(cmdOrName) {
  const db = openTruthDb({ readonly: true });
  try {
    const numeric = /^\d+$/.test(String(cmdOrName)) ? Number(cmdOrName) : null;
    const rows = db
      .prepare(
        `SELECT * FROM protocol_catalog
          WHERE cmd = ? OR name = ? OR request_type = ? OR response_type = ?
          LIMIT 5`,
      )
      .all(numeric, String(cmdOrName), String(cmdOrName), String(cmdOrName));
    return rows.map((row) => protocolRow(row, 0, 0));
  } finally {
    db.close();
  }
}

function resolveInspectPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) throw new Error("file_path is required");
  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else {
    const clean = raw.replace(/^\.\//, "");
    for (const prefix of ["formatted/", ".larkit-data/formatted/"]) {
      if (clean.startsWith(prefix)) {
        candidates.push(safeJoin(FORMATTED_DIR, clean.slice(prefix.length)));
      }
    }
    for (const prefix of ["verified_truths/", ".larkit/verified_truths/"]) {
      if (clean.startsWith(prefix)) {
        candidates.push(safeJoin(VERIFIED_DIR, clean.slice(prefix.length)));
      }
    }
    candidates.push(safeJoin(FORMATTED_DIR, clean));
    candidates.push(safeJoin(VERIFIED_DIR, clean));
    candidates.push(safeJoin(PROTOCOL_REFERENCE_DIR, clean));
    candidates.push(safeJoin(ROOT, clean));
  }
  const allowedRoots = [FORMATTED_DIR, VERIFIED_DIR, PROTOCOL_REFERENCE_DIR, ROOT];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      !allowedRoots.some(
        (root) =>
          resolved === path.resolve(root) ||
          resolved.startsWith(path.resolve(root) + path.sep),
      )
    ) {
      continue;
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  if (
    /^formatted\//.test(String(filePath)) ||
    /^web\/|^electron\//.test(String(filePath))
  ) {
    throw new Error(
      `file not found: ${filePath}\nThe code corpus ships with the truth pack; rerun \`larkit init\` to repair it.`,
    );
  }
  throw new Error(`file not found: ${filePath}`);
}

function findFunctionStart(lines, lineIndex) {
  const patterns = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z0-9_$]*/,
    /^\s*(?:export\s+)?(?:default\s+)?class\s+[A-Za-z0-9_$]*/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?(?:function\b|\()/,
    /^\s*(?:async\s+)?[A-Za-z0-9_$]+\s*\([^)]*\)\s*\{\s*$/,
  ];
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 240); i--) {
    if (patterns.some((re) => re.test(lines[i]))) return i;
  }
  return null;
}

function braceEnd(lines, startIndex) {
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) return i;
  }
  return Math.min(lines.length - 1, startIndex + 119);
}

export function readSlice({
  filePath,
  lineNumber,
  context = 12,
  mode = "context",
  maxLines = 120,
} = {}) {
  const resolved = resolveInspectPath(filePath);
  const text = fs.readFileSync(resolved, "utf8");
  const lines = text.split("\n");
  const total = lines.length;
  const target = Math.max(1, Math.min(Number(lineNumber) || 1, total));
  const radius = Math.max(0, Math.min(Number(context) || 12, 60));
  const cap = Math.max(10, Math.min(Number(maxLines) || 120, 200));
  let start;
  let end;
  let usedMode = "context";
  if (mode === "function") {
    const fnStart = findFunctionStart(lines, target - 1);
    if (fnStart !== null) {
      const fnEnd = braceEnd(lines, fnStart);
      if (fnStart <= target - 1 && target - 1 <= fnEnd) {
        usedMode = "function";
        if (fnEnd - fnStart + 1 > cap) {
          // Keep the target line inside the slice even for long functions.
          start = Math.max(fnStart, target - 1 - Math.floor(cap / 2));
          end = Math.min(fnEnd, start + cap - 1);
          start = Math.max(fnStart, end - cap + 1);
        } else {
          start = Math.max(0, fnStart - 2);
          end = Math.min(total - 1, fnEnd + 2);
        }
      }
    }
  }
  if (start === undefined) {
    start = Math.max(0, target - 1 - radius);
    end = Math.min(total - 1, target - 1 + radius);
  }
  const truncated = end - start + 1 > cap;
  if (truncated) end = start + cap - 1;
  const slice = [];
  for (let i = start; i <= end; i++) {
    slice.push({ n: i + 1, text: lines[i] });
  }
  return {
    file_path: displayPath(resolved),
    mode: usedMode,
    line_number: target,
    range: { start: start + 1, end: end + 1 },
    total_lines: total,
    truncated,
    lines: slice,
  };
}

export function saveVerified({
  topic,
  content,
  evidence,
  source = "probe",
  confidence = "high",
  tags = [],
} = {}) {
  const { file, text } = saveVerifiedTruth({
    topic,
    content,
    evidence,
    source,
    confidence,
    tags,
  });
  let indexed = false;
  let sections = 0;
  try {
    const db = openTruthDb({ readonly: false });
    try {
      sections = syncVerifiedFile(db, file);
      indexed = true;
    } finally {
      db.close();
    }
  } catch (error) {
    // The truth can be saved even before the first index build; report why.
    return {
      saved: true,
      indexed,
      file_path: displayPath(file),
      bytes: Buffer.byteLength(text),
      sections,
      warning: error.message,
    };
  }
  return {
    saved: true,
    indexed,
    file_path: displayPath(file),
    bytes: Buffer.byteLength(text),
    sections,
  };
}

export function truthStats() {
  const db = openTruthDb({ readonly: true });
  try {
    const counts = {};
    for (const table of [
      "protocol_catalog",
      "code_anchors",
      "verified_truths",
      "protocol_docs",
    ]) {
      counts[table] = Number(
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c,
      );
    }
    const byScope = db
      .prepare(
        "SELECT scope, COUNT(*) AS c FROM code_anchors GROUP BY scope ORDER BY c DESC",
      )
      .all()
      .map((row) => ({ scope: row.scope, count: Number(row.c) }));
    const byType = db
      .prepare(
        "SELECT anchor_type, COUNT(*) AS c FROM code_anchors GROUP BY anchor_type ORDER BY c DESC",
      )
      .all()
      .map((row) => ({ anchor_type: row.anchor_type, count: Number(row.c) }));
    return { counts, byScope, byType };
  } finally {
    db.close();
  }
}
