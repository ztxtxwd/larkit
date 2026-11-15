import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  DOWNLOAD_DIR,
  FORMATTED_DIR,
  PKG_ROOT,
  TRUTH_DB,
  TRUTH_META,
  VERIFIED_DIR,
  displayPath,
} from "../shared/paths.js";
import {
  ensureDir,
  fileSizeMiB,
  log,
  readJson,
  walkFiles,
  writeJson,
} from "../shared/util.js";
import { createTarGz, extractTarGz } from "./tar.js";
import {
  downloadFile,
  fetchJson,
  isFileUrl,
  isHttpUrl,
  sha256File,
  sha256FileSync,
} from "./download.js";

export const PACK_KIND = "larkit-truth-pack";
export const PACK_SCHEMA_VERSION = 1;
export const TIER_NAME = "full";
/**
 * The official truth channel: `larkit init --channel` (or `--pack=<url>`)
 * pulls the newest published truth pack from here, independently of npm
 * releases.  Truth packs are published by maintainers (see README §14.1).
 */
export const DEFAULT_TRUTH_CHANNEL =
  "https://larkit.tapeless.eu.org/v1/truth/latest";
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "utf8");

export function isChannelSource(source) {
  return typeof source === "string" && isHttpUrl(source);
}

export function packageVersion() {
  return readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0";
}

export function truthMeta() {
  return readJson(TRUTH_META, {});
}

export function tierFileName(tag) {
  return `larkit-truth-${TIER_NAME}-${tag}.tar.gz`;
}

/**
 * Truth packs are released independently of npm releases, so they carry their
 * own immutable tag (e.g. "2026.11.15").  Archive names are permanent URLs, so
 * a tag must never be reused for different bytes.
 */
function normalizeTag(tag) {
  const value = String(tag || "").trim();
  if (!value) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(
      `invalid pack tag "${value}": use letters, digits, dot, dash or underscore (max 64 chars)`,
    );
  }
  return value;
}

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(dir, name));
}

function assertSqlite(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    if (!header.equals(SQLITE_MAGIC)) {
      throw new Error(`${displayPath(file)} is not a SQLite database`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function describeArtifact(file, onProgress) {
  const stat = fs.statSync(file);
  const { sha256 } = await sha256File(file, onProgress);
  return {
    file: path.basename(file),
    bytes: stat.size,
    sha256,
  };
}

function synthesizeArchiveManifest(archive, version) {
  const name = path.basename(archive);
  const tag = name.match(/^larkit-truth-full-(.+)\.tar\.gz$/i)?.[1] || null;
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: PACK_KIND,
    larkitVersion: version,
    ...(tag ? { packVersion: tag } : {}),
    builtAt: null,
    tiers: {
      [TIER_NAME]: {
        kind: "tar.gz",
        file: name,
        bytes: fs.statSync(archive).size,
      },
    },
  };
}

/**
 * Resolve a pack source into `{manifest, location}`.
 *
 * Accepted sources:
 *   - directory            -> directory containing manifest.json
 *   - *.json / URL         -> manifest (the channel API returns one too)
 *   - *.tar.gz / *.tgz     -> a single unified archive
 *   - file:// URL          -> local manifest or archive
 *
 * There is no bundled pack: every install downloads the unified archive from
 * the channel (or from a local file / pack the caller passes in).
 */
export async function loadPackManifest(source) {
  if (!source) {
    throw new Error(
      [
        "no truth pack source.",
        "",
        "Pick one:",
        "  1. larkit init --channel                        (download from the official truth channel)",
        "  2. larkit init --pack=<manifest.json|dir|.tar.gz|https://...>",
        "  3. LARKIT_PACK_MANIFEST=<url> larkit init",
        "  4. larkit init --from-assets --deb=<feishu-linux.deb> --web-dump=<feishu-web-dump>  (maintainer, Linux, slow)",
      ].join("\n"),
    );
  }

  const raw = String(source);
  const isRemote = isHttpUrl(raw) || isFileUrl(raw);
  if (!isRemote) {
    const resolved = path.resolve(raw);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const file = path.join(resolved, "manifest.json");
      if (!fs.existsSync(file)) {
        throw new Error(`no manifest.json in pack directory: ${resolved}`);
      }
      return {
        manifest: validateManifest(readJson(file, null), file),
        location: { type: "file", base: resolved },
        manifestFile: file,
      };
    }
    if (/\.(tar\.gz|tgz)$/i.test(resolved)) {
      return {
        manifest: validateManifest(
          synthesizeArchiveManifest(resolved, packageVersion()),
          resolved,
        ),
        location: { type: "file", base: path.dirname(resolved) },
        manifestFile: null,
      };
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`pack not found: ${resolved}`);
    }
    return {
      manifest: validateManifest(readJson(resolved, null), resolved),
      location: { type: "file", base: path.dirname(resolved) },
      manifestFile: resolved,
    };
  }

  const pathname = isFileUrl(raw) ? fileURLToPath(raw) : new URL(raw).pathname;
  if (/\.(tar\.gz|tgz)$/i.test(pathname)) {
    if (isFileUrl(raw)) {
      return {
        manifest: validateManifest(
          synthesizeArchiveManifest(pathname, packageVersion()),
          pathname,
        ),
        location: { type: "file", base: path.dirname(pathname) },
        manifestFile: null,
      };
    }
    return {
      manifest: validateManifest(
        {
          schemaVersion: PACK_SCHEMA_VERSION,
          kind: PACK_KIND,
          larkitVersion: packageVersion(),
          builtAt: null,
          tiers: {
            [TIER_NAME]: { kind: "tar.gz", file: pathname.split("/").pop() },
          },
        },
        raw,
      ),
      location: { type: "url", base: new URL(".", raw).href },
      manifestFile: null,
    };
  }

  const manifest = validateManifest(await fetchJson(raw), raw);
  return {
    manifest,
    location: {
      type: isHttpUrl(raw) ? "url" : "file",
      base: isHttpUrl(raw) ? new URL(".", raw).href : path.dirname(fileURLToPath(raw)),
    },
    manifestFile: raw,
  };
}

