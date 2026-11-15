import fs from "node:fs";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  try {
    const detected = execSync(
      "which google-chrome || which google-chrome-stable || which chromium || which chromium-browser",
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    if (detected) return detected;
  } catch {
    // ignore
  }
  throw new Error(
    "Chrome/Chromium not found; install google-chrome or set CHROME_PATH",
  );
}

export async function launchBrowser({
  headless = true,
  viewport = { width: 1280, height: 900 },
} = {}) {
  const executablePath = findChrome();
  return await puppeteer.launch({
    executablePath,
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: viewport,
  });
}

export function parseCookieString(cookie) {
  const out = {};
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}
