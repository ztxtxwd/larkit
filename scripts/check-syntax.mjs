#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "src", "scripts"];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) if (fs.existsSync(root)) walk(root);

let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${file}\n${result.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files passed syntax check`);
process.exit(failed ? 1 : 0);
