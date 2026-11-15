import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  CONSOLE_RECIPES_FILE,
} from "../shared/paths.js";
import { getProfileCookies } from "../auth/store.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";

export const CONSOLE_BASE = "https://open.feishu.cn";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const DEFAULT_RECIPES = {
  list_apps: { method: "POST", path: "/developers/v1/app/list" },
  get_app: { method: "POST", path: "/developers/v1/app/:app_id" },
  create_app: { method: "POST", path: "/developers/v1/app/create" },
  get_credentials: { method: "POST", path: "/developers/v1/secret/:app_id" },
  update_app_info: { method: "POST", path: "/developers/v1/base_info/:app_id" },
  list_scopes: { method: "POST", path: "/developers/v1/scope/all/:app_id" },
  applied_scopes: { method: "POST", path: "/developers/v1/scope/applied/:app_id" },
  grant_scopes: { method: "POST", path: "/developers/v1/scope/update/:app_id" },
  list_versions: { method: "POST", path: "/developers/v1/app_version/list/:app_id" },
  create_version: { method: "POST", path: "/developers/v1/app_version/create/:app_id" },
  publish: { method: "POST", path: "/developers/v1/publish/commit/:app_id/:version_id" },
  release: { method: "POST", path: "/developers/v1/publish/release/:app_id/:version_id" },
  get_robot: { method: "POST", path: "/developers/v1/robot/:app_id" },
  switch_robot: { method: "POST", path: "/developers/v1/robot/switch/:app_id" },
  update_robot: { method: "POST", path: "/developers/v1/robot/update/:app_id" },
  switch_event: { method: "POST", path: "/developers/v1/event/switch/:app_id" },
  get_event: { method: "POST", path: "/developers/v1/event/:app_id" },
  update_event: { method: "POST", path: "/developers/v1/event/update/:app_id" },
  switch_callback: { method: "POST", path: "/developers/v1/callback/switch/:app_id" },
  get_callback: { method: "POST", path: "/developers/v1/callback/:app_id" },
  switch_card_callback: {
    method: "POST",
    path: "/developers/v2/robot/push_mode/switch/:app_id",
  },
};

const sessionCache = new Map();

function parseCookieString(cookie) {
  const out = {};
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function mergeSetCookie(response, cookies) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const raw of setCookies) {
    const first = raw.split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) {
      cookies[first.slice(0, index).trim()] = first.slice(index + 1).trim();
    }
  }
}

