// lib/config.js
//
// Shared configuration resolution for opencode-hard-limit.
//
// Precedence (highest wins):
//   1. Environment variables      (ephemeral override)
//   2. Project config file        (<projectDir>/.opencode-hard-limit.json)
//   3. Global config file         (~/.config/opencode/opencode-hard-limit/config.json)
//   4. Built-in defaults
//
// Config keys (camelCase in files, ENV names in parentheses):
//   minRemaining      (OPENCODE_QUOTA_MIN_REMAINING)        number
//   blockOnError      (OPENCODE_QUOTA_BLOCK_ON_ERROR)        boolean
//   blockOnAuthError  (OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR)   boolean
//   cacheTtlMs        (OPENCODE_QUOTA_CACHE_TTL_MS)          number
//   timeoutMs         (OPENCODE_QUOTA_TIMEOUT_MS)            number
//   window            (OPENCODE_QUOTA_WINDOW)                string  '5h' | 'Weekly'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULTS = Object.freeze({
  minRemaining: 30,
  blockOnError: true,
  blockOnAuthError: false,
  cacheTtlMs: 60000,
  timeoutMs: 20000,
  window: "5h",
});

export const PROJECT_FILENAME = ".opencode-hard-limit.json";

const ENV_KEYS = {
  minRemaining: "OPENCODE_QUOTA_MIN_REMAINING",
  blockOnError: "OPENCODE_QUOTA_BLOCK_ON_ERROR",
  blockOnAuthError: "OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR",
  cacheTtlMs: "OPENCODE_QUOTA_CACHE_TTL_MS",
  timeoutMs: "OPENCODE_QUOTA_TIMEOUT_MS",
  window: "OPENCODE_QUOTA_WINDOW",
};

const NUMBER_KEYS = new Set(["minRemaining", "cacheTtlMs", "timeoutMs"]);
const BOOL_KEYS = new Set(["blockOnError", "blockOnAuthError"]);

export function configDirGlobal() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "opencode-hard-limit");
}

export function globalConfigPath() {
  return join(configDirGlobal(), "config.json");
}

export function projectConfigPath(projectDir) {
  return join(resolve(projectDir || process.cwd()), PROJECT_FILENAME);
}

const TRUE_TOKENS = new Set(["1", "true", "yes", "on"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off"]);

// Coerce + validate a single value. Returns undefined for missing OR invalid
// input, so an invalid value transparently falls through to the next layer
// (and ultimately to the safe built-in default) instead of taking effect.
function coerce(key, value) {
  if (value == null || value === "") return undefined;

  if (BOOL_KEYS.has(key)) {
    if (typeof value === "boolean") return value;
    const t = String(value).trim().toLowerCase();
    if (TRUE_TOKENS.has(t)) return true;
    if (FALSE_TOKENS.has(t)) return false;
    return undefined; // invalid boolean -> ignore
  }

  if (NUMBER_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    if (key === "minRemaining") {
      // percent remaining: only 0..100 is meaningful. Clamp to keep the
      // hard-stop safe rather than silently disabling it.
      return Math.min(100, Math.max(0, n));
    }
    if (key === "timeoutMs") return n > 0 ? n : undefined;
    if (key === "cacheTtlMs") return n >= 0 ? n : undefined;
    return n;
  }

  if (key === "window") {
    const t = String(value).trim().toLowerCase();
    if (t === "5h" || t === "5" || t === "daily") return "5h";
    if (t === "weekly" || t === "week" || t === "7d") return "Weekly";
    return undefined; // unrecognized -> fall through to next layer
  }

  return undefined;
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const out = {};
    for (const key of Object.keys(ENV_KEYS)) {
      const c = coerce(key, raw[key]);
      if (c !== undefined) out[key] = c;
    }
    return out;
  } catch {
    return {};
  }
}

function readEnv() {
  const out = {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const c = coerce(key, process.env[envName]);
    if (c !== undefined) out[key] = c;
  }
  return out;
}

// Resolve effective config with per-key provenance.
// Returns { values: {...}, sources: { key: "env"|"project"|"global"|"default" }, paths }.
export function resolveConfig({ projectDir } = {}) {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(projectDir);

  const layers = [
    { source: "default", data: { ...DEFAULTS } },
    { source: "global", data: readJsonFile(globalPath) },
    { source: "project", data: readJsonFile(projectPath) },
    { source: "env", data: readEnv() },
  ];

  const values = {};
  const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    for (const layer of layers) {
      if (layer.data[key] !== undefined) {
        values[key] = layer.data[key];
        sources[key] = layer.source;
      }
    }
  }

  return {
    values,
    sources,
    paths: { global: globalPath, project: projectPath },
  };
}

// Read a single scope's raw stored config (for editing via the CLI).
export function readScope(scope, projectDir) {
  const path = scope === "global" ? globalConfigPath() : projectConfigPath(projectDir);
  return { path, data: readJsonFile(path) };
}

// Persist a partial config to the given scope, merging with what's there.
export function writeScope(scope, patch, projectDir) {
  const path = scope === "global" ? globalConfigPath() : projectConfigPath(projectDir);
  const current = readJsonFile(path);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const c = coerce(key, value);
    if (c !== undefined) next[key] = c;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { path, data: next };
}
