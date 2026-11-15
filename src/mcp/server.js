import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchDocs, readDoc, docCategories } from "../docs/client.js";
import { searchTruth, readSlice, saveVerified } from "../truth/search.js";
import { authDispatch } from "../auth/service.js";
import { consoleDispatch } from "../console/dispatch.js";
import { probeOpenApi } from "../probe/openapi.js";
import { probeClientProtocol } from "../probe/client.js";

const TOOLS = [
  {
    name: "lark_doc",
    description:
      "Feishu official documentation (4800+ docs, zero config). action=search lists docs by category or keyword; action=read reads a doc path and returns saved markdown + line-bounded content; action=categories lists taxonomy.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["search", "read", "categories"],
          description: "search | read | categories",
        },
        query: { type: "string", description: "Title/path keyword for search" },
        category: {
          type: "string",
          description: "Taxonomy key, e.g. 服务端 API_即时通讯",
        },
        path: { type: "string", description: "Document path from search" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Read start line (0-based) for large docs",
        },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: 400,
          description: "Read line count / search result cap",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_truth_search",
    description:
      "Search the local truth engine: verified_truths, 2020 client protocol commands/schemas, official protocol notes, and formatted web/electron code anchors. Returns compact hits with exact file:line coordinates. Use scope=protocol for commands, web/electron for code, verified for prior conclusions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Keyword, API path, card field (chart_spec/card_link), error code, IPC channel, or client command",
        },
        scope: {
          type: "string",
          enum: ["all", "verified", "protocol", "web", "electron"],
          description: "Search domain (default all)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max results (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lark_truth_inspect",
    description:
      "Read a bounded slice of formatted code by file/line (action=read_slice), or persist a verified hidden field/protocol/endpoint into verified_truths and the SQLite index (action=save_verified). Prefer max_lines<=120 to save tokens.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["read_slice", "save_verified"],
          description: "read_slice | save_verified",
        },
        file_path: {
          type: "string",
          description: "Formatted file path from lark_truth_search, e.g. web/debugger/x.js",
        },
        line_number: {
          type: "integer",
          minimum: 1,
          description: "1-based line number",
        },
        context: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Context radius (default 12)",
        },
        mode: {
          type: "string",
          enum: ["context", "function"],
          description: "context slice or nearest function boundary",
        },
        max_lines: {
          type: "integer",
          minimum: 10,
          maximum: 200,
          description: "Hard cap (default 120)",
        },
        topic: { type: "string", description: "Verified-truth topic/title" },
        content: {
          type: "string",
          description: "Markdown conclusion + reusable code",
        },
        evidence: {
          type: "string",
          description: "Probe output, URL, file:line, log id",
        },
        source: {
          type: "string",
          enum: ["probe", "reverse", "doc", "console", "other"],
          description: "Evidence source",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Confidence",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_auth",
    description:
      "larkit auth: whoami/check/list/use/cookie/login/login_status/import/logout. Profiles live in ~/.larkit. login starts a detached QR worker and returns a status_file (qr_path appears there); import accepts a cookie string or a JSON file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "whoami",
            "check",
            "list",
            "use",
            "cookie",
            "login",
            "login_status",
            "import",
            "logout",
          ],
        },
        profile: { type: "string", description: "Profile name" },
        name: { type: "string", description: "Alias for profile on use/login/import/logout" },
        file: {
          type: "string",
          description: "JSON credentials file or plain cookie file for import",
        },
        cookie: {
          type: "string",
          description: "Raw Cookie header string for import",
        },
        wait: {
          type: "boolean",
          description: "Wait for QR scan instead of detaching the login worker",
        },
        timeout_ms: {
          type: "integer",
          minimum: 5000,
          maximum: 300000,
          description: "QR login timeout (default 120000)",
        },
        headless: {
          type: "boolean",
          description: "Headless Chrome for login (default true)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_console",
    description:
      "Feishu developer console lifecycle via cookies: list/create apps, get app_id+secret, update info, grant scopes, enable bot + event/card WebSocket long connection, publish version, or browser_fallback (CDP, records real admin APIs). Mutating actions support dry_run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "list_apps",
            "create_app",
            "get_app",
            "get_credentials",
            "update_app_info",
            "list_scopes",
            "applied_scopes",
            "grant_scopes",
            "list_versions",
            "enable_bot_ws",
            "publish",
            "browser_fallback",
          ],
        },
        profile: { type: "string", description: "larkit profile (default active)" },
        app_id: { type: "string", description: "cli_xxx app id" },
        name: { type: "string", description: "App name / login profile alias" },
        desc: { type: "string", description: "App description" },
        avatar: { type: "string", description: "Avatar image key/URL if known" },
        i18n: { type: "object", description: "i18n name/description map" },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Language codes, e.g. [zh_cn,en_us]",
        },
        scopes: {
          type: "array",
          items: { type: "string" },
          description: "Scope names, e.g. [im:message, im:chat:readonly]",
        },
        scope_type: {
          type: "string",
          enum: ["app", "user", "both"],
          description: "Scope identity (default app)",
        },
        operation: {
          type: "string",
          enum: ["add", "del"],
          description: "Scope operation (default add)",
        },
        version: { type: "string", description: "App version, e.g. 1.0.1" },
        remark: { type: "string", description: "Version remark" },
        full_release: { type: "boolean", description: "Full release (default false)" },
        create_if_missing: {
          type: "boolean",
          description: "Create a version when no draft exists (default true)",
        },
        release: { type: "boolean", description: "Also call release endpoint" },
        dry_run: { type: "boolean", description: "Plan only, do not mutate" },
        enable_bot: { type: "boolean", description: "Enable bot ability" },
        enable_events: { type: "boolean", description: "Enable event WS mode" },
        enable_callbacks: { type: "boolean", description: "Enable card callback WS mode" },
        query: { type: "string", description: "list_apps filter" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        url: { type: "string", description: "browser_fallback URL" },
        wait_ms: { type: "integer", minimum: 0, maximum: 60000 },
        actions: {
          type: "array",
          description:
            "browser_fallback actions, e.g. [{type:'click_text',text:'创建应用'},{type:'fill',fields:[{placeholder:'应用名称',value:'x'}]}]",
          items: { type: "object" },
        },
        screenshot: { type: "boolean" },
        record_as: { type: "string", description: "Recipe action name to record" },
        app_scene_type: { type: "integer", description: "0 self-built, 1 ISV" },
        primary_lang: { type: "string", description: "Default zh_cn" },
      },
      required: ["action"],
    },
  },
  {
    name: "lark_probe",
    description:
      "Live probes. mode=openapi gets tenant_access_token (cached) and calls /open-apis/{method,path,query,body}, returning status/code/msg/log_id. mode=client sends a client private-protocol command over WS or im/gateway and decodes protobuf to JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["openapi", "client"] },
        app_id: { type: "string" },
        app_secret: { type: "string" },
        method: { type: "string", description: "HTTP method (default GET)" },
        path: { type: "string", description: "e.g. /im/v1/messages or full URL" },
        query: { type: "object", description: "Query params" },
        body: { description: "JSON object or string body" },
        user_access_token: { type: "string" },
        tenant_access_token: { type: "string" },
        force_token: { type: "boolean" },
        headers: { type: "object", description: "Extra headers" },
        command: {
          type: "string",
          description: "client command name or number, e.g. PUT_MESSAGE / 5",
        },
        payload: { type: "object", description: "Protobuf payload object" },
        transport: {
          type: "string",
          enum: ["ws", "gateway"],
          description: "client transport (default ws)",
        },
        profile: { type: "string", description: "larkit profile for client cookie" },
        timeout: { type: "integer", minimum: 1000, maximum: 120000 },
        wait_push: { type: "boolean", description: "Listen for pushes instead of sending" },
        max_events: { type: "integer", minimum: 1, maximum: 50 },
        listen_ms: { type: "integer", minimum: 0, maximum: 60000 },
      },
      required: ["mode"],
    },
  },
];

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    ],
  };
}

