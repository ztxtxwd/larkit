import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  BIN_DIR,
  DATA_DIR,
  DEB_FILE,
  FORMATTED_DIR,
  INSTALL_STATE_FILE,
  LARKIT_HOME,
  MCP_CONFIG_FILE,
  PKG_ROOT,
  TRUTH_DB,
  TRUTH_META,
  VERIFIED_DIR,
  WEB_DUMP_DIR,
  WEB_SUMMARY,
  displayPath,
} from "../shared/paths.js";
import {
  ensureDir,
  fileSizeMiB,
  nowIso,
  readJson,
  writeJson,
} from "../shared/util.js";
import { createReporter } from "./report.js";
import {
  DEFAULT_TRUTH_CHANNEL,
  installTruthPack,
  isChannelSource,
  packageVersion,
} from "./pack.js";
import { resolveTruthChannel } from "./channel.js";
import {
  detectCliInstall,
  installCli,
  mcpServerCommand,
} from "./cli-install.js";
import {
  installSkill,
  listInstalledSkills,
  resolveSkillTargets,
} from "./skills.js";
import {
  initialState,
  isInitialized,
  readState,
  writeState,
} from "./state.js";

const STEP_NAMES = ["truth", "skill", "cli", "mcp"];

function num(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "?";
}

function statsLine(stats = {}) {
  return [
    `${num(stats.protocolCatalog)} commands`,
    `${num(stats.codeAnchors)} anchors`,
    `${num(stats.verifiedSections)} verified sections`,
  ].join(" / ");
}

function parseList(value) {
  if (!value) return [];
  if (value === true) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function hasCodeCorpus() {
  try {
    return fs.statSync(FORMATTED_DIR).isDirectory() && fs.readdirSync(FORMATTED_DIR).length > 0;
  } catch {
    return false;
  }
}

export function collectStatus({ cwd = process.cwd() } = {}) {
  const state = readState();
  const truthInstalled = fs.existsSync(TRUTH_DB);
  const meta = readJson(TRUTH_META, null);
  const cli = detectCliInstall();
  const skills = listInstalledSkills({ cwd });
  const knownSkills = new Set(skills.map((skill) => skill.target));
  for (const entry of state?.steps?.skill?.targets || []) {
    if (!entry?.target || knownSkills.has(entry.target)) continue;
    const manifestFile = path.join(entry.target, ".larkit-skill.json");
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = readJson(manifestFile, {});
    skills.push({
      name: entry.name || "custom",
      target: entry.target,
      version: manifest.version || null,
      files: manifest.files ? Object.keys(manifest.files).length : 0,
      installed_at: manifest.installedAt || null,
    });
  }
  const failed = Object.entries(state?.steps || {})
    .filter(([, value]) => value?.status === "failed")
    .map(([name, value]) => ({ step: name, error: value.error || null }));
  return {
    larkitVersion: packageVersion(),
    initialized: Boolean(state && truthInstalled),
    failed_steps: failed,
    home: LARKIT_HOME,
    data_dir: DATA_DIR,
    verified_dir: VERIFIED_DIR,
    state_file: INSTALL_STATE_FILE,
    truth: {
      installed: truthInstalled,
      path: TRUTH_DB,
      bytes: fileBytes(TRUTH_DB),
      meta,
      step: state?.steps?.truth || null,
    },
    code: {
      installed: hasCodeCorpus(),
      path: FORMATTED_DIR,
      files: state?.steps?.truth?.files?.files || null,
    },
    skills,
    cli: {
      ...cli,
      step: state?.steps?.cli || null,
    },
    mcp: {
      config: MCP_CONFIG_FILE,
      installed: fs.existsSync(MCP_CONFIG_FILE),
      server: mcpServerCommand(),
    },
  };
}

export function printStatus(status, reporter = createReporter()) {
  reporter.line("");
  reporter.header(
    `larkit ${status.larkitVersion}`,
    status.initialized
      ? "initialized"
      : status.truth.installed
        ? "data present, setup incomplete"
        : "not initialized",
  );
  reporter.detail("home", status.home);
  if (status.truth.installed) {
    const meta = status.truth.meta || {};
    reporter.detail(
      "truth.db",
      `${fileSizeMiB(status.truth.bytes)} · ${statsLine(meta)}`,
    );
  } else {
    reporter.detail("truth.db", "missing (run `larkit init`)");
  }
  const truthStep = status.truth.step || {};
  if (status.truth.installed && truthStep.packVersion) {
    reporter.detail(
      "truth pack",
      `${truthStep.packVersion}${truthStep.source ? ` (${truthStep.source})` : ""}`,
    );
  }
  if (truthStep.channel) reporter.detail("truth channel", truthStep.channel);
  const check = status.truth.channel_check;
  if (check) {
    if (!check.checked) {
      reporter.detail("truth update", `unavailable (${check.reason || "unknown"})`);
    } else if (check.upToDate) {
      reporter.detail("truth update", `up to date (${check.latest})`);
    } else {
      reporter.detail(
        "truth update",
        `${check.latest} available (current ${check.current || "unknown"}) · run \`larkit update\``,
      );
    }
  }
  reporter.detail(
    "code corpus",
    status.code.installed
      ? `${displayPath(status.code.path)} (read_slice ready${status.code.files ? `, ${num(status.code.files)} files` : ""})`
      : "missing (shipped with the truth pack; rerun `larkit init`)",
  );
  if (status.skills.length) {
    for (const skill of status.skills) {
      reporter.detail("skill", `${skill.target}  v${skill.version || "?"}`);
    }
  } else {
    reporter.detail("skill", "not installed (run `larkit init --only=skill`)");
  }
  reporter.detail(
    "cli",
    status.cli.shim_installed
      ? `${status.cli.shim}${status.cli.on_path ? " (on PATH)" : " (not on PATH)"}`
      : "not installed",
  );
  reporter.detail(
    "mcp",
    status.mcp.installed
      ? `${status.mcp.config} → ${status.mcp.server}`
      : "not configured",
  );
  for (const failure of status.failed_steps || []) {
    reporter.warn(`${failure.step} failed: ${failure.error || "unknown error"}`);
  }
  if (!status.initialized) {
    reporter.line("");
    reporter.info(
      status.truth.installed
        ? "Truth data is present. Run `larkit init` to install/repair the skill, CLI and MCP config."
        : "Run `larkit init` (or `npx larkit`) to install the truth source, skill and CLI.",
    );
  } else if (status.failed_steps?.length) {
    reporter.info("Rerun `larkit init` to retry failed steps.");
  }
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    throw new Error(
      `larkit needs Node.js >= 24 (found ${process.versions.node}). Upgrade Node, then rerun.`,
    );
  }
}

