// lib/accounts.js
//
// Multi-account discovery for opencode-hard-limit.
//
// Optional, convention-based integration with two other OpenCode plugins the
// user may have installed — no npm dependency on either, just reading their
// on-disk storage format if present. Both discovery functions are best-effort
// and NEVER throw: any account store that's missing, unreadable, or
// malformed simply yields no accounts, so callers fall back to the
// pre-existing single-account behavior.
//
//   Anthropic (Claude): @openchamber/opencode-claude supports running
//     multiple isolated Claude Code CLI logins by registering separate
//     plugin instances, each pinned to its own CLAUDE_CONFIG_DIR profile
//     directory (e.g. ~/.claude-profiles/pro, ~/.claude-profiles/max). Each
//     profile dir holds a standard `.credentials.json` in the same shape the
//     vanilla `claude` CLI writes to ~/.claude/.credentials.json.
//
//   OpenAI (Codex/ChatGPT): oc-codex-multi-auth keeps every logged-in
//     account in one JSON store (default
//     ~/.opencode/oc-codex-multi-auth-accounts.json) with an `activeIndex`
//     pointing at the account currently in use.
//
// Self-contained on purpose (only Node>=18 builtins), matching lib/quota.js's
// deploy-set constraint: this file is copied alongside quota.js/config.js
// into the sidebar's plugins/lib/ directory (see lib/deploy.js).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function defaultAnthropicProfileDirs() {
  const dirs = [];
  const profilesRoot = join(homedir(), ".claude-profiles");
  try {
    if (existsSync(profilesRoot) && statSync(profilesRoot).isDirectory()) {
      for (const name of readdirSync(profilesRoot).sort()) {
        const dir = join(profilesRoot, name);
        try {
          if (statSync(dir).isDirectory()) dirs.push(dir);
        } catch {
          // skip unreadable entries
        }
      }
    }
  } catch {
    // profiles root missing or unreadable -> no extra profiles
  }
  // Always also consider the bare default ~/.claude dir, added last, so it
  // acts as a genuine extra/fallback account rather than shadowing named
  // profiles when both exist.
  dirs.push(join(homedir(), ".claude"));
  return dirs;
}

function baseName(dir) {
  const parts = String(dir).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "default";
}

function labelForProfileDir(dir) {
  const base = baseName(dir);
  if (base === ".claude") return "Claude (default)";
  return `Claude ${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

function slugForProfileDir(dir) {
  const base = baseName(dir);
  return base === ".claude" ? "default" : base;
}

/**
 * Discover Anthropic (Claude) accounts by scanning known profile
 * directories for a `.credentials.json` file.
 *
 * Options:
 *   profileDirs - explicit list of directories to check, overriding the
 *                 default ~/.claude-profiles/* + ~/.claude convention.
 *
 * Returns an array of { id, label, credentialsPath, configDir }, ordered by
 * directory name (profiles before the bare default). Never throws; returns
 * [] when nothing is found. `id` is stable and derived from the directory
 * name (e.g. "pro", "max", "default") so it can be used as a cache key and
 * matched against an OpenCode provider id via evaluate.js's
 * resolveAnthropicProfileSlug().
 */
export function discoverAnthropicAccounts({ profileDirs } = {}) {
  const dirs =
    Array.isArray(profileDirs) && profileDirs.length > 0 ? profileDirs : defaultAnthropicProfileDirs();

  const seen = new Set();
  const accounts = [];
  for (const dir of dirs) {
    if (!dir || typeof dir !== "string") continue;
    const credentialsPath = join(dir, ".credentials.json");
    try {
      if (!existsSync(credentialsPath) || !statSync(credentialsPath).isFile()) continue;
    } catch {
      continue;
    }
    if (seen.has(credentialsPath)) continue;
    seen.add(credentialsPath);
    accounts.push({
      id: slugForProfileDir(dir),
      label: labelForProfileDir(dir),
      credentialsPath,
      configDir: dir,
    });
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function defaultOpenAIAccountsFile() {
  return join(homedir(), ".opencode", "oc-codex-multi-auth-accounts.json");
}

function planLabel(account, index) {
  const who = (typeof account.email === "string" && account.email.trim()) || `OpenAI #${index + 1}`;
  return account.planType ? `${who} (${account.planType})` : who;
}

/**
 * Discover OpenAI (Codex/ChatGPT) accounts from an oc-codex-multi-auth-style
 * account store.
 *
 * Options:
 *   accountsFile - explicit path override (default:
 *                  ~/.opencode/oc-codex-multi-auth-accounts.json).
 *
 * Returns an array of { id, label, accessToken, accountId, expiresAt,
 * isActive } — one entry per account with a usable access token — or null
 * when no such store is found/readable/well-formed (signal: fall back to
 * the pre-existing single-account behavior via OpenCode's own auth.json).
 * Never throws.
 */
export function discoverOpenAIAccounts({ accountsFile } = {}) {
  const path = accountsFile || defaultOpenAIAccountsFile();
  let raw;
  try {
    if (!existsSync(path)) return null;
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    return null;
  }

  const activeIndex = Number.isInteger(raw.activeIndex) ? raw.activeIndex : 0;

  const accounts = raw.accounts
    .map((account, index) => {
      if (!account || typeof account !== "object") return null;
      const accessToken = typeof account.accessToken === "string" ? account.accessToken.trim() : "";
      if (!accessToken) return null;
      const accountId = typeof account.accountId === "string" && account.accountId ? account.accountId : null;
      return {
        id: accountId || `openai-${index}`,
        label: planLabel(account, index),
        accessToken,
        // The ChatGPT-Account-Id header value — same field the plugin's own
        // JWT-claim extraction (lib/quota.js's fetchOpenAI) resolves for the
        // single-account case.
        accountId,
        expiresAt: typeof account.expiresAt === "number" ? account.expiresAt : null,
        isActive: index === activeIndex,
      };
    })
    .filter(Boolean);

  return accounts.length > 0 ? accounts : null;
}
