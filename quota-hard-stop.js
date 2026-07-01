// quota-hard-stop.js
//
// OpenCode plugin: hard stop model calls when the WEEKLY AI quota for a
// provider drops below a configurable "percent remaining" threshold.
//
// It shells out to the `@slkiser/opencode-quota` CLI, reads the JSON, filters
// the `Weekly` window entry, and throws (aborting the model call) when the
// remaining percentage is below the threshold.
//
// Config via environment variables:
//   OPENCODE_QUOTA_MIN_REMAINING   Minimum weekly % remaining to allow a call.
//                                  Default: 30 (i.e. block once >70% is used).
//   OPENCODE_QUOTA_BLOCK_ON_ERROR  "1" (default) blocks when the quota cannot
//                                  be verified (timeout, error, bad JSON, no
//                                  Weekly window). "0" fails open (allows).
//   OPENCODE_QUOTA_CACHE_TTL_MS    In-memory cache TTL per provider to avoid
//                                  spawning the CLI on every turn. Default 60000.
//   OPENCODE_QUOTA_TIMEOUT_MS      Max time to wait for the CLI. Default 20000.

import { execFile } from "node:child_process";

function numberEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

// Map an OpenCode provider id to a quota CLI provider id.
// Returns null for providers we do not monitor (plugin then no-ops).
function resolveQuotaProvider(id) {
  if (!id) return null;
  const v = String(id).toLowerCase();
  if (v.includes("anthropic") || v.includes("claude")) return "anthropic";
  if (v.includes("openai") || v.includes("codex")) return "openai";
  return null;
}

const cache = new Map(); // quotaProvider -> { at, result }

function runQuota(provider, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["-y", "@slkiser/opencode-quota", "show", "--json", "--provider", provider],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, reason: `cli-failed: ${err.message}` });
          return;
        }
        try {
          resolve({ ok: true, parsed: JSON.parse(stdout) });
        } catch {
          resolve({ ok: false, reason: "invalid-json" });
        }
      },
    );
  });
}

async function getQuota(provider, cfg) {
  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && now - cached.at < cfg.cacheTtlMs) return cached.result;
  const result = await runQuota(provider, cfg.timeoutMs);
  cache.set(provider, { at: now, result });
  return result;
}

// Decide whether to block. Returns { block: boolean, message: string }.
function evaluate(quotaProvider, res, cfg) {
  if (!res.ok) {
    return { block: cfg.blockOnError, message: `quota check failed (${res.reason})` };
  }
  const node = res.parsed?.providers?.[quotaProvider];
  if (!node) {
    return { block: cfg.blockOnError, message: "no provider data in response" };
  }
  if (node.status !== "ok") {
    return { block: cfg.blockOnError, message: `provider status: ${node.status}` };
  }
  const entries = Array.isArray(node.entries) ? node.entries : [];
  const weekly = entries.find((e) => e && e.window === "Weekly");
  if (!weekly) {
    return { block: cfg.blockOnError, message: "no Weekly window entry" };
  }
  if (weekly.unlimited) {
    return { block: false, message: "weekly quota unlimited" };
  }
  const remaining = Number(weekly.percentRemaining);
  if (!Number.isFinite(remaining)) {
    return { block: cfg.blockOnError, message: "no numeric percentRemaining" };
  }
  if (remaining < cfg.minRemaining) {
    return {
      block: true,
      message: `weekly quota ${remaining}% remaining < ${cfg.minRemaining}% threshold`,
    };
  }
  return { block: false, message: `weekly quota ${remaining}% remaining` };
}

export const QuotaHardStopPlugin = async () => {
  return {
    "chat.params": async (input) => {
      const cfg = {
        minRemaining: numberEnv("OPENCODE_QUOTA_MIN_REMAINING", 30),
        blockOnError: boolEnv("OPENCODE_QUOTA_BLOCK_ON_ERROR", true),
        cacheTtlMs: numberEnv("OPENCODE_QUOTA_CACHE_TTL_MS", 60000),
        timeoutMs: numberEnv("OPENCODE_QUOTA_TIMEOUT_MS", 20000),
      };

      const providerId =
        input?.provider?.info?.id ??
        input?.model?.providerID ??
        input?.model?.provider;

      const quotaProvider = resolveQuotaProvider(providerId);
      if (!quotaProvider) return; // provider not monitored -> allow

      const res = await getQuota(quotaProvider, cfg);
      const { block, message } = evaluate(quotaProvider, res, cfg);

      if (block) {
        throw new Error(
          `[quota-hard-stop] Blocked ${providerId} (${quotaProvider}): ${message}. ` +
            `Override with OPENCODE_QUOTA_MIN_REMAINING=<lower> or ` +
            `OPENCODE_QUOTA_BLOCK_ON_ERROR=0.`,
        );
      }
    },
  };
};

export default QuotaHardStopPlugin;
