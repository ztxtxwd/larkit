import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  DOWNLOAD_DIR,
  FORMATTED_DIR,
  LARKIT_HOME,
  PKG_ROOT,
  TRUTH_DB,
  VERIFIED_DIR,
} from "../shared/paths.js";
import { readJson } from "../shared/util.js";
import { buildTruthPack, packageVersion, verifyPack } from "./pack.js";

function defaultOutDir() {
  return path.join(PKG_ROOT, "dist", "truth-pack");
}

export async function runPackCommand(action, flags = {}, reporter) {
  const version = packageVersion();

  if (action === "path") {
    const value = {
      larkitVersion: version,
      home: LARKIT_HOME,
      dataDir: DATA_DIR,
      truthDb: TRUTH_DB,
      verifiedDir: VERIFIED_DIR,
      formattedDir: FORMATTED_DIR,
      downloads: DOWNLOAD_DIR,
      packageRoot: PKG_ROOT,
    };
    reporter.result(value);
    if (!reporter.json) {
      for (const [key, entry] of Object.entries(value)) {
        reporter.detail(key, entry);
      }
    }
    return value;
  }

  if (action === "verify") {
    const source =
      flags.manifest || process.env.LARKIT_PACK_MANIFEST || flags.from || null;
    if (!source) {
      throw new Error("usage: larkit pack verify <manifest.json|pack-dir|.tar.gz|https://...>");
    }
    const report = await verifyPack(source);
    reporter.result(report);
    if (!reporter.json) {
      for (const tier of report.tiers) {
        reporter.line(
          `${tier.ok ? "PASS" : "FAIL"}  ${tier.tier}  ${tier.file || tier.url}${tier.remote ? " (remote, not downloaded)" : ""}`,
        );
      }
    }
    if (!report.ok) throw new Error("pack verification failed");
    return report;
  }

  if (action === "build") {
    const outDir = flags.out ? path.resolve(flags.out) : defaultOutDir();
    const built = await buildTruthPack({
      outDir,
      baseUrl: flags["base-url"] || "",
      tag: flags.tag || "",
      version,
      onProgress: (bytes) => reporter.progress?.("pack", bytes, 0),
    });
    reporter.result(built);
    if (!reporter.json) {
      reporter.line("");
      reporter.ok(`manifest ${built.manifestFile}`);
      for (const [tier, artifact] of Object.entries(built.manifest.tiers)) {
        reporter.detail(
          tier,
          `${artifact.file}  ${(artifact.bytes / 1024 / 1024).toFixed(1)} MiB  ${artifact.sha256.slice(0, 16)}…`,
        );
      }
    }
    return built;
  }

  if (action === "stats") {
    const manifest = readJson(
      flags.manifest ||
        process.env.LARKIT_PACK_MANIFEST ||
        path.join(defaultOutDir(), "manifest.json"),
      null,
    );
    if (!manifest) throw new Error("no pack manifest found; run `larkit pack build`");
    reporter.result(manifest.stats || {});
    return manifest.stats || {};
  }

  throw new Error("usage: larkit pack <build|verify|path|stats>");
}
