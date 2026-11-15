#!/usr/bin/env node
/**
 * End-to-end bootstrap verification with a synthetic pack:
 *   tar round-trip → pack build → `larkit init` in a temp home → search/status.
 *
 * Uses child processes for init/search because paths are resolved from the
 * environment at module load time.
 */
import "../src/shared/quiet.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createTarGz, extractTarGz } from "../src/bootstrap/tar.js";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "larkit-verify-"));
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function makeFixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const dataDir = path.join(tmp, "source-data");
  const verifiedDir = path.join(tmp, "source-verified");
  fs.mkdirSync(verifiedDir, { recursive: true });
  const formatted = path.join(dataDir, "formatted", "demo");
  fs.mkdirSync(formatted, { recursive: true });
  fs.writeFileSync(
    path.join(formatted, "sample.js"),
    "function cardLink() {\n  return 'card_link';\n}\n",
  );
  fs.writeFileSync(
    path.join(verifiedDir, "demo-truth.md"),
    "---\ntopic: demo card truth\nsource: doc\nconfidence: high\n---\n\n## 结论\n\nchart_spec is documented here.\n",
  );
  const db = new DatabaseSync(path.join(dataDir, "truth.db"));
  db.exec(`
    CREATE TABLE verified_truths (
      id INTEGER PRIMARY KEY, topic TEXT, section TEXT, path TEXT,
      line_start INTEGER, line_end INTEGER, verified_at TEXT, source TEXT,
      confidence TEXT, body TEXT
    );
    CREATE VIRTUAL TABLE verified_fts USING fts5(
      topic, section, body, path, search_text
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(
    `INSERT INTO verified_truths (topic, section, path, line_start, line_end, verified_at, source, confidence, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "demo card truth",
    "结论",
    "verified_truths/demo-truth.md",
    1,
    3,
    "2026-01-01T00:00:00.000Z",
    "doc",
    "high",
    "chart_spec is documented here.",
  );
  db.prepare(
    `INSERT INTO verified_fts (rowid, topic, section, body, path, search_text)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(
    "demo card truth",
    "结论",
    "chart_spec is documented here.",
    "verified_truths/demo-truth.md",
    "chart_spec demo card truth",
  );
  db.close();
  fs.writeFileSync(
    path.join(dataDir, "truth.meta.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), protocolCatalog: 1, codeAnchors: 1, verifiedSections: 1, protocolDocs: 0 }, null, 2)}\n`,
  );
  return { dataDir, verifiedDir };
}

