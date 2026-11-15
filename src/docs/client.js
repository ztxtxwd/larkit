import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CACHE_DIR, displayPath } from "../shared/paths.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";

const DIRECTORY_LIST_URL =
  "https://open.feishu.cn/api/tools/docment/directory_list";
const URI_MAPPING_URL =
  "https://open.feishu.cn/document_portal/v1/document_portal/v1/document/uri/mapping";
const DOC_DETAIL_URL =
  "https://open.feishu.cn/document_portal/v1/document/get_detail";
const TREE_CACHE = path.join(CACHE_DIR, "docs-tree.json");
const DOC_CACHE_DIR = path.join(CACHE_DIR, "docs");

let state = null;

function fetchJson(url, timeout = 45_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeout) }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  });
}

function walk(nodes, category, out, uriMap) {
  for (const node of nodes || []) {
    if (node.type === "DocumentType") {
      out.push({
        title: node.name,
        full_path: node.fullPath,
        path: uriMap[node.fullPath] || node.fullPath,
        category,
      });
      continue;
    }
    if (node.type === "DirectoryType") {
      walk(node.items, category, out, uriMap);
    }
  }
}

async function loadState({ force = false } = {}) {
  if (state && !force) return state;
  const cached = readJson(TREE_CACHE, null);
  if (
    !force &&
    cached?.fetched_at &&
    Date.now() - cached.fetched_at < 24 * 60 * 60 * 1000 &&
    cached.tree &&
    cached.uri_map
  ) {
    state = buildState(cached.tree, cached.uri_map, cached.fetched_at);
    return state;
  }
  try {
    const [treeResponse, mappingResponse] = await Promise.all([
      fetchJson(DIRECTORY_LIST_URL),
      fetchJson(URI_MAPPING_URL),
    ]);
    if (treeResponse.code !== 0) {
      throw new Error(`directory_list: ${treeResponse.msg || treeResponse.code}`);
    }
    if (mappingResponse.code !== 0) {
      throw new Error(`uri mapping: ${mappingResponse.msg || mappingResponse.code}`);
    }
    const tree = treeResponse.data.items;
    const uriMap = mappingResponse.data.uriMap || {};
    writeJson(TREE_CACHE, {
      fetched_at: Date.now(),
      tree,
      uri_map: uriMap,
    });
    state = buildState(tree, uriMap, Date.now());
    return state;
  } catch (error) {
    if (cached?.tree && cached?.uri_map) {
      state = buildState(cached.tree, cached.uri_map, cached.fetched_at);
      state.stale = true;
      state.warning = error.message;
      return state;
    }
    throw error;
  }
}

function buildState(tree, uriMap, fetchedAt) {
  const categories = [];
  const docs = [];
  for (const level1 of tree || []) {
    if (level1.type !== "DirectoryType") continue;
    for (const level2 of level1.items || []) {
      if (level2.type !== "DirectoryType") continue;
      const category = `${level1.name}_${level2.name}`;
      const before = docs.length;
      walk([level2], category, docs, uriMap);
      categories.push({
        category,
        level1: level1.name,
        level2: level2.name,
        docs: docs.length - before,
      });
    }
  }
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  const byFullPath = new Map(docs.map((doc) => [doc.full_path, doc]));
  return {
    fetchedAt,
    categories,
    docs,
    byPath,
    byFullPath,
    uriMap,
    tree,
  };
}

function cleanMarkdown(content) {
  return String(content || "")
    .replace(/:::html\n?/g, "")
    .replace(/:::\n?/g, "")
    .replace(/<md-[a-z0-9-]+[^>]*>/g, "")
    .replace(/<\/md-[a-z0-9-]+>/g, "")
    .replace(/<\/?div[^>]*>/g, "")
    .replace(/<\/?tr[^>]*>/g, "")
    .replace(/<\/?font[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headingsOf(content) {
  const headings = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,4})\s+(.*)$/);
    if (match) {
      headings.push({ level: match[1].length, title: match[2].trim(), line: i + 1 });
    }
  }
  return headings.slice(0, 60);
}

