import fs from "node:fs";
import {
  DATA_DIR,
  FORMATTED_DIR,
  INSTALL_STATE_FILE,
  LARKIT_HOME,
  TRUTH_DB,
} from "../shared/paths.js";
import { ensureDir, nowIso, readJson, writeJson } from "../shared/util.js";

export const STATE_SCHEMA_VERSION = 1;

export function initialState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    larkitVersion: null,
    installedAt: null,
    updatedAt: null,
    home: LARKIT_HOME,
    dataDir: DATA_DIR,
    steps: {},
  };
}

export function readState() {
  const state = readJson(INSTALL_STATE_FILE, null);
  if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  return state;
}

export function writeState(state) {
  ensureDir(LARKIT_HOME);
  const next = {
    ...initialState(),
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
    home: LARKIT_HOME,
    dataDir: DATA_DIR,
    updatedAt: nowIso(),
  };
  writeJson(INSTALL_STATE_FILE, next);
  return next;
}

export function updateState(mutator) {
  const state = readState() || initialState();
  const next = mutator(state) || state;
  return writeState(next);
}

export function isInitialized() {
  const state = readState();
  return Boolean(state?.steps?.truth?.status === "ready" && fs.existsSync(TRUTH_DB));
}

export function hasCodeTier() {
  return fs.existsSync(FORMATTED_DIR);
}

export function setStep(name, value) {
  return updateState((state) => ({
    ...state,
    installedAt: state.installedAt || nowIso(),
    steps: { ...state.steps, [name]: { ...value, at: nowIso() } },
  }));
}
