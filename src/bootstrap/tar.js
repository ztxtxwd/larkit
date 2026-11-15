import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BLOCK = 512;
const CHUNK = 1024 * 1024;

function padding(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function writeAscii(buf, offset, value, length) {
  const text = String(value);
  const bytes = Buffer.from(text, "utf8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function octal(value, width) {
  const text = Math.max(0, Math.trunc(value)).toString(8);
  return `${text.padStart(width - 1, "0")}\0`;
}

function splitUstarPath(relPath) {
  if (Buffer.byteLength(relPath) <= 100) return { name: relPath, prefix: "" };
  for (let i = relPath.length - 1; i > 0; i--) {
    if (relPath[i] !== "/") continue;
    const prefix = relPath.slice(0, i);
    const name = relPath.slice(i + 1);
    if (!name) continue;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

function header({
  name,
  prefix = "",
  mode = 0o644,
  size = 0,
  mtime = Math.floor(Date.now() / 1000),
  typeflag = "0",
}) {
  const buf = Buffer.alloc(BLOCK, 0);
  writeAscii(buf, 0, name, 100);
  writeAscii(buf, 100, octal(mode & 0o7777, 8), 8);
  writeAscii(buf, 108, octal(0, 8), 8);
  writeAscii(buf, 116, octal(0, 8), 8);
  writeAscii(buf, 124, octal(size, 12), 12);
  writeAscii(buf, 136, octal(mtime, 12), 12);
  buf.fill(0x20, 148, 156);
  writeAscii(buf, 156, typeflag, 1);
  writeAscii(buf, 257, "ustar\0", 6);
  writeAscii(buf, 263, "00", 2);
  writeAscii(buf, 329, octal(0, 8), 8);
  writeAscii(buf, 337, octal(0, 8), 8);
  writeAscii(buf, 345, prefix, 155);
  let sum = 0;
  for (const byte of buf) sum += byte;
  writeAscii(buf, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return buf;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = `${length}${body}`;
    const bytes = Buffer.byteLength(candidate);
    if (bytes === length) return candidate;
    length = bytes;
  }
}

function entryHeaders(tarPath, size, stat) {
  const chunks = [];
  const split = splitUstarPath(tarPath);
  if (split) {
    chunks.push(
      header({
        name: split.name,
        prefix: split.prefix,
        size,
        mode: stat ? stat.mode : 0o644,
        mtime: stat ? Math.floor(stat.mtimeMs / 1000) : undefined,
      }),
    );
    return chunks;
  }
  const pax = paxRecord("path", tarPath);
  chunks.push(
    header({
      name: `PaxHeader/${path.posix.basename(tarPath).slice(-90)}`,
      size: Buffer.byteLength(pax),
      mode: 0o644,
      typeflag: "x",
    }),
  );
  chunks.push(Buffer.from(pax, "utf8"), Buffer.alloc(padding(Buffer.byteLength(pax))));
  chunks.push(
    header({
      name: path.posix.basename(tarPath).slice(-99),
      size,
      mode: stat ? stat.mode : 0o644,
      mtime: stat ? Math.floor(stat.mtimeMs / 1000) : undefined,
    }),
  );
  return chunks;
}

/**
 * Create a .tar.gz from explicit entries.  Entries are
 * `{ tarPath, file }` or `{ tarPath, content }`; order is preserved.
 */
export async function createTarGz(outFile, { entries = [], onProgress } = {}) {
  if (!entries.length) throw new Error("createTarGz: no entries");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let written = 0;
  const report = () => onProgress?.(written);

  async function* generate() {
    for (const entry of entries) {
      const tarPath = entry.tarPath.split(path.sep).join("/").replace(/^\/+/, "");
      if (!tarPath) continue;
      if (entry.content !== undefined) {
        const buf = Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content);
        for (const chunk of entryHeaders(tarPath, buf.length, null)) yield chunk;
        if (buf.length) yield buf;
        const pad = padding(buf.length);
        if (pad) yield Buffer.alloc(pad);
        written += buf.length;
        report();
        continue;
      }
      const stat = await fsp.stat(entry.file);
      if (!stat.isFile()) continue;
      for (const chunk of entryHeaders(tarPath, stat.size, stat)) yield chunk;
      let sent = 0;
      const stream = fs.createReadStream(entry.file, {
        highWaterMark: CHUNK,
      });
      for await (const chunk of stream) {
        sent += chunk.length;
        written += chunk.length;
        report();
        yield chunk;
      }
      if (sent !== stat.size) {
        throw new Error(
          `createTarGz: ${entry.file} changed while reading (${sent}/${stat.size})`,
        );
      }
      const pad = padding(stat.size);
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(BLOCK * 2);
  }

  await pipeline(
    Readable.from(generate()),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(outFile),
  );
  return outFile;
}

class ChunkReader {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  async pull(size) {
    while (this.buffer.length < size && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : chunk;
    }
    return this.buffer.length >= size;
  }

  async readExact(size) {
    if (!(await this.pull(size))) {
      throw new Error("unexpected end of tar stream");
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  async readUpTo(size) {
    if (this.buffer.length === 0) await this.pull(1);
    const take = Math.min(size, this.buffer.length);
    if (!take) return null;
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  async skip(size) {
    let left = size;
    while (left > 0) {
      const chunk = await this.readUpTo(left);
      if (!chunk) throw new Error("unexpected end of tar stream");
      left -= chunk.length;
    }
  }
}

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function parseOctal(buf, offset, length) {
  const text = readString(buf, offset, length).trim();
  return text ? Number.parseInt(text, 8) || 0 : 0;
}

function parseHeader(buf) {
  const name = readString(buf, 0, 100);
  const prefix = readString(buf, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: parseOctal(buf, 100, 8) & 0o777,
    size: parseOctal(buf, 124, 12),
    mtime: parseOctal(buf, 136, 12),
    typeflag: readString(buf, 156, 1) || "0",
  };
}

function parsePax(buf) {
  const text = buf.toString("utf8");
  const records = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

function normalizeTarPath(raw) {
  const clean = String(raw || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!clean || clean === ".") return "";
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    throw new Error(`tar entry uses an absolute path: ${raw}`);
  }
  if (clean.split("/").includes("..")) {
    throw new Error(`tar entry escapes the destination: ${raw}`);
  }
  return clean.split("/").join(path.sep);
}

function ensureSafeDir(baseDir, dir) {
  const base = path.resolve(baseDir);
  const relative = path.relative(base, path.resolve(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`tar entry escapes the destination: ${dir}`);
  }
  let current = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to extract through symlink: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`refusing to extract through non-directory: ${current}`);
    }
  }
}

/**
 * Extract a .tar.gz stream.  Symlinks/hardlinks are ignored; path traversal is
 * rejected; existing directories are reused.  `mapPath` receives POSIX paths.
 */
export async function extractTarGz(
  archive,
  destDir,
  { mapPath = (value) => value, onProgress, onWarning } = {},
) {
  fs.mkdirSync(destDir, { recursive: true });
  const source = fs.createReadStream(archive);
  const gunzip = zlib.createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new ChunkReader(gunzip);
  let paxPath = null;
  let longName = null;
  let extractedBytes = 0;
  let files = 0;

  for (;;) {
    let block;
    try {
      block = await reader.readExact(BLOCK);
    } catch (error) {
      if (/unexpected end of tar stream/.test(error.message)) break;
      throw error;
    }
    if (block.every((byte) => byte === 0)) break;
    const parsed = parseHeader(block);
    let name = parsed.name;
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (paxPath !== null) {
      name = paxPath;
      paxPath = null;
    }
    const type = parsed.typeflag;

    if (type === "x" || type === "g") {
      const data = await reader.readExact(parsed.size);
      const records = parsePax(data);
      if (type === "g") {
        if (records.path) paxPath = records.path;
      } else if (records.path) {
        paxPath = records.path;
      }
      await reader.skip(padding(parsed.size));
      continue;
    }
    if (type === "L") {
      const data = await reader.readExact(parsed.size);
      longName = data.toString("utf8").replace(/\0+$/, "");
      await reader.skip(padding(parsed.size));
      continue;
    }

    const normalized = normalizeTarPath(mapPath(name));
    if (normalized) {
      if (type === "5") {
        ensureSafeDir(destDir, path.join(destDir, normalized));
        await reader.skip(parsed.size + padding(parsed.size));
      } else if (
        type === "0" ||
        type === "7" ||
        type === "\0" ||
        type === ""
      ) {
        const dest = path.join(destDir, normalized);
        ensureSafeDir(destDir, path.dirname(dest));
        try {
          if (fs.lstatSync(dest).isSymbolicLink()) {
            throw new Error(`refusing to overwrite symlink: ${dest}`);
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const fd = fs.openSync(dest, "w", parsed.mode || 0o644);
        try {
          let remaining = parsed.size;
          while (remaining > 0) {
            const chunk = await reader.readUpTo(Math.min(remaining, CHUNK));
            if (!chunk) throw new Error("unexpected end of tar stream");
            fs.writeSync(fd, chunk);
            remaining -= chunk.length;
          }
        } finally {
          fs.closeSync(fd);
        }
        if (parsed.mtime > 0) {
          try {
            fs.utimesSync(dest, new Date(), new Date(parsed.mtime * 1000));
          } catch {
            // mtime is cosmetic
          }
        }
        extractedBytes += parsed.size;
        files++;
        onProgress?.(extractedBytes, files);
        await reader.skip(padding(parsed.size));
      } else if (type === "1" || type === "2") {
        onWarning?.(`skipped link entry: ${normalized}`);
        await reader.skip(parsed.size + padding(parsed.size));
      } else {
        await reader.skip(parsed.size + padding(parsed.size));
      }
    } else {
      await reader.skip(parsed.size + padding(parsed.size));
    }
  }
  return { bytes: extractedBytes, files };
}
