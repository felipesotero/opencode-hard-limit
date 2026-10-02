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
 * Stable identity for a credentials file: the OAuth refresh token, which is
 * per-login and survives access-token rotation. Returns null when the file is
 * unreadable, malformed, or carries no refresh token — callers must then treat
 * the account as unique rather than silently dropping it. Never throws and
 * never returns anything derived from the token beyond the token itself (used
 * only as an in-memory Set key, never logged).
 */
function credentialIdentity(credentialsPath) {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const token = parsed?.claudeAiOauth?.refreshToken;
    return typeof token === "string" && token.trim() ? token : null;
  } catch {
    return null;
  }
}

/**
 * Discover Anthropic (Claude) accounts by scanning known profile
 * directories for a `.credentials.json` file.
 *
 * Options:
 *   profileDirs - explicit list of directories to check, overriding the
 *                 default convention below.
 *
 * By convention this reads ~/.claude-profiles/*, and falls back to the bare
 * ~/.claude only when those yield no account — ~/.claude is the single-account
 * setup's store, not an extra account alongside named profiles.
 *
 * Returns an array of { id, label, credentialsPath, configDir }, ordered by
 * directory name. Dirs whose credentials carry a refresh token already seen
 * are skipped, so a copied profile does not become a second account. Never
 * throws; returns [] when nothing is found. `id` is stable and derived from the directory
 * name (e.g. "pro", "max", "default") so it can be used as a cache key and
 * matched against an OpenCode provider id via evaluate.js's
 * resolveAnthropicProfileSlug().
 */
export function discoverAnthropicAccounts({ profileDirs } = {}) {
  if (Array.isArray(profileDirs) && profileDirs.length > 0) return collectAnthropicAccounts(profileDirs);

  const accounts = collectAnthropicAccounts(defaultAnthropicProfileDirs());
  if (accounts.length > 0) return accounts;
  // The bare ~/.claude dir is the single-account fallback, not an extra
  // account: once named profiles exist, @openchamber/opencode-claude pins every
  // instance to one of them and ~/.claude is a leftover login nothing routes
  // to. Polling it anyway spends the usage endpoint's per-account rate limit on
  // a quota no model call consumes — enough to earn a 429 and a long
  // Retry-After for the profiles that do matter. Note this keys off accounts
  // found, not dirs scanned: ~/.claude-profiles holds non-profile entries like
  // a stray `pro.lock` directory, which must not pass for a real profile.
  return collectAnthropicAccounts([join(homedir(), ".claude")]);
}

function collectAnthropicAccounts(dirs) {
  const seen = new Set();
  const seenIdentities = new Set();
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
    // Two dirs can also hold the very same login (a copied profile). Polling
    // both spends the usage endpoint's rate limit on one subscription and
    // invites a 429, so keep only the first one in dir order.
    const identity = credentialIdentity(credentialsPath);
    if (identity !== null) {
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
    }
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
