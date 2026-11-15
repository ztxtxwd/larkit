#!/usr/bin/env node
/**
 * Publish a built truth pack to Cloudflare R2.
 *
 *   # maintainer machine — truth source release (no npm involved)
 *   node bin/larkit.js pack build --out=dist/truth-pack \
 *     --tag=2026.11.15 --base-url=https://larkit.tapeless.eu.org
 *   node scripts/publish-pack.mjs --pack-dir=dist/truth-pack \
 *     --bucket=larkit-truth --base-url=https://larkit.tapeless.eu.org
 *
 * Objects are uploaded with immutable cache headers (archive names carry the
 * pack tag), then `manifest.json` last — clients never observe a manifest that
 * points at objects which are not there yet.  A pinned copy (`<tag>.json`) is
 * published alongside for reproducible installs, plus `index.json` that lists
 * every published tag so a tag can never be silently reused for new bytes.
 *
 * Uploads go through `wrangler r2 object put`, so either run `wrangler login`
 * once or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const IMMUTABLE = "public, max-age=31536000, immutable";
const MANIFEST_CACHE = "public, max-age=60, must-revalidate";

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    const value = rest.join("=");
    flags[key] = value === "" ? true : value;
  }
  return flags;
}

function fail(message) {
  console.error(`[publish] ${message}`);
  process.exit(1);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const flags = parseArgs(process.argv.slice(2));
const packDir = path.resolve(flags["pack-dir"] || "dist/truth-pack");
const bucket = flags.bucket || process.env.LARKIT_R2_BUCKET || "larkit-truth";
const prefix = String(flags.prefix || "").replace(/^\/+|\/+$/g, "");
const dryRun = Boolean(flags["dry-run"]);
const manifestOnly = Boolean(flags["manifest-only"]);
const force = Boolean(flags.force);
const wrangler = flags.wrangler || "npx --yes wrangler@latest";

const manifestFile = path.join(packDir, "manifest.json");
if (!fs.existsSync(manifestFile)) {
  fail(
    `missing ${manifestFile}; run "larkit pack build --out=${path.relative(process.cwd(), packDir)}" first`,
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
if (manifest.kind !== "larkit-truth-pack") fail(`${manifestFile} is not a truth pack manifest`);
const tiers = Object.entries(manifest.tiers || {});
if (!tiers.length) fail(`${manifestFile} has no tiers`);

const tag = String(manifest.packVersion || manifest.larkitVersion || "0.0.0");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) fail(`unsafe pack tag "${tag}"`);

function baseUrlFromManifest() {
  for (const [, tier] of tiers) {
    if (typeof tier.url === "string" && /^https?:\/\//.test(tier.url)) {
      return tier.url.replace(/\/[^/]*$/, "");
    }
  }
  return "";
}

const baseUrl = String(
  flags["base-url"] || process.env.LARKIT_PACK_BASE_URL || baseUrlFromManifest(),
).replace(/\/+$/, "");
if (!baseUrl) {
  fail("no public base URL: pass --base-url=https://host/prefix (or build with --base-url)");
}

function keyFor(name) {
  return prefix ? `${prefix}/${name}` : name;
}

function urlFor(name) {
  return `${baseUrl}/${keyFor(name)}`;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function upload(localFile, name, { contentType, cacheControl }) {
  const key = keyFor(name);
  const args = [
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    `--file=${localFile}`,
    `--content-type=${contentType}`,
    `--cache-control=${cacheControl}`,
    "--remote",
    "-y",
  ];
  const label = `${bucket}/${key}`;
  if (dryRun) {
    console.log(`[publish] dry-run ${label} <- ${path.relative(process.cwd(), localFile)}`);
    return;
  }
  console.log(`[publish] upload ${label} (${mib(fs.statSync(localFile).size)})`);
  const [command, ...prefixArgs] = wrangler.split(/\s+/);
  const result = spawnSync(command, [...prefixArgs, ...args], { stdio: "inherit" });
  if (result.status !== 0) fail(`wrangler failed for ${label}`);
}

async function fetchIndex() {
  try {
    const response = await fetch(urlFor("index.json"), {
      headers: { "cache-control": "no-cache" },
    });
    if (response.status === 404) return { schemaVersion: 1, packs: [] };
    if (!response.ok) fail(`GET ${urlFor("index.json")} -> HTTP ${response.status}`);
    const index = await response.json();
    if (!Array.isArray(index.packs)) return { schemaVersion: 1, packs: [] };
    return index;
  } catch (error) {
    if (dryRun) return { schemaVersion: 1, packs: [] };
    fail(`cannot read ${urlFor("index.json")}: ${error.message}`);
  }
  return { schemaVersion: 1, packs: [] };
}

async function verifyRemote(name, entry) {
  if (dryRun) return;
  const url = urlFor(name);
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) fail(`HEAD ${url} -> HTTP ${head.status}`);
  const length = Number(head.headers.get("content-length")) || 0;
  if (length !== entry.bytes) fail(`content-length mismatch for ${url}: ${length} != ${entry.bytes}`);
  const range = await fetch(url, { headers: { range: "bytes=0-15" } });
  if (range.status !== 206) {
    console.warn(`[publish] warning: ${url} answered ${range.status} to a range request (no resume)`);
  }
  const response = await fetch(url, { redirect: "follow" });
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (entry.sha256 && actual !== entry.sha256) {
    fail(`sha256 mismatch for ${url}: ${actual} != ${entry.sha256}`);
  }
  console.log(`[publish] verified ${url}`);
}

// Pre-flight: never publish a manifest that does not match the bytes on disk.
const artifacts = [];
for (const [tier] of tiers) {
  if (tier !== "full") {
    fail(
      `legacy "${tier}" tier in ${manifestFile}; larkit now publishes a single "full" archive ` +
        "(rebuild with `larkit pack build`)",
    );
  }
}
for (const [tier, entry] of tiers) {
  const file = path.join(packDir, entry.file);
  if (!fs.existsSync(file)) fail(`missing artifact for ${tier} tier: ${file}`);
  const stat = fs.statSync(file);
  if (entry.bytes && stat.size !== entry.bytes) {
    fail(`${entry.file}: size ${stat.size} != manifest ${entry.bytes}`);
  }
  const actual = sha256(file);
  if (entry.sha256 && actual !== entry.sha256) {
    fail(`${entry.file}: sha256 ${actual} != manifest ${entry.sha256}`);
  }
  artifacts.push({ tier, file, name: entry.file, bytes: stat.size, sha256: actual });
}

// Immutability guard: archive names carry the tag, so a tag is a permanent URL.
const index = await fetchIndex();
const existing = index.packs.find((entry) => entry.tag === tag);
const fingerprint = Object.fromEntries(artifacts.map((a) => [a.tier, a.sha256]));
if (existing && !force) {
  const drift = Object.entries(fingerprint).filter(
    ([tier, sha]) => existing.tiers?.[tier]?.sha256 && existing.tiers[tier].sha256 !== sha,
  );
  if (drift.length) {
    fail(
      `tag "${tag}" is already published with different bytes (${drift
        .map(([tier]) => tier)
        .join(", ")}); rebuild with a new --tag=<date> (tags are immutable), or pass --force`,
    );
  }
  console.log(`[publish] tag "${tag}" already published with identical content`);
  if (!(manifestOnly || force)) {
    console.log("[publish] nothing to upload (use --manifest-only to refresh manifest.json)");
  }
}

console.log(
  `[publish] pack ${tag} (larkit ${manifest.larkitVersion}) -> r2://${bucket}/${prefix || ""}, base ${baseUrl}`,
);

const uploaded = [];
if (!manifestOnly) {
  for (const artifact of artifacts) {
    if (existing && !force && existing.tiers?.[artifact.tier]?.sha256 === artifact.sha256) {
      console.log(`[publish] re-use ${keyFor(artifact.name)} (same sha256)`);
      continue;
    }
    upload(artifact.file, artifact.name, {
      contentType: "application/gzip",
      cacheControl: IMMUTABLE,
    });
    uploaded.push(artifact);
  }
}

upload(manifestFile, `${tag}.json`, { contentType: "application/json", cacheControl: IMMUTABLE });
upload(manifestFile, "manifest.json", {
  contentType: "application/json",
  cacheControl: MANIFEST_CACHE,
});

const nextIndex = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  latest: tag,
  packs: [
    ...index.packs.filter((entry) => entry.tag !== tag),
    {
      tag,
      builtAt: manifest.builtAt || null,
      larkitVersion: manifest.larkitVersion || null,
      clientVersion: manifest.clientVersion || null,
      stats: manifest.stats || null,
      manifest: urlFor(`${tag}.json`),
      tiers: Object.fromEntries(
        artifacts.map((a) => [a.tier, { url: urlFor(a.name), bytes: a.bytes, sha256: a.sha256 }]),
      ),
    },
  ].sort((a, b) => String(a.tag).localeCompare(String(b.tag))),
};
const indexPath = path.join(packDir, "index.json");
fs.writeFileSync(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
upload(indexPath, "index.json", { contentType: "application/json", cacheControl: MANIFEST_CACHE });

if (!manifestOnly) {
  for (const artifact of uploaded) {
    await verifyRemote(artifact.name, artifact);
  }
}

const manifestUrl = urlFor("manifest.json");
if (!dryRun) {
  const check = await fetch(manifestUrl, { redirect: "follow", headers: { "cache-control": "no-cache" } });
  if (!check.ok) fail(`GET ${manifestUrl} -> HTTP ${check.status}`);
  const served = await check.json();
  if ((served.packVersion || served.larkitVersion) !== tag) {
    fail(`served manifest tag ${served.packVersion || served.larkitVersion} != ${tag}`);
  }
}

console.log("");
console.log("[publish] done. truth source is live:");
console.log(`  manifest   ${manifestUrl}`);
console.log(`  pinned     ${urlFor(`${tag}.json`)}`);
console.log(`  index      ${urlFor("index.json")}`);
console.log("");
console.log("[publish] keep old tags on R2: published npm versions and pinned");
console.log("[publish] manifests point at those archive names forever.");
