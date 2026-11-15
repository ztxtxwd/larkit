import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import * as prettier from "prettier";
import beautify from "js-beautify";

function parserFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  return "babel";
}

function basicBreak(code) {
  // Last-resort line breaker for pathological minified input.  It keeps strings
  // intact and inserts newlines at structural characters.
  let out = "";
  let quote = "";
  let escape = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    out += ch;
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "{" || ch === "}") {
      if (i + 1 < code.length && code[i + 1] !== "\n") out += "\n";
    }
  }
  return out;
}

function beautifyFallback(code, parser) {
  try {
    if (parser === "json") return `${JSON.stringify(JSON.parse(code), null, 2)}\n`;
    if (parser === "css") {
      return `${beautify.css(code, { indent_size: 2, preserve_newlines: false })}\n`;
    }
    if (parser === "html") {
      return `${beautify.html(code, { indent_size: 2, wrap_line_length: 120 })}\n`;
    }
    return `${beautify.js(code, {
      indent_size: 2,
      preserve_newlines: false,
      max_preserve_newlines: 1,
      brace_style: "collapse,preserve-inline",
      end_with_newline: true,
    })}\n`;
  } catch {
    return `${basicBreak(code)}\n`;
  }
}

parentPort.on("message", async (task) => {
  const { id, srcPath, parser: requestedParser } = task;
  const parser = requestedParser || parserFor(srcPath);
  try {
    const buf = fs.readFileSync(srcPath);
    if (buf.includes(0)) {
      throw new Error("binary content");
    }
    const code = buf.toString("utf8");
    if (!code.trim()) {
      throw new Error("empty content");
    }

    let out = "";
    let used = parser;
    let fallback = false;

    // js-beautify is substantially faster for huge bundles; Prettier gives the
    // best line-number fidelity for the normal case.
    if (buf.length > 4 * 1024 * 1024) {
      fallback = true;
      out = beautifyFallback(code, parser);
    } else {
      try {
        out = await prettier.format(code, {
          parser,
          printWidth: 120,
          tabWidth: 2,
          useTabs: false,
          semi: true,
          singleQuote: false,
          trailingComma: "all",
          bracketSpacing: true,
          arrowParens: "always",
          endOfLine: "lf",
        });
        used = parser;
      } catch (error) {
        fallback = true;
        out = beautifyFallback(code, parser);
        out = `${out}`;
        if (!out.endsWith("\n")) out += "\n";
      }
    }

    if (buf.length > 500 && !out.includes("\n")) {
      fallback = true;
      out = beautifyFallback(out, parser);
    }
    if (!out.endsWith("\n")) out += "\n";

    const lines = out.split("\n").length - 1;
    parentPort.postMessage({
      id,
      ok: true,
      code: out,
      parser: used,
      fallback,
      srcBytes: buf.length,
      outBytes: Buffer.byteLength(out),
      lines,
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      parser,
    });
  }
});