async function buildTruthFromAssets({ deb, webDump, concurrency, force, reporter }) {
  const platform = process.platform;
  if (platform !== "linux") {
    throw new Error(
      `--from-assets needs dpkg-deb (found ${platform}). Use a Linux machine/WSL, or pass --pack=<archive>.`,
    );
  }
  const dpkg = spawnSync("dpkg-deb", ["--version"], { encoding: "utf8" });
  if (dpkg.error || dpkg.status !== 0) {
    throw new Error("--from-assets needs `dpkg-deb` on PATH (Debian/Ubuntu package).");
  }
  const debFile = deb ? path.resolve(deb) : DEB_FILE;
  const webDir = webDump ? path.resolve(webDump) : WEB_DUMP_DIR;
  if (!fs.existsSync(debFile)) {
    throw new Error(
      `Feishu deb not found: ${debFile}\nDownload the official Linux client and pass --deb=<path>.`,
    );
  }
  if (!fs.existsSync(WEB_SUMMARY) && !fs.existsSync(path.join(webDir, "summary.json"))) {
    throw new Error(
      `web dump not found: ${webDir}\nPass --web-dump=<dir containing summary.json>, or omit --from-assets.`,
    );
  }
  mergeSeeds(path.join(PKG_ROOT, "verified_truths"), VERIFIED_DIR, {});
  const args = [path.join(PKG_ROOT, "scripts", "build-index.mjs")];
  if (concurrency) args.push(`--concurrency=${concurrency}`);
  if (force) args.push("--force");
  const env = {
    ...process.env,
    LARKIT_DATA_DIR: DATA_DIR,
    LARKIT_VERIFIED_DIR: VERIFIED_DIR,
    LARKIT_DEB: debFile,
    LARKIT_WEB_DUMP: webDir,
  };
  reporter.info(`deb        ${debFile} (${fileSizeMiB(fileBytes(debFile))})`);
  reporter.info(`web dump   ${webDir}`);
  reporter.info(`data       ${DATA_DIR}`);
  reporter.info("this unpacks the deb, formats ~9k files and builds SQLite; expect 10+ minutes");
  const result = spawnSync(process.execPath, args, {
    cwd: PKG_ROOT,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`index build failed with exit code ${result.status}`);
  }
  if (!fs.existsSync(TRUTH_DB)) {
    throw new Error("index build finished but truth.db is missing; check the build log above");
  }
  return { stats: readJson(TRUTH_META, {}) };
}