function validateManifest(manifest, source) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`invalid pack manifest: ${source}`);
  }
  if (manifest.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new Error(
      `unsupported pack schema ${manifest.schemaVersion} (expected ${PACK_SCHEMA_VERSION}): ${source}`,
    );
  }
  if (manifest.kind && manifest.kind !== PACK_KIND) {
    throw new Error(`not a larkit truth pack: ${source}`);
  }
  if (!manifest.tiers?.[TIER_NAME]) {
    throw new Error(
      `pack manifest has no "${TIER_NAME}" tier: ${source}\n` +
        "This looks like a legacy core/code pack; larkit now uses a single unified archive.",
    );
  }
  return manifest;
}

function resolveArtifact(tier, location) {
  if (tier.url) return tier.url;
  if (!tier.file) throw new Error("pack tier has neither file nor url");
  if (location.type === "url") {
    return new URL(tier.file, location.base).href;
  }
  const root = path.resolve(location.base);
  const resolved = path.resolve(root, tier.file);
  if (
    !path.isAbsolute(tier.file) &&
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    throw new Error(`pack artifact path escapes the manifest directory: ${tier.file}`);
  }
  return resolved;
}

export function mergeSeeds(seedDir, targetDir, previous = {}) {
  const seeds = { ...previous };
  if (!fs.existsSync(seedDir)) return seeds;
  ensureDir(targetDir);
  for (const name of fs.readdirSync(seedDir)) {
    if (!name.endsWith(".md")) continue;
    const source = path.join(seedDir, name);
    if (!fs.statSync(source).isFile()) continue;
    const dest = path.join(targetDir, name);
    const next = sha256FileSync(source);
    const sameFile = path.resolve(source) === path.resolve(dest);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(source, dest);
      seeds[name] = next;
      continue;
    }
    const current = sha256FileSync(dest);
    const previousHash = previous[name];
    if (previousHash && current === previousHash) {
      if (!sameFile) fs.copyFileSync(source, dest);
      seeds[name] = next;
    } else if (!previousHash && current === next) {
      seeds[name] = next;
    }
    // Otherwise the user edited the seed; keep their version.
  }
  return seeds;
}

function readStats() {
  const meta = truthMeta();
  return {
    protocolCatalog: meta.protocolCatalog ?? null,
    codeAnchors: meta.codeAnchors ?? null,
    verifiedSections: meta.verifiedSections ?? null,
    protocolDocs: meta.protocolDocs ?? null,
    generatedAt: meta.generatedAt || null,
  };
}

