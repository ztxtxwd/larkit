import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";
import {
  DEB_ROOT,
  DATA_DIR,
} from "../shared/paths.js";
import { ensureDir, readJson, writeJson } from "../shared/util.js";
import { mergeRoots, parseFileDescriptorSet } from "./descriptor.js";

const BUNDLE_FILE = new URL("./data/bundle.json", import.meta.url);
const BUNDLED_SCHEMA = new URL("./data/schema.json.gz", import.meta.url);
const SCHEMA_CACHE = path.join(DATA_DIR, "protocol", "schema.json");
const FEISHU_APP_DIR = path.join(DEB_ROOT, "opt", "bytedance", "feishu");

let cachedRoot;
let cachedRegistry;

function readBundle() {
  return readJson(BUNDLE_FILE.pathname, { nested: {} });
}

function descriptorFiles() {
  return {
    pb: path.join(FEISHU_APP_DIR, "pb.desc"),
    pbServer: path.join(FEISHU_APP_DIR, "pb_server.desc"),
  };
}

export function buildSchemaRoot({ force = false } = {}) {
  const { pb, pbServer } = descriptorFiles();
  const cacheMtime = fs.existsSync(SCHEMA_CACHE)
    ? fs.statSync(SCHEMA_CACHE).mtimeMs
    : 0;
  const sourceMtime = Math.max(
    fs.existsSync(pb) ? fs.statSync(pb).mtimeMs : 0,
    fs.existsSync(pbServer) ? fs.statSync(pbServer).mtimeMs : 0,
  );
  if (!force && cacheMtime > 0 && cacheMtime >= sourceMtime) {
    return readJson(SCHEMA_CACHE, { nested: {} });
  }
  const bundle = readBundle();
  const roots = [bundle];
  const hasPb = fs.existsSync(pb);
  const hasPbServer = fs.existsSync(pbServer);
  if (!hasPb || !hasPbServer) {
    // Runtime-only install without the deb: use the bundled merged schema.
    try {
      if (fs.existsSync(BUNDLED_SCHEMA)) {
        return JSON.parse(gunzipSync(fs.readFileSync(BUNDLED_SCHEMA)).toString("utf8"));
      }
    } catch (error) {
      console.error(`[protocol] bundled schema load failed: ${error.message}`);
    }
  }
  for (const file of [pb, pbServer]) {
    if (!fs.existsSync(file)) continue;
    try {
      roots.push(parseFileDescriptorSet(fs.readFileSync(file)));
    } catch (error) {
      console.error(`[protocol] descriptor parse failed ${file}: ${error.message}`);
    }
  }
  const root = mergeRoots(...roots);
  ensureDir(path.dirname(SCHEMA_CACHE));
  writeJson(SCHEMA_CACHE, root);
  return root;
}

export function getSchemaRoot({ force = false } = {}) {
  if (cachedRoot && !force) return cachedRoot;
  cachedRoot = buildSchemaRoot({ force });
  return cachedRoot;
}

export function getProtoRoot({ force = false } = {}) {
  const root = protobuf.Root.fromJSON(getSchemaRoot({ force }));
  root.resolveAll();
  return root;
}

function lowerCamel(value) {
  return String(value).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function snakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function normalizeValue(type, value, depth = 0) {
  if (value === undefined || value === null || depth > 20) return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(type, item, depth + 1));
  }
  if (typeof value !== "object" || value instanceof Uint8Array) return value;
  if (!type || !type.fields) return value;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = lowerCamel(rawKey);
    const snake = snakeCase(rawKey);
    const field =
      type.fields[key] ||
      type.fields[rawKey] ||
      type.fields[snake] ||
      Object.values(type.fields).find(
        (candidate) =>
          candidate.name === rawKey ||
          candidate.name === key ||
          candidate.name === snake,
      );
    if (!field) {
      out[rawKey] = rawValue;
      continue;
    }
    if (field.resolvedType && field.resolvedType.fields) {
      out[field.name] = normalizeValue(field.resolvedType, rawValue, depth + 1);
    } else {
      out[field.name] = rawValue;
    }
  }
  return out;
}

function camelizeOutput(value, depth = 0) {
  if (value === undefined || value === null || depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => camelizeOutput(item, depth + 1));
  if (typeof value !== "object" || value instanceof Uint8Array) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[lowerCamel(key)] = camelizeOutput(child, depth + 1);
  }
  return out;
}

export function createRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const root = getProtoRoot();
  const registry = {
    root,
    lookup(typeName) {
      try {
        const found = root.lookup(typeName);
        return found || null;
      } catch {
        return null;
      }
    },
    has(typeName) {
      return Boolean(registry.lookup(typeName));
    },
    typeInfo(typeName) {
      const found = registry.lookup(typeName);
      if (!found) return null;
      if (found.values) {
        return {
          fq: found.fullName.replace(/^\./, ""),
          kind: "enum",
          enumValues: Object.entries(found.values).map(([name, value]) => ({
            name,
            value,
          })),
        };
      }
      if (!found.fields) return null;
      return {
        fq: found.fullName.replace(/^\./, ""),
        kind: "message",
        fields: Object.entries(found.fields).map(([name, field]) => ({
          name,
          type:
            field.resolvedType?.fullName?.replace(/^\./, "") || field.type,
          id: field.id,
          rule: field.repeated ? "repeated" : field.required ? "required" : undefined,
          keyType: field.keyType || undefined,
        })),
      };
    },
    encode(typeName, value) {
      const type = root.lookupType(typeName);
      const normalized = normalizeValue(type, value);
      return type.encode(type.fromObject(normalized)).finish();
    },
    decode(typeName, bytes) {
      const type = root.lookupType(typeName);
      const message = type.decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      );
      return camelizeOutput(
        type.toObject(message, {
          longs: String,
          enums: Number,
          bytes: String,
          defaults: false,
          arrays: false,
          objects: false,
        }),
      );
    },
    decodeRaw(typeName, bytes) {
      const type = root.lookupType(typeName);
      const message = type.decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      );
      return type.toObject(message, {
        longs: String,
        enums: Number,
        bytes: Array,
        defaults: false,
        arrays: false,
        objects: false,
      });
    },
  };
  cachedRegistry = registry;
  return registry;
}

export function schemaStats() {
  const root = getSchemaRoot();
  let messages = 0;
  let enums = 0;
  const walk = (node) => {
    for (const value of Object.values(node.nested || {})) {
      if (!value || typeof value !== "object") continue;
      if (value.fields) messages++;
      else if (value.values) enums++;
      if (value.nested) walk(value);
    }
  };
  walk(root);
  return { messages, enums, cache: SCHEMA_CACHE };
}
