import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ensureDir,
  fileSizeMiB,
  log,
  readJson,
} from "../shared/util.js";
import { PKG_ROOT } from "../shared/paths.js";

const VERSION = readJson(path.join(PKG_ROOT, "package.json"), {}).version || "0.0.0";

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

export function isFileUrl(value) {
  return /^file:\/\//i.test(String(value));
}

export async function sha256File(file, onProgress) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
    onProgress?.(bytes);
  }
  return { sha256: hash.digest("hex"), bytes };
}

export function sha256FileSync(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function finalize(partFile, destFile, { expectedSha256, expectedBytes } = {}) {
  const stat = fs.statSync(partFile);
  if (expectedBytes && stat.size !== expectedBytes) {
    throw new Error(
      `download size mismatch: got ${stat.size} bytes, expected ${expectedBytes}`,
    );
  }
  if (expectedSha256) {
    const { sha256 } = await sha256File(partFile);
    if (sha256 !== expectedSha256) {
      throw new Error(
        `download checksum mismatch: got ${sha256}, expected ${expectedSha256}`,
      );
    }
  }
  fs.rmSync(destFile, { force: true });
  fs.renameSync(partFile, destFile);
  return { file: destFile, bytes: stat.size };
}

/** Copy a local file with the same atomic/verified semantics as a download. */
export async function copyLocalFile(source, dest, options = {}) {
  const from = isFileUrl(source) ? fileURLToPath(source) : path.resolve(source);
  if (!fs.existsSync(from)) throw new Error(`file not found: ${source}`);
  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  await pipeline(fs.createReadStream(from), fs.createWriteStream(part));
  return finalize(part, dest, options);
}

/**
 * Download (or copy) with resume + sha256 verification.  A `.part` file is
 * reused when the server supports Range requests, so interrupted installs can
 * continue instead of restarting a multi-hundred-MB download.
 */
export async function downloadFile(source, dest, options = {}) {
  const {
    expectedSha256,
    expectedBytes,
    onProgress,
    quiet = false,
    label = path.basename(dest),
  } = options;

  if (!isHttpUrl(source)) {
    if (!quiet) log(`[download] copy ${path.basename(source)} -> ${dest}`);
    return copyLocalFile(source, dest, { expectedSha256, expectedBytes });
  }

  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  let response;
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {
      "user-agent": `larkit/${VERSION}`,
      "accept-encoding": "identity",
    };
    if (start > 0) headers.range = `bytes=${start}-`;
    try {
      response = await fetch(source, { headers, redirect: "follow" });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800));
      continue;
    }
    if (response.status === 416 && start > 0) {
      // The .part file is already complete (or larger). Hash it.
      const result = await finalize(part, dest, { expectedSha256, expectedBytes });
      onProgress?.(result.bytes, result.bytes);
      return result;
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} for ${source}`);
    }
    break;
  }
  if (!response) {
    throw new Error(`download failed: ${lastError?.message || source}`);
  }

  const resuming = start > 0 && response.status === 206;
  if (start > 0 && !resuming) {
    start = 0;
    fs.rmSync(part, { force: true });
  }
  const length = Number(response.headers.get("content-length")) || 0;
  const total = expectedBytes || (resuming ? start + length : length);
  if (!quiet) {
    log(
      `[download] ${label} ${resuming ? "resume " : ""}${total ? fileSizeMiB(total) : ""}`,
    );
  }

  let received = 0;
  let lastTick = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 500) {
        lastTick = now;
        onProgress?.(start + received, total);
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(part, { flags: resuming ? "a" : "w" }),
    );
  } catch (error) {
    throw new Error(
      `download interrupted at ${fileSizeMiB(start + received)}: ${error.message}; rerun to resume`,
    );
  }
  const result = await finalize(part, dest, { expectedSha256, expectedBytes });
  onProgress?.(result.bytes, result.bytes);
  return result;
}

export async function fetchJson(url) {
  if (!isHttpUrl(url)) {
    const file = isFileUrl(url) ? fileURLToPath(url) : path.resolve(url);
    return readJson(file, null);
  }
  const response = await fetch(url, {
    headers: { "user-agent": `larkit/${VERSION}` },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export function formatPercent(received, total) {
  if (!total) return `${fileSizeMiB(received)}`;
  return `${Math.min(100, Math.round((received / total) * 100))}% (${fileSizeMiB(received)}/${fileSizeMiB(total)})`;
}
