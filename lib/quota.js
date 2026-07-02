// lib/quota.js
//
// Shared quota-reading module for opencode-hard-limit.
//
// Exports MONITORED_PROVIDERS and readWeekly(), which shells out to the
// @slkiser/opencode-quota CLI and returns a normalized Weekly-entry result.
// Used by both the server plugin (quota-hard-stop.js) and any TUI widget.

import { execFile } from "node:child_process";

// Providers this package knows how to monitor.
export const MONITORED_PROVIDERS = [
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Codex" },
];

// Read the Weekly quota entry for a given provider.
//
// Options:
//   provider   - quota CLI provider id ("anthropic" | "openai")
//   timeoutMs  - child-process timeout in ms (default 20000)
//
// Returns (always resolves, never throws):
//   {
//     ok: boolean,
//     status: 'ok' | 'error',
//     remaining: number | null,   // percentRemaining when ok, else null
//     resetAt: string | null,
//     unlimited: boolean,
//     error?: string,             // short reason string when ok===false
//   }
export async function readWeekly({ provider, timeoutMs = 20000 }) {
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
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      error: `cli-failed: ${err.message}`,
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
      error: "invalid-json",
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
      error: "no provider data in response",
    };
  }
  if (node.status !== "ok") {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      error: `provider status: ${node.status}`,
    };
  }

  // Find the Weekly entry.
  const entries = Array.isArray(node.entries) ? node.entries : [];
  const weekly = entries.find((e) => e && e.window === "Weekly");
  if (!weekly) {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      error: "no Weekly window entry",
    };
  }

  const resetAt = weekly.resetAt ?? null;

  if (weekly.unlimited) {
    return { ok: true, status: "ok", remaining: null, resetAt, unlimited: true };
  }

  const remaining = Number(weekly.percentRemaining);
  if (!Number.isFinite(remaining)) {
    return {
      ok: false,
      status: "error",
      remaining: null,
      resetAt: null,
      unlimited: false,
      error: "no numeric percentRemaining",
    };
  }

  return { ok: true, status: "ok", remaining, resetAt, unlimited: false };
}
