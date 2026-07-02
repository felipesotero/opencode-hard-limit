// quota-hard-stop.js
//
// OpenCode plugin: hard stop model calls when the WEEKLY AI quota for a
// provider drops below a configurable "percent remaining" threshold.
//
// It shells out to the `@slkiser/opencode-quota` CLI, reads the JSON, filters
// the `Weekly` window entry, and throws (aborting the model call) when the
// remaining percentage is below the threshold.
//
// Configuration is resolved by ./lib/config.js with this precedence:
//   env var > project file > global file > built-in default.
// See README.md and `opencode-hard-limit --help` for details.

import { execFile } from "node:child_process";
import { resolveConfig } from "./lib/config.js";

const cache = new Map(); // quotaProvider -> { at, result, ttl }
const inflight = new Map(); // quotaProvider -> Promise (dedupe concurrent checks)
const ERROR_TTL_CAP_MS = 10000; // don't pin a transient failure for the full TTL

// Map an OpenCode provider id to a quota CLI provider id.
// Returns null for providers we do not monitor (plugin then no-ops).
export function resolveQuotaProvider(id) {
  if (!id) return null;
  const v = String(id).toLowerCase();
  if (v.includes("anthropic") || v.includes("claude")) return "anthropic";
  if (v.includes("openai") || v.includes("codex")) return "openai";
  return null;
}

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
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result;

  let pending = inflight.get(provider);
  if (!pending) {
    pending = runQuota(provider, cfg.timeoutMs)
      .then((result) => {
        // Timestamp AFTER the call returns, so a slow check doesn't shorten
        // the effective TTL. Cache failures for a shorter window.
        const ttl = result.ok
          ? cfg.cacheTtlMs
          : Math.min(cfg.cacheTtlMs, ERROR_TTL_CAP_MS);
        cache.set(provider, { at: Date.now(), result, ttl });
        inflight.delete(provider);
        return result;
      })
      .catch((err) => {
        inflight.delete(provider);
        throw err;
      });
    inflight.set(provider, pending);
  }
  return pending;
}

// Decide whether to block. Returns { block: boolean, message: string }.
export function evaluate(quotaProvider, res, cfg) {
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

export const QuotaHardStopPlugin = async ({ directory } = {}) => {
  return {
    "chat.params": async (input) => {
      const cfg = resolveConfig({ projectDir: directory }).values;

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
            `Raise your budget with: opencode-hard-limit set --threshold <lower> --global ` +
            `(or OPENCODE_QUOTA_MIN_REMAINING=<lower>). ` +
            `To allow when quota can't be checked: OPENCODE_QUOTA_BLOCK_ON_ERROR=0.`,
        );
      }
    },
  };
};

export default QuotaHardStopPlugin;