async function callTool(name, args) {
  switch (name) {
    case "lark_doc": {
      if (args.action === "search") return searchDocs(args);
      if (args.action === "read") return readDoc({ docPath: args.path, offset: args.offset, limit: args.limit });
      if (args.action === "categories") return docCategories();
      throw new Error(`unknown lark_doc action: ${args.action}`);
    }
    case "lark_truth_search":
      return searchTruth({
        query: args.query,
        scope: args.scope || "all",
        limit: args.limit || 10,
      });
    case "lark_truth_inspect": {
      if (args.action === "read_slice") {
        return readSlice({
          filePath: args.file_path,
          lineNumber: args.line_number,
          context: args.context,
          mode: args.mode,
          maxLines: args.max_lines,
        });
      }
      if (args.action === "save_verified") {
        return saveVerified({
          topic: args.topic,
          content: args.content,
          evidence: args.evidence,
          source: args.source,
          confidence: args.confidence,
          tags: args.tags,
        });
      }
      throw new Error(`unknown lark_truth_inspect action: ${args.action}`);
    }
    case "lark_auth":
      return authDispatch(args);
    case "lark_console":
      return consoleDispatch(args);
    case "lark_probe": {
      if (args.mode === "openapi") {
        return probeOpenApi({
          appId: args.app_id,
          appSecret: args.app_secret,
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          headers: args.headers,
          userAccessToken: args.user_access_token,
          tenantAccessToken: args.tenant_access_token,
          forceToken: args.force_token,
          timeout: args.timeout,
        });
      }
      if (args.mode === "client") {
        return probeClientProtocol({
          command: args.command,
          payload: args.payload,
          transport: args.transport,
          profile: args.profile,
          timeout: args.timeout,
          waitPush: args.wait_push,
          maxEvents: args.max_events,
          listenMs: args.listen_ms,
        });
      }
      throw new Error(`unknown lark_probe mode: ${args.mode}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function createLarkitServer() {
  const server = new Server(
    { name: "larkit", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Feishu full-stack truth engine. Start with lark_truth_search(scope=verified), then lark_doc, then lark_truth_search(scope=all), then lark_probe; persist confirmed findings with lark_truth_inspect(action=save_verified). Use lark_console for developer-console lifecycle and lark_auth for cookies.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args || {});
      return ok(JSON.stringify(result, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  return server;
}

export { TOOLS };
