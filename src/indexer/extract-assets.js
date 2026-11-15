import fs from "node:fs";
import path from "node:path";
import * as asar from "@electron/asar";
import {
  ELECTRON_EXTRACT_DIR,
  ELECTRON_INDEX,
  FEISHU_APP_DIR,
  RAW_DIR,
  WEB_DUMP_DIR,
  WEB_INDEX,
  WEB_SUMMARY,
} from "../shared/paths.js";
import {
  ensureDir,
  fileSizeMiB,
  log,
  readJson,
  relativeTo,
  toPosix,
  writeJson,
} from "../shared/util.js";
import { ensureDebExtracted, directorySize } from "./extract-deb.js";

/**
 * Curated desktop asar set.  The Linux client has no single app.asar: its main
 * process is native (feishu/libiron), and every window is a separate asar.
 * We extract all non-i18n JS from the windows that carry messaging, cards,
 * spaces and settings, plus the preload/resource bundles.
 */
const ASAR_SELECTION = [
  { name: "resource.asar", all: true },
  { name: "lark-api.asar", all: true },
  { name: "jssdk-mf.asar", all: true },
  { name: "js-worker.asar", all: true },
  { name: "shared-libs.asar", all: true },
  { name: "messenger.asar", all: false },
  { name: "main-window.asar", all: false },
  { name: "messenger-modals.asar", all: false },
  { name: "space.asar", all: false },
  { name: "setting.asar", all: false },
  { name: "search.asar", all: false },
];

const LOOSE_EXTENSIONS = new Set([".js", ".css", ".json"]);
const ASAR_EXTENSIONS = new Set([".js", ".css", ".json"]);

function isInterestingAsarEntry(entry, all) {
  if (entry.endsWith("/")) return false;
  const ext = path.extname(entry).toLowerCase();
  if (!ASAR_EXTENSIONS.has(ext)) return false;
  if (!all && entry.startsWith("/i18n/")) return false;
  // Massive locale bundles are noise for a code/truth index.
  if (entry.includes("/i18n/") && !all) return false;
  return true;
}

function buildWebIndex() {
  const summary = readJson(WEB_SUMMARY, null);
  if (!summary?.captures?.length) {
    throw new Error(`missing or invalid ${WEB_SUMMARY}`);
  }
  const entries = [];
  const seen = new Set();
  let missing = 0;
  let bytes = 0;
  for (const capture of summary.captures) {
    const key = capture.file;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const sourcePath = path.join(WEB_DUMP_DIR, capture.file);
    if (!fs.existsSync(sourcePath)) {
      missing++;
      continue;
    }
    const stat = fs.statSync(sourcePath);
    bytes += stat.size;
    entries.push({
      scope: "web",
      sourceTag: "web",
      relPath: toPosix(capture.file),
      sourcePath,
      assetType: capture.assetType,
      kind: capture.kind,
      sha1: capture.sha1,
      bytes: stat.size,
      resourceUrl: capture.resourceUrl,
      targetType: capture.targetType,
    });
  }
  writeJson(WEB_INDEX, {
    generatedAt: new Date().toISOString(),
    totalCaptures: summary.captures.length,
    uniqueFiles: entries.length,
    missing,
    bytes,
    entries,
  });
  log(
    `[extract] web index: ${entries.length}/${summary.captures.length} files, ${fileSizeMiB(bytes)}${missing ? `, missing=${missing}` : ""}`,
  );
  return entries;
}

function buildLooseElectronIndex() {
  const root = path.join(FEISHU_APP_DIR, "webcontent");
  const entries = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const full = path.join(current, child.name);
      if (child.isDirectory()) {
        if (child.name === "i18n" || child.name === "locales") continue;
        if (child.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!child.isFile()) continue;
      const ext = path.extname(child.name).toLowerCase();
      if (!LOOSE_EXTENSIONS.has(ext)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > 15 * 1024 * 1024) continue;
      const rel = relativeTo(root, full);
      if (seen.has(rel)) continue;
      seen.add(rel);
      entries.push({
        scope: "electron",
        sourceTag: "loose",
        relPath: rel,
        sourcePath: full,
        assetType: ext.slice(1),
        bytes: stat.size,
      });
    }
  }
  return entries;
}

