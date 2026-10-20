// lib/quota.js
//
// Shared quota-reading module for opencode-hard-limit.
//
// Exports MONITORED_PROVIDERS and readWeekly(), which fetch subscription quota
// windows NATIVELY (no external CLI dependency) and return a normalized
// quota-entry result for the requested window ("5h" or "Weekly").
//
//   Anthropic (Claude): probe the local `claude` CLI (`claude auth status --json`)
//                       and, if it exposes no quota windows, fall back to the
//                       OAuth usage HTTP API (api.anthropic.com/api/oauth/usage).
//   OpenAI    (OpenAI):  read OpenCode's OAuth token from auth.json and call the
//                       ChatGPT usage endpoint (chatgpt.com/backend-api/wham/usage).
//
// Used by both the server plugin (quota-hard-stop.js) and the TUI sidebar.
// Shared by the server plugin and TUI sidebar. The sidebar deploys this module
// with its relative lib dependencies alongside the widget.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configDirGlobal } from "./config.js";
import { windowDurationMs } from "./reset.js";
import { discoverAnthropicProfiles, discoverOpenAIAccounts } from "./accounts.js";
import { resolveAnthropicProfileSlug } from "./evaluate.js";

// Providers this package knows how to monitor.
export const MONITORED_PROVIDERS = [
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "OpenAI" },
];

export function quotaCachePath() {
  return join(configDirGlobal(), "quota-cache.json");
}