function run(args, env) {
  const result = spawnSync(process.execPath, [path.join(root, "bin", "larkit.js"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: (() => {
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    })(),
  };
}

try {
  // 1. tar round-trip, including long and UTF-8 paths.
  const longRel =
    "formatted/very/deep/directory/that/exceeds/the/classic/ustar/one-hundred-byte/name/limit/for/sure/file.js";
  const tarSource = path.join(tmp, "tar-source");
  fs.mkdirSync(path.join(tarSource, path.dirname(longRel)), { recursive: true });
  fs.writeFileSync(path.join(tarSource, longRel), "console.log('卡片 chart_spec');\n");
  fs.writeFileSync(path.join(tarSource, "short.txt"), "hello\n");
  const archive = path.join(tmp, "roundtrip.tar.gz");
  await createTarGz(archive, {
    entries: [
      { file: path.join(tarSource, "short.txt"), tarPath: "short.txt" },
      { file: path.join(tarSource, longRel), tarPath: longRel },
    ],
  });
  const tarOut = path.join(tmp, "tar-out");
  await extractTarGz(archive, tarOut);
  check("tar: short file", fs.readFileSync(path.join(tarOut, "short.txt"), "utf8") === "hello\n");
  check(
    "tar: long path + utf8",
    fs.readFileSync(path.join(tarOut, longRel), "utf8").includes("卡片 chart_spec"),
  );
  const traversal = path.join(tmp, "traversal.tar.gz");
  await createTarGz(traversal, {
    entries: [{ tarPath: "../escape.txt", content: "nope" }],
  });
  let traversalRejected = false;
  try {
    await extractTarGz(traversal, path.join(tmp, "traversal-out"));
  } catch {
    traversalRejected = true;
  }
  check("tar: path traversal rejected", traversalRejected);
  const symlinkDir = path.join(tmp, "symlink-out");
  fs.mkdirSync(symlinkDir, { recursive: true });
  fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(symlinkDir, "x.txt"));
  const symlinkArchive = path.join(tmp, "symlink.tar.gz");
  await createTarGz(symlinkArchive, {
    entries: [{ tarPath: "x.txt", content: "oops" }],
  });
  let symlinkRejected = false;
  try {
    await extractTarGz(symlinkArchive, symlinkDir);
  } catch {
    symlinkRejected = true;
  }
  check("tar: symlink overwrite rejected", symlinkRejected);

  // 2. Build a synthetic truth pack.
  const fixture = await makeFixture();
  const packDir = path.join(tmp, "pack");
  const build = spawnSync(
    process.execPath,
    [
      path.join(root, "bin", "larkit.js"),
      "pack",
      "build",
      `--out=${packDir}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LARKIT_DATA_DIR: fixture.dataDir,
        LARKIT_VERIFIED_DIR: fixture.verifiedDir,
        LARKIT_HOME: path.join(tmp, "builder-home"),
      },
      encoding: "utf8",
    },
  );
  check("pack build exits 0", build.status === 0, build.stderr?.slice(-600));
  check("pack manifest exists", fs.existsSync(path.join(packDir, "manifest.json")));

  // 3. Init into a temp home.
  const home = path.join(tmp, "home");
  const userHome = path.join(tmp, "userhome");
  fs.mkdirSync(userHome, { recursive: true });
  const skillDir = path.join(userHome, ".agents", "skills", "larkit");
  const env = {
    HOME: userHome,
    USERPROFILE: userHome,
    LARKIT_HOME: home,
    LARKIT_DATA_DIR: path.join(home, "data"),
    LARKIT_VERIFIED_DIR: path.join(home, "verified_truths"),
    LARKIT_BIN_DIR: path.join(home, "bin"),
  };
  const init = run(
    ["init", `--pack=${packDir}`, "--no-cli", "--json"],
    env,
  );
  check("init exits 0", init.status === 0, init.stderr?.slice(-1200));
  check("init reports truth ready", init.json?.steps?.truth?.status === "ready", init.stdout);
  check("truth.db installed", fs.existsSync(path.join(home, "data", "truth.db")));
  check(
    "verified truth seeded",
    fs.existsSync(path.join(home, "verified_truths", "demo-truth.md")),
  );
  check("skill installed", fs.existsSync(path.join(skillDir, "SKILL.md")));
  check("skill references installed", fs.existsSync(path.join(skillDir, "references", "playbooks.md")));
  check("mcp config written", fs.existsSync(path.join(home, "mcp.json")));

  // 4. Query through the installed home.
  const search = run(["search", "chart_spec", "--scope=verified"], env);
  check("search exits 0", search.status === 0, search.stderr?.slice(-600));
  check("search hits seeded truth", (search.json?.results?.length || 0) > 0, search.stdout);

  const status = run(["status", "--json"], env);
  check("status exits 0", status.status === 0, status.stderr?.slice(-600));
  check("status sees installed truth", status.json?.truth?.installed === true);
  check("status sees skill", (status.json?.skills?.length || 0) === 1, status.stdout);

  const slice = run(
    ["inspect", "verified_truths/demo-truth.md", "5", "--max-lines=10"],
    env,
  );
  check("inspect verified path", slice.status === 0 && slice.json?.lines?.length > 0, slice.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (error) {
  failed++;
  console.error(error);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

console.log(failed ? `\n${failed} bootstrap check(s) failed` : "\nall bootstrap checks passed");
process.exit(failed ? 1 : 0);
