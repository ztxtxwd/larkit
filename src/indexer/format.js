import fs from "node:fs";
import path from "node:path";
import {
  ELECTRON_INDEX,
  FORMAT_MANIFEST,
  FORMATTED_DIR,
  WEB_INDEX,
} from "../shared/paths.js";
import {
  ensureDir,
  fileSizeMiB,
  log,
  readJson,
  safeJoin,
  sha1,
  toPosix,
  writeJson,
} from "../shared/util.js";
import { runFormatPool } from "./format-pool.js";

function parserFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".css") return "css";
  return "babel";
}

function outputRel(entry) {
  if (entry.scope === "web") return toPosix(path.join("web", entry.relPath));
  if (entry.sourceTag === "loose") {
    return toPosix(path.join("electron", "loose", entry.relPath));
  }
  const archiveBase = (entry.archive || entry.sourceTag || "asar").replace(
    /\.asar$/,
    "",
  );
  return toPosix(
    path.join("electron", "asar", archiveBase, entry.relPath),
  );
}

function collectEntries() {
  const web = readJson(WEB_INDEX, null);
  const electron = readJson(ELECTRON_INDEX, null);
  if (!web?.entries?.length) {
    throw new Error(`missing ${WEB_INDEX}; run extract first`);
  }
  if (!electron?.entries?.length) {
    throw new Error(`missing ${ELECTRON_INDEX}; run extract first`);
  }
  const entries = [];
  for (const entry of [...web.entries, ...electron.entries]) {
    if (!fs.existsSync(entry.sourcePath)) continue;
    entries.push({
      ...entry,
      outRel: outputRel(entry),
      parser: parserFor(entry.relPath),
    });
  }
  return entries;
}

export async function formatAssets({ force = false, concurrency, limit } = {}) {
  if (force && fs.existsSync(FORMATTED_DIR)) {
    fs.rmSync(FORMATTED_DIR, { recursive: true, force: true });
  }
  ensureDir(FORMATTED_DIR);

  const entries = collectEntries();
  const manifest = force
    ? { version: 2, entries: {} }
    : readJson(FORMAT_MANIFEST, { version: 2, entries: {} });
  if (!manifest.entries) manifest.entries = {};

  const cacheHits = [];
  const pending = [];
  for (const entry of entries) {
    let srcHash;
    try {
      srcHash = sha1(fs.readFileSync(entry.sourcePath));
    } catch (error) {
      log(`[format] skip unreadable ${entry.sourcePath}: ${error.message}`);
      continue;
    }
    const outPath = safeJoin(FORMATTED_DIR, entry.outRel);
    const cached = manifest.entries[entry.outRel];
    if (
      !force &&
      cached &&
      cached.srcHash === srcHash &&
      fs.existsSync(outPath) &&
      fs.statSync(outPath).size > 0
    ) {
      cacheHits.push(entry);
      continue;
    }
    pending.push({ ...entry, srcHash, outPath });
  }

  log(
    `[format] ${entries.length} sources: ${cacheHits.length} cached, ${pending.length} to format`,
  );

  // Content-addressed dedupe: many asar chunks are byte-identical. Format one
  // representative, then copy the formatted text to every alias.
  const groups = new Map();
  for (const entry of pending) {
    const key = `${entry.srcHash}:${entry.parser}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, parser: entry.parser, members: [] };
      groups.set(key, group);
    }
    group.members.push(entry);
  }

  const groupList = [...groups.values()];
  const limitedGroups = limit ? groupList.slice(0, limit) : groupList;
  const taskById = new Map();
  const tasks = limitedGroups.map((group, index) => {
    const id = `g${index}`;
    taskById.set(id, group);
    return {
      id,
      srcPath: group.members[0].sourcePath,
      parser: group.parser,
    };
  });

  const stats = {
    cached: cacheHits.length,
    formattedFiles: 0,
    formattedBytes: 0,
    lines: 0,
    fallback: 0,
    errors: 0,
    deduped: 0,
  };
  let completedGroups = 0;

  if (tasks.length > 0) {
    await runFormatPool(tasks, {
      concurrency,
      progress: 100,
      onResult: (result) => {
        completedGroups++;
        const group = taskById.get(result.id);
        if (!group) return;
        const representative = group.members[0];
        if (!result.ok) {
          stats.errors++;
          log(
            `[format] failed ${representative.outRel}: ${result.error}`,
          );
          return;
        }
        ensureDir(path.dirname(representative.outPath));
        fs.writeFileSync(representative.outPath, result.code);
        manifest.entries[representative.outRel] = {
          srcHash: representative.srcHash,
          srcBytes: result.srcBytes,
          outBytes: result.outBytes,
          lines: result.lines,
          parser: result.parser,
          fallback: result.fallback,
        };
        stats.formattedFiles++;
        stats.formattedBytes += result.outBytes;
        stats.lines += result.lines;
        if (result.fallback) stats.fallback++;

        for (const alias of group.members.slice(1)) {
          ensureDir(path.dirname(alias.outPath));
          fs.copyFileSync(representative.outPath, alias.outPath);
          manifest.entries[alias.outRel] = {
            srcHash: alias.srcHash,
            srcBytes: result.srcBytes,
            outBytes: result.outBytes,
            lines: result.lines,
            parser: result.parser,
            fallback: result.fallback,
            copiedFrom: representative.outRel,
          };
          stats.deduped++;
        }
      },
    });
  }

  // Remove manifest entries whose source disappeared.
  const live = new Set(entries.map((e) => e.outRel));
  for (const key of Object.keys(manifest.entries)) {
    if (!live.has(key)) delete manifest.entries[key];
  }
  manifest.version = 2;
  manifest.generatedAt = new Date().toISOString();
  manifest.sources = entries.length;
  manifest.stats = stats;
  writeJson(FORMAT_MANIFEST, manifest);

  const allOutputs = entries.filter((e) =>
    fs.existsSync(safeJoin(FORMATTED_DIR, e.outRel)),
  );
  const totalBytes = allOutputs.reduce((sum, e) => {
    try {
      return sum + fs.statSync(safeJoin(FORMATTED_DIR, e.outRel)).size;
    } catch {
      return sum;
    }
  }, 0);

  const readme = `# Formatted code corpus

Generated by \`larkit index:format\`.

- Sources: ${entries.length}
- Outputs: ${allOutputs.length}
- Formatted bytes: ${fileSizeMiB(totalBytes)}
- Cache hits: ${stats.cached}
- Newly formatted: ${stats.formattedFiles}
- Deduplicated aliases: ${stats.deduped}
- Parser fallbacks: ${stats.fallback}
- Errors: ${stats.errors}

Layout:

- \`web/<debugger|stylesheet|network>/...\` — 531 deduplicated web-client resources.
- \`electron/loose/...\` — JS/CSS/JSON already present in the deb's webcontent.
- \`electron/asar/<archive>/...\` — non-i18n JS/CSS/JSON extracted from desktop asars.

Every file is multi-line formatted; line numbers in \`truth.db\` refer to these
files.  Use \`larkit inspect <file> <line>\` for a bounded slice.
`;
  fs.writeFileSync(path.join(FORMATTED_DIR, "README.md"), readme);
  log(
    `[format] done: ${allOutputs.length} outputs, ${fileSizeMiB(totalBytes)}, ${stats.errors} errors, ${stats.deduped} aliases`,
  );
  return { entries, stats, totalBytes, outputs: allOutputs.length };
}