function artifactCachePath(tier, source) {
  const base = tier.file || path.basename(new URL(source).pathname);
  const prefix = tier.sha256 ? `${tier.sha256.slice(0, 16)}-` : "";
  return path.join(DOWNLOAD_DIR, `${prefix}${base}`);
}

/**
 * Reuse an already-downloaded archive when its checksum still matches, so a
 * forced re-install (or an interrupted run) never pulls 161 MB twice.
 */
async function ensureArchive(tier, location, { quiet, reporter }) {
  const source = resolveArtifact(tier, location);
  if (!isHttpUrl(source)) {
    if (!fs.existsSync(source)) {
      throw new Error(
        `pack archive not found: ${source}\nPublish it with --base-url=... or pass --pack=<manifest>`,
      );
    }
    if (tier.sha256) {
      const actual = sha256FileSync(source);
      if (actual !== tier.sha256) throw new Error(`pack checksum mismatch for ${source}`);
    }
    return source;
  }
  const cached = artifactCachePath(tier, source);
  if (tier.sha256 && fs.existsSync(cached) && sha256FileSync(cached) === tier.sha256) {
    if (!quiet) log(`[pack] reuse cached ${path.basename(cached)}`);
    return cached;
  }
  await downloadFile(source, cached, {
    expectedSha256: tier.sha256,
    expectedBytes: tier.bytes,
    quiet,
    onProgress: (received, total) => reporter?.progress?.("truth", received, total),
  });
  return cached;
}

/**
 * Install the truth source: one archive carrying truth.db, the verified seeds
 * and the formatted code corpus.  There is nothing optional to select — the
 * corpus is what makes `read_slice` work, so it always comes down.
 */