function extractAssignment(html, name) {
  const marker = `${name}=`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{") return null;
  let depth = 0;
  let quote = "";
  let escape = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function summarizeUser(user) {
  if (!user || typeof user !== "object" || Object.keys(user).length === 0) {
    return null;
  }
  const tenant = user.tenant || user.tenantInfo || {};
  return {
    name: user.name || user.userName || user.displayName || user.enName || "",
    email: user.email || "",
    user_id: user.userId || user.user_id || user.id || "",
    tenant_name: tenant.name || user.tenantName || user.tenant_name || "",
    tenant_id: tenant.id || tenant.tenantId || user.tenantId || user.tenant_id || "",
    is_admin: Boolean(user.isAdmin || user.is_admin),
  };
}

export async function resolveConsoleSession(profile, { force = false } = {}) {
  const { name, cookies: rawCookie } = getProfileCookies(profile);
  const cached = sessionCache.get(name);
  if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return cached;
  }
  const cookies = parseCookieString(rawCookie);
  const response = await fetch(`${CONSOLE_BASE}/app`, {
    headers: {
      Cookie: cookieString(cookies),
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  mergeSetCookie(response, cookies);
  const html = await response.text();
  const csrfMatch = html.match(/window\.csrfToken="([^"]+)"/);
  const csrf = csrfMatch?.[1] || cookies.lark_oapi_csrf_token || "";
  const user = summarizeUser(extractAssignment(html, "window.user"));
  const session = {
    profile: name,
    cookie: cookieString(cookies),
    csrf,
    user,
    valid: Boolean(user) && Boolean(csrf),
    page_status: response.status,
    at: Date.now(),
  };
  sessionCache.set(name, session);
  return session;
}

export function invalidateSession(profile) {
  if (profile) sessionCache.delete(profile);
  else sessionCache.clear();
}

function recipeFile() {
  return readJson(CONSOLE_RECIPES_FILE, { version: 1, recipes: {} });
}

export function getRecipe(action) {
  const file = recipeFile();
  return file.recipes?.[action] || DEFAULT_RECIPES[action] || null;
}

export function recordRecipe(action, recipe) {
  if (!action) return;
  ensureDir(CONSOLE_RECIPES_FILE.replace(/\/[^/]+$/, ""));
  const file = recipeFile();
  file.version = 1;
  file.recipes = file.recipes || {};
  file.recipes[action] = {
    ...(file.recipes[action] || {}),
    ...recipe,
    recorded_at: new Date().toISOString(),
  };
  writeJson(CONSOLE_RECIPES_FILE, file);
}

export function listRecipes() {
  return recipeFile().recipes || {};
}

function pathFor(action, params = {}) {
  const recipe = getRecipe(action);
  if (!recipe) return null;
  let path = recipe.path;
  path = path.replace(":app_id", params.app_id || params.appId || "");
  path = path.replace(":version_id", params.version_id || params.versionId || "");
  return path;
}

export async function consoleRequest({
  action,
  path,
  method = "POST",
  body = {},
  profile,
  headers = {},
  timeout = 30_000,
  retry = true,
} = {}) {
  const session = await resolveConsoleSession(profile);
  if (!session.valid) {
    return {
      ok: false,
      status: 401,
      code: null,
      msg: `Feishu console session is not logged in (profile=${session.profile})`,
      needs_login: true,
      data: null,
    };
  }
  const finalPath = path || (action ? pathFor(action, body) : null);
  if (!finalPath) throw new Error(`unknown console action: ${action}`);
  const url = finalPath.startsWith("http")
    ? finalPath
    : `${CONSOLE_BASE}${finalPath.startsWith("/") ? "" : "/"}${finalPath}`;
  const requestHeaders = {
    Cookie: session.cookie,
    "x-csrf-token": session.csrf,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "User-Agent": USER_AGENT,
    Origin: CONSOLE_BASE,
    Referer: `${CONSOLE_BASE}/app`,
    "X-Timezone-Offset": String(new Date().getTimezoneOffset()),
    "X-Request-Id": randomUUID(),
    ...headers,
  };
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: null,
      msg: error instanceof Error ? error.message : String(error),
      data: null,
      url,
    };
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const code = parsed?.code ?? null;
  const msg = parsed?.msg ?? parsed?.message ?? "";
  const ok = response.ok && (code === null || code === 0);
  const result = {
    ok,
    status: response.status,
    code,
    msg,
    data: parsed?.data ?? parsed ?? null,
    url,
    raw: parsed ? undefined : text.slice(0, 2000),
    needs_login:
      response.status === 401 ||
      response.status === 403 ||
      code === 9499 ||
      /csrf|login|session/i.test(msg),
  };
  if (!ok && retry && (result.needs_login || response.status === 401)) {
    invalidateSession(session.profile);
    return consoleRequest({
      action,
      path: finalPath,
      method,
      body,
      profile: session.profile,
      headers,
      timeout,
      retry: false,
    });
  }
  return result;
}

export function summarizeApp(app) {
  const owner = app.owner || {};
  return {
    app_id: app.appID || app.clientID || app.appId || "",
    name: app.name || app.i18n?.zh_cn?.name || "",
    desc: app.desc || app.i18n?.zh_cn?.description || "",
    status: app.appStatus,
    dev_status: app.appListDevStatus,
    list_status: app.appListStatus,
    app_type: app.appType,
    abilities: app.ability || [],
    version: app.version,
    owner: owner.displayName?.value || owner.displayName || "",
    updated_at: app.updateTime || null,
  };
}

export async function listApps({ profile, limit = 50, query = "" } = {}) {
  const body = { Count: Math.max(1, Math.min(Number(limit) || 50, 200)), Cursor: 0 };
  if (query) {
    body.QueryFilter = { Query: query };
  }
  const response = await consoleRequest({
    action: "list_apps",
    method: "POST",
    body,
    profile,
  });
  if (!response.ok) return { ...response, apps: [] };
  const data = response.data || {};
  const apps = (data.apps || []).map(summarizeApp);
  return {
    ok: true,
    status: response.status,
    total: Number(data.totalCount ?? data.total ?? apps.length),
    apps,
  };
}

export async function getApp({ appId, profile } = {}) {
  if (!appId) throw new Error("app_id is required");
  const response = await consoleRequest({
    action: "get_app",
    method: "POST",
    body: {},
    path: pathFor("get_app", { app_id: appId }),
    profile,
  });
  return { ...response, app: response.ok ? response.data : null };
}

export async function getCredentials({ appId, profile } = {}) {
  if (!appId) throw new Error("app_id is required");
  const [app, secret] = await Promise.all([
    getApp({ appId, profile }),
    consoleRequest({
      action: "get_credentials",
      method: "POST",
      body: {},
      path: pathFor("get_credentials", { app_id: appId }),
      profile,
    }),
  ]);
  if (!secret.ok) return { ...secret, app_id: appId };
  const appSecret = secret.data?.secret || secret.data?.appSecret || secret.data?.app_secret || "";
  return {
    ok: true,
    app_id: appId,
    app_name: app.app?.name || "",
    app_secret: appSecret,
    secret_restricted: Boolean(app.app?.secretRestricted),
    source: "console",
  };
}

export async function updateAppInfo({
  appId,
  name,
  desc,
  avatar,
  i18n,
  languages,
  profile,
  dryRun = false,
} = {}) {
  if (!appId) throw new Error("app_id is required");
  const app = await getApp({ appId, profile });
  const primary = app.app?.primaryLang || app.app?.langs?.[0] || "zh_cn";
  const nextI18n = i18n
    ? i18n
    : name || desc
      ? {
          [primary]: {
            ...(name ? { name } : {}),
            ...(desc ? { description: desc } : {}),
          },
        }
      : undefined;
  const body = {
    clientId: appId,
    ...(name ? { name } : {}),
    ...(desc ? { desc } : {}),
    ...(avatar ? { avatar } : {}),
    ...(languages ? { languages } : {}),
    ...(nextI18n ? { i18n: nextI18n } : {}),
  };
  const plan = {
    action: "update_app_info",
    method: "POST",
    path: pathFor("update_app_info", { app_id: appId }),
    body,
  };
  if (dryRun) return { ok: true, dry_run: true, plan };
  const response = await consoleRequest({
    action: "update_app_info",
    method: "POST",
    path: plan.path,
    body,
    profile,
  });
  return { ...response, plan };
}

export async function createApp({
  name,
  desc = "",
  avatar = "",
  appSceneType = 0,
  primaryLang = "zh_cn",
  profile,
  dryRun = false,
} = {}) {
  if (!name) throw new Error("name is required");
  const body = {
    fromProduct: 0,
    appSceneType,
    name,
    desc,
    avatar,
    primaryLang,
    i18n: {
      [primaryLang]: {
        name,
        description: desc,
      },
    },
  };
  const plan = {
    action: "create_app",
    method: "POST",
    path: pathFor("create_app"),
    body,
  };
  if (dryRun) return { ok: true, dry_run: true, plan };
  const response = await consoleRequest({
    action: "create_app",
    method: "POST",
    path: plan.path,
    body,
    profile,
  });
  return {
    ...response,
    app_id: response.data?.ClientID || response.data?.clientID || response.data?.appID,
    plan,
  };
}

export async function listScopes({ appId, profile } = {}) {
  if (!appId) throw new Error("app_id is required");
  const response = await consoleRequest({
    action: "list_scopes",
    method: "POST",
    body: { clientId: appId },
    path: pathFor("list_scopes", { app_id: appId }),
    profile,
  });
  if (!response.ok) return { ...response, scopes: [], scope_bizs: [] };
  const data = response.data || {};
  return {
    ok: true,
    total: (data.scopes || []).length,
    scope_bizs: (data.scopeBizs || []).map((biz) => ({
      id: biz.bizId,
      name: biz.bizName,
    })),
    scopes: (data.scopes || []).map((scope) => ({
      id: scope.id,
      name: scope.name,
      biz: scope.bizId,
      status: scope.status,
      levels: scope.levels,
      desc: scope.desc,
      identity_types: scope.supportScopeIdentityTypes || scope.scopeIdentityType,
    })),
  };
}

export async function appliedScopes({ appId, profile } = {}) {
  if (!appId) throw new Error("app_id is required");
  const response = await consoleRequest({
    action: "applied_scopes",
    method: "POST",
    body: { clientId: appId },
    path: pathFor("applied_scopes", { app_id: appId }),
    profile,
  });
  if (!response.ok) return { ...response, scopes: [] };
  const data = response.data || {};
  return {
    ok: true,
    total: (data.scopes || []).length,
    scopes: (data.scopes || []).map((scope) => ({
      id: scope.id,
      name: scope.name,
      biz: scope.bizId,
      status: scope.status,
    })),
  };
}

async function searchScope({ appId, scopeName, profile }) {
  const response = await consoleRequest({
    action: "search_scope",
    method: "POST",
    body: { clientId: appId, query: scopeName },
    path: `/developers/v1/scope/search/${appId}`,
    profile,
  });
  if (!response.ok) return null;
  const data = response.data || {};
  const list = data.scopes || data.scopeNames || data.items || [];
  if (!list.length) return null;
  const hit = list.find((item) => item.name === scopeName || item === scopeName);
  return hit || list[0] || null;
}

export async function grantScopes({
  appId,
  scopes = [],
  scopeType = "app",
  operation = "add",
  profile,
  dryRun = false,
} = {}) {
  if (!appId) throw new Error("app_id is required");
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("scopes must be a non-empty array of scope names");
  }
  const all = await listScopes({ appId, profile });
  if (!all.ok) return all;
  const byName = new Map(all.scopes.map((scope) => [scope.name, scope]));
  const resolved = [];
  const missing = [];
  for (const name of scopes) {
    const hit = byName.get(name);
    if (hit) resolved.push(hit);
    else {
      const remote = await searchScope({ appId, scopeName: name, profile });
      if (remote?.id) resolved.push(remote);
      else missing.push(name);
    }
  }
  const ids = resolved.map((scope) => String(scope.id));
  const body = {
    clientId: appId,
    operation,
    scopeIds: [],
    ...(scopeType === "user" || scopeType === "both"
      ? { userScopeIDs: ids }
      : { appScopeIDs: ids }),
    ...(scopeType === "both" ? { appScopeIDs: ids } : {}),
  };
  const plan = {
    action: "grant_scopes",
    method: "POST",
    path: pathFor("grant_scopes", { app_id: appId }),
    body,
    resolved: resolved.map((s) => ({ id: s.id, name: s.name })),
    missing,
  };
  if (missing.length && resolved.length === 0) {
    return { ok: false, error: "no scope names resolved", plan };
  }
  if (dryRun) return { ok: true, dry_run: true, plan };
  const response = await consoleRequest({
    action: "grant_scopes",
    method: "POST",
    path: plan.path,
    body,
    profile,
  });
  return { ...response, plan };
}

export async function listVersions({ appId, profile } = {}) {
  if (!appId) throw new Error("app_id is required");
  const response = await consoleRequest({
    action: "list_versions",
    method: "POST",
    body: { clientId: appId },
    path: pathFor("list_versions", { app_id: appId }),
    profile,
  });
  if (!response.ok) return { ...response, versions: [] };
  const data = response.data || {};
  return {
    ok: true,
    versions: (data.versions || []).map((version) => ({
      version_id: version.versionId,
      app_version: version.appVersion,
      status: version.versionStatus,
      remark: version.updateRemark,
      create_time: version.createTime,
      publish_time: version.publishTime,
    })),
  };
}

export async function enableBotWs({
  appId,
  enableBot = true,
  enableEvents = true,
  enableCallbacks = true,
  enableCardRequestMode = false,
  profile,
  dryRun = false,
} = {}) {
  if (!appId) throw new Error("app_id is required");
  const calls = [];
  if (enableBot) {
    calls.push({
      action: "switch_robot",
      path: pathFor("switch_robot", { app_id: appId }),
      body: { clientId: appId, enable: true },
    });
  }
  if (enableEvents) {
    calls.push({
      action: "switch_event",
      path: pathFor("switch_event", { app_id: appId }),
      body: { clientId: appId, eventMode: 4 },
    });
  }
  if (enableCallbacks) {
    calls.push({
      action: "switch_callback",
      path: pathFor("switch_callback", { app_id: appId }),
      body: { clientId: appId, callbackMode: 4 },
    });
  }
  if (enableCardRequestMode) {
    calls.push({
      action: "switch_card_callback",
      path: pathFor("switch_card_callback", { app_id: appId }),
      body: { clientId: appId, callbackMode: 1 },
    });
  }
  if (dryRun) return { ok: true, dry_run: true, calls };

  const results = [];
  for (const call of calls) {
    results.push({
      action: call.action,
      ...(await consoleRequest({
        action: call.action,
        method: "POST",
        path: call.path,
        body: call.body,
        profile,
      })),
    });
  }
  const [robot, event, callback] = await Promise.all([
    consoleRequest({
      action: "get_robot",
      method: "POST",
      body: { clientId: appId },
      path: pathFor("get_robot", { app_id: appId }),
      profile,
    }),
    consoleRequest({
      action: "get_event",
      method: "POST",
      body: { clientId: appId, needEventDetail: false },
      path: pathFor("get_event", { app_id: appId }),
      profile,
    }),
    consoleRequest({
      action: "get_callback",
      method: "POST",
      body: { clientId: appId },
      path: pathFor("get_callback", { app_id: appId }),
      profile,
    }),
  ]);
  return {
    ok: results.every((result) => result.ok),
    calls: results,
    verification: {
      bot_enabled: Boolean(robot.data?.enable),
      event_mode: event.data?.eventMode,
      callback_mode: callback.data?.callbackMode,
      card_request_mode: robot.data?.cardCallbackMode,
      events: event.data?.events || [],
      callbacks: callback.data?.callbacks || [],
    },
    raw: {
      robot: robot.data,
      event: event.data,
      callback: callback.data,
    },
  };
}

export async function publishVersion({
  appId,
  version,
  remark = "",
  fullRelease = false,
  createIfMissing = true,
  release = false,
  profile,
  dryRun = false,
} = {}) {
  if (!appId) throw new Error("app_id is required");
  const versions = await listVersions({ appId, profile });
  if (!versions.ok) return versions;
  let target = versions.versions.find((v) => v.version_id && v.status !== 2);
  const plan = { action: "publish", app_id: appId, steps: [] };
  let created = false;
  if (!target && createIfMissing) {
    const createBody = {
      clientId: appId,
      appVersion: version || nextVersion(versions.versions),
      updateRemark: remark || "larkit automated publish",
      visibleSuggest: {},
      changeLog: remark || "larkit automated publish",
    };
    plan.steps.push({
      action: "create_version",
      path: pathFor("create_version", { app_id: appId }),
      body: createBody,
    });
    if (!dryRun) {
      const createdResponse = await consoleRequest({
        action: "create_version",
        method: "POST",
        path: pathFor("create_version", { app_id: appId }),
        body: createBody,
        profile,
      });
      if (!createdResponse.ok) return { ...createdResponse, plan };
      created = true;
      target = {
        version_id:
          createdResponse.data?.versionId ||
          createdResponse.data?.version_id ||
          createdResponse.data?.VersionId,
        app_version: createBody.appVersion,
      };
      if (!target.version_id) {
        return {
          ok: false,
          error: "version created but versionId missing from response",
          response: createdResponse,
          plan,
        };
      }
    } else {
      target = { version_id: "<new>", app_version: createBody.appVersion };
    }
  }
  if (!target?.version_id) {
    return {
      ok: false,
      error: "no draft version found; pass create_if_missing=true and a version",
      versions: versions.versions,
      plan,
    };
  }
  const commitBody = { clientId: appId, versionId: target.version_id, is_full_release: fullRelease };
  plan.steps.push({
    action: "publish",
    path: pathFor("publish", { app_id: appId, version_id: target.version_id }),
    body: commitBody,
  });
  if (release) {
    plan.steps.push({
      action: "release",
      path: pathFor("release", { app_id: appId, version_id: target.version_id }),
      body: commitBody,
    });
  }
  if (dryRun) return { ok: true, dry_run: true, plan, versions: versions.versions };
  const commitResponse = await consoleRequest({
    action: "publish",
    method: "POST",
    path: pathFor("publish", { app_id: appId, version_id: target.version_id }),
    body: commitBody,
    profile,
  });
  if (!commitResponse.ok) return { ...commitResponse, plan };
  let releaseResponse = null;
  if (release) {
    releaseResponse = await consoleRequest({
      action: "release",
      method: "POST",
      path: pathFor("release", { app_id: appId, version_id: target.version_id }),
      body: commitBody,
      profile,
    });
  }
  return {
    ok: releaseResponse ? releaseResponse.ok : true,
    created_version: created,
    version: target,
    commit: commitResponse,
    release: releaseResponse,
    plan,
  };
}

function nextVersion(versions) {
  const latest = versions.find((v) => /^\d+\.\d+\.\d+$/.test(v.app_version || ""));
  if (!latest) return "1.0.0";
  const [major, minor, patch] = latest.app_version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
