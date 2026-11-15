#!/usr/bin/env node
import "../src/shared/quiet.js";
import process from "node:process";
import { searchTruth, getProtocolEntry, readSlice, truthStats } from "../src/truth/search.js";
import { TRUTH_DB, FORMATTED_DIR } from "../src/shared/paths.js";

const queries = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const list = queries.length
  ? queries
  : ["chart_spec", "card_link", "PUT_MESSAGE", "PUSH_MESSAGES"];

let failed = 0;
const stats = truthStats();
console.log(JSON.stringify({ truth_db: TRUTH_DB, formatted_dir: FORMATTED_DIR, stats }, null, 2));

for (const query of list) {
  const result = searchTruth({ query, scope: "all", limit: 5 });
  const ok = result.results.length > 0;
  const fast = result.elapsed_ms < 50;
  if (!ok || !fast) failed++;
  console.log(
    `\n${ok ? "PASS" : "FAIL"} ${fast ? "fast" : "SLOW"} ${result.elapsed_ms}ms  query=${JSON.stringify(query)}  hits=${result.results.length}`,
  );
  for (const hit of result.results.slice(0, 3)) {
    if (hit.kind === "protocol") {
      console.log(
        `  protocol cmd=${hit.cmd} ${hit.name} ${hit.request_type || ""} schema=${(hit.schema || "").slice(0, 100)}`,
      );
    } else {
      console.log(
        `  ${hit.kind} ${hit.file_path}:${hit.line_number ?? hit.line_start} ${hit.anchor_type || hit.section || hit.title || ""} ${(hit.literal || "").slice(0, 90)}`,
      );
    }
  }
  if (query === list[0]) {
    const first = result.results[0];
    if (first && !first.kind.includes("protocol")) {
      const slice = readSlice({
        filePath: first.file_path,
        lineNumber: first.line_number || first.line_start || 1,
        context: 3,
        maxLines: 12,
      });
      console.log(
        `  slice ${slice.file_path}:${slice.range.start}-${slice.range.end} (${slice.lines.length} lines)`,
      );
    }
  }
}

const protocol = getProtocolEntry("PUT_MESSAGE");
console.log(`\nprotocol lookup PUT_MESSAGE: ${protocol.length} entr${protocol.length === 1 ? "y" : "ies"}`);
if (!protocol.length) failed++;

if (failed) {
  console.error(`\n${failed} verification check(s) failed`);
  process.exit(1);
}
console.log("\nall index checks passed");
