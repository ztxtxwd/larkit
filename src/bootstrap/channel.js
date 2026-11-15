import fs from "node:fs";
import { FORMATTED_DIR, TRUTH_DB } from "../shared/paths.js";
import {
  DEFAULT_TRUTH_CHANNEL,
  TIER_NAME,
  installTruthPack,
  isChannelSource,
  loadPackManifest,
  packageVersion,
} from "./pack.js";
import { initialState, readState, writeState } from "./state.js";

export { DEFAULT_TRUTH_CHANNEL };

/** How often a normal command is allowed to look for a newer truth pack. */
export const AUTO_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

/** sha256 of the single unified archive that carries truth + code corpus. */
export function packShaOf(manifest) {
  return manifest?.tiers?.[TIER_NAME]?.sha256 || null;
}

export function truthTagOf(manifest) {
  return manifest?.packVersion || manifest?.larkitVersion || null;
}

/**
 * Resolve where the truth source comes from.
 *
 *   --pack=<dir|url>            explicit source (remembered when it is a URL)
 *   LARKIT_PACK_MANIFEST        same, via env
 *   --channel[=<url>]           opt in to the official/custom truth channel
 *   remembered channel          state.steps.truth.channel (set by a previous run)
 *   otherwise                   the official channel
 *
 * There is no bundled pack and no core/code split: every install downloads the
 * same unified archive.
 */
export function resolveTruthChannel(state, options = {}) {
  const explicit = options.pack || process.env.LARKIT_PACK_MANIFEST || null;
  const remembered = state?.steps?.truth?.channel || null;
  const flag = options.channel;
  const requested = flag
    ? flag === true || flag === "default" || flag === "latest"
      ? DEFAULT_TRUTH_CHANNEL
      : String(flag)
    : null;
  const channel = isChannelSource(explicit) ? explicit : requested || remembered;
  return { explicit, remembered, channel, requested };
}

/** The channel a plain command should consult. */
export function activeChannel(state) {
  return state?.steps?.truth?.channel || DEFAULT_TRUTH_CHANNEL;
}

async function fetchManifest(source, { timeoutMs } = {}) {
  if (!timeoutMs) return (await loadPackManifest(source)).manifest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source, {
      headers: { "user-agent": `larkit/${packageVersion()}` },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${source}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare the installed truth pack with the channel without changing anything.
 * Backs `larkit status --check`.
 */
export async function checkTruthChannel({ channel } = {}) {
  const state = readState() || initialState();
  const target = channel
    ? channel === "default"
      ? DEFAULT_TRUTH_CHANNEL
      : String(channel)
    : activeChannel(state);
  const manifest = await fetchManifest(target);
  const latestSha = packShaOf(manifest);
  const currentSha = state.steps?.truth?.packSha || null;
  const tier = manifest.tiers?.[TIER_NAME] || null;
  return {
    channel: target,
    checked: true,
    current: state.steps?.truth?.packVersion || null,
    currentSha,
    latest: truthTagOf(manifest),
    latestSha,
    clientVersion: manifest.clientVersion || null,
    archive: tier ? { bytes: tier.bytes, sha256: tier.sha256 } : null,
    upToDate: Boolean(latestSha && currentSha && latestSha === currentSha),
  };
}

export function autoUpdateDisabled(env = process.env) {
  if (env.CI) return true;
  const flag = env.LARKIT_NO_AUTO_UPDATE;
  return Boolean(flag && flag !== "0" && flag !== "false");
}

/** Persist a check result without clobbering the rest of the install state. */
export function recordTruth(state, patch) {
  const next = { ...(readState() || state) };
  next.steps = {
    ...(next.steps || {}),
    truth: { ...(next.steps?.truth || {}), ...patch },
  };
  writeState(next);
  return next;
}

/**
 * Startup hook: read the channel, and if the published pack is newer than the
 * installed one, install it before the command runs.
 *
 * Guardrails: no-op in CI, with LARKIT_NO_AUTO_UPDATE=1, or within the TTL
 * window; the lookup itself is time-boxed, and any failure only produces one
 * warning — the command always runs with whatever truth exists.
 */
export async function maybeAutoUpdate({ reporter, force = false, timeoutMs = 2500 } = {}) {
  if (autoUpdateDisabled()) return { status: "disabled" };
  const state = readState() || initialState();
  const truth = state.steps?.truth || {};
  const channel = activeChannel(state);

  const ttl = Number(process.env.LARKIT_TRUTH_TTL_MS || AUTO_UPDATE_TTL_MS);
  const last = Number(truth.lastCheckAt || 0);
  if (!force && Date.now() - last < ttl) {
    return { status: "fresh", channel, checkedAt: last ? new Date(last).toISOString() : null };
  }

  let manifest;
  try {
    manifest = await fetchManifest(channel, { timeoutMs });
  } catch (error) {
    if (fs.existsSync(TRUTH_DB)) {
      recordTruth(state, { lastCheckAt: Date.now() - ttl + 15 * 60 * 1000 });
      reporter?.warn?.(`truth channel unreachable (${error.message}); keeping the local truth`);
      return { status: "unreachable", channel, error: error.message };
    }
    throw new Error(
      `cannot reach the truth channel ${channel} (${error.message}).\n` +
        "retry when the network is back, or install from a pack file:\n" +
        "  larkit init --pack=<manifest.json|pack-dir|.tar.gz>",
    );
  }

  const latestSha = packShaOf(manifest);
  const latest = truthTagOf(manifest);
  if (!latestSha || latestSha === truth.packSha) {
    recordTruth(state, { lastCheckAt: Date.now(), latestSeen: latest, channel });
    return { status: "up-to-date", channel, latest };
  }

  const tier = manifest.tiers?.[TIER_NAME];
  reporter?.info?.(
    `truth update ${truth.packVersion || "?"} → ${latest} (${tier ? `${(tier.bytes / 1024 / 1024).toFixed(1)} MiB` : "pack"})`,
  );
  try {
    const result = await installTruthPack({
      source: channel,
      quiet: true,
      reporter,
      state: { truth },
    });
    recordTruth(state, {
      status: "ready",
      source: result.source,
      channel,
      packVersion: result.packVersion,
      packSha: result.packSha,
      stats: result.stats,
      seeds: result.seeds || truth.seeds || {},
      skipped: false,
      lastCheckAt: Date.now(),
      latestSeen: latest,
      codeFiles: result.files || truth.codeFiles || null,
    });
    reporter?.ok?.(`truth ${result.packVersion} installed (${fmt(result.stats)})`);
    return { status: "updated", channel, latest, result };
  } catch (error) {
    recordTruth(state, { lastCheckAt: Date.now() - ttl + 15 * 60 * 1000 });
    reporter?.warn?.(`truth update failed (${error.message}); keeping the local truth`);
    return { status: "failed", channel, error: error.message };
  }
}

function fmt(stats = {}) {
  const parts = [];
  if (stats.protocolCatalog) parts.push(`${stats.protocolCatalog} commands`);
  if (stats.codeAnchors) parts.push(`${stats.codeAnchors} anchors`);
  if (fs.existsSync(FORMATTED_DIR)) parts.push("code corpus");
  return parts.join(" · ") || "up to date";
}
