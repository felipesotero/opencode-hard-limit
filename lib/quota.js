// lib/quota.js
//
// Shared quota-reading module for opencode-hard-limit.
//
// Exports MONITORED_PROVIDERS and readWeekly(), which shells out to the
// @slkiser/opencode-quota CLI and returns a normalized quota-entry result
// for the requested window ('5h' or 'Weekly').
// Used by both the server plugin (quota-hard-stop.js) and any TUI widget.

import { execFile } from "node:child_process";

// Providers this package knows how to monitor.
export const MONITORED_PROVIDERS = [
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Codex" },
];

// Classify a quota error string into a broad kind for routing in evaluate().
// Returns 'auth' | 'timeout' | 'unreadable'.
function classifyError(text) {
  const t = String(text).toLowerCase();
  if (/expired|token|auth|unauthor|not detected|undetected|unavailable|login|sign in|signed out|credential|forbidden|401|403/.test(t)) {
    return "auth";
  }
  if (/timeout|timed out|etimedout/.test(t)) {
    return "timeout";
  }
  return "unreadable";
}

// Read a quota entry for a given provider and window.
//
// Options:
//   provider   - quota CLI provider id ("anthropic" | "openai")
//   window     - quota window to filter ("5h" | "Weekly", default "Weekly")
//   timeoutMs  - child-process timeout in ms (default 20000)
//
// Returns (always resolves, never throws):
//   {
//     ok: boolean,
//     status: 'ok' | 'error',
//     remaining: number | null,   // percentRemaining when ok, else null
//     resetAt: string | null,
//     unlimited: boolean,
//     window: string,             // the requested window value
//     error?: string,             // short reason string when ok===false
//     errorKind?: 'auth' | 'timeout' | 'unreadable' | 'unknown',
//   }
export async function readWeekly({ provider, window = "Weekly", timeoutMs = 20000 }) {
  // Spawn the CLI.
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execFile(
        "npx",
        ["-y", "@slkiser/opencode-quota", "show", "--json", "--provider", provider],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, out) => {
          if (err && !out) reject(err);
          else resolve(out);
        },
      );
    });
  } catch (err) {
    const errorKind =
      err.killed || /timeout|timed out|etimedout/i.test(err.message) ? "timeout" : "unknown";
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error: `cli-failed: ${err.message}`,
      errorKind,
    };
  }

  // Parse JSON.
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error: "invalid-json",
      errorKind: "unreadable",
    };
  }

  // Locate provider node.
  const node = parsed?.providers?.[provider];
  if (!node) {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error: "no provider data in response",
      errorKind: "unreadable",
    };
  }
  if (node.status !== "ok") {
    // Prefer the real error message from the provider node when present.
    const error =
      typeof node.error === "string" && node.error.trim()
        ? node.error
        : `provider status: ${node.status}`;
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error,
      errorKind: classifyError(error),
    };
  }

  // Find the requested window entry.
  const entries = Array.isArray(node.entries) ? node.entries : [];
  const entry = entries.find((e) => e && e.window === window);
  if (!entry) {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error: `no ${window} window entry`,
      errorKind: "unreadable",
    };
  }

  const resetAt = entry.resetAt ?? null;

  if (entry.unlimited) {
    return { ok: true, status: "ok", remaining: null, resetAt, unlimited: true, window };
  }

  const remaining = Number(entry.percentRemaining);
  if (!Number.isFinite(remaining)) {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      window,
      error: "no numeric percentRemaining",
      errorKind: "unreadable",
    };
  }

  return { ok: true, status: "ok", remaining, resetAt, unlimited: false, window };
}
