import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  BIN_DIR,
  CLI_INSTALL_DIR,
  IS_REPO_CHECKOUT,
  PKG_ROOT,
  displayPath,
} from "../shared/paths.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";

function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n");
    throw new Error(`npm ${args[0]} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

function shimBody(target) {
  return `#!/usr/bin/env sh\nexec node "${target}" "$@"\n`;
}

function cmdShimBody(target) {
  return `@echo off\r\nnode "${target}" %*\r\n`;
}

function writeShims(entry, binDir) {
  const binDirOfPackage = path.dirname(entry);
  const targets = {
    larkit: path.join(binDirOfPackage, "larkit.js"),
    "larkit-mcp": path.join(binDirOfPackage, "larkit-mcp.js"),
  };
  ensureDir(binDir);
  const written = [];
  for (const [name, target] of Object.entries(targets)) {
    if (!fs.existsSync(target)) continue;
    const file = path.join(binDir, name);
    fs.writeFileSync(file, shimBody(target));
    fs.chmodSync(file, 0o755);
    written.push(file);
    if (process.platform === "win32") {
      const cmd = `${file}.cmd`;
      fs.writeFileSync(cmd, cmdShimBody(target));
      written.push(cmd);
    }
  }
  return written;
}

export function binDirOnPath(binDir = BIN_DIR) {
  const parts = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((part) => path.resolve(part));
  return parts.includes(path.resolve(binDir));
}

export function detectCliInstall({ binDir = BIN_DIR } = {}) {
  const shim = path.join(binDir, "larkit");
  const installedPackage = path.join(CLI_INSTALL_DIR, "node_modules", "larkit", "package.json");
  const repoVersion = IS_REPO_CHECKOUT
    ? readJson(path.join(PKG_ROOT, "package.json"), {}).version || null
    : null;
  return {
    shim,
    shim_installed: fs.existsSync(shim),
    bin_dir: binDir,
    on_path: binDirOnPath(binDir),
    mode: fs.existsSync(installedPackage)
      ? "local-prefix"
      : IS_REPO_CHECKOUT
        ? "repo"
        : null,
    version: readJson(installedPackage, {}).version || repoVersion,
  };
}

/**
 * Install a durable `larkit` command.
 *
 * Default strategy: install the package into ~/.larkit/cli and drop a tiny
 * shell shim into ~/.local/bin, so no sudo/global prefix is required and the
 * command survives npx cache cleanup.  In a git checkout the shim points at
 * the checkout itself.  `--global` delegates to `npm install -g`.
 */
export function installCli({
  version,
  force = false,
  global = false,
  binDir = BIN_DIR,
  source = null,
} = {}) {
  if (global) {
    const target = source || `larkit@${version}`;
    runNpm(["install", "-g", target, "--no-audit", "--no-fund", "--loglevel=error"]);
    return {
      mode: "global",
      entry: null,
      shim: null,
      bin_dir: binDir,
      on_path: binDirOnPath(binDir),
      status: "installed",
    };
  }

  const devCheckout =
    IS_REPO_CHECKOUT && fs.existsSync(path.join(PKG_ROOT, "bin", "larkit.js"));

  if (devCheckout && !source) {
    const entry = path.join(PKG_ROOT, "bin", "larkit.js");
    const written = writeShims(entry, binDir);
    return {
      mode: "repo",
      entry,
      shim: path.join(binDir, "larkit"),
      shims: written,
      bin_dir: binDir,
      on_path: binDirOnPath(binDir),
      status: "linked",
      version,
    };
  }

  const packageRoot = path.join(CLI_INSTALL_DIR, "node_modules", "larkit");
  const entry = path.join(packageRoot, "bin", "larkit.js");
  const installed = readJson(path.join(packageRoot, "package.json"), {});
  let status = "present";
  if (force || !fs.existsSync(entry) || (version && installed.version !== version)) {
    ensureDir(CLI_INSTALL_DIR);
    const manifest = path.join(CLI_INSTALL_DIR, "package.json");
    if (!fs.existsSync(manifest)) {
      writeJson(manifest, { name: "larkit-cli-install", private: true });
    }
    const target = source || `larkit@${version}`;
    runNpm([
      "install",
      "--prefix",
      CLI_INSTALL_DIR,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      target,
    ]);
    if (!fs.existsSync(entry)) {
      throw new Error(
        `npm installed ${target} but ${displayPath(entry)} is missing; check that the package bin entry is correct`,
      );
    }
    status = "installed";
  }
  const written = writeShims(entry, binDir);
  return {
    mode: "local-prefix",
    entry,
    shim: path.join(binDir, "larkit"),
    shims: written,
    bin_dir: binDir,
    on_path: binDirOnPath(binDir),
    status,
    version: readJson(path.join(packageRoot, "package.json"), {}).version || version,
  };
}

export function mcpServerCommand() {
  const shim = path.join(BIN_DIR, "larkit-mcp");
  if (fs.existsSync(shim)) return shim;
  return "larkit-mcp";
}
