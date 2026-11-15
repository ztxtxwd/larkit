import fs from "node:fs";
import {
  AUTH_CONFIG_FILE,
  AUTH_CREDENTIALS_FILE,
  LARKIT_HOME,
} from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";

function ensureHome() {
  ensureDir(LARKIT_HOME);
  try {
    fs.chmodSync(LARKIT_HOME, 0o700);
  } catch {
    // best effort
  }
}

function readCredentials() {
  ensureHome();
  return readJson(AUTH_CREDENTIALS_FILE, { profiles: {} });
}

function writeCredentials(credentials) {
  ensureHome();
  writeJson(AUTH_CREDENTIALS_FILE, credentials);
  try {
    fs.chmodSync(AUTH_CREDENTIALS_FILE, 0o600);
  } catch {
    // best effort
  }
}

function readAuthConfig() {
  ensureHome();
  return readJson(AUTH_CONFIG_FILE, { activeProfile: null });
}

function writeAuthConfig(config) {
  ensureHome();
  // Preserve user-level keys (defaultProfile, apps, console) that share this
  // file; auth only owns `activeProfile`.
  const current = readJson(AUTH_CONFIG_FILE, {});
  writeJson(AUTH_CONFIG_FILE, { ...current, ...config });
  try {
    fs.chmodSync(AUTH_CONFIG_FILE, 0o600);
  } catch {
    // best effort
  }
}

export function listProfiles() {
  const credentials = readCredentials();
  const authConfig = readAuthConfig();
  const project = loadConfig();
  return {
    active_profile: authConfig.activeProfile || null,
    larkit_default_profile:
      project.defaultProfile || project.console?.profile || null,
    profiles: Object.entries(credentials.profiles || {}).map(([name, profile]) => ({
      name,
      active: name === authConfig.activeProfile,
      cookies: String(profile.cookies || "").split(";").filter(Boolean).length,
      created_at: profile.createdAt || null,
      updated_at: profile.updatedAt || null,
    })),
  };
}

export function resolveProfileName(profile) {
  const credentials = readCredentials();
  const authConfig = readAuthConfig();
  const project = loadConfig();
  const preferred =
    profile ||
    process.env.LARKIT_PROFILE ||
    project.defaultProfile ||
    project.console?.profile;
  if (preferred && credentials.profiles?.[preferred]) return preferred;
  if (preferred && profile) {
    throw new Error(
      `unknown larkit profile "${preferred}"; run "larkit auth list"`,
    );
  }
  return (
    authConfig.activeProfile ||
    Object.keys(credentials.profiles || {})[0] ||
    null
  );
}

export function getProfileCookies(profile) {
  const credentials = readCredentials();
  const name = resolveProfileName(profile);
  const entry = name ? credentials.profiles?.[name] : null;
  if (!entry?.cookies) {
    throw new Error(
      `no larkit profile "${name || "<none>"}"; run "larkit auth login <name>" or "larkit auth import --file <cookie.json>"`,
    );
  }
  return { name, cookies: entry.cookies, profile: entry };
}

export function saveProfile({ name, cookie, active = false } = {}) {
  if (!name) throw new Error("profile name is required");
  if (!cookie) throw new Error("cookie is required");
  const credentials = readCredentials();
  const now = new Date().toISOString();
  const existing = credentials.profiles?.[name];
  credentials.profiles = credentials.profiles || {};
  credentials.profiles[name] = {
    name,
    cookies: String(cookie).trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeCredentials(credentials);
  const authConfig = readAuthConfig();
  if (active || !authConfig.activeProfile) {
    authConfig.activeProfile = name;
    writeAuthConfig(authConfig);
  }
  return {
    ok: true,
    profile: name,
    active_profile: authConfig.activeProfile,
    cookies: String(cookie).split(";").filter(Boolean).length,
  };
}

export function setActiveProfile(name) {
  const credentials = readCredentials();
  if (!credentials.profiles?.[name]) throw new Error(`unknown profile: ${name}`);
  const authConfig = readAuthConfig();
  authConfig.activeProfile = name;
  writeAuthConfig(authConfig);
  return { ok: true, active_profile: name };
}

export function removeProfile(name) {
  const credentials = readCredentials();
  if (!credentials.profiles?.[name]) return { ok: false, error: "profile not found" };
  delete credentials.profiles[name];
  writeCredentials(credentials);
  const authConfig = readAuthConfig();
  if (authConfig.activeProfile === name) {
    authConfig.activeProfile = Object.keys(credentials.profiles)[0] || null;
    writeAuthConfig(authConfig);
  }
  return { ok: true, profile: name, active_profile: authConfig.activeProfile };
}

export function importProfiles(input, { active = false } = {}) {
  const credentials = readCredentials();
  const now = new Date().toISOString();
  let imported = 0;
  if (input && typeof input === "object" && input.profiles) {
    for (const [name, value] of Object.entries(input.profiles)) {
      const cookie = value?.cookies || value?.cookie;
      if (!cookie) continue;
      credentials.profiles[name] = {
        name,
        cookies: String(cookie).trim(),
        createdAt: value.createdAt || now,
        updatedAt: now,
      };
      imported++;
    }
  } else if (input && typeof input === "object" && input.cookie) {
    const name = input.name || "default";
    credentials.profiles[name] = {
      name,
      cookies: String(input.cookie).trim(),
      createdAt: now,
      updatedAt: now,
    };
    imported++;
  } else if (typeof input === "string" && input.includes("=")) {
    const name = "default";
    credentials.profiles[name] = {
      name,
      cookies: input.trim(),
      createdAt: now,
      updatedAt: now,
    };
    imported++;
  }
  if (!imported) throw new Error("no profiles/cookies found to import");
  writeCredentials(credentials);
  const authConfig = readAuthConfig();
  if (active || !authConfig.activeProfile) {
    authConfig.activeProfile = Object.keys(credentials.profiles)[0];
    writeAuthConfig(authConfig);
  }
  return {
    ok: true,
    imported,
    active_profile: authConfig.activeProfile,
    profiles: listProfiles().profiles,
  };
}

export function readRawCredentials() {
  return readCredentials();
}

export function authPaths() {
  return {
    home: LARKIT_HOME,
    credentials: AUTH_CREDENTIALS_FILE,
    config: AUTH_CONFIG_FILE,
  };
}
