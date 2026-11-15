import { readFileSync } from "node:fs";
import { createRegistry } from "./schema.js";

const COMMANDS_FILE = new URL("./data/commands.json", import.meta.url);

const CONTROL = new Set([
  "ACK",
  "PING",
  "CONNECT",
  "DISCONNECT",
  "SERVER_DISCONNET",
  "SYNC_PACKETS",
  "SYNC_REQUEST",
  "SYNC_RESPONSE",
  "PROCESS_MULTI_PACKETS",
  "NO_TRACE_REMOVE_MESSAGE_BY_ID",
  "NOOP",
]);

let cachedCatalog;

function classify(entry, enumName) {
  const name = (enumName || entry.name || "").toUpperCase();
  const requestType = (entry.requestType || "").toLowerCase();
  const responseType = (entry.responseType || "").toLowerCase();
  if (
    name.startsWith("PUSH_") ||
    name.includes("PUSH") ||
    requestType.includes("push") ||
    responseType.includes("push")
  ) {
    return "push";
  }
  if (CONTROL.has(name) || name.startsWith("SYNC_")) return "control";
  if (!entry.requestType) {
    if (responseType.includes("ack") || name.endsWith("_ACK")) return "control";
    return "push";
  }
  if (
    entry.requestType &&
    entry.responseType &&
    requestType !== responseType
  ) {
    return "request";
  }
  return "push";
}

export function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const raw = JSON.parse(readFileSync(COMMANDS_FILE, "utf8"));
  const registry = createRegistry();
  const commandEnum = registry.lookup("improto.Command");
  const enumNames = new Map();
  if (commandEnum?.values) {
    for (const [name, value] of Object.entries(commandEnum.values)) {
      enumNames.set(value, name);
    }
  }
  const entries = raw.map((command) => {
    const enumName = enumNames.get(command.value);
    const name =
      command.version !== undefined
        ? command.name || enumName
        : enumName || command.name;
    const kind = classify(
      command,
      command.version !== undefined ? undefined : enumName,
    );
    const probeType = command.requestType || command.responseType;
    return {
      cmd: command.value,
      name: name || "",
      requestType: command.requestType || "",
      responseType: command.responseType || "",
      version: command.version,
      kind,
      schemaAvailable: probeType ? registry.has(probeType) : false,
      source: command.source || "",
    };
  });
  entries.sort(
    (a, b) => a.cmd - b.cmd || a.name.localeCompare(b.name),
  );
  cachedCatalog = {
    entries,
    byValue: new Map(entries.map((entry) => [entry.cmd, entry])),
    byName: new Map(),
    byType: new Map(),
  };
  for (const entry of entries) {
    if (entry.name) {
      const list = cachedCatalog.byName.get(entry.name) || [];
      list.push(entry);
      cachedCatalog.byName.set(entry.name, list);
    }
    if (entry.requestType) {
      const list = cachedCatalog.byType.get(entry.requestType) || [];
      list.push(entry);
      cachedCatalog.byType.set(entry.requestType, list);
    }
  }
  return cachedCatalog;
}

export function listApis(kind) {
  const { entries } = loadCatalog();
  return kind ? entries.filter((entry) => entry.kind === kind) : [...entries];
}

export function findApiByValue(cmd) {
  return loadCatalog().byValue.get(Number(cmd));
}

export function findApisByName(name) {
  return loadCatalog().byName.get(name) || [];
}

export function findApisByType(typeName) {
  return loadCatalog().byType.get(typeName) || [];
}

export function resolveApi(cmdOrName) {
  if (typeof cmdOrName === "number" || /^\d+$/.test(String(cmdOrName))) {
    return findApiByValue(Number(cmdOrName));
  }
  return (
    findApisByName(String(cmdOrName))[0] ||
    findApisByType(String(cmdOrName))[0]
  );
}

export function summarize() {
  const entries = listApis();
  const byKind = {};
  let schemaAvailable = 0;
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    if (entry.schemaAvailable) schemaAvailable++;
  }
  return { total: entries.length, byKind, schemaAvailable };
}

export function catalogDataFile() {
  return COMMANDS_FILE.pathname;
}
