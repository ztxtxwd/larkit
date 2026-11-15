import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CACHE_DIR,
  LOCAL_CONFIG_FILE,
  ROOT,
} from "../shared/paths.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";
import { resolveConsoleSession } from "../console/client.js";
import {
  authPaths,
  getProfileCookies,
  importProfiles,
  listProfiles,
  removeProfile,
  resolveProfileName,
  setActiveProfile,
} from "./store.js";
import { loginWithQr } from "./login.js";

function statusFileFor(name) {
  const safe = String(name || "default").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return path.join(CACHE_DIR, "login", `${safe}.status.json`);
}

export function authList() {
  return {
    ...listProfiles(),
    home: authPaths().home,
    credentials_file: authPaths().credentials,
  };
}

export async function whoami({ profile } = {}) {
  const name = resolveProfileName(profile);
  if (!name) {
    return { ok: false, error: "no larkit profiles; run lark_auth action=login or import" };
  }
  getProfileCookies(name);
  try {
    const session = await resolveConsoleSession(name, { force: true });
    return {
      ok: session.valid,
      profile: name,
      user: session.user,
      console_logged_in: session.valid,
      hint: session.valid
        ? undefined
        : "cookie expired; run lark_auth action=login or import a fresh cookie",
    };
  } catch (error) {
    return {
      ok: false,
      profile: name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkAuth({ profile } = {}) {
  const name = resolveProfileName(profile);
  if (!name) {
    return { ok: false, error: "no larkit profiles; run lark_auth action=login or import" };
  }
  try {
    const session = await resolveConsoleSession(name, { force: true });
    return {
      ok: session.valid,
      profile: name,
      user: session.user,
      console_logged_in: session.valid,
      page_status: session.page_status,
      csrf_present: Boolean(session.csrf),
      hint: session.valid
        ? undefined
        : "cookie expired; run lark_auth action=login or import a fresh cookie",
    };
  } catch (error) {
    return {
      ok: false,
      profile: name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function useProfile(name) {
  if (!name) throw new Error("profile name is required");
  const result = setActiveProfile(name);
  const local = readJson(LOCAL_CONFIG_FILE, {});
  writeJson(LOCAL_CONFIG_FILE, { ...local, defaultProfile: name });
  return { ...result, default_profile: name };
}

export function cookieFor(profile) {
  const { name, cookies } = getProfileCookies(profile);
  return { ok: true, profile: name, cookie: cookies, length: cookies.length };
}

export function startLogin(
  name = "default",
  { timeoutMs = 120_000, headless = true, wait = false } = {},
) {
  ensureDir(path.join(CACHE_DIR, "login"));
  const statusFile = statusFileFor(name);
  if (wait) {
    const result = loginWithQr({ name, timeoutMs, headless, statusFile });
    return result;
  }
  const logPath = path.join(CACHE_DIR, "login", `${name.replace(/[^\w.-]+/g, "_")}.log`);
  const fd = fs.openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "scripts", "login-worker.mjs"),
      "--name",
      name,
      "--timeout",
      String(timeoutMs),
      "--status",
      statusFile,
      headless ? "--headless" : "--headful",
    ],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: ROOT,
      env: { ...process.env },
    },
  );
  child.unref();
  fs.closeSync(fd);
  return {
    ok: true,
    started: true,
    profile: name,
    pid: child.pid,
    status_file: statusFile,
    log_path: logPath,
    qr_path: path.join(CACHE_DIR, "login", "*.png"),
    hint:
      "Login worker started. Wait a few seconds, read status_file for qr_path, scan the PNG with Feishu, then call lark_auth action=check.",
  };
}

export function loginStatus(name = "default") {
  const statusFile = statusFileFor(name);
  if (!fs.existsSync(statusFile)) {
    return { ok: false, profile: name, status_file: statusFile, error: "no login status yet" };
  }
  return { ok: true, profile: name, status_file: statusFile, ...readJson(statusFile, {}) };
}

export function logout(name) {
  if (!name) throw new Error("profile name is required");
  return removeProfile(name);
}

export function importAuth({ file, cookie, name = "default", active = true } = {}) {
  let input = cookie;
  if (file) {
    const text = fs.readFileSync(path.resolve(file), "utf8");
    try {
      input = JSON.parse(text);
    } catch {
      input = text;
    }
  }
  if (!input) throw new Error("cookie or file is required");
  return importProfiles(input, { active });
}

export function authDispatch({
  action,
  profile,
  name,
  browser,
  file,
  cookie,
  wait,
  timeout_ms: timeoutMs,
  headless,
} = {}) {
  switch (action) {
    case "list":
      return authList();
    case "whoami":
      return whoami({ profile });
    case "check":
      return checkAuth({ profile });
    case "use":
      return useProfile(name || profile);
    case "cookie":
      return cookieFor(profile);
    case "login":
      return startLogin(name || profile || "default", {
        timeoutMs,
        wait,
        headless: headless !== false && browser !== "headful",
      });
    case "login_status":
      return loginStatus(name || profile || "default");
    case "import":
      return importAuth({ file, cookie, name: name || profile || "default" });
    case "logout":
      return logout(name || profile);
    default:
      throw new Error(
        `unknown auth action: ${action}; expected list|whoami|check|use|cookie|login|login_status|import|logout`,
      );
  }
}
