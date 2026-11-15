#!/usr/bin/env node
import "../src/shared/quiet.js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  DATA_DIR,
  FORMATTED_DIR,
  ROOT,
  TRUTH_DB,
} from "../src/shared/paths.js";
import { createReporter } from "../src/bootstrap/report.js";

// Piping into `head`/`jq -e` closes stdout early; treat that as success.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code === "EPIPE") process.exit(0);
    throw error;
  });
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function printHelp() {
  console.log(`larkit — Feishu full-stack truth engine

Usage:
  larkit                     Initialize on first run, otherwise show status
  larkit init [options]      Install/refresh truth source + skill + CLI
  larkit status [--json] [--check]   --check compares the installed truth with its channel
  larkit update [options]    Re-run init; outdated pieces are refreshed
  larkit update --channel    switch to the official truth channel (R2) and refresh

  larkit index [--only=extract,format,anchors,protocol,db] [--force]
  larkit search <query> [--scope=all|verified|protocol|web|electron] [--limit=10]
  larkit inspect <file_path> <line_number> [--context=12] [--mode=context|function] [--max-lines=120]
  larkit save <topic> [--content=... | --file=...] [--evidence=...] [--source=probe] [--confidence=high]
  larkit doc search <query> [--category=...] [--limit=30]
  larkit doc read <path> [--offset=0] [--limit=120]
  larkit doc categories
  larkit auth <whoami|check|list|use|cookie|login|login_status|import|logout> [--profile=...] [--name=...] [--file=...] [--cookie=...]
  larkit console <action> [--app=cli_xxx] [--profile=...] [--dry-run] [--json]
  larkit probe openapi --path=/im/v1/chats [--app-id=... --app-secret=...] [--method=GET]
  larkit probe client --command=PUT_MESSAGE [--transport=ws|gateway] [--payload='{}']
  larkit skills <list|install|remove> [--target=agents,claude,project] [--force]
  larkit pack <build|verify|path|stats> [--out=dist/truth-pack] [--tag=<pack-tag>] [--base-url=...]
  larkit mcp                 Start the MCP stdio server
  larkit mcp config          Print the MCP client configuration
  larkit doctor

Init options:
  --pack=<manifest.json|dir|.tar.gz|https://...>   truth pack source (URLs are remembered as the channel)
  --channel[=<url>]                               adopt https://larkit.tapeless.eu.org/manifest.json (or a custom channel)
  --from-assets --deb=<feishu-linux.deb> --web-dump=<dir>   build locally (Linux)
  --only=truth,skill,cli,mcp   --skip=...          select bootstrap steps
  --force[=truth,skill,cli]                       reinstall selected steps
  --target=agents,claude,project  --project       skill install targets
  --global  --bin-dir=<dir>  --no-skill  --no-cli  --dry-run  --json  --quiet

Environment:
  LARKIT_HOME       override ~/.larkit (data, skill state, CLI, config)
  LARKIT_DATA_DIR   override the truth.db / formatted corpus location
  LARKIT_VERIFIED_DIR  override verified_truths
  LARKIT_PACK_MANIFEST  default truth pack manifest (URL or path)
  LARKIT_DEB / LARKIT_WEB_DUMP   local assets for --from-assets
  FEISHU_APP_ID / FEISHU_APP_SECRET
  CHROME_PATH       Chrome executable for browser_fallback
`);
}

