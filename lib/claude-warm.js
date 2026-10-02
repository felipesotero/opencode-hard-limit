// lib/claude-warm.js
//
// Forces one real, minimal, authenticated call through the official `claude`
// CLI per discovered Anthropic profile (see lib/accounts.js), so each
// profile's OAuth access token gets refreshed even when nothing in OpenCode
// is actually using that profile's model.
//
// Why this is needed: lib/quota.js's readWeekly()/readAccountsWeekly() read
// the access token straight out of .credentials.json and call the usage API
// directly -- there is no OAuth refresh call anywhere in that path. An
// expired access token there just yields a 401 ("unavailable"), forever,
// until *something* makes a real call through the `claude` CLI, whose own
// OAuth client transparently refreshes an expired/near-expiry access token
// and rewrites .credentials.json as a side effect -- the same thing normal
// use of that profile would do.
//
// Deliberately NOT part of the sidebar's deploy set (lib/deploy.js's
// SIDEBAR_LIB_FILES): warming is a CLI-only command (`opencode-hard-limit
// warm`), not something the TUI sidebar polls on its own.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAnthropicAccounts } from "./accounts.js";

// Haiku: the cheapest model in the catalog, so a warm call consumes the
// smallest possible slice of the subscription's rate-limit window.
export const DEFAULT_WARM_MODEL = "haiku";
export const DEFAULT_WARM_PROMPT = "Reply with just: ok";
export const DEFAULT_WARM_TIMEOUT_MS = 30_000;

// Dropped from the child env so the CLI exclusively uses the profile's OAuth
// login (matches @openchamber/opencode-claude's own auth-env.js convention).
const AUTH_OVERRIDE_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

// A bare "ok"-style reply never needs any of these; disallowing them keeps
// the call a single untooled turn (lowest possible cost) and removes any
// chance of the CLI wandering into a tool call that spends real quota.
const DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task",
  "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite",
];

function buildEnv(configDir, baseEnv) {
  const env = { ...baseEnv, CLAUDE_CONFIG_DIR: configDir };
  for (const key of AUTH_OVERRIDE_ENV_KEYS) delete env[key];
  return env;
}

/**
 * Resolve the `claude` CLI binary: PATH first, then the install locations a
 * clean/non-login-shell environment commonly misses. Returns null when not
 * found. Never throws.
 */
export function findClaudeBinary(env = process.env, { spawnSyncFn = spawnSync } = {}) {
  const probe = (candidate) => {
    try {
      const result = spawnSyncFn(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return !result.error && (result.status === 0 || Boolean((result.stdout || "").trim()));
    } catch {
      return false;
    }
  };

  if (probe("claude")) return "claude";

  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  const fallback = join(home, ".local", "bin", "claude");
  if (existsSync(fallback) && probe(fallback)) return fallback;

  return null;
}

function runOne(account, { cliPath, model, prompt, timeoutMs, cwd, env, spawnFn }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ id: account.id, label: account.label, ...result });
    };

    let child;
    try {
      child = spawnFn(
        cliPath,
        [
          "-p", prompt,
          "--model", model,
          "--output-format", "json",
          "--disallowedTools", DISALLOWED_TOOLS.join(","),
        ],
        {
          cwd,
          env: buildEnv(account.configDir, env),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `warm timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.once("error", (err) => finish({ ok: false, error: err.message || String(err) }));
    child.once("exit", (code) => {
      if (code !== 0) {
        const lines = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean);
        finish({ ok: false, error: lines[lines.length - 1] || `exit code ${code ?? "unknown"}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        finish({ ok: true, costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null });
      } catch {
        finish({ ok: true, costUsd: null });
      }
    });
  });
}

/**
 * Warm every discovered Anthropic (Claude) profile with one minimal, real,
 * authenticated CLI call. Accounts are warmed sequentially (one `claude`
 * process at a time) to avoid competing for the same OAuth client state.
 *
 * Options:
 *   cliPath    - path to the `claude` binary (required; resolve with
 *                findClaudeBinary() first -- a missing CLI is the caller's
 *                concern, not something to re-probe per account here).
 *   model      - model alias/name to use (default: "haiku", the cheapest).
 *   prompt     - the prompt sent (default: a trivial fixed reply request).
 *   timeoutMs  - per-account spawn timeout (default: 30s).
 *   cwd        - working directory for the child process (default: a neutral
 *                tmp dir, so no project CLAUDE.md/hooks get pulled in).
 *   env        - base env to derive each child's env from (default: process.env).
 *   profileDirs - forwarded to discoverAnthropicAccounts() to override which
 *                 profile directories are scanned.
 *   spawnFn    - injectable `spawn`-like function, for tests.
 *
 * Returns one { id, label, ok, costUsd? | error } entry per discovered
 * account. Returns [] when cliPath is falsy or no accounts are discovered.
 * Never throws.
 */
export async function warmClaudeAccounts({
  cliPath,
  model = DEFAULT_WARM_MODEL,
  prompt = DEFAULT_WARM_PROMPT,
  timeoutMs = DEFAULT_WARM_TIMEOUT_MS,
  cwd = tmpdir(),
  env = process.env,
  profileDirs,
  spawnFn = spawn,
} = {}) {
  if (!cliPath) return [];
  const accounts = discoverAnthropicAccounts({ profileDirs });
  const results = [];
  for (const account of accounts) {
    results.push(await runOne(account, { cliPath, model, prompt, timeoutMs, cwd, env, spawnFn }));
  }
  return results;
}
