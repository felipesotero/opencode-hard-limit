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
// When quota cannot be read due to an auth/token error the call is allowed
// by default (blockOnAuthError: false) and a throttled warning toast is shown.
//
// Configuration is resolved by ./lib/config.js with this precedence:
//   env var > project file > global file > built-in default.
// See README.md and `opencode-hard-limit --help` for details.

import { readWeekly, MONITORED_PROVIDERS } from "./lib/quota.js";
import { resolveConfig } from "./lib/config.js";
import { resolveQuotaProvider, evaluate } from "./lib/evaluate.js";

const cache = new Map(); // "quotaProvider:window" -> { at, result, ttl }
const inflight = new Map(); // "quotaProvider:window" -> Promise (dedupe concurrent checks)
const lastWarnAt = new Map(); // quotaProvider -> timestamp of last warning toast
const ERROR_TTL_CAP_MS = 10000; // don't pin a transient failure for the full TTL

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

export const QuotaHardStopPlugin = async ({ directory, client } = {}) => {
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
      const { block, reason } = evaluate(quotaProvider, res, cfg);

      if (block) {
        let blockMsg;
        if (reason === "below-threshold") {
          blockMsg =
            `quota ${res.remaining}% remaining is below the ${cfg.minRemaining}% threshold. ` +
            `Raise your budget: opencode-hard-limit set --threshold <lower> --global ` +
            `(or OPENCODE_QUOTA_MIN_REMAINING=<lower>).`;
        } else if (reason === "unreadable") {
          blockMsg =
            `quota data is unreadable (percentRemaining missing). ` +
            `Set OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR=0 to allow calls when quota cannot be read.`;
        } else {
          const lastColon = reason.lastIndexOf(":");
          const humanReason = lastColon >= 0 ? reason.slice(lastColon + 1) : reason;
          const isAuth = reason.startsWith("auth-error:");
          blockMsg = isAuth
            ? `quota could not be read (${humanReason}). ` +
              `Refresh your provider login or set OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR=0 to allow.`
            : `quota check failed (${humanReason}). ` +
              `Set OPENCODE_QUOTA_BLOCK_ON_ERROR=0 to allow when quota cannot be checked.`;
        }
        throw new Error(
          `[quota-hard-stop] Blocked ${providerId} (${quotaProvider}): ${blockMsg}`,
        );
      }

      // Throttled warning toast when quota is unreadable but the call is allowed.
      if (
        reason.startsWith("auth-error-allowed:") ||
        reason === "unreadable-allowed" ||
        reason.startsWith("error-allowed:")
      ) {
        const now = Date.now();
        if (now - (lastWarnAt.get(quotaProvider) ?? 0) >= cfg.cacheTtlMs) {
          lastWarnAt.set(quotaProvider, now);
          try {
            const providerEntry = MONITORED_PROVIDERS.find((p) => p.id === quotaProvider);
            const label = providerEntry?.label ?? quotaProvider;
            const lastColon = reason.lastIndexOf(":");
            const humanReason = lastColon >= 0 ? reason.slice(lastColon + 1) : "unreadable";
            let toastMsg;
            if (reason.startsWith("auth-error-allowed:")) {
              toastMsg =
                `${label} quota unreadable (${humanReason}). ` +
                `Allowing call; refresh provider login to restore monitoring.`;
            } else if (reason === "unreadable-allowed") {
              toastMsg = `${label} quota data unreadable. Allowing call.`;
            } else {
              toastMsg =
                `${label} quota check failed (${humanReason}). Allowing call.`;
            }
            client?.tui?.showToast({ body: { message: toastMsg, variant: "warning" } });
          } catch {
            // toast failure must not affect model call flow
          }
        }
      }
    },
  };
};

export default QuotaHardStopPlugin;
