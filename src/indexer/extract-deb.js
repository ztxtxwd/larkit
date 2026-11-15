import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEB_FILE, DEB_ROOT, FEISHU_APP_DIR } from "../shared/paths.js";
import { ensureDir, log, fileSizeMiB } from "../shared/util.js";

export function ensureDebExtracted({ force = false } = {}) {
  const marker = path.join(FEISHU_APP_DIR, "manifest.json");
  if (!force && fs.existsSync(marker)) {
    log(`[extract] deb already extracted: ${DEB_ROOT}`);
    return FEISHU_APP_DIR;
  }
  if (!fs.existsSync(DEB_FILE)) {
    throw new Error(`missing ${DEB_FILE}`);
  }
  ensureDir(DEB_ROOT);
  log(`[extract] dpkg-deb -x ${path.basename(DEB_FILE)} -> ${DEB_ROOT}`);
  const t0 = Date.now();
  const result = spawnSync("dpkg-deb", ["-x", DEB_FILE, DEB_ROOT], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`dpkg-deb failed with exit code ${result.status}`);
  }
  const size = directorySize(DEB_ROOT);
  log(
    `[extract] deb extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s (${fileSizeMiB(size)})`,
  );
  return FEISHU_APP_DIR;
}

export function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}
