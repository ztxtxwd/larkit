import process from "node:process";
import { fileSizeMiB } from "../shared/util.js";

const paint = (enabled) => (code, text) =>
  enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text);

/**
 * Human output for interactive `larkit init/status`.  In `--json` mode every
 * human line goes to stderr so stdout stays a single JSON document.
 */
export function createReporter({ json = false, quiet = false } = {}) {
  const humanStream = json ? process.stderr : process.stdout;
  const color = paint(Boolean(humanStream.isTTY) && !process.env.NO_COLOR);
  const write = (line = "") => humanStream.write(`${line}\n`);
  const lastProgress = new Map();
  let stepNumber = 0;

  return {
    json,
    quiet,
    line: write,
    header(title, subtitle) {
      if (quiet) return;
      write(`${color("1", title)}${subtitle ? `  ${color("2", subtitle)}` : ""}`);
    },
    step(title) {
      stepNumber++;
      if (!quiet) write(`\n${color("36", `[${stepNumber}]`)} ${color("1", title)}`);
    },
    info(message) {
      if (!quiet) write(`  ${message}`);
    },
    ok(message) {
      if (!quiet) write(`  ${color("32", "✓")} ${message}`);
    },
    detail(label, value) {
      if (!quiet) write(`  ${color("2", String(label).padEnd(12))} ${value}`);
    },
    warn(message) {
      if (!quiet) process.stderr.write(`  ${color("33", "!")} ${message}\n`);
    },
    error(message) {
      process.stderr.write(`  ${color("31", "✗")} ${message}\n`);
    },
    progress(kind, received, total) {
      if (quiet || json || !humanStream.isTTY) return;
      const now = Date.now();
      if (!total && now - (lastProgress.get(kind) || 0) < 2000) return;
      if (total && now - (lastProgress.get(kind) || 0) < 250) return;
      lastProgress.set(kind, now);
      const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null;
      const text = total
        ? `${percent}%  ${fileSizeMiB(received)} / ${fileSizeMiB(total)}`
        : fileSizeMiB(received);
      process.stderr.write(`  ${color("2", kind.padEnd(6))} ${text}\x1b[K\r`);
      if (total && received >= total) process.stderr.write("\n");
    },
    result(value) {
      if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
