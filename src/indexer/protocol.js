import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_CATALOG_JSON,
  PROTOCOL_DOCS_JSON,
  ROOT,
} from "../shared/paths.js";
import { log, readJson, relativeTo, truncate, writeJson } from "../shared/util.js";
import { loadCatalog } from "../protocol/catalog.js";
import { createRegistry } from "../protocol/schema.js";

const REFERENCE_DIR = fileURLToPath(
  new URL("../protocol/data/reference", import.meta.url),
);

function schemaSummary(registry, typeName) {
  if (!typeName) return "";
  try {
    const info = registry.typeInfo(typeName);
    if (!info) return `${typeName}: <schema unavailable>`;
    if (info.kind === "enum") {
      const values = (info.enumValues || [])
        .slice(0, 30)
        .map((value) => `${value.name}=${value.value}`)
        .join(", ");
      return truncate(`${info.fq}{${values}}`, 1000);
    }
    const fields = (info.fields || [])
      .slice(0, 40)
      .map((field) => {
        const suffix =
          field.rule === "repeated" ? "[]" : field.keyType ? "{}" : "";
        return `${field.name}:${field.type}${suffix}`;
      })
      .join(", ");
    return truncate(`${info.fq}{${fields}}`, 1400);
  } catch (error) {
    return `${typeName}: ${error.message}`;
  }
}

function splitMarkdownSections(file, repoPath) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = {
        title: line.slice(3).trim(),
        path: repoPath,
        line_start: i + 1,
        line_end: lines.length,
        body: [],
      };
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  for (const section of sections) {
    section.line_end = section.line_start + section.body.length - 1;
    section.body = section.body.join("\n");
  }
  return sections;
}

export async function buildProtocolAssets() {
  const registry = createRegistry();
  const { entries: apis } = loadCatalog();
  const catalog = apis.map((api) => {
    const requestSchema = schemaSummary(registry, api.requestType);
    const responseSchema = schemaSummary(registry, api.responseType);
    return {
      cmd: api.cmd,
      name: api.name || "",
      request_type: api.requestType || "",
      response_type: api.responseType || "",
      kind: api.kind,
      version: api.version ?? null,
      schema_available: api.schemaAvailable ? 1 : 0,
      source: api.source || "",
      schema_summary: [requestSchema, responseSchema].filter(Boolean).join("\n"),
    };
  });
  writeJson(PROTOCOL_CATALOG_JSON, {
    generatedAt: new Date().toISOString(),
    total: catalog.length,
    entries: catalog,
  });

  const docs = [];
  const protocolMd = path.join(REFERENCE_DIR, "PROTOCOL.md");
  if (fs.existsSync(protocolMd)) {
    docs.push(
      ...splitMarkdownSections(protocolMd, relativeTo(ROOT, protocolMd)),
    );
  }
  const endpointsJson = path.join(REFERENCE_DIR, "endpoints.json");
  if (fs.existsSync(endpointsJson)) {
    const data = readJson(endpointsJson, {});
    for (const [key, value] of Object.entries(data)) {
      docs.push({
        title: `endpoints.json#${key}`,
        path: relativeTo(ROOT, endpointsJson),
        line_start: 1,
        line_end: 1,
        body: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      });
    }
  }
  writeJson(PROTOCOL_DOCS_JSON, {
    generatedAt: new Date().toISOString(),
    total: docs.length,
    entries: docs,
  });
  log(
    `[protocol] ${catalog.length} catalog entries, ${docs.length} protocol doc sections`,
  );
  return { catalog, docs };
}
