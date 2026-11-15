import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_SOURCE_DIR } from "../shared/paths.js";
import {
  ensureDir,
  nowIso,
  readJson,
  sha256,
  walkFiles,
  writeJson,
} from "../shared/util.js";

const MANIFEST_NAME = ".larkit-skill.json";

export function skillTargetCandidates(cwd = process.cwd()) {
  return [
    { name: "agents", dir: path.join(os.homedir(), ".agents", "skills", "larkit") },
    { name: "claude", dir: path.join(os.homedir(), ".claude", "skills", "larkit") },
    { name: "project", dir: path.join(cwd, ".agents", "skills", "larkit") },
  ];
}

/**
 * Default policy: install into every agent skills directory that already
 * exists; if none exists, create the neutral `~/.agents/skills/larkit`.
 */
export function resolveSkillTargets({
  targets = null,
  cwd = process.cwd(),
  project = false,
} = {}) {
  const candidates = skillTargetCandidates(cwd);
  if (targets?.length) {
    const result = [];
    for (const raw of targets) {
      const value = String(raw).trim();
      if (!value) continue;
      if (value === "all") {
        result.push(...candidates);
        continue;
      }
      const named = candidates.find((candidate) => candidate.name === value);
      if (named) {
        result.push(named);
        continue;
      }
      result.push({
        name: path.basename(path.dirname(path.dirname(value))) || "custom",
        dir: path.resolve(value),
      });
    }
    return dedupeTargets(result);
  }
  if (project) {
    return candidates.filter((candidate) => candidate.name === "project");
  }
  const existing = candidates.filter(
    (candidate) =>
      candidate.name !== "project" && fs.existsSync(path.dirname(candidate.dir)),
  );
  return existing.length ? existing : candidates.filter((c) => c.name === "agents");
}

function dedupeTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.dir)) return false;
    seen.add(target.dir);
    return true;
  });
}

function sourceFiles() {
  if (!fs.existsSync(SKILL_SOURCE_DIR)) {
    throw new Error(`skill source missing: ${SKILL_SOURCE_DIR}`);
  }
  return walkFiles(SKILL_SOURCE_DIR, { skipDirs: new Set() }).map((entry) => ({
    abs: entry.path,
    rel: path.relative(SKILL_SOURCE_DIR, entry.path).split(path.sep).join("/"),
    sha256: sha256(fs.readFileSync(entry.path)),
  }));
}

function targetFile(dir, rel) {
  const root = path.resolve(dir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`skill manifest path escapes its directory: ${rel}`);
  }
  return resolved;
}

function pruneEmpty(dir, stopAt) {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current.startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

/**
 * Copy the bundled skill into one or more agent skill directories.  A
 * `.larkit-skill.json` manifest makes updates safe: only files we own are
 * overwritten or deleted, and an unmanaged pre-existing directory is left
 * untouched unless `force` is set (then it is backed up, not deleted).
 */
export function installSkill({
  targets,
  version,
  force = false,
  dryRun = false,
} = {}) {
  const files = sourceFiles();
  const results = [];
  for (const target of targets) {
    const dir = target.dir;
    const manifestFile = path.join(dir, MANIFEST_NAME);
    const existing = readJson(manifestFile, null);
    const exists = fs.existsSync(dir);
    const populated = exists && fs.readdirSync(dir).length > 0;
    if (populated && !existing && !force) {
      results.push({
        target: dir,
        name: target.name,
        status: "skipped",
        reason: "existing unmanaged directory (use --force to back up and replace)",
      });
      continue;
    }
    let backup = null;
    if (populated && !existing && force) {
      backup = `${dir}.bak-${Date.now()}`;
      if (!dryRun) fs.renameSync(dir, backup);
    }
    if (dryRun) {
      results.push({
        target: dir,
        name: target.name,
        status: existing ? "would-update" : "would-install",
        files: files.length,
        backup,
      });
      continue;
    }
    ensureDir(dir);
    for (const file of files) {
      const dest = path.join(dir, file.rel);
      ensureDir(path.dirname(dest));
      if (path.resolve(file.abs) !== path.resolve(dest)) {
        fs.copyFileSync(file.abs, dest);
      }
    }
    if (existing?.files) {
      for (const rel of Object.keys(existing.files)) {
        if (files.some((file) => file.rel === rel)) continue;
        const stale = targetFile(dir, rel);
        fs.rmSync(stale, { force: true });
        pruneEmpty(path.dirname(stale), dir);
      }
    }
    writeJson(manifestFile, {
      skill: "larkit",
      version,
      installedAt: nowIso(),
      files: Object.fromEntries(files.map((file) => [file.rel, file.sha256])),
    });
    results.push({
      target: dir,
      name: target.name,
      status: existing ? "updated" : "installed",
      files: files.length,
      backup,
    });
  }
  return results;
}

export function listInstalledSkills({ cwd = process.cwd() } = {}) {
  const candidates = skillTargetCandidates(cwd);
  return candidates
    .filter((candidate) => fs.existsSync(path.join(candidate.dir, MANIFEST_NAME)))
    .map((candidate) => {
      const manifest = readJson(path.join(candidate.dir, MANIFEST_NAME), {});
      return {
        name: candidate.name,
        target: candidate.dir,
        version: manifest.version || null,
        files: manifest.files ? Object.keys(manifest.files).length : 0,
        installed_at: manifest.installedAt || null,
      };
    });
}

export function removeSkill({ targets, dryRun = false } = {}) {
  const results = [];
  for (const target of targets) {
    const dir = target.dir;
    const manifestFile = path.join(dir, MANIFEST_NAME);
    const manifest = readJson(manifestFile, null);
    if (!manifest) {
      results.push({ target: dir, status: "skipped", reason: "not installed by larkit" });
      continue;
    }
    if (!dryRun) {
      for (const rel of Object.keys(manifest.files || {})) {
        const stale = targetFile(dir, rel);
        fs.rmSync(stale, { force: true });
        pruneEmpty(path.dirname(stale), dir);
      }
      fs.rmSync(manifestFile, { force: true });
      pruneEmpty(dir, dir);
    }
    results.push({ target: dir, status: dryRun ? "would-remove" : "removed" });
  }
  return results;
}