function writeMcpConfig({ global } = {}) {
  const server = global ? "larkit-mcp" : mcpServerCommand();
  const env = {
    LARKIT_HOME,
    LARKIT_DATA_DIR: DATA_DIR,
    LARKIT_VERIFIED_DIR: VERIFIED_DIR,
  };
  const config = {
    mcpServers: {
      larkit: {
        command: server,
        args: [],
        env,
      },
    },
  };
  writeJson(MCP_CONFIG_FILE, config);
  return { server, config };
}

/**
 * Idempotent bootstrap:
 *   1. truth source (embedded pack / downloaded pack / local build)
 *   2. optional code corpus for read_slice()
 *   3. agent skill
 *   4. durable CLI command
 *   5. MCP config + status
 */
export async function runInit(options = {}) {
  const reporter = createReporter({ json: options.json, quiet: options.quiet });
  const version = packageVersion();
  const startedAt = Date.now();
  const only = options.only ? new Set(parseList(options.only)) : null;
  const skip = new Set(parseList(options.skip));
  if (options.noSkill) skip.add("skill");
  if (options.noCli) skip.add("cli");
  if (only) {
    for (const name of only) {
      if (!STEP_NAMES.includes(name)) {
        throw new Error(`unknown --only step: ${name}; expected ${STEP_NAMES.join(",")}`);
      }
    }
  }
  const should = (name) => (!only || only.has(name)) && !skip.has(name);
  const forceSteps = parseList(options.forceSteps);
  const forced = (name) => options.force === true || forceSteps.includes(name);
  const cwd = options.cwd || process.cwd();
  const dryRun = Boolean(options.dryRun);

  if (!dryRun) {
    ensureDir(LARKIT_HOME);
    ensureDir(DATA_DIR);
    ensureDir(VERIFIED_DIR);
    for (const dir of [LARKIT_HOME, DATA_DIR]) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // best effort (Windows, exotic filesystems)
      }
    }
  }

  const state = readState() || initialState();
  const summary = {
    ok: false,
    larkitVersion: version,
    home: LARKIT_HOME,
    dataDir: DATA_DIR,
    verifiedDir: VERIFIED_DIR,
    dryRun,
    steps: {},
  };

  reporter.header(
    `larkit ${version}`,
    options.fromAssets
      ? "building the truth source from local assets"
      : `install target ${LARKIT_HOME}`,
  );

  try {
    checkNodeVersion();
  } catch (error) {
    reporter.error(error.message);
    throw error;
  }

  // 1. truth source -------------------------------------------------------
  if (should("truth")) {
    reporter.step("truth source");
    try {
      if (options.fromAssets) {
        if (dryRun) {
          summary.steps.truth = { status: "ready", source: "local-build", dryRun: true };
          reporter.info(`would build from ${path.resolve(options.deb || DEB_FILE)}`);
        } else {
          const built = await buildTruthFromAssets({
            deb: options.deb,
            webDump: options.webDump,
            concurrency: options.concurrency,
            force: forced("truth"),
            reporter,
          });
          summary.steps.truth = {
            status: "ready",
            source: "local-build",
            stats: built.stats,
            packVersion: version,
            packSha: `local-build:${built.stats?.generatedAt || nowIso()}`,
            seeds: {},
          };
          reporter.ok(`truth.db ${fileSizeMiB(fileBytes(TRUTH_DB))} · ${statsLine(built.stats)}`);
        }
      } else {
        const { explicit, remembered, channel } = resolveTruthChannel(state, options);
        const source = explicit || channel || DEFAULT_TRUTH_CHANNEL;
        const channelToRecord = isChannelSource(source)
          ? source
          : remembered || (isChannelSource(channel) ? channel : null);
        if (!source && fs.existsSync(TRUTH_DB)) {
          summary.steps.truth = {
            status: "ready",
            source: "existing",
            channel: channelToRecord,
            packVersion: state.steps.truth?.packVersion || version,
            packSha: state.steps.truth?.packSha || `existing:${fileBytes(TRUTH_DB)}`,
            stats: readJson(TRUTH_META, {}),
            seeds: state.steps.truth?.seeds || {},
            skipped: true,
          };
          reporter.info(`using existing truth.db at ${TRUTH_DB}`);
        } else {
          let result;
          try {
            result = await installTruthPack({
              source,
              force: forced("truth"),
              quiet: reporter.quiet,
              reporter,
              state: { truth: state.steps.truth },
            });
          } catch (error) {
            if (!isChannelSource(source)) throw error;
            throw new Error(
              `cannot reach the truth channel ${source} (${error.message}).\n` +
                "retry when the network is back, or install from a pack file:\n" +
                "  larkit init --pack=<manifest.json|pack-dir|.tar.gz>",
            );
          }
          summary.steps.truth = {
            status: "ready",
            source: result.source || result.location,
            channel: channelToRecord,
            packVersion: result.packVersion,
            packSha: result.packSha,
            stats: result.stats,
            seeds: result.seeds || {},
            files: result.files || null,
            skipped: result.status !== "installed",
            lastCheckAt: Date.now(),
            latestSeen: result.packVersion,
          };
          state.steps = { ...state.steps, truth: summary.steps.truth };
          if (!dryRun) {
            writeState({
              ...state,
              larkitVersion: version,
              installedAt: state.installedAt || nowIso(),
              steps: state.steps,
            });
          }
          if (result.status === "installed") {
            reporter.ok(
              `truth.db ${fileSizeMiB(fileBytes(TRUTH_DB))} · ${statsLine(result.stats)}`,
            );
            reporter.detail(
              "source",
              `${summary.steps.truth.source} pack ${result.packVersion}`,
            );
            if (result.files) reporter.detail("code", `${num(result.files)} files`);
          } else {
            reporter.info(
              `already up to date (pack ${result.packVersion}, ${statsLine(result.stats)})`,
            );
          }
        }
      }
      state.steps = { ...state.steps, truth: summary.steps.truth };
      if (!dryRun) {
        writeState({
          ...state,
          larkitVersion: version,
          installedAt: state.installedAt || nowIso(),
          steps: state.steps,
        });
      }
    } catch (error) {
      summary.steps.truth = { status: "failed", error: error.message };
      if (!dryRun) {
        writeState({
          ...state,
          larkitVersion: version,
          steps: { ...state.steps, truth: summary.steps.truth },
        });
      }
      reporter.error(error.message);
      if (error && typeof error === "object") error.larkitReported = true;
      throw error;
    }
  }

  // 3. agent skill --------------------------------------------------------
  if (should("skill")) {
    reporter.step("agent skill");
    try {
      const targets = resolveSkillTargets({
        targets: options.targets,
        cwd,
        project: options.project,
      });
      const results = installSkill({
        targets,
        version,
        force: forced("skill"),
        dryRun,
      });
      const installed = results.filter((entry) =>
        ["installed", "updated", "would-install", "would-update"].includes(entry.status),
      );
      summary.steps.skill = {
        status: installed.length ? "ready" : "skipped",
        version,
        targets: results,
      };
      for (const entry of results) {
        if (entry.status === "skipped") {
          reporter.warn(`${entry.target}: ${entry.reason}`);
        } else {
          reporter.ok(`${entry.target} (${entry.files} files, ${entry.status})`);
          if (entry.backup) reporter.detail("backup", entry.backup);
        }
      }
      state.steps = { ...state.steps, skill: summary.steps.skill };
      if (!dryRun) {
        writeState({
          ...state,
          larkitVersion: version,
          installedAt: state.installedAt || nowIso(),
          steps: state.steps,
        });
      }
    } catch (error) {
      summary.steps.skill = { status: "failed", error: error.message };
      reporter.error(error.message);
    }
  }

  // 4. CLI ----------------------------------------------------------------
  if (should("cli")) {
    reporter.step("CLI");
    try {
      if (dryRun) {
        summary.steps.cli = {
          status: "ready",
          dryRun: true,
          mode: options.global ? "global" : "local-prefix",
        };
        reporter.info(
          options.global
            ? `would run npm install -g larkit@${version}`
            : `would install larkit@${version} into ${path.join(LARKIT_HOME, "cli")} and shim ${path.join(BIN_DIR, "larkit")}`,
        );
      } else {
        const result = installCli({
          version,
          force: forced("cli"),
          global: Boolean(options.global),
          binDir: options.binDir || BIN_DIR,
          source: options.cliSource || process.env.LARKIT_CLI_SOURCE || null,
        });
        summary.steps.cli = {
          status: "ready",
          ...result,
        };
        if (result.status === "present") {
          reporter.info(`already installed (${result.mode}, v${result.version || version})`);
        } else {
          reporter.ok(
            result.shim
              ? `${result.shim} → ${result.entry}`
              : `installed globally (npm prefix)`,
          );
        }
        if (!result.on_path) {
          reporter.warn(
            `${result.bin_dir} is not on PATH; add it to PATH (bash/zsh: export PATH="${result.bin_dir}:$PATH")`,
          );
        }
        // Keep an already-written MCP config pointing at the new shim even
        // when `--only=cli` excludes the mcp step.
        if (fs.existsSync(MCP_CONFIG_FILE) || summary.steps.mcp) {
          const written = writeMcpConfig({ global: Boolean(options.global) });
          summary.steps.mcp = {
            status: "ready",
            config: MCP_CONFIG_FILE,
            server: written.server,
          };
          state.steps = { ...state.steps, mcp: summary.steps.mcp };
        }
      }
      state.steps = { ...state.steps, cli: summary.steps.cli };
      if (!dryRun) {
        writeState({
          ...state,
          larkitVersion: version,
          installedAt: state.installedAt || nowIso(),
          steps: state.steps,
        });
      }
    } catch (error) {
      summary.steps.cli = { status: "failed", error: error.message };
      reporter.error(error.message);
    }
  }

  // 5. MCP config ---------------------------------------------------------
  if (should("mcp")) {
    reporter.step("MCP config");
    try {
      if (dryRun) {
        summary.steps.mcp = {
          status: "ready",
          config: MCP_CONFIG_FILE,
          dryRun: true,
        };
        reporter.info(`would write ${MCP_CONFIG_FILE}`);
      } else {
        const written = writeMcpConfig({ global: Boolean(options.global) });
        summary.steps.mcp = {
          status: "ready",
          config: MCP_CONFIG_FILE,
          server: written.server,
        };
        reporter.ok(`${MCP_CONFIG_FILE} (command: ${written.server})`);
      }
      state.steps = { ...state.steps, mcp: summary.steps.mcp };
      if (!dryRun) {
        writeState({
          ...state,
          larkitVersion: version,
          installedAt: state.installedAt || nowIso(),
          steps: state.steps,
        });
      }
    } catch (error) {
      summary.steps.mcp = { status: "failed", error: error.message };
      reporter.error(error.message);
    }
  }

  summary.ok = Object.values(summary.steps).every(
    (step) => step.status !== "failed",
  );
  summary.elapsed_ms = Date.now() - startedAt;
  summary.state_file = INSTALL_STATE_FILE;

  reporter.line("");
  if (summary.ok) {
    reporter.header(`larkit ${version} ready`, LARKIT_HOME);
    reporter.line("");
    reporter.info(`larkit status`);
    reporter.info(`larkit search card_link`);
    reporter.info(`larkit doc search 卡片`);
    reporter.info(`MCP: ${MCP_CONFIG_FILE}`);
  } else {
    reporter.error("some steps failed; rerun `larkit init --only=<step>` after fixing the cause");
  }
  reporter.result(summary);
  return summary;
}

export { isInitialized };
