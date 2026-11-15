#!/usr/bin/env node
import process from "node:process";
import { extractAssets } from "../src/indexer/extract-assets.js";
import { formatAssets } from "../src/indexer/format.js";
import { scanAnchors } from "../src/indexer/anchors.js";
import { buildProtocolAssets } from "../src/indexer/protocol.js";
import { buildDatabase } from "../src/indexer/db.js";

function parseArgs(argv) {
  const out = { only: null, force: false, limit: 0, concurrency: undefined };
  for (const arg of argv) {
    if (arg === "--force") out.force = true;
    else if (arg.startsWith("--only=")) out.only = arg.slice(7).split(",").filter(Boolean);
    else if (arg.startsWith("--limit=")) out.limit = Number(arg.slice(8)) || 0;
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice(14)) || undefined;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/build-index.mjs [options]

Options:
  --only=extract,format,anchors,protocol,db   Run selected steps
  --force                                    Rebuild formatted corpus / re-extract deb
  --limit=N                                  Format only N content-hash groups (debug)
  --concurrency=N                            Formatting workers (default: CPU/2, max 8)
`);
      process.exit(0);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const only = args.only ? new Set(args.only) : null;
const should = (step) => !only || only.has(step);

async function run(step, fn) {
  const t0 = Date.now();
  console.error(`\n=== ${step} ===`);
  const result = await fn();
  console.error(`=== ${step} done in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  return result;
}

const summary = {};
if (should("extract")) {
  summary.extract = await run("extract", () => extractAssets());
}
if (should("format")) {
  summary.format = await run("format", () =>
    formatAssets({
      force: args.force,
      limit: args.limit || undefined,
      concurrency: args.concurrency,
    }),
  );
}
if (should("anchors")) {
  summary.anchors = await run("anchors", () => scanAnchors());
}
if (should("protocol")) {
  summary.protocol = await run("protocol", () => buildProtocolAssets());
}
if (should("db")) {
  summary.db = await run("db", () => buildDatabase());
}

console.log(JSON.stringify(summary, null, 2));
