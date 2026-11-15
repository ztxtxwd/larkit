import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../shared/paths.js";
import { getAppCredentials, loadConfig } from "../shared/config.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";

const TOKEN_FILE = path.join(CACHE_DIR, "tokens.json");
const OPENAPI_BASE = "https://open.feishu.cn";

function loadTokens() {
  return readJson(TOKEN_FILE, {});
}

function saveTokens(tokens) {
  ensureDir(CACHE_DIR);
  writeJson(TOKEN_FILE, tokens);
}

export async function getTenantToken({ appId, appSecret, force = false } = {}) {
  let resolved = appId && appSecret ? { app_id: appId, app_secret: appSecret, source: "args" } : getAppCredentials(appId);
  if (!resolved) {
    throw new Error(
      "app_id/app_secret required (args, larkit.config.json apps, or FEISHU_APP_ID/FEISHU_APP_SECRET)",
    );
  }
  const tokens = loadTokens();
  const cached = tokens[resolved.app_id];
  if (!force && cached && cached.expires_at > Date.now() + 60_000) {
    return { ...cached, cached: true };
  }
  const response = await fetch(
    `${OPENAPI_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: resolved.app_id,
        app_secret: resolved.app_secret,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const data = await response.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(
      `tenant_access_token failed: code=${data.code} msg=${data.msg || "unknown"}`,
    );
  }
  const expiresAt = Date.now() + Math.max(60, Number(data.expire) || 7200) * 1000;
  const token = {
    app_id: resolved.app_id,
    tenant_access_token: data.tenant_access_token,
    expires_at: expiresAt,
    obtained_at: Date.now(),
    source: resolved.source,
  };
  tokens[resolved.app_id] = token;
  saveTokens(tokens);
  return { ...token, cached: false };
}

export function clearToken(appId) {
  const tokens = loadTokens();
  if (appId) delete tokens[appId];
  else for (const key of Object.keys(tokens)) delete tokens[key];
  saveTokens(tokens);
  return { ok: true, cleared: appId || "all" };
}

function normalizePath(input) {
  let p = String(input || "").trim();
  if (!p) throw new Error("path is required");
  if (/^https?:\/\//i.test(p)) return p;
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.startsWith("/open-apis/")) p = `/open-apis${p}`;
  return `${OPENAPI_BASE}${p}`;
}

function truncateDeep(value, maxChars = 12_000) {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return {
    _truncated: true,
    _original_chars: text.length,
    preview: text.slice(0, maxChars),
  };
}

export async function probeOpenApi({
  appId,
  appSecret,
  method = "GET",
  path: apiPath,
  query,
  body,
  headers = {},
  userAccessToken,
  tenantAccessToken,
  forceToken = false,
  timeout = 30_000,
} = {}) {
  if (!apiPath) throw new Error("path is required");
  let token = tenantAccessToken || "";
  let tokenSource = tenantAccessToken ? "arg" : "";
  if (!token && !userAccessToken) {
    const t = await getTenantToken({ appId, appSecret, force: forceToken });
    token = t.tenant_access_token;
    tokenSource = t.cached ? "cache" : "fresh";
  }
  const url = new URL(normalizePath(apiPath));
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const requestHeaders = {
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
    ...headers,
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  else if (userAccessToken) requestHeaders.Authorization = `Bearer ${userAccessToken}`;
  const hasBody = body !== undefined && body !== null && method !== "GET" && method !== "HEAD";
  if (hasBody) requestHeaders["Content-Type"] = "application/json; charset=utf-8";
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: method.toUpperCase(),
      headers: requestHeaders,
      body: hasBody
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    return {
      ok: false,
      mode: "openapi",
      error: error instanceof Error ? error.message : String(error),
      request: { method, url: url.toString() },
      elapsed_ms: Date.now() - t0,
    };
  }
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON response
  }
  const code = json?.code ?? null;
  const msg = json?.msg ?? json?.message ?? (json ? "" : raw.slice(0, 500));
  return {
    ok: response.ok && (code === null || code === 0),
    mode: "openapi",
    status: response.status,
    code,
    msg,
    log_id:
      response.headers.get("x-tt-logid") ||
      response.headers.get("x-request-id") ||
      json?.log_id ||
      json?.data?.log_id,
    token_source: tokenSource,
    request: {
      method: method.toUpperCase(),
      url: url.toString(),
      body: hasBody ? truncateDeep(body, 4000) : undefined,
    },
    data: json?.data !== undefined ? truncateDeep(json.data) : undefined,
    body: json ? truncateDeep(json) : raw.slice(0, 12_000),
    raw_bytes: Buffer.byteLength(raw),
    elapsed_ms: Date.now() - t0,
  };
}

export function tokenStatus() {
  const tokens = loadTokens();
  return Object.values(tokens).map((token) => ({
    app_id: token.app_id,
    expires_at: new Date(token.expires_at).toISOString(),
    valid: token.expires_at > Date.now(),
    source: token.source,
  }));
}
