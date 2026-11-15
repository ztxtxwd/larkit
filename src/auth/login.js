import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { CACHE_DIR } from "../shared/paths.js";
import { ensureDir } from "../shared/util.js";
import { launchBrowser } from "../shared/browser.js";
import { saveProfile } from "./store.js";

const LOGIN_URL =
  "https://accounts.feishu.cn/accounts/page/login?app_id=11&force_login=1&no_trap=1&redirect_uri=https%3A%2F%2Fwww.feishu.cn%2F";
const NAV_TIMEOUT = 45_000;
const TOKEN_TIMEOUT = 30_000;

function safeName(name) {
  return String(name || "default").replace(/[^\p{L}\p{N}_-]+/gu, "_");
}

function writeStatus(file, data) {
  if (!file) return;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function loginWithQr({
  name = "default",
  timeoutMs = 120_000,
  headless = true,
  statusFile,
} = {}) {
  ensureDir(path.join(CACHE_DIR, "login"));
  const base = `${safeName(name)}-${Date.now()}`;
  const qrPath = path.join(CACHE_DIR, "login", `${base}.png`);
  const screenshotPath = path.join(CACHE_DIR, "login", `${base}-page.png`);
  const status = (phase, extra = {}) =>
    writeStatus(statusFile, {
      phase,
      profile: name,
      updated_at: new Date().toISOString(),
      ...extra,
    });

  status("starting");
  let browser;
  let page;
  try {
    browser = await launchBrowser({ headless });
    page = await browser.newPage();
    status("loading", { login_url: LOGIN_URL });

    const tokenPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("waiting for qrlogin/init timed out")),
        TOKEN_TIMEOUT,
      );
      page.on("response", async (response) => {
        if (!response.url().includes("/accounts/qrlogin/init")) return;
        try {
          const body = await response.json();
          const token = body?.data?.step_info?.token;
          if (token) {
            clearTimeout(timer);
            resolve(token);
          }
        } catch {
          // ignore non-JSON responses
        }
      });
    });

    try {
      await page.goto(LOGIN_URL, {
        waitUntil: "networkidle2",
        timeout: NAV_TIMEOUT,
      });
    } catch (error) {
      if (!page.url().includes("accounts.feishu.cn")) throw error;
    }

    const token = await tokenPromise;
    const qrData = JSON.stringify({ qrlogin: { token } });
    await QRCode.toFile(qrPath, qrData, {
      width: 640,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    status("qr_ready", { qr_path: qrPath, final_url: page.url() });

    const deadline = Date.now() + Math.max(5_000, Number(timeoutMs) || 120_000);
    let lastCookies = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        lastCookies = await browser.cookies();
      } catch {
        break;
      }
      const session = lastCookies.find((cookie) => cookie.name === "session");
      const device = lastCookies.find(
        (cookie) => cookie.name === "passport_web_did",
      );
      if (session?.value && device?.value) {
        const cookie = lastCookies
          .filter((item) => item.domain.includes("feishu.cn"))
          .map((item) => `${item.name}=${item.value}`)
          .join("; ");
        const saved = saveProfile({ name, cookie, active: true });
        status("success", {
          qr_path: qrPath,
          final_url: page.url(),
          cookies: saved.cookies,
        });
        return {
          ok: true,
          profile: name,
          cookies: saved.cookies,
          qr_path: qrPath,
          final_url: page.url(),
        };
      }
    }

    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {
      // ignore
    }
    status("timeout", {
      qr_path: qrPath,
      screenshot_path: screenshotPath,
      final_url: page.url(),
      cookie_names: lastCookies.map((cookie) => cookie.name),
    });
    return {
      ok: false,
      profile: name,
      error: "QR login timed out",
      qr_path: qrPath,
      screenshot_path: screenshotPath,
      final_url: page.url(),
      hint: "Open qr_path and scan with Feishu, then retry. Or use lark_auth action=import with a cookie string/file.",
    };
  } catch (error) {
    try {
      if (page) {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      }
    } catch {
      // ignore
    }
    status("error", {
      error: error instanceof Error ? error.message : String(error),
      qr_path: fs.existsSync(qrPath) ? qrPath : null,
      screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : null,
      final_url: page?.url?.(),
    });
    return {
      ok: false,
      profile: name,
      error: error instanceof Error ? error.message : String(error),
      qr_path: fs.existsSync(qrPath) ? qrPath : null,
      screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : null,
      final_url: page?.url?.(),
    };
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
  }
}