function buildAsarElectronIndex() {
  const webcontent = path.join(FEISHU_APP_DIR, "webcontent");
  const entries = [];
  let totalBytes = 0;
  let extracted = 0;
  let skipped = 0;
  for (const selection of ASAR_SELECTION) {
    const archive = path.join(webcontent, selection.name);
    if (!fs.existsSync(archive)) {
      log(`[extract] asar missing: ${selection.name}`);
      continue;
    }
    const archiveBase = selection.name.replace(/\.asar$/, "");
    const outRoot = path.join(ELECTRON_EXTRACT_DIR, "asar", archiveBase);
    ensureDir(outRoot);
    const list = asar.listPackage(archive);
    let archiveCount = 0;
    for (const entry of list) {
      if (!isInterestingAsarEntry(entry, selection.all)) continue;
      const rel = entry.replace(/^\/+/, "");
      const dest = path.join(outRoot, rel);
      const ext = path.extname(rel).toLowerCase();
      archiveCount++;
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        skipped++;
      } else {
        try {
          const buf = asar.extractFile(archive, rel);
          ensureDir(path.dirname(dest));
          fs.writeFileSync(dest, buf);
          extracted++;
        } catch (error) {
          log(`[extract] asar read failed ${selection.name}:${entry}: ${error.message}`);
          continue;
        }
      }
      let size = 0;
      try {
        size = fs.statSync(dest).size;
      } catch {
        continue;
      }
      totalBytes += size;
      entries.push({
        scope: "electron",
        sourceTag: `asar/${archiveBase}`,
        relPath: rel,
        sourcePath: dest,
        assetType: ext.slice(1),
        bytes: size,
        archive: selection.name,
      });
    }
    log(
      `[extract] ${selection.name}: ${archiveCount} selected files (${extracted} new, ${skipped} cached)`,
    );
  }
  return { entries, totalBytes, extracted, skipped };
}

function writeElectronReadme() {
  const file = path.join(ELECTRON_EXTRACT_DIR, "README.md");
  const text = `# Electron extraction notes

The Linux client **does not ship a single \`app.asar\`**.  Its window code lives in
\`webcontent/*.asar\`, while the Electron main process is the native \`feishu\`
binary plus \`libiron\` / \`liblark\`.  This directory therefore contains:

- \`loose/\`: JS/CSS/JSON that the deb already extracts under \`webcontent/\`
  (jssdk worklets, js-worker, openplatform, lark-api, bridge.js, ...).
- \`asar/<archive>/\`: every non-i18n JS/CSS/JSON entry from the curated asar
  set (messenger, main-window, messenger-modals, space, setting, search,
  resource, lark-api, jssdk-mf, js-worker, shared-libs).

The \`resource.asar/js/*\` files are the closest equivalent to preload /
bootstrap scripts; \`messenger.asar/common/*\` and
\`main-window.asar/common/*\` are the renderer chunks used by the desktop UI.

No package.json was present inside the selected asar archives.  Desktop
protocol/schema truth ultimately comes from \`pb.desc\`, \`pb_server.desc\`,
the jssdk worklets and these renderer chunks.
`;
  fs.writeFileSync(file, text);
}

export function extractAssets() {
  ensureDebExtracted();
  ensureDir(RAW_DIR);
  ensureDir(ELECTRON_EXTRACT_DIR);
  writeElectronReadme();

  const webEntries = buildWebIndex();
  const looseEntries = buildLooseElectronIndex();
  const asarResult = buildAsarElectronIndex();
  const electronEntries = [...looseEntries, ...asarResult.entries];

  writeJson(ELECTRON_INDEX, {
    generatedAt: new Date().toISOString(),
    loose: looseEntries.length,
    asar: asarResult.entries.length,
    total: electronEntries.length,
    bytes: electronEntries.reduce((sum, e) => sum + e.bytes, 0),
    entries: electronEntries,
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    deb: "feishu-linux.deb",
    clientVersion: readClientVersion(),
    web: { entries: webEntries.length, bytes: webEntries.reduce((s, e) => s + e.bytes, 0) },
    electron: {
      loose: looseEntries.length,
      asar: asarResult.entries.length,
      extractedNow: asarResult.extracted,
      cached: asarResult.skipped,
      bytes: electronEntries.reduce((s, e) => s + e.bytes, 0),
    },
    extractedDirBytes: directorySize(ELECTRON_EXTRACT_DIR),
  };
  writeJson(path.join(RAW_DIR, "manifest.extract.json"), manifest);
  log(
    `[extract] electron index: ${electronEntries.length} files (${manifest.electron.bytes ? fileSizeMiB(manifest.electron.bytes) : "0"})`,
  );
  return { webEntries, electronEntries, manifest };
}

function readClientVersion() {
  try {
    const manifest = readJson(path.join(FEISHU_APP_DIR, "manifest.json"), {});
    return manifest.appVersion || "unknown";
  } catch {
    return "unknown";
  }
}
