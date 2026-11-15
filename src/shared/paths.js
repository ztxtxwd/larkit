import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PKG_ROOT is the immutable package directory (src/, skills/, protocol data).
 * LARKIT_HOME is the mutable per-user directory created by `larkit init`.
 *
 * A git checkout keeps using the historical in-repo `.larkit-data/` layout so
 * `pnpm index` / `pnpm verify` continue to work unchanged.  An installed CLI
 * (global install or `npx larkit`) has no `.larkit-data/` next to the package
 * and therefore stores everything under `~/.larkit/`.
 */
export const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Backwards-compatible alias: code that reads bundled assets uses ROOT. */
export const ROOT = PKG_ROOT;

const REPO_DATA_DIR = path.join(PKG_ROOT, ".larkit-data");
export const IS_REPO_CHECKOUT =
  fs.existsSync(path.join(PKG_ROOT, ".git")) ||
  fs.existsSync(path.join(PKG_ROOT, "pnpm-lock.yaml"));

const HAS_REPO_DATA = fs.existsSync(REPO_DATA_DIR);

export const LARKIT_HOME = process.env.LARKIT_HOME
  ? path.resolve(process.env.LARKIT_HOME)
  : path.join(os.homedir(), ".larkit");

export const DATA_DIR = process.env.LARKIT_DATA_DIR
  ? path.resolve(process.env.LARKIT_DATA_DIR)
  : HAS_REPO_DATA
    ? REPO_DATA_DIR
    : path.join(LARKIT_HOME, "data");

export const VERIFIED_DIR = process.env.LARKIT_VERIFIED_DIR
  ? path.resolve(process.env.LARKIT_VERIFIED_DIR)
  : HAS_REPO_DATA
    ? path.join(PKG_ROOT, "verified_truths")
    : path.join(LARKIT_HOME, "verified_truths");

export const RAW_DIR = path.join(DATA_DIR, "raw");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const DEB_ROOT = path.join(RAW_DIR, "deb-root");
export const FEISHU_APP_DIR = path.join(
  DEB_ROOT,
  "opt",
  "bytedance",
  "feishu",
);
export const ELECTRON_EXTRACT_DIR = path.join(
  DATA_DIR,
  "extracted",
  "electron",
);
export const FORMATTED_DIR = path.join(DATA_DIR, "formatted");
export const TRUTH_DB = path.join(DATA_DIR, "truth.db");
export const TRUTH_META = path.join(DATA_DIR, "truth.meta.json");
export const WEB_INDEX = path.join(RAW_DIR, "web-index.json");
export const ELECTRON_INDEX = path.join(RAW_DIR, "electron-index.json");
export const EXTRACT_MANIFEST = path.join(RAW_DIR, "manifest.extract.json");
export const FORMAT_MANIFEST = path.join(
  FORMATTED_DIR,
  ".format-manifest.json",
);
export const ANCHORS_JSONL = path.join(RAW_DIR, "anchors.jsonl");
export const PROTOCOL_CATALOG_JSON = path.join(
  RAW_DIR,
  "protocol-catalog.json",
);
export const PROTOCOL_DOCS_JSON = path.join(RAW_DIR, "protocol-docs.json");

export const PROTOCOL_REFERENCE_DIR = path.join(
  PKG_ROOT,
  "src",
  "protocol",
  "data",
  "reference",
);

/** Immutable assets shipped inside the npm package. */
export const SKILL_SOURCE_DIR = path.join(PKG_ROOT, "skills", "larkit");

/** Mutable per-user locations. */
export const INSTALL_STATE_FILE = path.join(LARKIT_HOME, "install.json");
export const INSTALL_LOCK_FILE = path.join(LARKIT_HOME, ".install.lock");
export const CLI_INSTALL_DIR = path.join(LARKIT_HOME, "cli");
export const DOWNLOAD_DIR = path.join(LARKIT_HOME, "downloads");
export const LOG_FILE = path.join(LARKIT_HOME, "install.log");
export const BIN_DIR = process.env.LARKIT_BIN_DIR
  ? path.resolve(process.env.LARKIT_BIN_DIR)
  : path.join(os.homedir(), ".local", "bin");
export const MCP_CONFIG_FILE = path.join(LARKIT_HOME, "mcp.json");

/** Configuration: project-local overrides user-level defaults. */
export const PROJECT_CONFIG_FILE = process.env.LARKIT_CONFIG
  ? path.resolve(process.env.LARKIT_CONFIG)
  : path.join(process.cwd(), "larkit.config.json");
export const HOME_CONFIG_FILE = path.join(LARKIT_HOME, "config.json");
/** Backwards-compatible exports. */
export const CONFIG_FILE = PROJECT_CONFIG_FILE;
export const LOCAL_CONFIG_FILE = HOME_CONFIG_FILE;

export const AUTH_CREDENTIALS_FILE = path.join(
  LARKIT_HOME,
  "credentials.json",
);
export const AUTH_CONFIG_FILE = path.join(LARKIT_HOME, "config.json");
export const CONSOLE_RECIPES_FILE = path.join(
  DATA_DIR,
  "console-api-recipes.json",
);

/** Build inputs (only needed for `larkit init --from-assets`). */
export const WEB_DUMP_DIR = process.env.LARKIT_WEB_DUMP
  ? path.resolve(process.env.LARKIT_WEB_DUMP)
  : path.join(PKG_ROOT, "feishu-web-dump");
export const WEB_SUMMARY = path.join(WEB_DUMP_DIR, "summary.json");
export const DEB_FILE = process.env.LARKIT_DEB
  ? path.resolve(process.env.LARKIT_DEB)
  : [
      path.join(PKG_ROOT, "feishu-linux.deb"),
      path.join(LARKIT_HOME, "assets", "feishu-linux.deb"),
    ].find((candidate) => fs.existsSync(candidate)) ||
    path.join(PKG_ROOT, "feishu-linux.deb");

/** Render a user-facing relative path that does not leak the install layout. */
export function displayPath(target) {
  const resolved = path.resolve(target);
  const formatted = path.resolve(FORMATTED_DIR);
  const verified = path.resolve(VERIFIED_DIR);
  const root = path.resolve(ROOT);
  if (resolved === formatted || resolved.startsWith(formatted + path.sep)) {
    return `formatted/${path.relative(formatted, resolved).split(path.sep).join("/")}`;
  }
  if (resolved === verified || resolved.startsWith(verified + path.sep)) {
    return `verified_truths/${path.relative(verified, resolved).split(path.sep).join("/")}`;
  }
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    return path.relative(root, resolved).split(path.sep).join("/");
  }
  const data = path.resolve(DATA_DIR);
  if (resolved === data || resolved.startsWith(data + path.sep)) {
    return path.relative(data, resolved).split(path.sep).join("/");
  }
  return resolved;
}