function initOptions(flags, json) {
  const truthy = (value) => value === true || value === "true";
  return {
    pack: flags.pack,
    channel: flags.channel,
    fromAssets: truthy(flags["from-assets"]),
    deb: flags.deb,
    webDump: flags["web-dump"],
    concurrency: num(flags.concurrency, undefined),
    force: flags.force === true,
    forceSteps: typeof flags.force === "string" ? flags.force : undefined,
    only: flags.only,
    skip: flags.skip,
    targets: flags.target ? String(flags.target).split(",") : undefined,
    project: truthy(flags.project),
    global: truthy(flags.global),
    binDir: flags["bin-dir"],
    cliSource: flags["cli-source"],
    noSkill: truthy(flags["no-skill"]),
    noCli: truthy(flags["no-cli"]),
    dryRun: truthy(flags["dry-run"]),
    json,
    quiet: truthy(flags.quiet),
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const json = flags.json === true;
  const reporter = createReporter({ json, quiet: flags.quiet === true });

  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  // Startup truth check: read the fixed channel URL and install a newer pack
  // before the command runs.  Time-boxed, TTL-cached, silent on failure, and
  // skipped for commands that manage the truth source themselves.
  const AUTO_UPDATE_SKIP = new Set([
    "init",
    "update",
    "mcp",
    "pack",
    "index",
    "version",
    "help",
    "skills",
    "status",
  ]);
  if (command && !AUTO_UPDATE_SKIP.has(command) && flags["no-update"] !== true) {
    try {
      const { maybeAutoUpdate } = await import("../src/bootstrap/channel.js");
      await maybeAutoUpdate({ reporter });
    } catch (error) {
      reporter.warn(`truth auto-update skipped: ${error.message}`);
    }
  }

  if (command === "version" || flags.version) {
    const { packageVersion } = await import("../src/bootstrap/pack.js");
    console.log(`larkit ${packageVersion()}`);
    return;
  }

  if (!command) {
    const { collectStatus, printStatus } = await import("../src/bootstrap/init.js");
    const { isInitialized, readState } = await import("../src/bootstrap/state.js");
    const state = readState();
    const failed = Object.values(state?.steps || {}).some(
      (step) => step?.status === "failed",
    );
    if (isInitialized() && !failed) {
      const status = collectStatus();
      if (json) reporter.result(status);
      else printStatus(status, reporter);
      return;
    }
    const { runInit } = await import("../src/bootstrap/init.js");
    await runInit(initOptions(flags, json));
    return;
  }

  if (command === "init" || command === "update") {
    const { runInit } = await import("../src/bootstrap/init.js");
    await runInit(initOptions(flags, json));
    return;
  }

  if (command === "status") {
    const { collectStatus, printStatus } = await import("../src/bootstrap/init.js");
    const { checkTruthChannel } = await import("../src/bootstrap/channel.js");
    const status = collectStatus();
    if (flags.check) {
      try {
        const check = await checkTruthChannel({
          channel: typeof flags.check === "string" ? flags.check : undefined,
        });
        status.truth.channel_check = check;
      } catch (error) {
        status.truth.channel_check = { checked: false, reason: error.message };
      }
    }
    if (json) reporter.result(status);
    else printStatus(status, reporter);
    return;
  }

  if (command === "skills") {
    const action = positional[1] || "list";
    const { packageVersion } = await import("../src/bootstrap/pack.js");
    const {
      installSkill,
      removeSkill,
      resolveSkillTargets,
    } = await import("../src/bootstrap/skills.js");
    if (action === "list") {
      const { collectStatus } = await import("../src/bootstrap/init.js");
      const value = { skills: collectStatus().skills };
      reporter.result(value);
      if (!json) {
        if (!value.skills.length) reporter.info("no larkit skill installed");
        for (const skill of value.skills) {
          reporter.detail(skill.name, `${skill.target}  v${skill.version || "?"}`);
        }
      }
      return;
    }
    const targets = resolveSkillTargets({
      targets: flags.target ? String(flags.target).split(",") : undefined,
      project: flags.project === true,
    });
    if (action === "install") {
      const results = installSkill({
        targets,
        version: packageVersion(),
        force: flags.force === true,
        dryRun: flags["dry-run"] === true,
      });
      reporter.result({ skills: results });
      if (!json) {
        for (const entry of results) {
          const text = `${entry.target} (${entry.status})`;
          if (entry.status === "skipped") reporter.warn(`${text}: ${entry.reason}`);
          else reporter.ok(text);
        }
      }
      return;
    }
    if (action === "remove") {
      const results = removeSkill({ targets, dryRun: flags["dry-run"] === true });
      reporter.result({ skills: results });
      if (!json) {
        for (const entry of results) {
          const text = `${entry.target} (${entry.status})`;
          if (entry.status === "skipped") reporter.warn(`${text}: ${entry.reason}`);
          else reporter.ok(text);
        }
      }
      return;
    }
    throw new Error(`unknown skills action: ${action}; expected list|install|remove`);
  }

  if (command === "pack") {
    const { runPackCommand } = await import("../src/bootstrap/pack-cli.js");
    const action = positional[1] || "path";
    await runPackCommand(action, { ...flags, manifest: positional[2] || flags.manifest }, reporter);
    return;
  }

  if (command === "index") {
    const args = [path.join(ROOT, "scripts", "build-index.mjs")];
    for (const key of ["only", "force", "limit", "concurrency"]) {
      if (flags[key] !== undefined) {
        args.push(flags[key] === true ? `--${key}` : `--${key}=${flags[key]}`);
      }
    }
    const env = { ...process.env };
    if (flags.deb) env.LARKIT_DEB = path.resolve(flags.deb);
    if (flags["web-dump"]) env.LARKIT_WEB_DUMP = path.resolve(flags["web-dump"]);
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
    process.exit(result.status || 0);
  }

  if (command === "search") {
    const { searchTruth } = await import("../src/truth/search.js");
    const result = searchTruth({
      query: positional[1],
      scope: flags.scope || "all",
      limit: num(flags.limit, 10),
    });
    output(result);
    return;
  }

  if (command === "inspect") {
    const { readSlice } = await import("../src/truth/search.js");
    const result = readSlice({
      filePath: positional[1],
      lineNumber: num(positional[2], 1),
      context: num(flags.context, 12),
      mode: flags.mode || "context",
      maxLines: num(flags["max-lines"], 120),
    });
    output(result);
    return;
  }

  if (command === "save") {
    const { saveVerified } = await import("../src/truth/search.js");
    const topic = positional[1];
    let content = flags.content;
    if (!content && flags.file) content = fs.readFileSync(path.resolve(flags.file), "utf8");
    if (!content && !process.stdin.isTTY) content = fs.readFileSync(0, "utf8");
    const tags = flags.tag
      ? String(flags.tag).split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    output(
      saveVerified({
        topic,
        content,
        evidence: flags.evidence,
        source: flags.source || "probe",
        confidence: flags.confidence || "high",
        tags,
      }),
    );
    return;
  }

  if (command === "doc") {
    const action = positional[1] || "categories";
    if (action === "search") {
      const { searchDocs } = await import("../src/docs/client.js");
      output(
        await searchDocs({
          query: positional[2] || flags.query || "",
          category: flags.category || "",
          limit: num(flags.limit, 30),
        }),
      );
      return;
    }
    if (action === "read") {
      const { readDoc } = await import("../src/docs/client.js");
      output(
        await readDoc({
          docPath: positional[2] || flags.path,
          offset: num(flags.offset, 0),
          limit: num(flags.limit, 0),
        }),
      );
      return;
    }
    const { docCategories } = await import("../src/docs/client.js");
    output(await docCategories());
    return;
  }

  if (command === "auth") {
    const { authDispatch } = await import("../src/auth/service.js");
    const action = positional[1] || "whoami";
    output(
      await authDispatch({
        action,
        profile: flags.profile,
        name: flags.name,
        file: flags.file,
        cookie: flags.cookie,
        wait: flags.wait === true || flags.wait === "true",
        timeout_ms: num(flags["timeout-ms"], undefined),
        headless: flags.headful
          ? false
          : flags.headless === undefined
            ? true
            : flags.headless !== "false",
      }),
    );
    return;
  }

  if (command === "console") {
    const { consoleDispatch } = await import("../src/console/dispatch.js");
    const action = positional[1] || "list_apps";
    const args = {
      action,
      profile: flags.profile,
      app_id: flags.app || flags["app-id"] || flags.app_id,
      name: flags.name,
      desc: flags.desc,
      avatar: flags.avatar,
      query: flags.query,
      limit: num(flags.limit, undefined),
      scopes: flags.scopes
        ? String(flags.scopes).split(",").map((x) => x.trim()).filter(Boolean)
        : undefined,
      scope_type: flags["scope-type"],
      operation: flags.operation,
      version: flags.version,
      remark: flags.remark,
      full_release: flags["full-release"] === true || flags["full-release"] === "true",
      create_if_missing:
        flags["create-if-missing"] === undefined
          ? undefined
          : flags["create-if-missing"] === true || flags["create-if-missing"] === "true",
      release: flags.release === true || flags.release === "true",
      dry_run: flags["dry-run"] === true || flags["dry-run"] === "true",
      url: flags.url,
      wait_ms: num(flags["wait-ms"], undefined),
      screenshot: flags.screenshot === true || flags.screenshot === "true",
      record_as: flags["record-as"],
      actions: flags.actions ? JSON.parse(flags.actions) : undefined,
    };
    output(await consoleDispatch(args));
    return;
  }

  if (command === "probe") {
    const mode = positional[1];
    if (mode === "openapi") {
      const { probeOpenApi } = await import("../src/probe/openapi.js");
      output(
        await probeOpenApi({
          appId: flags["app-id"] || flags.app,
          appSecret: flags["app-secret"] || flags.secret,
          method: flags.method || "GET",
          path: flags.path || positional[2],
          query: flags.query ? JSON.parse(flags.query) : undefined,
          body: flags.body ? JSON.parse(flags.body) : undefined,
          userAccessToken: flags["user-access-token"],
          tenantAccessToken: flags["tenant-access-token"],
          forceToken: flags["force-token"] === true || flags["force-token"] === "true",
          timeout: num(flags.timeout, 30000),
        }),
      );
      return;
    }
    if (mode === "client") {
      const { probeClientProtocol } = await import("../src/probe/client.js");
      output(
        await probeClientProtocol({
          command: flags.command || positional[2],
          payload: flags.payload ? JSON.parse(flags.payload) : {},
          transport: flags.transport || "ws",
          profile: flags.profile,
          timeout: num(flags.timeout, 15000),
          waitPush: flags["wait-push"] === true || flags["wait-push"] === "true",
          maxEvents: num(flags["max-events"], 5),
          listenMs: num(flags["listen-ms"], 0),
        }),
      );
      return;
    }
    throw new Error("probe mode required: openapi | client");
  }

  if (command === "doctor") {
    const result = {
      node: process.version,
      root: ROOT,
      data_dir: DATA_DIR,
      truth_db: fs.existsSync(TRUTH_DB),
      formatted_dir: fs.existsSync(FORMATTED_DIR),
      chrome: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
      ].find((candidate) => fs.existsSync(candidate)) || null,
    };
    if (result.truth_db) {
      const { truthStats } = await import("../src/truth/search.js");
      result.stats = truthStats();
    }
    const { listProfiles } = await import("../src/auth/store.js");
    result.profiles = listProfiles();
    const { tokenStatus } = await import("../src/probe/openapi.js");
    result.tokens = tokenStatus();
    const { listRecipes } = await import("../src/console/client.js");
    result.console_recipes = Object.keys(listRecipes());
    const { collectStatus } = await import("../src/bootstrap/init.js");
    result.install = collectStatus();
    output(result);
    return;
  }

  if (command === "mcp") {
    if (positional[1] === "config") {
      const { MCP_CONFIG_FILE } = await import("../src/shared/paths.js");
      const { mcpServerCommand } = await import("../src/bootstrap/cli-install.js");
      const config = fs.existsSync(MCP_CONFIG_FILE)
        ? JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, "utf8"))
        : {
            mcpServers: {
              larkit: { command: mcpServerCommand(), args: [] },
            },
          };
      reporter.result(config);
      if (!json) console.log(JSON.stringify(config, null, 2));
      return;
    }
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const { createLarkitServer } = await import("../src/mcp/server.js");
    const server = createLarkitServer();
    await server.connect(new StdioServerTransport());
    return;
  }

  throw new Error(`unknown command: ${command}; run "larkit help"`);
}

main().catch((error) => {
  if (!error?.larkitReported) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
