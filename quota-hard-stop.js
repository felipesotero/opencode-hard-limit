// quota-hard-stop.js
//
// OpenCode plugin: hard stop model calls when the quota for a provider's
// configured window ('5h' or 'Weekly') drops below a configurable
// "percent remaining" threshold.
//
// It reads quota natively via lib/quota.js (Anthropic: local `claude` CLI or
// the OAuth usage API; OpenAI: OpenCode auth.json + the ChatGPT usage endpoint),
// filters the configured window entry, and throws (aborting the model call)
// when the remaining percentage is below the threshold.
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
import { ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";

const cache = new Map(); // "quotaProvider:window" -> { at, result, ttl }
const inflight = new Map(); // "quotaProvider:window" -> Promise (dedupe concurrent checks)
const lastFetchAt = new Map(); // "quotaProvider:window" -> timestamp of last real fetch start
const nextAllowedFetchAt = new Map(); // "quotaProvider:window" -> backoff deadline after a 429
const lastWarnAt = new Map(); // quotaProvider -> timestamp of last warning toast
const seenKeys = new Set(); // tracked provider:window combos seen in chat.params
const ERROR_TTL_CAP_MS = 10000; // cap transient failures; stale entries can be background-refreshed
const RATE_LIMIT_RE = /(?:\b429\b|rate\s*limit)/i;
let quotaReader = readWeekly;

function cacheKey(provider, window) {
  return `${provider}:${window}`;
}

function getCached(provider, window) {
  return cache.get(cacheKey(provider, window))?.result ?? null;
}

function getCacheEntry(provider, window) {
  return cache.get(cacheKey(provider, window)) ?? null;
}

function isCacheFresh(entry) {
  return Boolean(entry && Date.now() - entry.at < entry.ttl);
}

function isRateLimitError(result) {
  return Boolean(!result?.ok && typeof result?.error === "string" && RATE_LIMIT_RE.test(result.error));
}

function parseSeenKey(key) {
  const i = key.indexOf(":");
  return i < 0 ? [key, "Weekly"] : [key.slice(0, i), key.slice(i + 1) || "Weekly"];
}

async function refreshQuota(provider, cfg, { window = cfg.window || "Weekly", force = false } = {}) {
  const quotaWindow = window || "Weekly";
  const key = cacheKey(provider, quotaWindow);
  const cached = cache.get(key);
  const now = Date.now();

  if (!force && cached && now - cached.at < cached.ttl) return cached.result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const lastStarted = lastFetchAt.get(key);
  const nextAllowed = nextAllowedFetchAt.get(key) ?? 0;
  if (!force && nextAllowed > now) {
    return cached?.result ?? null;
  }
  if (!force && lastStarted !== undefined && now - lastStarted < cfg.minRefreshIntervalMs) {
    return cached?.result ?? null;
  }

  lastFetchAt.set(key, now);

  const pendingFetch = quotaReader({ provider, window: quotaWindow, timeoutMs: cfg.timeoutMs })
    .then((result) => {
      const finishedAt = Date.now();
      const ttl = result.ok ? cfg.cacheTtlMs : Math.min(cfg.cacheTtlMs, ERROR_TTL_CAP_MS);

      if (result.ok) {
        cache.set(key, { at: finishedAt, result, ttl });
        nextAllowedFetchAt.delete(key);
      } else if (isRateLimitError(result)) {
        if (!cached) {
          cache.set(key, { at: finishedAt, result, ttl });
        }
        nextAllowedFetchAt.set(key, finishedAt + cfg.rateLimitBackoffMs);
      } else {
        cache.set(key, { at: finishedAt, result, ttl });
        nextAllowedFetchAt.delete(key);
      }

      return result;
    })
    .catch((err) => {
      const finishedAt = Date.now();
      lastFetchAt.set(key, finishedAt);
      nextAllowedFetchAt.delete(key);
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pendingFetch);
  return pendingFetch;
}

/** Extract the human-readable tail after the last ':' in reason, or return fallback. */
function humanReason(reason, fallback) {
  const i = reason.lastIndexOf(":");
  return i >= 0 ? reason.slice(i + 1) : fallback;
}

export const QuotaHardStopPlugin = async ({ directory, client } = {}) => {
  // Self-heal: ensure deployed sidebar matches the installed npm version.
  // ensureTuiDeployed never throws — outer try/catch is not needed.
  const { copied: sidebarUpdated } = ensureTuiDeployed();
  // Defer cleanupLegacyCopies to avoid racing opencode's plugins-dir autoloader.
  setTimeout(() => { try { cleanupLegacyCopies(); } catch {} }, 30_000).unref?.();
  if (sidebarUpdated) {
    // showToast returns a Promise; use .catch to prevent unhandled rejection.
    client?.tui?.showToast({
      body: { message: "hard-limit sidebar updated — restart to refresh", variant: "info" },
    })?.catch?.(() => {});
  }

  return {
    "chat.params": async (input) => {
      const cfg = resolveConfig({ projectDir: directory }).values;
      const quotaWindow = cfg.window || "Weekly";

      const providerId =
        input?.provider?.info?.id ??
        input?.model?.providerID ??
        input?.model?.provider;

      const quotaProvider = resolveQuotaProvider(providerId);
      if (!quotaProvider) return; // provider not monitored -> allow

      const key = cacheKey(quotaProvider, quotaWindow);
      seenKeys.add(key);

      const cachedEntry = getCacheEntry(quotaProvider, quotaWindow);
      let res;
      if (!cachedEntry) {
        res = await refreshQuota(quotaProvider, cfg, { window: quotaWindow, force: true });
      } else {
        res = cachedEntry.result;
        if (!isCacheFresh(cachedEntry)) {
          refreshQuota(quotaProvider, cfg, { window: quotaWindow }).catch(() => {});
        }
      }
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
          const hr = humanReason(reason, reason);
          const isAuth = reason.startsWith("auth-error:");
          blockMsg = isAuth
            ? `quota could not be read (${hr}). ` +
              `Refresh your provider login or set OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR=0 to allow.`
            : `quota check failed (${hr}). ` +
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
            const hr = humanReason(reason, "unreadable");
            let toastMsg;
            if (reason.startsWith("auth-error-allowed:")) {
              toastMsg =
                `${label} quota unreadable (${hr}). ` +
                `Allowing call; refresh provider login to restore monitoring.`;
            } else if (reason === "unreadable-allowed") {
              toastMsg = `${label} quota data unreadable. Allowing call.`;
            } else {
              toastMsg =
                `${label} quota check failed (${hr}). Allowing call.`;
            }
            // showToast returns a Promise; use .catch to prevent unhandled rejection.
            client?.tui?.showToast({ body: { message: toastMsg, variant: "warning" } })?.catch?.(() => {});
          } catch {
            // toast failure must not affect model call flow
          }
        }
      }
    },
    event: async ({ event }) => {
      try {
        if (!event || typeof event !== "object") return;

        const isIdle =
          event.type === "session.idle" ||
          (event.type === "session.status" && event.properties?.status?.type === "idle");
        if (!isIdle || seenKeys.size === 0) return;

        const cfg = resolveConfig({ projectDir: directory }).values;
        const refreshes = [];

        for (const key of seenKeys) {
          const [provider, window] = parseSeenKey(key);
          refreshes.push(refreshQuota(provider, cfg, { window }));
        }

        await Promise.allSettled(refreshes);
      } catch {
        // event hook must never interfere with the agent lifecycle
      }
    },
  };
};

QuotaHardStopPlugin.__test__ = {
  cache,
  inflight,
  lastFetchAt,
  nextAllowedFetchAt,
  lastWarnAt,
  seenKeys,
  cacheKey,
  getCacheEntry,
  getCached,
  isCacheFresh,
  refreshQuota,
  clearState() {
    cache.clear();
    inflight.clear();
    lastFetchAt.clear();
    nextAllowedFetchAt.clear();
    lastWarnAt.clear();
    seenKeys.clear();
  },
  setQuotaReader(fn) {
    quotaReader = typeof fn === "function" ? fn : readWeekly;
  },
  resetQuotaReader() {
    quotaReader = readWeekly;
  },
};

export default QuotaHardStopPlugin;
