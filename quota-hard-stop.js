// quota-hard-stop.js
//
// OpenCode plugin: hard stop model calls when the quota for a provider's
// configured window ('5h' or 'Weekly') drops below a configurable
// "percent remaining" threshold.
//
// It shells out to the `@slkiser/opencode-quota` CLI via lib/quota.js,
// reads the JSON, filters the configured window entry, and throws (aborting
// the model call) when the remaining percentage is below the threshold.
//
// Configuration is resolved by ./lib/config.js with this precedence:
//   env var > project file > global file > built-in default.
// See README.md and `opencode-hard-limit --help` for details.

import { readWeekly } from "./lib/quota.js";
import { resolveConfig } from "./lib/config.js";

const cache = new Map(); // "quotaProvider:window" -> { at, result, ttl }
const inflight = new Map(); // "quotaProvider:window" -> Promise (dedupe concurrent checks)
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

async function getQuota(provider, cfg) {
  const quotaWindow = cfg.window || "Weekly";
  const cacheKey = `${provider}:${quotaWindow}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.result;

  let pending = inflight.get(cacheKey);
  if (!pending) {
    pending = readWeekly({ provider, window: quotaWindow, timeoutMs: cfg.timeoutMs })
      .then((result) => {
        // Timestamp AFTER the call returns, so a slow check doesn't shorten
        // the effective TTL. Cache failures for a shorter window.
        const ttl = result.ok
          ? cfg.cacheTtlMs
          : Math.min(cfg.cacheTtlMs, ERROR_TTL_CAP_MS);
        cache.set(cacheKey, { at: Date.now(), result, ttl });
        inflight.delete(cacheKey);
        return result;
      })
      .catch((err) => {
        inflight.delete(cacheKey);
        throw err;
      });
    inflight.set(cacheKey, pending);
  }
  return pending;
}

// Decide whether to block. Returns { block: boolean, message: string }.
// Consumes the normalized result returned by readWeekly() in lib/quota.js.
// quotaProvider is kept in the signature for backward compatibility.
export function evaluate(_quotaProvider, res, cfg) {
  if (!res.ok) {
    return { block: cfg.blockOnError, message: `quota check failed (${res.error})` };
  }
  if (res.unlimited) {
    return { block: false, message: "weekly quota unlimited" };
  }
  const remaining = res.remaining;
  if (remaining === null || !Number.isFinite(Number(remaining))) {
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
