#!/usr/bin/env node
import "../src/shared/quiet.js";
import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(process.execPath, ["bin/larkit-mcp.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LARKIT_MCP_TEST: "1" },
});

let buffer = "";
const pending = new Map();
let nextId = 1;
let stderr = "";
const received = [];

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  if (stderr.length > 8000) stderr = stderr.slice(-8000);
});

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("non-JSON stdout:", line.slice(0, 300));
      continue;
    }
    received.push(message);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function send(method, params, timeout = 60_000) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeout);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function textOf(result) {
  return result?.content?.map((item) => item.text).join("\n") || "";
}

async function main() {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "larkit-verify", version: "1.0.0" },
  });
  console.log("initialize:", init.serverInfo?.name, init.serverInfo?.version);
  notify("notifications/initialized");

  const list = await send("tools/list", {});
  console.log(
    "tools:",
    list.tools.map((tool) => tool.name).join(", "),
  );
  if (list.tools.length !== 6) {
    throw new Error(`expected 6 tools, got ${list.tools.length}`);
  }

  const search = await send("tools/call", {
    name: "lark_truth_search",
    arguments: { query: "chart_spec", scope: "all", limit: 3 },
  });
  const searchJson = JSON.parse(textOf(search));
  console.log(
    "truth_search:",
    `${searchJson.results.length} hits, ${searchJson.elapsed_ms}ms, first=${searchJson.results[0]?.file_path}:${searchJson.results[0]?.line_start || searchJson.results[0]?.line_number}`,
  );
  if (!searchJson.results.length) throw new Error("truth search returned no hits");

  const firstCode = searchJson.results.find((hit) => hit.kind === "code") || {
    file_path: "verified_truths/card-json-2.0-official.md",
    line_number: 10,
  };
  const slice = await send("tools/call", {
    name: "lark_truth_inspect",
    arguments: {
      action: "read_slice",
      file_path: firstCode.file_path,
      line_number: firstCode.line_number || 1,
      context: 3,
      max_lines: 20,
    },
  });
  const sliceJson = JSON.parse(textOf(slice));
  console.log(
    "truth_inspect:",
    `${sliceJson.file_path}:${sliceJson.range?.start}-${sliceJson.range?.end}, ${sliceJson.lines?.length} lines`,
  );
  if (!sliceJson.lines?.length) throw new Error("read_slice returned no lines");

  const who = await send("tools/call", {
    name: "lark_auth",
    arguments: { action: "whoami", profile: "geren" },
  });
  const whoJson = JSON.parse(textOf(who));
  console.log("auth whoami:", whoJson.ok, whoJson.profile, whoJson.user?.name || "");

  const doc = await send("tools/call", {
    name: "lark_doc",
    arguments: { action: "search", query: "图表", limit: 3 },
  });
  const docJson = JSON.parse(textOf(doc));
  console.log("doc search:", docJson.ok, docJson.total, docJson.docs?.[0]?.title || "");
  if (!docJson.docs?.length) throw new Error("doc search returned no docs");
  const docRead = await send("tools/call", {
    name: "lark_doc",
    arguments: { action: "read", path: docJson.docs[0].path, limit: 20 },
  });
  const docReadJson = JSON.parse(textOf(docRead));
  console.log("doc read:", docReadJson.ok, docReadJson.total_lines, "lines");

  const consoleList = await send("tools/call", {
    name: "lark_console",
    arguments: { action: "list_apps", profile: "geren", limit: 50 },
  });
  const consoleJson = JSON.parse(textOf(consoleList));
  console.log("console list_apps:", consoleJson.ok, consoleJson.total, consoleJson.apps?.[0]?.app_id || "");
  if (!consoleJson.apps?.length) throw new Error("console list_apps returned no apps");
  const testApp = consoleJson.apps[0].app_id;
  const probeApp =
    (process.env.LARKIT_VERIFY_APP_ID &&
      consoleJson.apps.find(
        (app) => app.app_id === process.env.LARKIT_VERIFY_APP_ID,
      )) ||
    consoleJson.apps.find((app) => app.status === 2) ||
    consoleJson.apps[0];

  const consoleDry = await send("tools/call", {
    name: "lark_console",
    arguments: { action: "enable_bot_ws", app_id: testApp, profile: "geren", dry_run: true },
  });
  const consoleDryJson = JSON.parse(textOf(consoleDry));
  console.log("console dry-run ws:", consoleDryJson.ok, consoleDryJson.calls?.length || 0, "calls");

  const credResult = await send("tools/call", {
    name: "lark_console",
    arguments: { action: "get_credentials", app_id: probeApp.app_id, profile: "geren" },
  });
  const cred = JSON.parse(textOf(credResult));
  console.log("console credentials:", cred.ok, cred.app_id, "secret_len=" + (cred.app_secret?.length || 0));

  const openapi = await send("tools/call", {
    name: "lark_probe",
    arguments: {
      mode: "openapi",
      app_id: cred.app_id,
      app_secret: cred.app_secret,
      method: "GET",
      path: "/im/v1/chats",
      query: { page_size: 1 },
    },
  }, 60_000);
  const openapiJson = JSON.parse(textOf(openapi));
  console.log("openapi probe:", openapiJson.ok, openapiJson.status, openapiJson.code, openapiJson.ms || openapiJson.elapsed_ms);

  const probe = await send("tools/call", {
    name: "lark_probe",
    arguments: {
      mode: "client",
      command: "PUSH_MESSAGES",
      profile: "geren",
      transport: "ws",
      wait_push: true,
      timeout: 5000,
    },
  }, 30_000);
  const probeJson = JSON.parse(textOf(probe));
  console.log(
    "client probe:",
    `handshake=${probeJson.handshake} ok=${probeJson.ok} events=${probeJson.events?.length || 0}`,
  );

  console.log("\nMCP verification passed");
  if (stderr.trim()) console.log("server stderr tail:\n", stderr.trim().split("\n").slice(-8).join("\n"));
}

try {
  await main();
} catch (error) {
  console.error("MCP verification failed:", error);
  if (stderr.trim()) console.error("stderr:\n", stderr.trim().slice(-3000));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