export async function installTruthPack({
  source,
  force = false,
  quiet = false,
  reporter,
  state = {},
} = {}) {
  const { manifest, location, manifestFile } = await loadPackManifest(source);
  const larkitVersion = manifest.larkitVersion || manifest.version || packageVersion();
  const packVersion = manifest.packVersion || larkitVersion;
  const tier = manifest.tiers[TIER_NAME];
  const packSha = tier.sha256 || `${TIER_NAME}:${tier.file}`;
  const result = {
    manifest,
    manifest_file: manifestFile,
    location: location.type,
    version: packVersion,
    packVersion,
    larkitVersion,
    packSha,
    status: null,
    source: null,
    seeds: {},
    stats: readStats(),
  };

  if (!force && fs.existsSync(TRUTH_DB) && state?.truth?.packSha === packSha) {
    return {
      ...result,
      status: "present",
      source: state.truth.source,
      seeds: state.truth.seeds || {},
      skipped: true,
    };
  }

  const archive = await ensureArchive(tier, location, { quiet, reporter });
  ensureDir(DATA_DIR);
  const tmp = fs.mkdtempSync(path.join(DATA_DIR, ".pack-full-"));
  try {
    const files = await extractTarGz(archive, tmp, {
      onWarning: (message) => reporter?.warn(message),
      onProgress: (bytes) => reporter?.progress?.("truth", bytes, tier.unpackedBytes),
    });

    const incoming = path.join(tmp, "truth.db");
    if (!fs.existsSync(incoming)) {
      throw new Error("unified pack does not contain truth.db");
    }
    assertSqlite(incoming);
    fs.rmSync(TRUTH_DB, { force: true });
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${TRUTH_DB}${suffix}`, { force: true });
    fs.renameSync(incoming, TRUTH_DB);

    const meta = path.join(tmp, "truth.meta.json");
    if (fs.existsSync(meta)) fs.copyFileSync(meta, TRUTH_META);

    const seeds = mergeSeeds(
      path.join(tmp, "verified_truths"),
      VERIFIED_DIR,
      !force ? state?.truth?.seeds || {} : {},
    );

    const incomingCode = path.join(tmp, "formatted");
    if (!fs.existsSync(incomingCode)) {
      throw new Error("unified pack does not contain formatted/; rebuild it with `larkit pack build`");
    }
    const backup = `${FORMATTED_DIR}.old-${Date.now()}`;
    if (fs.existsSync(FORMATTED_DIR)) fs.renameSync(FORMATTED_DIR, backup);
    fs.renameSync(incomingCode, FORMATTED_DIR);
    fs.rmSync(backup, { recursive: true, force: true });

    return {
      ...result,
      status: "installed",
      source: location.type === "url" ? "download" : "archive",
      archive,
      seeds,
      files: files.files,
      bytes: files.bytes,
      stats: readStats(),
      skipped: false,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Package-maintainer helper: snapshot DATA_DIR + VERIFIED_DIR + FORMATTED_DIR
 * into one versioned archive and a manifest that points at it.
 */
export async function buildTruthPack({
  outDir = path.join(PKG_ROOT, "dist", "truth-pack"),
  dataDir = DATA_DIR,
  verifiedDir = VERIFIED_DIR,
  baseUrl = "",
  version = packageVersion(),
  tag = "",
  onProgress,
} = {}) {
  const packTag = normalizeTag(tag) || version;
  const truthDb = path.join(dataDir, "truth.db");
  if (!fs.existsSync(truthDb)) {
    throw new Error(`missing ${truthDb}; run "larkit index" or "larkit init --from-assets" first`);
  }
  const metaPath = path.join(dataDir, "truth.meta.json");
  ensureDir(outDir);
  const seeds = markdownFiles(verifiedDir);

  const formatted = path.join(dataDir, "formatted");
  const files = walkFiles(formatted, { skipDirs: new Set([".git", "node_modules"]) });
  if (!files.length) throw new Error(`missing ${formatted}; cannot build the truth pack`);
  const formattedBytes = files.reduce((sum, file) => sum + file.size, 0);
  log(
    `[pack] truth: truth.db + ${seeds.length} seeds + ${files.length} code files (${fileSizeMiB(formattedBytes)})`,
  );

  const entries = [
    { file: truthDb, tarPath: "truth.db" },
    ...(fs.existsSync(metaPath) ? [{ file: metaPath, tarPath: "truth.meta.json" }] : []),
    ...seeds.map((file) => ({
      file,
      tarPath: `verified_truths/${path.basename(file)}`,
    })),
    ...files.map((entry) => ({
      file: entry.path,
      tarPath: `formatted/${path.relative(formatted, entry.path).split(path.sep).join("/")}`,
    })),
  ];

  const file = tierFileName(packTag);
  const archive = path.join(outDir, file);
  await createTarGz(archive, { entries, onProgress });
  const full = await describeArtifact(archive, onProgress);
  full.kind = "tar.gz";
  full.unpackedBytes =
    fs.statSync(truthDb).size +
    (fs.existsSync(metaPath) ? fs.statSync(metaPath).size : 0) +
    seeds.reduce((sum, seed) => sum + fs.statSync(seed).size, 0) +
    formattedBytes;
  full.codeFiles = files.length;
  if (baseUrl) full.url = `${baseUrl.replace(/\/+$/, "")}/${file}`;

  const manifest = {
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: PACK_KIND,
    larkitVersion: version,
    packVersion: packTag,
    builtAt: new Date().toISOString(),
    clientVersion: readJson(path.join(dataDir, "raw", "manifest.extract.json"), {})
      .clientVersion || null,
    stats: readStats(),
    tiers: { [TIER_NAME]: full },
  };
  const manifestFile = path.join(outDir, "manifest.json");
  writeJson(manifestFile, manifest);
  return { manifest, manifestFile, files: { full: archive } };
}

/** Verify local pack artifacts referenced by a manifest. */
export async function verifyPack(source) {
  const { manifest, location, manifestFile } = await loadPackManifest(source);
  const checked = [];
  for (const [name, tier] of Object.entries(manifest.tiers || {})) {
    const artifact = resolveArtifact(tier, location);
    if (isHttpUrl(artifact)) {
      checked.push({ tier: name, url: artifact, ok: true, remote: true });
      continue;
    }
    if (!fs.existsSync(artifact)) {
      checked.push({ tier: name, file: artifact, ok: false, error: "missing" });
      continue;
    }
    const stat = fs.statSync(artifact);
    const actual = sha256FileSync(artifact);
    checked.push({
      tier: name,
      file: artifact,
      bytes: stat.size,
      ok: (!tier.sha256 || actual === tier.sha256) && (!tier.bytes || stat.size === tier.bytes),
    });
  }
  return {
    ok: checked.every((item) => item.ok),
    manifest_file: manifestFile,
    version: manifest.packVersion || manifest.larkitVersion,
    tiers: checked,
  };
}
