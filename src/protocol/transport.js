import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { readJson } from "../shared/util.js";
import { findApiByValue } from "./catalog.js";
import { createRegistry } from "./schema.js";

const CONSTANTS = readJson(
  fileURLToPath(new URL("./data/constants.json", import.meta.url)),
  {},
);
const ENDPOINTS = readJson(
  fileURLToPath(new URL("./data/reference/endpoints.json", import.meta.url)),
  {},
);
const GZIP_MAGIC = [0x1f, 0x8b];
const DEFAULT_WEB_VERSION = "7.61.0";

export const DEFAULT_BASE_URL =
  CONSTANTS.baseUrl || "wss://msg-frontier.feishu.cn/ws/v2";
export const DEFAULT_TICKET_URL =
  CONSTANTS.ticketUrl || "https://login.feishu.cn/suite/passport/frontier_ticket/";
export const WEB_APP_KEY = CONSTANTS.webAppKey || "";
const ACCESS_KEY_SALT = CONSTANTS.accessKeySalt || "";
const SDK_VERSION = CONSTANTS.sdkVersion || "7.68.5";
const ORIGIN = CONSTANTS.origin || "https://www.feishu.cn";

export function parseCookies(cookie) {
  const out = {};
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

export function generateAccessKey(value) {
  return createHash("md5").update(value, "utf8").digest("hex");
}

export function buildWsQuery(cookies, options = {}) {
  const deviceId = cookies.passport_web_did || "";
  const appKey = options.appKey || WEB_APP_KEY;
  const accessKey = generateAccessKey(
    `2${appKey}${deviceId}${ACCESS_KEY_SALT}`,
  );
  return {
    access_key: accessKey,
    aid: "1",
    ticket: options.ticket || "",
    device_id: deviceId,
    fpid: "2",
    accept_encoding: "gzip",
    request_id: randomUUID().toUpperCase(),
    sdk_version: options.sdkVersion || SDK_VERSION,
  };
}

async function fetchTicket(cookies, options = {}) {
  const deviceId = cookies.passport_web_did || "";
  const ticketUrl = options.ticketUrl || DEFAULT_TICKET_URL;
  const url = `${ticketUrl}?${new URLSearchParams({ local_device_id: deviceId })}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: cookieHeader(cookies),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data?.ticket || "";
  } catch {
    return "";
  }
}

export function encodeFrame(registry, frame) {
  return registry.encode("frame.Frame", frame);
}

export function decodeFrame(registry, bytes) {
  return registry.decodeRaw("frame.Frame", bytes);
}

export function encodePacket(registry, packet) {
  return registry.encode("improto.Packet", packet);
}

export function buildAckBytes(registry, sid) {
  const now = Date.now();
  const packet = encodePacket(registry, {
    cmd: 1,
    sid,
    payloadType: 1,
  });
  return encodeFrame(registry, {
    seqid: String(now),
    logid: String(now),
    service: 1,
    method: 1,
    headers: [{ key: "x-request-time", value: `${now}000` }],
    payloadType: "pb",
    payload: packet,
  });
}

export function decodeWsMessage(registry, input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    buf = gunzipSync(buf);
  }
  const frame = decodeFrame(registry, buf);
  const packetBytes = Uint8Array.from(frame.payload || []);
  const packet = registry.decodeRaw("improto.Packet", packetBytes);
  const api = findApiByValue(packet.cmd);
  const payloadTypeName = api?.responseType || api?.requestType || "";
  let payload;
  const businessBytes = packet.payload
    ? Uint8Array.from(packet.payload)
    : new Uint8Array(0);
  if (payloadTypeName && businessBytes.length > 0) {
    try {
      payload = registry.decode(payloadTypeName, businessBytes);
    } catch {
      payload = undefined;
    }
  }
  return { frame, packet, payload, payloadTypeName };
}

export async function connectFrontier({ cookie, registry, timeout = 15_000 } = {}) {
  const cookies = parseCookies(cookie);
  if (!cookies.passport_web_did) {
    throw new Error(
      "cookie 缺少 passport_web_did；需要飞书网页版登录后的 Cookie",
    );
  }
  const reg = registry || createRegistry();
  const ticket = await fetchTicket(cookies);
  const query = buildWsQuery(cookies, { ticket });
  const url = `${DEFAULT_BASE_URL}?${Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")}`;
  const ws = new WebSocket(url, {
    headers: {
      Origin: ORIGIN,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
  });
  const pushHandlers = [];
  const eventHandlers = [];
  const closeHandlers = [];
  let closed = false;

  const handle = (data) => {
    let decoded;
    try {
      decoded = decodeWsMessage(reg, data);
    } catch {
      return;
    }
    const packet = decoded.packet;
    if (!packet) return;
    if (packet.sid) {
      try {
        ws.send(buildAckBytes(reg, packet.sid));
      } catch {
        // ignore ack failures
      }
    }
    if (packet.cmd === 6) {
      for (const handler of pushHandlers) {
        try {
          handler(decoded.payload, decoded);
        } catch {
          // ignore handler failure
        }
      }
    } else {
      for (const handler of eventHandlers) {
        try {
          handler(decoded);
        } catch {
          // ignore handler failure
        }
      }
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WS 握手超时（${timeout}ms）`));
    }, timeout);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on("message", handle);
    ws.on("close", (code, reason) => {
      closed = true;
      if (!ws.__opened) {
        clearTimeout(timer);
        reject(new Error(`WS 未打开即关闭 code=${code}`));
      }
      for (const handler of closeHandlers) {
        try {
          handler(code, reason?.toString());
        } catch {
          // ignore
        }
      }
    });
    ws.on("open", () => {
      ws.__opened = true;
    });
  });

  return {
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
    onPush(handler) {
      pushHandlers.push(handler);
      return () => {
        const index = pushHandlers.indexOf(handler);
        if (index >= 0) pushHandlers.splice(index, 1);
      };
    },
    onEvent(handler) {
      eventHandlers.push(handler);
      return () => {
        const index = eventHandlers.indexOf(handler);
        if (index >= 0) eventHandlers.splice(index, 1);
      };
    },
    onClose(handler) {
      closeHandlers.push(handler);
      return () => {
        const index = closeHandlers.indexOf(handler);
        if (index >= 0) closeHandlers.splice(index, 1);
      };
    },
    send(packet, frame = {}) {
      const now = Date.now();
      const payload = encodePacket(reg, packet);
      const frameBytes = encodeFrame(reg, {
        seqid: String(now),
        logid: String(now),
        service: 1,
        method: 1,
        payloadType: "pb",
        payload,
        ...frame,
      });
      if (ws.readyState === WebSocket.OPEN) ws.send(frameBytes);
    },
    ack(sid) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buildAckBytes(reg, sid));
    },
    stop() {
      closed = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
    get closed() {
      return closed;
    },
  };
}

export function gatewayOrigin(baseDomain = "feishu.cn") {
  let hostname = String(baseDomain || "feishu.cn").trim();
  if (!/^https?:\/\//i.test(hostname)) hostname = `https://${hostname}`;
  try {
    hostname = new URL(hostname).hostname;
  } catch {
    hostname = hostname.replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "");
  }
  const labels = hostname.split(".").filter(Boolean).slice(-2).join(".");
  return `https://internal-api-lark-api.${labels}`;
}

export function gatewayHeaders(cmd, requestId, overrides = {}) {
  const webVersion =
    ENDPOINTS.commandWebVersions?.[String(cmd)] || DEFAULT_WEB_VERSION;
  return {
    accept: "*/*",
    "content-type": "application/x-protobuf",
    locale: "zh-CN",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
    ...(ENDPOINTS.defaultGatewayHeaders || {}),
    "x-command": String(cmd),
    "x-command-version": webVersion,
    "x-request-id": requestId,
    "x-source": "web",
    "x-web-version": webVersion,
    ...overrides,
  };
}

export async function postCommand({
  cmd,
  payload,
  cookie,
  registry,
  origin,
  baseDomain = "feishu.cn",
  timeout = 15_000,
  headers = {},
} = {}) {
  const reg = registry || createRegistry();
  const api = findApiByValue(cmd);
  const requestId = randomUUID();
  let payloadBytes;
  if (payload instanceof Uint8Array) payloadBytes = payload;
  else if (api?.requestType && payload && Object.keys(payload).length > 0) {
    payloadBytes = reg.encode(api.requestType, payload);
  } else {
    payloadBytes = new Uint8Array(0);
  }
  const packetBytes = encodePacket(reg, {
    cmd,
    cid: requestId,
    payloadType: 1,
    payload: payloadBytes,
    sid: requestId,
  });
  const base = origin || gatewayOrigin(baseDomain);
  const cookieValue =
    typeof cookie === "string" ? cookie : cookieHeader(cookie || {});
  const response = await fetch(`${base}/im/gateway/`, {
    method: "POST",
    headers: gatewayHeaders(cmd, requestId, {
      ...(cookieValue ? { cookie: cookieValue } : {}),
      ...headers,
    }),
    body: packetBytes,
    signal: AbortSignal.timeout(timeout),
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  let packet;
  let decodedPayload;
  if (raw.length > 0) {
    try {
      packet = reg.decodeRaw("improto.Packet", raw);
      const typeName = api?.responseType || api?.requestType;
      const business = packet.payload
        ? Uint8Array.from(packet.payload)
        : new Uint8Array(0);
      if (typeName && business.length > 0) {
        decodedPayload = reg.decode(typeName, business);
      }
    } catch {
      // gateway may return raw response bytes; keep raw
    }
  }
  return {
    status: response.status,
    requestId,
    packet,
    payload: decodedPayload,
    raw,
  };
}

export { createRegistry };
