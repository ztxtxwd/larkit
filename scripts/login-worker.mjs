#!/usr/bin/env node
import "../src/shared/quiet.js";
import fs from "node:fs";
import { loginWithQr } from "../src/auth/login.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const name = arg("name", "default");
const timeoutMs = Number(arg("timeout", "120000")) || 120000;
const statusFile = arg("status", undefined);
const headless = !process.argv.includes("--headful");

try {
  const result = await loginWithQr({ name, timeoutMs, headless, statusFile });
  if (statusFile) {
    fs.writeFileSync(
      statusFile,
      `${JSON.stringify(
        {
          phase: result.ok ? "success" : "failed",
          updated_at: new Date().toISOString(),
          ...result,
        },
        null,
        2,
      )}\n`,
    );
  }
  process.exit(result.ok ? 0 : 2);
} catch (error) {
  if (statusFile) {
    fs.writeFileSync(
      statusFile,
      `${JSON.stringify(
        {
          phase: "error",
          updated_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
  }
  console.error(error);
  process.exit(1);
}
