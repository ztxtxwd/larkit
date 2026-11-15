import { randomUUID } from "node:crypto";
import { getProfileCookies } from "../auth/store.js";
import { resolveApi } from "../protocol/catalog.js";
import { createRegistry } from "../protocol/schema.js";
import {
  connectFrontier,
  postCommand,
} from "../protocol/transport.js";

function summarizePacket(packet) {
  if (!packet) return null;
  return {
    cmd: packet.cmd,
    status: packet.status,
    sid: packet.sid,
    cid: packet.cid,
    payload_type: packet.payloadType,
    payload_bytes: Array.isArray(packet.payload) ? packet.payload.length : 0,
  };
}

function summarizeDecoded(decoded) {
  if (!decoded) return null;
  return {
    packet: summarizePacket(decoded.packet),
    payload_type_name: decoded.payloadTypeName,
    layers: {
      frame: Boolean(decoded.frame),
      packet: Boolean(decoded.packet),
      payload: decoded.payload !== undefined,
    },
    payload: decoded.payload,
  };
}

export async function probeClientProtocol({
  command,
  payload = {},
  transport = "ws",
  profile,
  timeout = 15_000,
  waitPush = false,
  maxEvents = 5,
  listenMs = 0,
} = {}) {
  if (!command) throw new Error("command is required");
  const { name: profileName, cookies } = getProfileCookies(profile);
  const registry = createRegistry();
  const api = resolveApi(command);
  const cmd =
    typeof command === "number" ? command : api?.cmd;
  if (cmd === undefined) {
    return {
      ok: false,
      mode: "client",
      transport,
      error: `unknown client command: ${command}`,
      hint: "Use lark_truth_search scope=protocol to find the command name/number.",
    };
  }
  const t0 = Date.now();

  if (transport === "gateway" || transport === "rest") {
    try {
      const result = await postCommand({
        cmd,
        payload,
        cookie: cookies,
        registry,
        baseDomain: "feishu.cn",
        timeout,
        headers: process.env.LARKIT_GATEWAY_HEADERS
          ? JSON.parse(process.env.LARKIT_GATEWAY_HEADERS)
          : {},
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        mode: "client",
        transport: "gateway",
        profile: profileName,
        command: {
          cmd,
          name: api?.name,
          request_type: api?.requestType,
          response_type: api?.responseType,
        },
        status: result.status,
        request_id: result.requestId,
        response: {
          packet: summarizePacket(result.packet),
          payload_type_name: api?.responseType,
          layers: {
            frame: false,
            packet: Boolean(result.packet),
            payload: result.payload !== undefined,
          },
          payload: result.payload,
        },
        payload: result.payload,
        raw_bytes: result.raw.length,
        elapsed_ms: Date.now() - t0,
      };
    } catch (error) {
      return {
        ok: false,
        mode: "client",
        transport: "gateway",
        profile: profileName,
        command: { cmd, name: api?.name },
        error: error instanceof Error ? error.message : String(error),
        elapsed_ms: Date.now() - t0,
      };
    }
  }

  let connection;
  const events = [];
  const eventLimit = Math.max(1, Math.min(Number(maxEvents) || 5, 50));
  try {
    connection = await connectFrontier({
      cookie: cookies,
      registry,
      timeout,
    });
    const cid = randomUUID();
    let payloadBytes = new Uint8Array(0);
    if (payload instanceof Uint8Array) {
      payloadBytes = payload;
    } else if (api?.requestType && payload && Object.keys(payload).length > 0) {
      payloadBytes = registry.encode(api.requestType, payload);
    }
    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      rejectResponse(
        new Error(`timeout after ${timeout}ms waiting for cmd=${cmd}`),
      );
    }, timeout);
    const offEvent = connection.onEvent((decoded) => {
      events.push(summarizeDecoded(decoded));
      if (events.length > eventLimit) events.shift();
      if (decoded.packet?.cmd === cmd) {
        clearTimeout(timer);
        resolveResponse(decoded);
      }
    });
    const offPush = connection.onPush((pushPayload, decoded) => {
      events.push(summarizeDecoded(decoded));
      if (events.length > eventLimit) events.shift();
      if (waitPush) {
        clearTimeout(timer);
        resolveResponse({ ...decoded, payload: pushPayload });
      }
    });

    const pushOnly = Boolean(waitPush) || api?.kind === "push";
    if (!pushOnly) {
      connection.send({
        cmd,
        cid,
        payloadType: 1,
        payload: payloadBytes,
      });
    }

    let response = null;
    let error = null;
    try {
      response = await responsePromise;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    clearTimeout(timer);
    offEvent();
    offPush();
    if (listenMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, listenMs));
    }
    return {
      ok: Boolean(response) && !error,
      handshake: true,
      mode: "client",
      transport: "ws",
      profile: profileName,
      command: {
        cmd,
        name: api?.name,
        request_type: api?.requestType,
        response_type: api?.responseType,
      },
      request_id: cid,
      push_only: pushOnly,
      request_payload_bytes: pushOnly ? 0 : payloadBytes.length,
      response: summarizeDecoded(response),
      events,
      error: error || undefined,
      elapsed_ms: Date.now() - t0,
      hint: error
        ? "Cookie 可能过期；先 lark_auth check/login。读消息命令通常不走这个 WS，可试 transport=gateway 或 lark_probe mode=openapi。"
        : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      mode: "client",
      transport: "ws",
      profile: profileName,
      command: { cmd, name: api?.name },
      error: error instanceof Error ? error.message : String(error),
      events,
      elapsed_ms: Date.now() - t0,
      hint: "WS 握手失败；检查 Cookie（passport_web_did）与 msg-frontier.feishu.cn 网络。",
    };
  } finally {
    try {
      connection?.stop();
    } catch {
      // ignore
    }
  }
}