export async function searchDocs({ query = "", category = "", limit = 30 } = {}) {
  const data = await loadState();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  if (!query && !category) {
    return {
      ok: true,
      kind: "categories",
      total_categories: data.categories.length,
      total_docs: data.docs.length,
      warning: data.warning,
      categories: data.categories.slice(0, 120),
      hint: "Pass category (一级目录_二级目录) to list a category, or query to search titles/paths.",
    };
  }
  let candidates = data.docs;
  let resolvedCategory = null;
  if (category) {
    const exact = data.categories.find((item) => item.category === category);
    const lower = category.toLowerCase();
    const fuzzy =
      exact ||
      data.categories.find((item) => item.category.toLowerCase() === lower) ||
      data.categories.find((item) => item.category.toLowerCase().includes(lower)) ||
      data.categories.find((item) =>
        item.category.toLowerCase().replace(/\s+/g, "").includes(lower.replace(/\s+/g, "")),
      );
    if (!fuzzy) {
      return {
        ok: false,
        error: `unknown category: ${category}`,
        suggestions: data.categories
          .filter((item) => item.category.toLowerCase().includes(lower.slice(0, 3)))
          .slice(0, 20),
        hint: "Use a category from suggestions, or pass only query to search all docs.",
      };
    }
    resolvedCategory = fuzzy.category;
    candidates = candidates.filter((doc) => doc.category === resolvedCategory);
  }
  if (query) {
    const q = query.toLowerCase();
    candidates = candidates.filter(
      (doc) =>
        doc.title.toLowerCase().includes(q) ||
        doc.path.toLowerCase().includes(q) ||
        doc.full_path.toLowerCase().includes(q),
    );
  }
  const total = candidates.length;
  return {
    ok: true,
    query: query || undefined,
    category: resolvedCategory || undefined,
    total,
    returned: Math.min(total, safeLimit),
    docs: candidates.slice(0, safeLimit).map((doc) => ({
      title: doc.title,
      path: doc.path,
      category: doc.category,
    })),
    warning: data.warning,
    hint:
      total > safeLimit
        ? "Narrow query/category or raise limit. Use lark_doc action=read with a path."
        : undefined,
  };
}

export async function readDoc({ docPath, offset = 0, limit = 0 } = {}) {
  if (!docPath) throw new Error("path is required");
  const data = await loadState();
  const requested = String(docPath).trim();
  const mapped = data.uriMap[requested] || requested;
  const known = data.byPath.get(mapped) || data.byFullPath.get(requested);
  const requestPath = known?.path || mapped;
  const url = new URL(DOC_DETAIL_URL);
  url.searchParams.set("fullPath", requestPath);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${requestPath}`);
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`document API ${payload.code}: ${payload.msg || "unknown error"}`);
  }
  const detail = payload.data || {};
  const title = detail.title || detail.name || known?.title || "";
  const content = cleanMarkdown(
    detail.content || detail.body || JSON.stringify(detail, null, 2),
  );
  ensureDir(DOC_CACHE_DIR);
  const hash = crypto.createHash("md5").update(requestPath).digest("hex").slice(0, 12);
  const safeName = (known?.title || title || "doc")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .slice(0, 60);
  const filePath = path.join(DOC_CACHE_DIR, `${safeName}_${hash}.md`);
  const text = `# ${title}\n\n${content}\n`;
  fs.writeFileSync(filePath, text);
  const lines = text.split("\n");
  const start = Math.max(0, Number(offset) || 0);
  const requestedLimit = Number(limit) || 0;
  const shouldSlice = requestedLimit > 0 || text.length > 5000;
  const sliceLimit = requestedLimit > 0 ? Math.min(requestedLimit, 400) : 120;
  const end = shouldSlice ? Math.min(lines.length, start + sliceLimit) : lines.length;
  return {
    ok: true,
    title,
    path: requestPath,
    file_path: displayPath(filePath),
    bytes: Buffer.byteLength(text),
    total_lines: lines.length,
    offset: start,
    limit: shouldSlice ? sliceLimit : lines.length,
    headings: headingsOf(text),
    content: lines.slice(start, end).join("\n"),
    truncated: end < lines.length,
    hint:
      end < lines.length
        ? `Large document: read again with offset=${end} limit=${sliceLimit}, or grep file_path.`
        : undefined,
  };
}

export async function docCategories() {
  const data = await loadState();
  return {
    ok: true,
    total_categories: data.categories.length,
    total_docs: data.docs.length,
    categories: data.categories,
  };
}

export function resetDocCache() {
  state = null;
  try {
    fs.rmSync(TREE_CACHE, { force: true });
  } catch {
    // ignore
  }
}
