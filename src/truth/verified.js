import fs from "node:fs";
import path from "node:path";
import { VERIFIED_DIR } from "../shared/paths.js";
import { ensureDir, nowIso } from "../shared/util.js";

export function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const raw = text.slice(4, end);
      for (const line of raw.split("\n")) {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (match) meta[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
      body = text.slice(end + 4).replace(/^\n/, "");
    }
  }
  return { meta, body };
}

export function splitVerifiedSections(filePath, text) {
  const { meta, body } = parseFrontmatter(text);
  const topic =
    meta.topic ||
    path.basename(filePath, ".md").replace(/[-_]+/g, " ");
  const bodyStartLine = text.slice(0, text.length - body.length).split("\n").length;
  const lines = body.split("\n");
  const sections = [];
  let current = {
    section: "Overview",
    line_start: bodyStartLine,
    line_end: bodyStartLine,
    body: [],
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ") && current.body.length > 0) {
      current.line_end = bodyStartLine + i - 1;
      current.body = current.body.join("\n").trim();
      if (current.body) sections.push(current);
      current = {
        section: line.slice(3).trim(),
        line_start: bodyStartLine + i + 1,
        line_end: bodyStartLine + i + 1,
        body: [line],
      };
    } else {
      current.body.push(line);
    }
  }
  current.line_end = bodyStartLine + lines.length - 1;
  current.body = current.body.join("\n").trim();
  if (current.body) sections.push(current);
  return {
    topic,
    meta,
    sections,
    body,
    path: filePath,
  };
}

export function readVerifiedFiles() {
  if (!fs.existsSync(VERIFIED_DIR)) return [];
  return fs
    .readdirSync(VERIFIED_DIR)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort()
    .map((name) => {
      const file = path.join(VERIFIED_DIR, name);
      const text = fs.readFileSync(file, "utf8");
      return {
        ...splitVerifiedSections(`verified_truths/${name}`, text),
        file,
      };
    });
}

export function saveVerifiedTruth({
  topic,
  content,
  evidence = "",
  source = "probe",
  confidence = "high",
  tags = [],
}) {
  if (!topic || !String(topic).trim()) throw new Error("topic is required");
  if (!content || !String(content).trim()) throw new Error("content is required");
  ensureDir(VERIFIED_DIR);
  const slug = String(topic)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `truth-${Date.now()}`;
  const file = path.join(VERIFIED_DIR, `${slug}.md`);
  const body = String(content).trim();
  const evidenceBlock = evidence
    ? `\n\n## 证据\n\n${String(evidence).trim()}\n`
    : "";
  const tagLine = tags?.length ? `tags: [${tags.join(", ")}]\n` : "";
  const text = `---\ntopic: ${topic}\nverified_at: ${nowIso()}\nsource: ${source}\nconfidence: ${confidence}\n${tagLine}---\n\n${body}${evidenceBlock}`;
  fs.writeFileSync(file, text);
  return { file, text };
}