function resolveCacheFile(cacheFile) {
  if (cacheFile === null || cacheFile === "") return null;
  if (typeof cacheFile === "string") return cacheFile;
  const env = process.env.OPENCODE_QUOTA_CACHE_FILE;
  if (env && env.trim()) return env.trim();
  if (process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test") return null;
  return quotaCachePath();
}

// Classify a quota error string into a broad kind for routing in evaluate().
// Returns 'auth' | 'timeout' | 'ratelimit' | 'unreadable'.
function classifyError(text) {
  const t = String(text).toLowerCase();
  if (/\b429\b|rate\s*limit|too\s+many\s+requests/.test(t)) {
    return "ratelimit";
  }
  if (/expired|token|auth|unauthor|not detected|undetected|unavailable|login|sign in|signed out|credential|forbidden|401|403/.test(t)) {
    return "auth";
  }
  if (/timeout|timed out|etimedout/.test(t)) {
    return "timeout";
  }
  return "unreadable";
}

// ---------------------------------------------------------------------------
// Small process/HTTP helpers
// ---------------------------------------------------------------------------

// Run a child process; NEVER rejects — resolves { error, stdout, stderr }.
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error: error || null, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// GET a URL with a hard timeout. NEVER throws — resolves a normalized shape.
async function fetchJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    const retryAfter = res.headers?.get?.("retry-after") ?? null;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null */
    }
    return { ok: res.ok, status: res.status, json, bodySnippet: text.slice(0, 120), timedOut: false, retryAfter };
  } catch (err) {
    return { ok: false, status: 0, json: null, bodySnippet: "", timedOut: err?.name === "AbortError", retryAfter: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfterMs(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const at = Date.parse(text);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

// Decode a JWT payload (best-effort). Returns {} on any failure.
function parseJwt(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) || {};
  } catch {
    return {};
  }
}

function firstNumeric(...values) {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function toIso(value) {
  if (value == null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

// Map a raw Anthropic window object -> { percentRemaining, resetTimeIso } | null.
function opencodeConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode");
}

function multiAccountAccountsPath(opts = {}) {
  if (opts.accountsFile !== undefined && opts.accountsFile !== null) return opts.accountsFile;
  const env = process.env.OPENCODE_QUOTA_ANTHROPIC_ACCOUNTS_FILE;
  if (env && env.trim()) return env.trim();
  return join(opencodeConfigDir(), "anthropic-multi-account-accounts.json");
}

let stickyMultiAccountSeen = false;
const quotaAccountMemo = new Map();

async function readMultiAccountFile(opts = {}) {
  try {
    const raw = JSON.parse(await readFile(multiAccountAccountsPath(opts), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.activeAccountUuid === undefined || raw.activeAccountUuid === null || raw.activeAccountUuid === "") return null;
    stickyMultiAccountSeen = true;
    return raw;
  } catch {
    return null;
  }
}

async function readMultiAccountActive(opts = {}) {
  const data = await readMultiAccountFile(opts);
  if (!data || !Array.isArray(data.accounts)) return null;
  const active = data.accounts.find((account) => account && account.uuid === data.activeAccountUuid);
  if (!active || active.enabled === false) return null;
  return active;
}

async function isMultiAccountManaged(opts = {}) {
  if (stickyMultiAccountSeen) return true;
  return Boolean(await readMultiAccountFile(opts));
}

async function readOpenCodeAnthropicAuth() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  try {
    const auth = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
    const entry = auth?.anthropic;
    if (entry?.type !== "oauth" || typeof entry.access !== "string" || !entry.access.trim()) return null;
    return {
      access: entry.access.trim(),
      refresh: typeof entry.refresh === "string" && entry.refresh.trim() ? entry.refresh.trim() : null,
      expires: entry.expires ?? null,
    };
  } catch {
    return null;
  }
}

function hashAccountToken(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

async function resolveAnthropicCredential(opts = {}) {
  const source = opts.credentialSource === "claude-cli" || opts.credentialSource === "opencode-auth"
    ? opts.credentialSource
    : "auto";
  const usable = (expiresAt) => !expiresAt || Number(expiresAt) > Date.now() + 60_000;

  if (source === "claude-cli") return null;

  if (source !== "opencode-auth") {
    const active = await readMultiAccountActive(opts);
    const managed = await isMultiAccountManaged(opts);

    if (active && usable(active.expiresAt) && active.accessToken) {
      return {
        source: "multi-account",
        accessToken: active.accessToken,
        expiresAt: active.expiresAt,
        accountKey: `ma:${active.uuid}`,
      };
    }

    if (managed) {
      if (active) {
        const b = await readOpenCodeAnthropicAuth();
        const sameAccount = Boolean(b) && (
          (typeof b.refresh === "string" && b.refresh && b.refresh === active.refreshToken) ||
          (typeof active.accessToken === "string" && active.accessToken && b.access === active.accessToken)
        );
        if (b && sameAccount && usable(b.expires)) {
          return {
            source: "opencode-auth",
            accessToken: b.access,
            expiresAt: b.expires,
            accountKey: `ma:${active.uuid}`,
          };
        }
      }
      return null;
    }
  }

  const b = await readOpenCodeAnthropicAuth();
  if (b && usable(b.expires) && b.access) {
    return {
      source: "opencode-auth",
      accessToken: b.access,
      expiresAt: b.expires,
      accountKey: `oc:${hashAccountToken(b.refresh || b.access)}`,
    };
  }
  return null;
}

function __resetMultiAccountSticky() {
  stickyMultiAccountSeen = false;
  quotaAccountMemo.clear();
}

function mapAnthropicWindow(w) {
  if (!w || typeof w !== "object") return null;
  const used = firstNumeric(
    w.utilization, w.used_percentage, w.usedPercentage,
    w.used_percent, w.usedPercent, w.percent_used, w.percentUsed,
  );
  if (used === null) return null;
  return {
    percentRemaining: Math.min(100, Math.round(100 - used)),
    resetTimeIso: toIso(w.resets_at ?? w.resetsAt ?? w.reset_at ?? w.resetAt),
  };
}

// Parse an Anthropic usage payload (CLI or HTTP) -> { five_hour, seven_day } | null.
// Accepts a root where at least one of the two windows is present/mappable
// (some accounts expose only one window) — a fully-empty root is skipped in
// favor of trying the next candidate root.
function parseAnthropicUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const roots = [
    payload, payload.quota, payload.usage,
    payload.rate_limits, payload.rateLimits, payload.oauth_usage, payload.oauthUsage,
  ];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const fhRaw = root.five_hour ?? root.fiveHour;
    const sdRaw = root.seven_day ?? root.sevenDay;
    if (fhRaw == null && sdRaw == null) continue;
    const five_hour = fhRaw != null ? mapAnthropicWindow(fhRaw) : null;
    const seven_day = sdRaw != null ? mapAnthropicWindow(sdRaw) : null;
    if (five_hour || seven_day) return { five_hour, seven_day };
  }
  return null;
}

function extractAuthBoolean(p) {
  if (!p || typeof p !== "object") return false;
  for (const v of [p.authenticated, p.isAuthenticated, p.loggedIn, p.auth?.authenticated, p.auth?.loggedIn]) {
    if (typeof v === "boolean") return v;
  }
  const s = String(p.status ?? "").toLowerCase();
  if (s === "authenticated") return true;
  return false;
}

function parseJsonLoose(text) {
  const t = String(text).trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Resolve a usable `claude` binary path, or null if none responds. Tries an
// explicit override, PATH, and the common ~/.local/bin location (the exact
// spot that a non-login shell PATH omits).
async function resolveClaudeBinary() {
  const candidates = [];
  if (process.env.OPENCODE_QUOTA_CLAUDE_BIN) candidates.push(process.env.OPENCODE_QUOTA_CLAUDE_BIN);
  candidates.push("claude", join(homedir(), ".local", "bin", "claude"));
  for (const bin of candidates) {
    const { error, stdout, stderr } = await run(bin, ["--version"], 3000);
    const out = `${stdout}${stderr}`.toLowerCase();
    const missing =
      (error && error.code === "ENOENT") ||
      /command not found|not recognized as an internal or external command|no such file or directory/.test(out);
    if (missing) continue;
    return bin; // binary exists (even a non-zero exit still means it's present)
  }
  return null;
}

// Probe the local claude CLI. Returns { authenticated, windows }.
async function anthropicViaCli(bin) {
  let { stdout, stderr } = await run(bin, ["auth", "status", "--json"], 3000);
  if (/unknown command|unrecognized command|unexpected argument/i.test(`${stdout}${stderr}`)) {
    ({ stdout, stderr } = await run(bin, ["auth", "status"], 3000));
  }
  const payload = parseJsonLoose(stdout);
  if (!payload) return { authenticated: false, windows: null };
  return { authenticated: extractAuthBoolean(payload), windows: parseAnthropicUsage(payload) };
}

// Read the Claude OAuth access token (macOS keychain, then credentials file).
function extractClaudeCredToken(j) {
  if (!j || typeof j !== "object") return null;
  const chains = [j.claudeAiOauth, j.oauth, j];
  for (const c of chains) {
    if (!c || typeof c !== "object") continue;
    for (const key of ["accessToken", "access_token", "token"]) {
      const v = c[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

export async function readClaudeCredentialState(credentialsPath) {
  try {
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    const oauth = credentials?.claudeAiOauth;
    const rawExpiresAt = oauth?.expiresAt;
    const expiresAt = Number.isFinite(rawExpiresAt) ? rawExpiresAt : null;
    const refreshToken = oauth?.refreshToken;
    return {
      accessToken: extractClaudeCredToken(credentials),
      expiresAt,
      hasRefreshToken: typeof refreshToken === "string" && Boolean(refreshToken.trim()),
    };
  } catch {
    return null;
  }
}

async function readClaudeToken() {
  if (process.platform === "darwin") {
    const { error, stdout } = await run(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      3000,
    );
    if (!error && stdout && stdout.trim()) {
      const asJson = parseJsonLoose(stdout);
      const token = asJson ? extractClaudeCredToken(asJson) : stdout.trim();
      if (token) return token;
    }
  }
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    return extractClaudeCredToken(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Only two windows exist, so fallback is binary.
const otherWindow = (w) => (w === "5h" ? "Weekly" : "5h");

async function anthropicUsageViaToken(token, window, timeoutMs) {
  const key = window === "5h" ? "five_hour" : "seven_day";
  const otherKey = window === "5h" ? "seven_day" : "five_hour";
  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    timeoutMs,
  );
  if (res.timedOut) return { ok: false, error: "timeout: anthropic usage request", errorKind: "timeout" };
  if (!res.ok) {
    const error = `Anthropic API error ${res.status}: ${res.bodySnippet}`;
    return { ok: false, error, errorKind: res.status === 429 ? "ratelimit" : undefined, retryAfter: res.retryAfter };
  }
  const windows = res.json ? parseAnthropicUsage(res.json) : null;
  if (!windows) return { ok: false, error: "unexpected Anthropic quota response shape" };
  if (windows[key]) return buildOk(windows[key], window);
  if (windows[otherKey]) {
    return { ...buildOk(windows[otherKey], otherWindow(window)), requestedWindow: window, windowFallback: true };
  }
  return { ok: false, error: `no ${window} window entry` };
}

async function fetchAnthropic({ window, timeoutMs, account }) {
  const key = window === "5h" ? "five_hour" : "seven_day";
  const otherKey = window === "5h" ? "seven_day" : "five_hour";
  const credential = account?.credential ?? null;
  const managed = account?.accountKey?.startsWith("ma:") === true;
  const profileAccount = account?.accountKey?.startsWith("cp:") === true;

  if (credential?.accessToken) {
    const result = await anthropicUsageViaToken(credential.accessToken, window, timeoutMs);
    if (managed || profileAccount || result.ok || result.errorKind === "ratelimit" || result.errorKind === "timeout") {
      return { ...result, accountKey: account.accountKey };
    }
  }

  if (managed) {
    return {
      ok: false,
      error: "no usable credential for the active anthropic account",
      errorKind: "auth",
      accountKey: account.accountKey,
    };
  }

  const bin = await resolveClaudeBinary();
  if (bin) {
    const cli = await anthropicViaCli(bin);
    if (cli.windows && cli.windows[key]) {
      return buildOk(cli.windows[key], window);
    }
    if (cli.windows && cli.windows[otherKey]) {
      return { ...buildOk(cli.windows[otherKey], otherWindow(window)), requestedWindow: window, windowFallback: true };
    }
  }

  const token = await readClaudeToken();
  if (!token) {
    return {
      ok: false,
      error: bin
        ? "unavailable (claude authenticated but exposes no quota windows)"
        : "claude CLI not found or not authenticated",
    };
  }
  return anthropicUsageViaToken(token, window, timeoutMs);
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function readOpenAIAuth() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  let auth;
  try {
    auth = JSON.parse(await readFile(join(dataHome, "opencode", "auth.json"), "utf8"));
  } catch {
    return null;
  }
  for (const key of ["openai", "codex", "chatgpt", "opencode"]) {
    const e = auth?.[key];
    if (e && e.type === "oauth" && typeof e.access === "string" && e.access.trim()) {
      const accessToken = e.access.trim();
      const claims = parseJwt(accessToken);
      const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? e.accountId ?? null;
      const expiresAt = typeof e.expires === "number" ? e.expires : null;
      return { accessToken, accountId, expiresAt };
    }
  }
  return null;
}

// Map a raw OpenAI window object -> { percentRemaining, resetTimeIso } | null.
function mapOpenAIWindow(w) {
  if (!w || typeof w !== "object") return null;
  const used = firstNumeric(w.used_percent);
  if (used === null) return null;
  let resetTimeIso;
  const ra = w.reset_at;
  const ras = w.reset_after_seconds;
  if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) {
    resetTimeIso = new Date(Math.round(ra * 1000)).toISOString();
  } else if (typeof ras === "number" && Number.isFinite(ras) && ras > 0) {
    resetTimeIso = new Date(Date.now() + Math.round(ras * 1000)).toISOString();
  }
  return { percentRemaining: Math.max(0, Math.min(100, Math.round(100 - used))), resetTimeIso };
}

// Select the raw OpenAI window object matching the requested window by
// duration instead of by slot position. primary_window/secondary_window are
// positional/API-internal and can appear in either order; the authoritative
// discriminator is each window's own limit_window_seconds field
// (18000 = 5h, 604800 = 7d/Weekly).
function pickOpenAIWindow(rateLimit, window) {
  const candidates = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(
    (w) => w && typeof w === "object",
  );
  if (candidates.length === 0) return null;

  const wantedSeconds = windowDurationMs(window) / 1000;

  // 1. Exact match on the authoritative duration field.
  const exact = candidates.find((c) => Number(c.limit_window_seconds) === wantedSeconds);
  if (exact) return exact;

  const withDuration = candidates.filter((c) => Number.isFinite(Number(c.limit_window_seconds)));

  // 2. Two or more candidates with known durations but no exact match: classify by
  //    relative order (shortest = "5h", longest = "Weekly"). Requires >=2 to be
  //    meaningful — a single known-duration candidate that didn't match exactly is
  //    handled in step 3, not here.
  if (withDuration.length >= 2) {
    const sorted = [...withDuration].sort(
      (a, b) => Number(a.limit_window_seconds) - Number(b.limit_window_seconds),
    );
    return window === "5h" ? sorted[0] : sorted[sorted.length - 1];
  }

  // 3. Exactly one candidate has a known duration and it didn't match wantedSeconds
  //    above (e.g. a free-tier account exposing only a weekly window, requesting
  //    "5h"): we know its real duration and it isn't what was asked for. Don't guess
  //    — report the window as genuinely unavailable.
  if (withDuration.length === 1) return null;

  // 4. Last resort — no duration data at all on any candidate: fall back to the
  //    previous positional assumption (primary="5h", secondary="Weekly"). Known-
  //    fragile; only fires when OpenAI's payload omits limit_window_seconds entirely,
  //    which none of our observed real payloads do.
  return window === "5h" ? (rateLimit?.primary_window ?? null) : (rateLimit?.secondary_window ?? null);
}

async function fetchOpenAI({ window, timeoutMs, credential }) {
  if (!credential?.accessToken) return { ok: false, error: "OpenAI OAuth token not detected", errorKind: "auth" };
  if (credential.expiresAt && credential.expiresAt < Date.now()) return { ok: false, error: "token expired", errorKind: "auth" };

  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    "User-Agent": "OpenCode-Quota-Toast/1.0",
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers, timeoutMs);
  if (res.timedOut) return { ok: false, error: "timeout: openai usage request", errorKind: "timeout" };
  if (!res.ok) {
    const error = `OpenAI API error ${res.status}: ${res.bodySnippet}`;
    return { ok: false, error, errorKind: res.status === 429 ? "ratelimit" : undefined, retryAfter: res.retryAfter };
  }

  const rateLimit = res.json?.rate_limit;
  if (!rateLimit) return { ok: false, error: "no quota data" };

  const raw = pickOpenAIWindow(rateLimit, window);
  const mapped = raw ? mapOpenAIWindow(raw) : null;
  if (mapped) return buildOk(mapped, window);

  const fallbackWindow = otherWindow(window);
  const fallbackRaw = pickOpenAIWindow(rateLimit, fallbackWindow);
  const fallbackMapped = fallbackRaw ? mapOpenAIWindow(fallbackRaw) : null;
  if (fallbackMapped) {
    return { ...buildOk(fallbackMapped, fallbackWindow), requestedWindow: window, windowFallback: true };
  }

  if (!raw) return { ok: false, error: `no ${window} window entry` };
  return { ok: false, error: `no numeric percent for ${window} window` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildOk(mapped, window) {
  return {
    ok: true,
    status: "ok",
    remaining: mapped.percentRemaining,
    resetAt: mapped.resetTimeIso ?? null,
    unlimited: false,
    window,
  };
}

const inflight = new Map();
const cacheWriteQueues = new Map();
let cacheWriteSequence = 0;

function cacheKey(provider, accountKey, window) {
  return `${provider}:${accountKey}:${window}`;
}

function hasFreshCache(entry, now, cacheTtlMs) {
  return Boolean(entry && Number.isFinite(entry.at) && now - entry.at < cacheTtlMs);
}

function hasMinRefresh(entry, now, minRefreshIntervalMs) {
  return Boolean(entry && Number.isFinite(entry.at) && now - entry.at < minRefreshIntervalMs);
}

function isBackoffActive(entry, now) {
  return Boolean(entry && Number.isFinite(entry.nextAllowedAt) && now < entry.nextAllowedAt);
}

// The last reading we still trust, or null. Carries its original `at` so the
// value stays honestly dated (and therefore correctly flagged stale) when a
// later failure serves it again.
function pickLastOk(entry) {
  if (!entry || !Number.isFinite(entry.at)) return null;
  return entry.result && entry.result.ok === true ? { at: entry.at, result: entry.result } : null;
}

// How long to wait after a 429. A server-sent Retry-After wins over the local
// cooldown, since it reflects when the endpoint will actually answer — but it
// is capped: Anthropic's usage endpoint can answer with the better part of an
// hour, and honoring that verbatim pins an account as unreadable long after it
// would have served a fresh number. Absent a Retry-After, the local cooldown
// applies as-is (it is the user's own setting, so it is not capped).
function resolveBackoffMs(retryAfter, rateLimitBackoffMs, maxRateLimitBackoffMs) {
  const serverMs = parseRetryAfterMs(retryAfter);
  if (serverMs == null) return rateLimitBackoffMs;
  return Number.isFinite(maxRateLimitBackoffMs) && maxRateLimitBackoffMs > 0
    ? Math.min(serverMs, maxRateLimitBackoffMs)
    : serverMs;
}

function decorateResult(result, { stale = false, receivedAt, backoffUntil } = {}) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result, receivedAt };
  if (stale) out.stale = true;
  if (Number.isFinite(backoffUntil)) out.backoffUntil = backoffUntil;
  return out;
}

async function readCacheState(cacheFile) {
  if (!cacheFile) return {};
  try {
    const raw = await readFile(cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeCacheState(cacheFile, state) {
  if (!cacheFile) return;
  const dir = dirname(cacheFile);
  const tmp = `${cacheFile}.tmp-${process.pid}-${cacheWriteSequence++}`;
  try {
    if (dir) await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(tmp, cacheFile);
  } catch {
    try { await rm(tmp, { force: true }); } catch {}
  }
}

// Serialize read-modify-write cycles in this process; separate processes still
// use last-writer-wins, so a collision can cost one additional quota fetch.
async function writeCacheEntry(cacheFile, key, entry) {
  if (!cacheFile) return;
  const write = async () => {
    const state = await readCacheState(cacheFile);
    state[key] = entry;
    const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (const [storedKey, storedEntry] of Object.entries(state)) {
      if (/^[^:]+:[^:]+$/.test(storedKey) || (Number.isFinite(storedEntry?.at) && storedEntry.at < cutoff)) {
        delete state[storedKey];
      }
    }
    await writeCacheState(cacheFile, state);
  };

  const previous = cacheWriteQueues.get(cacheFile);
  const pending = previous ? previous.then(write, write) : write();
  cacheWriteQueues.set(cacheFile, pending);
  const clearQueue = () => {
    if (cacheWriteQueues.get(cacheFile) === pending) cacheWriteQueues.delete(cacheFile);
  };
  pending.then(clearQueue, clearQueue);
  await pending;
}

// Read a quota entry for a provider, account, and window.
//
// If account is omitted, resolveQuotaAccount() picks the account automatically.
// `account` can be supplied by the gate/sidebar to share the resolved slot.
// `window` defaults to "Weekly".
//
// Returns (always resolves, never throws):
//   {
//     ok: boolean,
//     status: 'ok' | 'error',
//     remaining: number | null,   // percentRemaining when ok, else null
//     resetAt: string | null,
//     unlimited: boolean,
//     window: string,             // the EFFECTIVE window the data represents
//                                  // (usually the requested window; differs
//                                  // from it only when windowFallback is set)
//     requestedWindow?: string,   // present only when a fallback occurred:
//                                  // the window that was actually asked for
//     windowFallback?: true,      // present only when window !== requestedWindow
//                                  // (this account has no `requestedWindow`
//                                  // window; data is for `window` instead)
//     error?: string,             // short reason string when ok===false
//     errorKind?: 'auth' | 'timeout' | 'ratelimit' | 'unreadable' | 'unknown',
//     receivedAt?: number,
//     stale?: boolean,
//     backoffUntil?: number,
//   }
//
// Cache and inflight keys use provider, resolved accountKey, and requested
// window. The stored payload carries the effective `window` after fallback.
function resolvedAccount({ accountKey, label, isActive = false, credential = null, error = undefined }) {
  const account = { accountKey, label, isActive, credential };
  if (error) account.error = error;
  return account;
}

function anthropicLabel(providerId) {
  const slug = resolveAnthropicProfileSlug(providerId);
  if (!slug) return "Claude";
  return `Claude ${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
}

async function resolveAnthropicProfile(profile) {
  const credentialState = await readClaudeCredentialState(profile.credentialsPath);
  const accessToken = credentialState?.accessToken;
  if (!accessToken) {
    return resolvedAccount({
      accountKey: `cp:${profile.id}`,
      label: profile.label,
      error: { message: `Claude profile "${profile.id}" has no usable credential`, errorKind: "auth" },
    });
  }

  const credential = { accessToken };
  if (credentialState.expiresAt !== null) credential.expiresAt = credentialState.expiresAt;
  return resolvedAccount({
    accountKey: `cp:${profile.id}`,
    label: profile.label,
    credential,
  });
}

function resolvedOpenAIStoreAccount(account) {
  return resolvedAccount({
    accountKey: `ox:${account.id}`,
    label: account.label,
    isActive: account.isActive,
    credential: {
      accessToken: account.accessToken,
      accountId: account.accountId ?? undefined,
      expiresAt: account.expiresAt ?? undefined,
    },
  });
}

async function resolveAnthropicAccount({ providerId, accountsFile, credentialSource, anthropicProfileDirs }) {
  const profiles = await discoverAnthropicProfiles({ profileDirs: anthropicProfileDirs });
  const profileMode = anthropicProfileDirs != null || profiles.length > 0;
  const profileSlug = resolveAnthropicProfileSlug(providerId);
  // Profile credentials are selected by providerId and ignore credentialSource.
  if (profileSlug && profileMode) {
    const profile = profiles.find((candidate) => candidate.id === profileSlug);
    if (profile) return resolveAnthropicProfile(profile);
    return resolvedAccount({
      accountKey: `cp:${profileSlug}`,
      label: anthropicLabel(providerId),
      error: { message: `no Claude profile "${profileSlug}"`, errorKind: "unknown" },
    });
  }

  const opts = { accountsFile, credentialSource };
  const credential = await resolveAnthropicCredential(opts);
  if (credential) {
    return resolvedAccount({
      accountKey: credential.accountKey,
      label: anthropicLabel(providerId),
      isActive: true,
      credential: {
        accessToken: credential.accessToken,
        expiresAt: credential.expiresAt ?? undefined,
      },
    });
  }

  const managedMode = credentialSource !== "claude-cli" && credentialSource !== "opencode-auth";
  if (managedMode && await isMultiAccountManaged(opts)) {
    const data = await readMultiAccountFile(opts);
    const uuid = typeof data?.activeAccountUuid === "string" && data.activeAccountUuid
      ? data.activeAccountUuid
      : "unknown";
    return resolvedAccount({
      accountKey: `ma:${uuid}`,
      label: anthropicLabel(providerId),
      error: {
        message: "no usable credential for the active anthropic account",
        errorKind: "auth",
      },
    });
  }

  return resolvedAccount({
    accountKey: "cli",
    label: anthropicLabel(providerId),
    isActive: true,
  });
}

async function resolveOpenAIAccount({ openaiAccountsFile }) {
  const accounts = await discoverOpenAIAccounts({ accountsFile: openaiAccountsFile });
  if (accounts) {
    const active = accounts.find((candidate) => candidate.isActive);
    if (active) return resolvedOpenAIStoreAccount(active);
    return resolvedAccount({
      accountKey: "ox:unknown",
      label: "OpenAI",
      error: { message: "no active OpenAI account", errorKind: "auth" },
    });
  }

  const credential = await readOpenAIAuth();
  if (!credential) {
    return resolvedAccount({
      accountKey: "oc:default",
      label: "OpenAI",
      isActive: true,
      error: { message: "OpenAI OAuth token not detected", errorKind: "auth" },
    });
  }
  const accountId = credential.accountId || "default";
  return resolvedAccount({
    accountKey: `oc:${accountId}`,
    label: "OpenAI",
    isActive: true,
    credential,
  });
}

function quotaAccountFingerprint({ provider, providerId, accountsFile, credentialSource, anthropicProfileDirs, openaiAccountsFile }) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const openAIFile = openaiAccountsFile || join(homedir(), ".opencode", "oc-codex-multi-auth-accounts.json");
  return JSON.stringify({
    provider,
    providerId,
    accountsFile: multiAccountAccountsPath({ accountsFile }),
    dataHome,
    credentialSource: credentialSource || "auto",
    anthropicProfileDirs: anthropicProfileDirs ?? null,
    openaiAccountsFile: openAIFile,
  });
}

/** Resolve the credential/account slot used for a provider request. */
export async function resolveQuotaAccount({
  provider,
  providerId = provider,
  accountsFile,
  credentialSource = "auto",
  anthropicProfileDirs,
  openaiAccountsFile,
} = {}) {
  const options = { provider, providerId, accountsFile, credentialSource, anthropicProfileDirs, openaiAccountsFile };
  const fingerprint = quotaAccountFingerprint(options);
  const now = Date.now();
  const memoized = quotaAccountMemo.get(fingerprint);
  if (memoized && now - memoized.at < 5000) return memoized.account;

  let account;
  if (provider === "anthropic") {
    account = await resolveAnthropicAccount(options);
  } else if (provider === "openai") {
    account = await resolveOpenAIAccount(options);
  } else {
    account = resolvedAccount({
      accountKey: "unknown",
      label: String(providerId ?? provider ?? "unknown"),
      error: { message: `unknown provider: ${provider}`, errorKind: "unknown" },
    });
  }
  quotaAccountMemo.set(fingerprint, { at: Date.now(), account });
  return account;
}

/** List the accounts the gate/sidebar can read for one quota provider. */
export async function listQuotaAccounts(options = {}) {
  const { provider } = options;
  if (provider === "anthropic") {
    const profiles = await discoverAnthropicProfiles({ profileDirs: options.anthropicProfileDirs });
    const profileMode = options.anthropicProfileDirs != null || profiles.length > 0;
    if (profileMode) {
      const accounts = [];
      for (const profile of profiles) {
        accounts.push(await resolveQuotaAccount({ ...options, providerId: `claude-${profile.id}` }));
      }
      return accounts;
    }
    return [await resolveQuotaAccount({ ...options, providerId: options.providerId ?? "anthropic" })];
  }

  if (provider === "openai") {
    const accounts = await discoverOpenAIAccounts({ accountsFile: options.openaiAccountsFile });
    if (accounts) return accounts.map(resolvedOpenAIStoreAccount);
    return [await resolveQuotaAccount({ ...options, providerId: options.providerId ?? "openai" })];
  }
  return [];
}

// A 429 with no last-known-good reading to serve meanwhile (e.g. the very
// first check for an account, or right after a token refresh raced the
// previous failing attempt) is capped at noBaselineRateLimitBackoffMs instead
// of the longer maxRateLimitBackoffMs: there is no stale value being
// protected, so re-checking sooner costs nothing and avoids pinning the
// account "unavailable" for minutes after the rate limit has already lifted.

export async function readWeekly({
  provider,
  providerId = provider,
  window = "Weekly",
  account = undefined,
  timeoutMs = 20000,
  cacheTtlMs = 60000,
  rateLimitBackoffMs = 300000,
  // Cap on a 429's server-sent Retry-After (see resolveBackoffMs).
  maxRateLimitBackoffMs = 600000,
  // Tighter cap used instead of maxRateLimitBackoffMs when there is no
  // last-known-good reading to serve through the backoff (see note above).
  noBaselineRateLimitBackoffMs = 60000,
  minRefreshIntervalMs = 120000,
  cacheFile = undefined,
  accountsFile = undefined,
  credentialSource = "auto",
  anthropicProfileDirs = undefined,
  openaiAccountsFile = undefined,
} = {}) {
  const resolvedAccount = account ?? await resolveQuotaAccount({
    provider,
    providerId,
    accountsFile,
    credentialSource,
    anthropicProfileDirs,
    openaiAccountsFile,
  });
  const accountKey = resolvedAccount.accountKey;
  const fail = (error, errorKind) => ({
    ok: false, status: "error", remaining: null, resetAt: null,
    unlimited: false, window, error, errorKind: errorKind ?? classifyError(error), accountKey,
  });

  if (resolvedAccount.error) {
    return fail(resolvedAccount.error.message, resolvedAccount.error.errorKind);
  }

  const key = cacheKey(provider, accountKey, window);
  const resolvedCacheFile = resolveCacheFile(cacheFile);
  const now = Date.now();
  const state = await readCacheState(resolvedCacheFile);
  const entry = state[key] && typeof state[key] === "object" ? state[key] : null;
  const cachedResult = entry?.result && typeof entry.result === "object"
    ? { ...entry.result, accountKey }
    : null;
  const age = entry && Number.isFinite(entry.at) ? now - entry.at : Infinity;
  const stale = Boolean(cachedResult && age >= cacheTtlMs);
  const backoffActive = isBackoffActive(entry, now);

  if (cachedResult && (backoffActive || hasFreshCache(entry, now, cacheTtlMs) || hasMinRefresh(entry, now, minRefreshIntervalMs))) {
    return decorateResult(cachedResult, {
      stale,
      receivedAt: entry.at,
      backoffUntil: backoffActive ? entry.nextAllowedAt : undefined,
    });
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const pendingFetch = (async () => {
    let result;
    try {
      if (provider === "anthropic") {
        result = await fetchAnthropic({ window, timeoutMs, account: resolvedAccount });
      } else if (provider === "openai") {
        result = await fetchOpenAI({ window, timeoutMs, credential: resolvedAccount.credential });
      } else {
        return fail(`unknown provider: ${provider}`, "unknown");
      }
    } catch (err) {
      return fail(`fetch-failed: ${err?.message || err}`, "unknown");
    }

    result = result && typeof result === "object"
      ? { ...result, accountKey }
      : fail("unreadable", "unreadable");

    if (result.ok !== true) {
      const lastOk = pickLastOk(entry);
      const lastOkResult = lastOk ? { ...lastOk.result, accountKey } : null;

      if (result.errorKind === "ratelimit") {
        const cap = lastOk ? maxRateLimitBackoffMs : Math.min(maxRateLimitBackoffMs, noBaselineRateLimitBackoffMs);
        const nextAllowedAt = now + resolveBackoffMs(result.retryAfter, rateLimitBackoffMs, cap);
        if (lastOk) {
          await writeCacheEntry(resolvedCacheFile, key, { at: lastOk.at, result: lastOkResult, nextAllowedAt });
          return decorateResult(lastOkResult, {
            stale: true,
            receivedAt: lastOk.at,
            backoffUntil: nextAllowedAt,
          });
        }
        const errorResult = fail(result.error || "rate limited", "ratelimit");
        await writeCacheEntry(resolvedCacheFile, key, { at: now, result: errorResult, nextAllowedAt });
        return decorateResult(errorResult, { receivedAt: now, backoffUntil: nextAllowedAt });
      }

      const errorResult = fail(result.error || "unreadable", result.errorKind);
      // Keep a good reading available during transient failures, but never hide
      // an auth error behind a value that can no longer be refreshed.
      if (lastOk && errorResult.errorKind !== "auth") {
        await writeCacheEntry(resolvedCacheFile, key, {
          at: lastOk.at, result: lastOkResult, nextAllowedAt: 0,
        });
        return decorateResult(lastOkResult, { stale: true, receivedAt: lastOk.at });
      }
      await writeCacheEntry(resolvedCacheFile, key, { at: now, result: errorResult, nextAllowedAt: 0 });
      return decorateResult(errorResult, { receivedAt: now });
    }

    await writeCacheEntry(resolvedCacheFile, key, { at: now, result, nextAllowedAt: 0 });
    if (result.unlimited) {
      return { ...result, status: "ok", unlimited: true, window, receivedAt: now };
    }
    return decorateResult(result, { receivedAt: now });
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, pendingFetch);
  return pendingFetch;
}

// Read one result for each resolved account of a provider. When no named
// Anthropic profiles or OpenAI store exists, returns the single account chosen
// by resolveQuotaAccount(). Each result also carries the compatibility fields
// { accountId, accountLabel, isActive }. Reads sequentially to avoid a request burst.
export async function readAccountsWeekly({
  provider,
  providerId = provider,
  window = "Weekly",
  timeoutMs = 20000,
  cacheTtlMs = 60000,
  rateLimitBackoffMs = 300000,
  maxRateLimitBackoffMs = 600000,
  noBaselineRateLimitBackoffMs = 60000,
  minRefreshIntervalMs = 120000,
  cacheFile = undefined,
  accountsFile = undefined,
  credentialSource = "auto",
  anthropicProfileDirs = undefined,
  openaiAccountsFile = undefined,
} = {}) {
  const options = {
    provider, providerId, window, timeoutMs, cacheTtlMs, rateLimitBackoffMs, maxRateLimitBackoffMs,
    noBaselineRateLimitBackoffMs, minRefreshIntervalMs, cacheFile, accountsFile, credentialSource, anthropicProfileDirs, openaiAccountsFile,
  };
  const accounts = await listQuotaAccounts(options);
  const results = [];
  for (const account of accounts) {
    const result = await readWeekly({ ...options, account });
    results.push({
      ...result,
      accountId: account.accountKey,
      accountLabel: account.label,
      isActive: account.isActive,
    });
  }
  return results;
}

// Pure helpers exposed for unit testing (not part of the stable public API).
export const __internals = {
  classifyError, parseAnthropicUsage, mapAnthropicWindow, extractAuthBoolean,
  mapOpenAIWindow, parseJwt, firstNumeric, extractClaudeCredToken,
  parseRetryAfterMs, quotaCachePath, resolveCacheFile, pickOpenAIWindow,
  opencodeConfigDir, multiAccountAccountsPath, readMultiAccountActive,
  readOpenCodeAnthropicAuth, hashAccountToken, resolveAnthropicCredential,
  anthropicUsageViaToken, isMultiAccountManaged, writeCacheEntry,
  __resetMultiAccountSticky,
};
