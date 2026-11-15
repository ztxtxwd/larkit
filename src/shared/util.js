import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function sha1(data) {
  return createHash("sha1").update(data).digest("hex");
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

export function relativeTo(base, target) {
  return toPosix(path.relative(base, target));
}

/** Resolve a user supplied relative path inside base, rejecting traversal. */
export function safeJoin(base, rel) {
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(base, clean);
  const prefix = path.resolve(base) + path.sep;
  if (resolved !== path.resolve(base) && !resolved.startsWith(prefix)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return resolved;
}

export function walkFiles(dir, options = {}) {
  const {
    extensions = null,
    skipDirs = new Set([
      "node_modules",
      ".git",
      "i18n",
      "locales",
      "__tests__",
      "test",
    ]),
    maxFileBytes = Infinity,
    includeHidden = false,
  } = options;
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        try {
          const st = fs.statSync(full);
          if (st.size > maxFileBytes || st.size === 0) continue;
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function truncate(value, max = 300) {
  const s = String(value ?? "");
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function oneLine(value, max = 300) {
  return truncate(String(value ?? "").replace(/\s+/g, " ").trim(), max);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileSizeMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function log(...args) {
  console.error(...args);
}

export function nowIso() {
  return new Date().toISOString();
}
