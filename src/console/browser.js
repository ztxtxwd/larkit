import path from "node:path";
import puppeteer from "puppeteer-core";
import { CACHE_DIR, displayPath } from "../shared/paths.js";
import { getProfileCookies } from "../auth/store.js";
import { ensureDir } from "../shared/util.js";
import { findChrome as findChromeShared } from "../shared/browser.js";
import { recordRecipe } from "./client.js";

async function findChrome() {
  return findChromeShared();
}

function parseCookies(cookie) {
  const out = {};
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/cookie|authorization|csrf|token|secret/i.test(key)) {
      out[key] = "<redacted>";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function shapeOf(value, depth = 0) {
  if (depth > 4) return "<deep>";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length ? [shapeOf(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = shapeOf(child, depth + 1);
    }
    return out;
  }
  return typeof value;
}

function parseMaybeJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function actionForPath(pathname) {
  if (pathname.includes("/v1/app/list")) return "list_apps";
  if (pathname.includes("/v1/app/create")) return "create_app";
  if (pathname.includes("/v1/secret/")) return "get_credentials";
  if (pathname.includes("/v1/base_info/")) return "update_app_info";
  if (pathname.includes("/v1/scope/update/")) return "grant_scopes";
  if (pathname.includes("/v1/scope/")) return "list_scopes";
  if (pathname.includes("/v1/app_version/list/")) return "list_versions";
  if (pathname.includes("/v1/app_version/create/")) return "create_version";
  if (pathname.includes("/v1/publish/commit/")) return "publish";
  if (pathname.includes("/v1/publish/release/")) return "release";
  if (pathname.includes("/v1/robot/switch/")) return "switch_robot";
  if (pathname.includes("/v1/robot/update")) return "update_robot";
  if (pathname.includes("/v1/robot/")) return "get_robot";
  if (pathname.includes("/v1/event/switch/")) return "switch_event";
  if (pathname.includes("/v1/event/update/")) return "update_event";
  if (pathname.includes("/v1/event/")) return "get_event";
  if (pathname.includes("/v1/callback/switch/")) return "switch_callback";
  if (pathname.includes("/v1/callback/")) return "get_callback";
  if (pathname.includes("/v2/robot/push_mode/switch/")) return "switch_card_callback";
  return null;
}

async function applyAction(page, action) {
  if (!action || typeof action !== "object") return null;
  const result = { type: action.type, ok: false };
  try {
    if (action.type === "click_text") {
      result.clicked = await page.evaluate((text) => {
        const candidates = [
          ...document.querySelectorAll(
            'button, a, [role="button"], [class*="btn"], [class*="button"]',
          ),
        ];
        const exact = candidates.find(
          (el) => (el.innerText || "").trim() === text,
        );
        const fuzzy = candidates.find((el) =>
          (el.innerText || "").includes(text),
        );
        const target = exact || fuzzy;
        if (!target) return false;
        target.click();
        return true;
      }, action.text);
      result.ok = Boolean(result.clicked);
    } else if (action.type === "fill") {
      const fields = Array.isArray(action.fields) ? action.fields : [action];
      result.fields = [];
      for (const field of fields) {
        const filled = await page.evaluate(({ selector, placeholder, label, value }) => {
          let el = selector ? document.querySelector(selector) : null;
          if (!el && placeholder) {
            el = [...document.querySelectorAll("input, textarea")].find((node) =>
              (node.getAttribute("placeholder") || "").includes(placeholder),
            );
          }
          if (!el && label) {
            const labelNode = [...document.querySelectorAll("label")].find((node) =>
              (node.innerText || "").includes(label),
            );
            if (labelNode) {
              const forId = labelNode.getAttribute("for");
              if (forId) el = document.getElementById(forId);
              if (!el) el = labelNode.parentElement?.querySelector("input, textarea");
            }
          }
          if (!el) return false;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(el),
            "value",
          )?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, field);
        result.fields.push({ ...field, filled });
      }
      result.ok = result.fields.every((field) => field.filled);
    } else if (action.type === "wait_for_text") {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        { timeout: action.timeout || 15_000 },
        action.text,
      );
      result.ok = true;
    } else if (action.type === "evaluate") {
      result.value = await page.evaluate(action.code);
      result.ok = true;
    } else if (action.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.ms || 1000));
      result.ok = true;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function browserFallback({
  profile,
  url = "https://open.feishu.cn/app",
  waitMs = 3000,
  actions = [],
  screenshot = false,
  recordAs = null,
  timeout = 45_000,
} = {}) {
  const executablePath = await findChrome();
  if (!executablePath) {
    return {
      ok: false,
      error: "Chrome not found; install google-chrome or set CHROME_PATH",
    };
  }
  const { name, cookies: rawCookie } = getProfileCookies(profile);
  const cookies = parseCookies(rawCookie);
  const started = Date.now();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1440,1000",
        "--lang=zh-CN",
      ],
      defaultViewport: { width: 1440, height: 1000 },
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    );
    await page.setCookie(
      ...Object.entries(cookies).map(([cookieName, value]) => ({
        name: cookieName,
        value,
        domain: ".feishu.cn",
        path: "/",
      })),
    ).catch(async () => {
      // Fall back to per-cookie attempts when one malformed cookie rejects the batch.
      for (const [cookieName, value] of Object.entries(cookies)) {
        try {
          await page.setCookie({
            name: cookieName,
            value,
            domain: ".feishu.cn",
            path: "/",
          });
        } catch {
          // ignore individual failures
        }
      }
    });

    const network = [];
    const byKey = new Map();
    page.on("request", (request) => {
      const requestUrl = request.url();
      if (!/\/developers\/|\/open-apis\/|open\.feishu\.cn/.test(requestUrl)) return;
      if (network.length >= 300) return;
      let parsedUrl;
      try {
        parsedUrl = new URL(requestUrl);
      } catch {
        return;
      }
      const postData = request.postData();
      const body = parseMaybeJson(postData);
      const entry = {
        method: request.method(),
        url: requestUrl,
        path: parsedUrl.pathname,
        resource_type: request.resourceType(),
        headers: redactHeaders(request.headers()),
        body_shape: body !== undefined ? shapeOf(body) : undefined,
        body_preview:
          body !== undefined
            ? JSON.stringify(body).slice(0, 800)
            : postData?.slice(0, 400),
        status: null,
      };
      network.push(entry);
      byKey.set(`${entry.method} ${entry.url}`, entry);
    });
    page.on("response", (response) => {
      const key = `${response.request().method()} ${response.url()}`;
      const entry = byKey.get(key);
      if (entry) entry.status = response.status();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const actionResults = [];
    for (const action of actions) {
      actionResults.push(await applyAction(page, action));
    }
    if (actions.length) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const title = await page.title();
    const finalUrl = page.url();
    const domText = await page.evaluate(() => document.body?.innerText || "");
    const needsLogin =
      /accounts\.feishu\.cn/.test(finalUrl) ||
      /扫码登录|Log in to Feishu|登录飞书/.test(domText);

    let screenshotPath = null;
    if (screenshot) {
      ensureDir(path.join(CACHE_DIR, "browser"));
      screenshotPath = path.join(
        CACHE_DIR,
        "browser",
        `console-${Date.now()}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    let recipesRecorded = 0;
    for (const entry of network) {
      if (!entry.path.startsWith("/developers/")) continue;
      if (!entry.body_shape && entry.method === "GET") continue;
      const action = recordAs || actionForPath(entry.path);
      if (!action) continue;
      recordRecipe(action, {
        method: entry.method,
        path: entry.path.replace(/\/cli_[A-Za-z0-9]+/g, "/:app_id"),
        headers: Object.fromEntries(
          Object.entries(entry.headers).filter(
            ([key]) => !/cookie|authorization|csrf|token|secret/i.test(key),
          ),
        ),
        body_shape: entry.body_shape,
        last_status: entry.status,
        source: "browser_fallback",
      });
      recipesRecorded++;
    }

    return {
      ok: true,
      profile: name,
      final_url: finalUrl,
      title,
      needs_login: needsLogin,
      screenshot_path: screenshotPath
        ? displayPath(screenshotPath)
        : null,
      actions: actionResults,
      network: network.slice(0, 80),
      recipes_recorded: recipesRecorded,
      dom_text: domText.slice(0, 5000),
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsed_ms: Date.now() - started,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}
