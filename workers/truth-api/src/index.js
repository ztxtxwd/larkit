/**
 * larkit truth channel API (Cloudflare Worker).
 *
 * A single stable URL that always answers "what is the current truth pack, and
 * where do I download it from":
 *
 *   GET /v1/truth/latest        → manifest of the current pack (schemaVersion 1)
 *   GET /v1/truth/<tag>         → manifest of a pinned pack (immutable)
 *   GET /v1/truth               → index: every published tag + sha256
 *   GET /health                 → liveness
 *
 * The Worker reads the objects that `scripts/publish-pack.mjs` writes into the
 * R2 bucket (manifest.json / <tag>.json / index.json) and turns them into an
 * API response: no duplicated state, no rebuild step, publishing stays one
 * upload.  `ETag` is the archive sha256, so clients can do conditional GETs.
 */

const CACHE_LATEST = "public, max-age=60, stale-while-revalidate=600";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

function jsonHeaders(extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "if-none-match, content-type",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    ...extra,
  };
}

function json(payload, { status = 200, headers = {} } = {}) {
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    status,
    headers: jsonHeaders(headers),
  });
}

function fail(status, message) {
  return json({ error: message, status }, { status });
}

function archiveSha(manifest) {
  return (
    manifest?.tiers?.full?.sha256 ||
    manifest?.tiers?.core?.sha256 ||
    null
  );
}

/** Pin absolute download URLs to the public bucket host, if configured. */
function rewriteUrls(manifest, base) {
  if (!base) return manifest;
  const root = String(base).replace(/\/+$/, "");
  for (const tier of Object.values(manifest.tiers || {})) {
    if (!tier?.file) continue;
    tier.url = `${root}/${tier.file}`;
  }
  return manifest;
}

async function readJson(env, key) {
  const object = await env.TRUTH.get(key);
  if (!object) return null;
  const text = await object.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeTag(tag) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag) ? tag : null;
}

async function serveManifest(request, env, key, { immutable }) {
  const manifest = await readJson(env, key);
  if (!manifest) return fail(404, `no such pack manifest: ${key}`);

  const payload = rewriteUrls({ ...manifest }, env.PUBLIC_BASE);
  const sha = archiveSha(payload);
  const tag = payload.packVersion || payload.larkitVersion || null;
  const etag = sha ? `"${sha.slice(0, 32)}"` : null;
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: jsonHeaders({ etag, "cache-control": immutable ? CACHE_IMMUTABLE : CACHE_LATEST }) });
  }

  const headers = {
    "cache-control": immutable ? CACHE_IMMUTABLE : CACHE_LATEST,
    "x-larkit-pack": tag || "unknown",
  };
  if (etag) headers.etag = etag;
  return json(
    {
      ...payload,
      channel: "stable",
      api: { version: 1, servedAt: new Date().toISOString(), tag },
    },
    { headers },
  );
}

async function serveIndex(env) {
  const index = await readJson(env, "index.json");
  if (!index) return fail(503, "channel index is not published yet");
  const base = new URL(env.PUBLIC_API || "https://larkit-api.tapeless.eu.org");
  const packs = (index.packs || []).map((entry) => ({
    tag: entry.tag,
    builtAt: entry.builtAt || null,
    larkitVersion: entry.larkitVersion || null,
    clientVersion: entry.clientVersion || null,
    stats: entry.stats || null,
    manifest: entry.tag ? `${base.origin}/v1/truth/${entry.tag}` : null,
    tiers: entry.tiers || {},
  }));
  return json(
    {
      api: { version: 1, servedAt: new Date().toISOString() },
      latest: index.latest || packs[packs.length - 1]?.tag || null,
      packs,
    },
    { headers: { "cache-control": CACHE_LATEST } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: jsonHeaders() });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(405, "method not allowed");
    }

    const path = url.pathname.replace(/\/+$/, "");

    // Tombstone for the retired core/code split archives.  The objects are
    // deleted from R2, but the edge may still hold `immutable` copies for up to
    // a year; a Worker route bypasses that cache and answers immediately.
    if (/^\/larkit-truth-(core|code)-/.test(path)) {
      return json(
        {
          error: "gone",
          status: 410,
          message:
            "The core/code split packs were retired. larkit now installs one unified archive: " +
            "GET /v1/truth/latest for the current pack manifest.",
        },
        { status: 410, headers: { "cache-control": "public, max-age=300" } },
      );
    }

    if (path === "/health") {
      return json({ ok: true, service: "larkit-truth", time: new Date().toISOString() });
    }
    if (path === "" || path === "/") {
      return json({
        service: "larkit-truth",
        docs: "https://github.com/…", // placeholder, see README
        endpoints: {
          latest: "/v1/truth/latest",
          pinned: "/v1/truth/<tag>",
          index: "/v1/truth",
          health: "/health",
        },
      });
    }
    if (!path.startsWith("/v1/truth")) return fail(404, "not found");

    const rest = path.slice("/v1/truth".length).replace(/^\//, "");
    if (!rest || rest === "index") return serveIndex(env);
    if (rest === "latest") {
      return serveManifest(request, env, "manifest.json", { immutable: false });
    }
    const tag = decodeTag(rest);
    if (!tag) return fail(400, "invalid tag");
    return serveManifest(request, env, `${tag}.json`, { immutable: true });
  },
};
