import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  ANCHORS_JSONL,
  PROTOCOL_CATALOG_JSON,
  PROTOCOL_DOCS_JSON,
  TRUTH_DB,
  VERIFIED_DIR,
} from "../shared/paths.js";
import {
  ensureDir,
  log,
  readJson,
  truncate,
  writeJson,
} from "../shared/util.js";
import { normalizeSearchText, searchTextFor } from "../truth/fts.js";
import { readVerifiedFiles, splitVerifiedSections } from "../truth/verified.js";

const SCHEMA = `
CREATE TABLE protocol_catalog (
  id INTEGER PRIMARY KEY,
  cmd INTEGER,
  name TEXT,
  request_type TEXT,
  response_type TEXT,
  kind TEXT,
  version INTEGER,
  schema_available INTEGER,
  source TEXT,
  schema_summary TEXT
);
CREATE VIRTUAL TABLE protocol_catalog_fts USING fts5(
  name, request_type, response_type, kind, source, schema_summary, search_text
);

CREATE TABLE code_anchors (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  anchor_type TEXT NOT NULL,
  literal_value TEXT NOT NULL,
  context_snippet TEXT
);
CREATE VIRTUAL TABLE code_anchors_fts USING fts5(
  file_path, literal_value, context_snippet, anchor_type, scope, search_text
);

CREATE TABLE verified_truths (
  id INTEGER PRIMARY KEY,
  topic TEXT,
  section TEXT,
  path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  verified_at TEXT,
  source TEXT,
  confidence TEXT,
  body TEXT
);
CREATE VIRTUAL TABLE verified_fts USING fts5(
  topic, section, body, path, search_text
);

CREATE TABLE protocol_docs (
  id INTEGER PRIMARY KEY,
  title TEXT,
  path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  body TEXT
);
CREATE VIRTUAL TABLE protocol_docs_fts USING fts5(
  title, body, path, search_text
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function begin(db) {
  db.exec("BEGIN");
}
function commit(db) {
  db.exec("COMMIT");
}

function createSchema(db) {
  db.exec("PRAGMA journal_mode=DELETE;");
  db.exec("PRAGMA synchronous=OFF;");
  db.exec("PRAGMA temp_store=MEMORY;");
  db.exec("PRAGMA cache_size=-262144;");
  db.exec(SCHEMA);
}

function insertProtocolCatalog(db, catalog) {
  const insert = db.prepare(
    `INSERT INTO protocol_catalog
       (cmd, name, request_type, response_type, kind, version, schema_available, source, schema_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO protocol_catalog_fts
       (rowid, name, request_type, response_type, kind, source, schema_summary, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  begin(db);
  for (const entry of catalog) {
    const result = insert.run(
      entry.cmd ?? null,
      entry.name || "",
      entry.request_type || "",
      entry.response_type || "",
      entry.kind || "",
      entry.version ?? null,
      entry.schema_available ? 1 : 0,
      entry.source || "",
      entry.schema_summary || "",
    );
    const rowid = Number(result.lastInsertRowid);
    insertFts.run(
      rowid,
      entry.name || "",
      entry.request_type || "",
      entry.response_type || "",
      entry.kind || "",
      entry.source || "",
      entry.schema_summary || "",
      searchTextFor([
        entry.cmd,
        entry.name,
        entry.request_type,
        entry.response_type,
        entry.kind,
        entry.source,
        entry.schema_summary,
      ]),
    );
  }
  commit(db);
}

async function insertAnchors(db) {
  if (!fs.existsSync(ANCHORS_JSONL)) {
    throw new Error(`missing ${ANCHORS_JSONL}; run anchors first`);
  }
  const insert = db.prepare(
    `INSERT INTO code_anchors
       (scope, file_path, line_number, anchor_type, literal_value, context_snippet)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO code_anchors_fts
       (rowid, file_path, literal_value, context_snippet, anchor_type, scope, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const reader = readline.createInterface({
    input: fs.createReadStream(ANCHORS_JSONL, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let count = 0;
  begin(db);
  for await (const line of reader) {
    if (!line.trim()) continue;
    let anchor;
    try {
      anchor = JSON.parse(line);
    } catch {
      continue;
    }
    const result = insert.run(
      anchor.scope || "web",
      anchor.file_path,
      anchor.line_number,
      anchor.anchor_type,
      anchor.literal_value,
      anchor.context_snippet || "",
    );
    const rowid = Number(result.lastInsertRowid);
    insertFts.run(
      rowid,
      anchor.file_path,
      anchor.literal_value,
      anchor.context_snippet || "",
      anchor.anchor_type,
      anchor.scope || "web",
      searchTextFor([
        anchor.literal_value,
        anchor.context_snippet,
        anchor.file_path,
        anchor.anchor_type,
        anchor.scope,
      ]),
    );
    count++;
    if (count % 2000 === 0) {
      commit(db);
      begin(db);
      if (count % 20000 === 0) log(`[db] ${count} anchors`);
    }
  }
  commit(db);
  return count;
}

function insertVerified(db, files) {
  const insert = db.prepare(
    `INSERT INTO verified_truths
       (topic, section, path, line_start, line_end, verified_at, source, confidence, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO verified_fts
       (rowid, topic, section, body, path, search_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  begin(db);
  let count = 0;
  for (const file of files) {
    for (const section of file.sections) {
      const result = insert.run(
        file.topic,
        section.section,
        file.path,
        section.line_start,
        section.line_end,
        file.meta.verified_at || "",
        file.meta.source || "",
        file.meta.confidence || "",
        section.body,
      );
      insertFts.run(
        Number(result.lastInsertRowid),
        file.topic,
        section.section,
        section.body,
        file.path,
        searchTextFor([
          file.topic,
          section.section,
          section.body,
          file.path,
          file.meta.source,
        ]),
      );
      count++;
    }
  }
  commit(db);
  return count;
}

function insertProtocolDocs(db, docs) {
  const insert = db.prepare(
    `INSERT INTO protocol_docs
       (title, path, line_start, line_end, body)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO protocol_docs_fts
       (rowid, title, body, path, search_text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  begin(db);
  for (const doc of docs) {
    const result = insert.run(
      doc.title,
      doc.path,
      doc.line_start,
      doc.line_end,
      doc.body,
    );
    insertFts.run(
      Number(result.lastInsertRowid),
      doc.title,
      doc.body,
      doc.path,
      searchTextFor([doc.title, doc.body, doc.path]),
    );
  }
  commit(db);
}

export async function buildDatabase() {
  const catalogFile = readJson(PROTOCOL_CATALOG_JSON, null);
  const docsFile = readJson(PROTOCOL_DOCS_JSON, null);
  if (!catalogFile?.entries?.length) {
    throw new Error(`missing ${PROTOCOL_CATALOG_JSON}; run protocol first`);
  }
  if (!docsFile?.entries?.length) {
    throw new Error(`missing ${PROTOCOL_DOCS_JSON}; run protocol first`);
  }
  if (!fs.existsSync(ANCHORS_JSONL)) {
    throw new Error(`missing ${ANCHORS_JSONL}; run anchors first`);
  }
  ensureDir(path.dirname(TRUTH_DB));
  const tmp = `${TRUTH_DB}.tmp`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${tmp}${suffix}`, { force: true });
    } catch {
      // ignore
    }
  }
  const db = new DatabaseSync(tmp);
  try {
    createSchema(db);
    insertProtocolCatalog(db, catalogFile.entries);
    const anchorCount = await insertAnchors(db);
    const verifiedFiles = readVerifiedFiles();
    const verifiedCount = insertVerified(db, verifiedFiles);
    insertProtocolDocs(db, docsFile.entries);
    db.exec(
      "CREATE INDEX idx_anchors_path ON code_anchors(file_path, line_number);",
    );
    db.exec("CREATE INDEX idx_anchors_literal ON code_anchors(literal_value);");
    db.exec("CREATE INDEX idx_anchors_type ON code_anchors(anchor_type);");
    db.exec("CREATE INDEX idx_protocol_cmd ON protocol_catalog(cmd);");
    db.exec("CREATE INDEX idx_protocol_name ON protocol_catalog(name);");
    db.exec("CREATE INDEX idx_verified_path ON verified_truths(path);");
    db.exec("CREATE INDEX idx_docs_path ON protocol_docs(path);");
    db.exec("INSERT INTO code_anchors_fts(code_anchors_fts) VALUES('optimize');");
    db.exec("INSERT INTO protocol_catalog_fts(protocol_catalog_fts) VALUES('optimize');");
    db.exec("INSERT INTO verified_fts(verified_fts) VALUES('optimize');");
    db.exec("INSERT INTO protocol_docs_fts(protocol_docs_fts) VALUES('optimize');");
    const stat = db.prepare("SELECT COUNT(*) AS c FROM code_anchors").get();
    const catalogCount = db
      .prepare("SELECT COUNT(*) AS c FROM protocol_catalog")
      .get();
    const final = {
      generatedAt: new Date().toISOString(),
      protocolCatalog: Number(catalogCount.c),
      codeAnchors: Number(stat.c),
      verifiedSections: verifiedCount,
      protocolDocs: docsFile.entries.length,
    };
    const insertMeta = db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    );
    for (const [key, value] of Object.entries(final)) {
      insertMeta.run(key, String(value));
    }
    db.exec("PRAGMA optimize;");
    db.close();
    fs.renameSync(tmp, TRUTH_DB);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.rmSync(`${TRUTH_DB}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
    writeJson(path.join(path.dirname(TRUTH_DB), "truth.meta.json"), final);
    log(
      `[db] truth.db: ${final.protocolCatalog} commands, ${final.codeAnchors} anchors, ${final.verifiedSections} verified sections, ${final.protocolDocs} protocol docs`,
    );
    return final;
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

export function openTruthDb({ readonly = true } = {}) {
  if (!fs.existsSync(TRUTH_DB)) {
    throw new Error(
      `truth.db not found at ${TRUTH_DB}; run "larkit init" (or "node scripts/build-index.mjs" in a checkout) first`,
    );
  }
  const db = new DatabaseSync(TRUTH_DB, { readOnly: readonly });
  return db;
}

/** Incrementally update one verified markdown file in an already-built DB. */
export function syncVerifiedFile(db, filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const dbPath = `verified_truths/${path.basename(filePath)}`;
  const parsed = splitVerifiedSections(dbPath, text);
  const rows = db
    .prepare("SELECT id FROM verified_truths WHERE path = ?")
    .all(dbPath);
  if (rows.length > 0) {
    const ids = rows.map((r) => Number(r.id));
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM verified_fts WHERE rowid IN (${placeholders})`,
    ).run(...ids);
    db.prepare("DELETE FROM verified_truths WHERE path = ?").run(dbPath);
  }
  const insert = db.prepare(
    `INSERT INTO verified_truths
       (topic, section, path, line_start, line_end, verified_at, source, confidence, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO verified_fts
       (rowid, topic, section, body, path, search_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  begin(db);
  for (const section of parsed.sections) {
    const result = insert.run(
      parsed.topic,
      section.section,
      dbPath,
      section.line_start,
      section.line_end,
      parsed.meta.verified_at || "",
      parsed.meta.source || "",
      parsed.meta.confidence || "",
      section.body,
    );
    insertFts.run(
      Number(result.lastInsertRowid),
      parsed.topic,
      section.section,
      section.body,
      filePath,
      searchTextFor([
        parsed.topic,
        section.section,
        section.body,
        filePath,
        parsed.meta.source,
      ]),
    );
  }
  commit(db);
  return parsed.sections.length;
}

export function listVerifiedFilesOnDisk() {
  if (!fs.existsSync(VERIFIED_DIR)) return [];
  return fs
    .readdirSync(VERIFIED_DIR)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .map((name) => path.join(VERIFIED_DIR, name));
}

export { normalizeSearchText, truncate };
