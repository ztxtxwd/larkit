import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  HOME_CONFIG_FILE,
  PROJECT_CONFIG_FILE,
} from "./paths.js";
import { readJson } from "./util.js";

/**
 * Configuration layers (lowest to highest precedence):
 *   1. <data dir>/config.json     (legacy / machine level)
 *   2. ~/.larkit/config.json      (user level)
 *   3. ./larkit.config.json       (project level, next to the app you build)
 * Environment variables still win inside getAppCredentials().
 */
export function loadConfig() {
  const machine = readJson(path.join(DATA_DIR, "config.json"), {});
  const home = readJson(HOME_CONFIG_FILE, {});
  const project = readJson(PROJECT_CONFIG_FILE, {});
  const merged = {
    ...machine,
    ...home,
    ...project,
    apps: { ...(machine.apps || {}), ...(home.apps || {}), ...(project.apps || {}) },
    console: {
      ...(machine.console || {}),
      ...(home.console || {}),
      ...(project.console || {}),
    },
  };
  return merged;
}

export function getAppCredentials(appId, config = loadConfig()) {
  if (
    process.env.FEISHU_APP_ID &&
    process.env.FEISHU_APP_SECRET &&
    (!appId || appId === process.env.FEISHU_APP_ID)
  ) {
    return {
      app_id: appId || process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      source: "env",
    };
  }
  const apps = config.apps || {};
  if (appId) {
    const direct = apps[appId];
    if (direct?.app_secret) {
      return { app_id: appId, app_secret: direct.app_secret, source: "config" };
    }
    for (const [name, value] of Object.entries(apps)) {
      if (value?.app_id === appId && value?.app_secret) {
        return {
          app_id: appId,
          app_secret: value.app_secret,
          source: `config:${name}`,
        };
      }
    }
  }
  const first = Object.entries(apps).find(
    ([, value]) => value?.app_id && value?.app_secret,
  );
  if (first) {
    return {
      app_id: first[1].app_id,
      app_secret: first[1].app_secret,
      source: `config:${first[0]}`,
    };
  }
  return null;
}

export function configForMcp() {
  const config = loadConfig();
  return {
    default_profile: config.defaultProfile || config.console?.profile || null,
    apps: Object.keys(config.apps || {}),
  };
}

export function ensureConfigFile() {
  return fs.existsSync(PROJECT_CONFIG_FILE);
}

export function configPath() {
  return path.resolve(PROJECT_CONFIG_FILE);
}
