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
//   windowAnthropic   (OPENCODE_QUOTA_WINDOW_ANTHROPIC)       string  '5h' | 'Weekly' (optional, overrides window for anthropic)
//   windowOpenai      (OPENCODE_QUOTA_WINDOW_OPENAI)          string  '5h' | 'Weekly' (optional, overrides window for openai)
//   minRefreshIntervalMs (OPENCODE_QUOTA_MIN_REFRESH_MS)     number
//   rateLimitBackoffMs   (OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS) number
//   maxRateLimitBackoffMs (OPENCODE_QUOTA_MAX_RATE_LIMIT_BACKOFF_MS) number
//                        upper bound on a 429's server-sent Retry-After, which
//                        would otherwise pin an account for its full duration
//   noBaselineRateLimitBackoffMs (OPENCODE_QUOTA_NO_BASELINE_RATE_LIMIT_BACKOFF_MS) number
//                        tighter upper bound applied in place of maxRateLimitBackoffMs
//                        when the account has no last-known-good reading to serve
//                        meanwhile, so a 429 hit before any baseline exists (e.g. right
//                        after a token refresh) clears quickly instead of leaving the
//                        account "unavailable" for the full maxRateLimitBackoffMs span
//   staleBlockMarginPct  (OPENCODE_QUOTA_STALE_BLOCK_MARGIN) number
//   allowPostpone        (OPENCODE_QUOTA_ALLOW_POSTPONE)     boolean
//   anthropicProfileDirs (OPENCODE_QUOTA_ANTHROPIC_PROFILE_DIRS) string[] (JSON) | comma-separated (env)
//                        additional Claude Code profile dirs to scan for
//                        multi-account quota (default: ~/.claude-profiles/* + ~/.claude)
//   openaiAccountsFile   (OPENCODE_QUOTA_OPENAI_ACCOUNTS_FILE) string
//                        path to a multi-account OpenAI/Codex store, e.g. the
//                        one written by oc-codex-multi-auth (default:
//                        ~/.opencode/oc-codex-multi-auth-accounts.json)

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
  minRefreshIntervalMs: 120000,
  rateLimitBackoffMs: 300000,
  maxRateLimitBackoffMs: 600000,
  noBaselineRateLimitBackoffMs: 60000,
  staleBlockMarginPct: 10,
  allowPostpone: false,
  // Left undefined by design: Object.keys(DEFAULTS) still enumerates them
  // (an explicitly-assigned `undefined` property IS listed), which is what
  // drives resolveConfig()'s allKeys loop — but no layer resolves a value
  // unless the user actually sets one, so absence is the correct default.
  anthropicProfileDirs: undefined,
  openaiAccountsFile: undefined,
});

export const PROJECT_FILENAME = ".opencode-hard-limit.json";

// Per-provider window override keys. Flat (not nested map) so the existing
// per-key coerce/precedence/provenance/env/writeScope machinery applies
// unchanged. Absence of a key means "inherit window" (see windowForProvider).
// NOTE: keys must stay in sync with the provider ids in MONITORED_PROVIDERS
// (lib/quota.js) — not imported here to avoid a circular dependency.
export const PROVIDER_WINDOW_KEYS = Object.freeze({
  anthropic: "windowAnthropic",
  openai: "windowOpenai",
});

const ENV_KEYS = {
  minRemaining: "OPENCODE_QUOTA_MIN_REMAINING",
  blockOnError: "OPENCODE_QUOTA_BLOCK_ON_ERROR",
  blockOnAuthError: "OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR",
  cacheTtlMs: "OPENCODE_QUOTA_CACHE_TTL_MS",
  timeoutMs: "OPENCODE_QUOTA_TIMEOUT_MS",
  window: "OPENCODE_QUOTA_WINDOW",
  windowAnthropic: "OPENCODE_QUOTA_WINDOW_ANTHROPIC",
  windowOpenai: "OPENCODE_QUOTA_WINDOW_OPENAI",
  minRefreshIntervalMs: "OPENCODE_QUOTA_MIN_REFRESH_MS",
  rateLimitBackoffMs: "OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS",
  maxRateLimitBackoffMs: "OPENCODE_QUOTA_MAX_RATE_LIMIT_BACKOFF_MS",
  noBaselineRateLimitBackoffMs: "OPENCODE_QUOTA_NO_BASELINE_RATE_LIMIT_BACKOFF_MS",
  staleBlockMarginPct: "OPENCODE_QUOTA_STALE_BLOCK_MARGIN",
  allowPostpone: "OPENCODE_QUOTA_ALLOW_POSTPONE",
  anthropicProfileDirs: "OPENCODE_QUOTA_ANTHROPIC_PROFILE_DIRS",
  openaiAccountsFile: "OPENCODE_QUOTA_OPENAI_ACCOUNTS_FILE",
};

const NUMBER_KEYS = new Set(["minRemaining", "cacheTtlMs", "timeoutMs", "minRefreshIntervalMs", "rateLimitBackoffMs", "maxRateLimitBackoffMs", "noBaselineRateLimitBackoffMs", "staleBlockMarginPct"]);
const BOOL_KEYS = new Set(["blockOnError", "blockOnAuthError", "allowPostpone"]);
const WINDOW_KEYS = new Set(["window", "windowAnthropic", "windowOpenai"]);
const STRING_KEYS = new Set(["openaiAccountsFile"]);
const PATH_LIST_KEYS = new Set(["anthropicProfileDirs"]);

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
    if (key === "staleBlockMarginPct") {
      return Math.min(100, Math.max(0, n));
    }
    if (key === "timeoutMs") return n > 0 ? n : undefined;
    if (key === "cacheTtlMs") return n >= 0 ? n : undefined;
    if (key === "minRefreshIntervalMs" || key === "rateLimitBackoffMs" || key === "maxRateLimitBackoffMs" || key === "noBaselineRateLimitBackoffMs") {
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    return n;
  }

  if (WINDOW_KEYS.has(key)) {
    const t = String(value).trim().toLowerCase();
    if (t === "5h" || t === "5" || t === "daily") return "5h";
    if (t === "weekly" || t === "week" || t === "7d") return "Weekly";
    return undefined; // unrecognized -> fall through to next layer
  }

  if (STRING_KEYS.has(key)) {
    const t = String(value).trim();
    return t || undefined;
  }

  if (PATH_LIST_KEYS.has(key)) {
    // JSON config files hold a real array; env vars hold a comma-separated
    // string (parity with how other list-shaped settings are exposed).
    const list = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : null;
    if (!list) return undefined;
    const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
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
  const allKeys = [...Object.keys(DEFAULTS), ...Object.values(PROVIDER_WINDOW_KEYS)];
  for (const key of allKeys) {
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

// Resolve the effective quota window for a given provider id, applying
// per-provider override -> base `window` -> built-in default precedence.
export function windowForProvider(values, providerId) {
  const key = PROVIDER_WINDOW_KEYS[providerId];
  return (key && values?.[key]) || values?.window || DEFAULTS.window;
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
