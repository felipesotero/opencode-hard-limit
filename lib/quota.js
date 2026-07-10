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
//   OpenAI    (Codex):  read OpenCode's OAuth token from auth.json and call the
//                       ChatGPT usage endpoint (chatgpt.com/backend-api/wham/usage).
//
// Used by both the server plugin (quota-hard-stop.js) and the TUI sidebar.
// Self-contained on purpose: only Node>=18 builtins + global fetch, no relative
// imports, so the sidebar's plugins/lib deploy set {quota.js, config.js} is enough.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Providers this package knows how to monitor.
export const MONITORED_PROVIDERS = [
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Codex" },
];

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
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null */
    }
    return { ok: res.ok, status: res.status, json, bodySnippet: text.slice(0, 120), timedOut: false };
  } catch (err) {
    return { ok: false, status: 0, json: null, bodySnippet: "", timedOut: err?.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
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
    if (fhRaw == null || sdRaw == null) continue;
    const five_hour = mapAnthropicWindow(fhRaw);
    const seven_day = mapAnthropicWindow(sdRaw);
    if (five_hour && seven_day) return { five_hour, seven_day };
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

async function fetchAnthropic({ window, timeoutMs }) {
  const key = window === "5h" ? "five_hour" : "seven_day";

  const bin = await resolveClaudeBinary();
  let authenticated = false;
  if (bin) {
    const cli = await anthropicViaCli(bin);
    authenticated = cli.authenticated;
    if (cli.windows && cli.windows[key]) {
      return buildOk(cli.windows[key], window);
    }
  }

  // HTTP OAuth fallback (CLI absent, unauthenticated, or exposing no windows).
  const token = await readClaudeToken();
  if (!token) {
    return {
      ok: false,
      error: bin
        ? "unavailable (claude authenticated but exposes no quota windows)"
        : "claude CLI not found or not authenticated",
    };
  }
  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    timeoutMs,
  );
  if (res.timedOut) return { ok: false, error: "timeout: anthropic usage request", errorKind: "timeout" };
  if (!res.ok) {
    const error = `Anthropic API error ${res.status}: ${res.bodySnippet}`;
    return { ok: false, error, errorKind: res.status === 429 ? "ratelimit" : undefined };
  }
  const windows = res.json ? parseAnthropicUsage(res.json) : null;
  if (!windows) return { ok: false, error: "unexpected Anthropic quota response shape" };
  if (!windows[key]) return { ok: false, error: `no ${window} window entry` };
  return buildOk(windows[key], window);
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

async function fetchOpenAI({ window, timeoutMs }) {
  const auth = await readOpenAIAuth();
  if (!auth) return { ok: false, error: "OpenAI OAuth token not detected" };
  if (auth.expiresAt && auth.expiresAt < Date.now()) return { ok: false, error: "token expired" };

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "OpenCode-Quota-Toast/1.0",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers, timeoutMs);
  if (res.timedOut) return { ok: false, error: "timeout: openai usage request", errorKind: "timeout" };
  if (!res.ok) {
    const error = `OpenAI API error ${res.status}: ${res.bodySnippet}`;
    return { ok: false, error, errorKind: res.status === 429 ? "ratelimit" : undefined };
  }

  const primary = res.json?.rate_limit?.primary_window;
  if (!primary) return { ok: false, error: "no quota data" };
  const raw = window === "5h" ? primary : (res.json?.rate_limit?.secondary_window ?? null);
  if (!raw) return { ok: false, error: `no ${window} window entry` };
  const mapped = mapOpenAIWindow(raw);
  if (!mapped) return { ok: false, error: `no numeric percent for ${window} window` };
  return buildOk(mapped, window);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildOk(mapped) {
  return { ok: true, remaining: mapped.percentRemaining, resetAt: mapped.resetTimeIso ?? null, unlimited: false };
}

// Read a quota entry for a given provider and window.
//
// Options:
//   provider   - "anthropic" | "openai"
//   window     - quota window to read ("5h" | "Weekly", default "Weekly")
//   timeoutMs  - network/child-process timeout in ms (default 20000)
//
// Returns (always resolves, never throws):
//   {
//     ok: boolean,
//     status: 'ok' | 'error',
//     remaining: number | null,   // percentRemaining when ok, else null
//     resetAt: string | null,
//     unlimited: boolean,
//     window: string,             // the requested window value, echoed back
//     error?: string,             // short reason string when ok===false
//     errorKind?: 'auth' | 'timeout' | 'ratelimit' | 'unreadable' | 'unknown',
//   }
export async function readWeekly({ provider, window = "Weekly", timeoutMs = 20000 }) {
  const fail = (error, errorKind) => ({
    ok: false, status: "error", remaining: null, resetAt: null,
    unlimited: false, window, error, errorKind: errorKind ?? classifyError(error),
  });

  let result;
  try {
    if (provider === "anthropic") {
      result = await fetchAnthropic({ window, timeoutMs });
    } else if (provider === "openai") {
      result = await fetchOpenAI({ window, timeoutMs });
    } else {
      return fail(`unknown provider: ${provider}`, "unknown");
    }
  } catch (err) {
    return fail(`fetch-failed: ${err?.message || err}`, "unknown");
  }

  if (!result || result.ok !== true) {
    return fail(result?.error || "unreadable", result?.errorKind);
  }
  if (result.unlimited) {
    return { ok: true, status: "ok", remaining: null, resetAt: result.resetAt ?? null, unlimited: true, window };
  }
  return { ok: true, status: "ok", remaining: result.remaining, resetAt: result.resetAt ?? null, unlimited: false, window };
}

// Pure helpers exposed for unit testing (not part of the stable public API).
export const __internals = {
  classifyError, parseAnthropicUsage, mapAnthropicWindow, extractAuthBoolean,
  mapOpenAIWindow, parseJwt, firstNumeric, extractClaudeCredToken,
};
