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

import { readWeekly, MONITORED_PROVIDERS, quotaCachePath } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { resolveQuotaProvider, evaluate } from "./lib/evaluate.js";
import { ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";

const cache = new Map(); // "quotaProvider:window" -> { at, result, ttl }
const inflight = new Map(); // "quotaProvider:window" -> Promise (dedupe concurrent checks)
const lastWarnAt = new Map(); // quotaProvider -> timestamp of last warning toast
const seenKeys = new Set(); // tracked provider:window combos seen in chat.params
const fallbackWarned = new Set(); // quotaProvider -> already warned about a window fallback this process
const ERROR_TTL_CAP_MS = 10000; // cap transient failures; stale entries can be background-refreshed
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

function parseSeenKey(key) {
  const i = key.indexOf(":");
  return i < 0 ? [key, "Weekly"] : [key.slice(0, i), key.slice(i + 1) || "Weekly"];
}

async function refreshQuota(provider, cfg, { window = windowForProvider(cfg, provider), force = false } = {}) {
  const quotaWindow = window || "Weekly";
  const key = cacheKey(provider, quotaWindow);
  const cached = cache.get(key);

  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const pendingFetch = quotaReader({
    provider,
    window: quotaWindow,
    timeoutMs: cfg.timeoutMs,
    cacheTtlMs: cfg.cacheTtlMs,
    rateLimitBackoffMs: cfg.rateLimitBackoffMs,
    minRefreshIntervalMs: cfg.minRefreshIntervalMs,
    cacheFile: quotaCachePath(),
  })
    .then((result) => {
      const finishedAt = Date.now();
      const at = typeof result?.receivedAt === "number" ? result.receivedAt : finishedAt;
      const ttl = result.ok ? cfg.cacheTtlMs : Math.min(cfg.cacheTtlMs, ERROR_TTL_CAP_MS);

      if (result.ok) {
        cache.set(key, { at, result, ttl });
      } else {
        cache.set(key, { at, result, ttl });
      }

      return result;
    })
    .catch((err) => {
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

      const providerId =
        input?.provider?.info?.id ??
        input?.model?.providerID ??
        input?.model?.provider;

      const quotaProvider = resolveQuotaProvider(providerId);
      if (!quotaProvider) return; // provider not monitored -> allow

      const quotaWindow = windowForProvider(cfg, quotaProvider);

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

      if (res?.windowFallback && !fallbackWarned.has(quotaProvider)) {
        fallbackWarned.add(quotaProvider);
        const providerEntry = MONITORED_PROVIDERS.find((p) => p.id === quotaProvider);
        const label = providerEntry?.label ?? quotaProvider;
        client?.tui?.showToast({
          body: {
            message:
              `${label} has no ${res.requestedWindow} quota window on this account; monitoring the ${res.window} window instead. ` +
              `Silence this by setting: opencode-hard-limit set --window-${quotaProvider} ${res.window} --global`,
            variant: "warning",
          },
        })?.catch?.(() => {});
      }

      if (block) {
        let blockMsg;
        if (reason === "below-threshold") {
          blockMsg =
            `quota ${res.remaining}% remaining is below the ${cfg.minRemaining}% threshold. ` +
            `Raise your budget: opencode-hard-limit set --threshold <lower> --global ` +
            `(or OPENCODE_QUOTA_MIN_REMAINING=<lower>).`;
        } else if (reason === "stale-failsafe") {
          const ageMin = Math.round((Date.now() - res.receivedAt) / 60000);
          blockMsg =
            `last known quota ${res.remaining}% is ${ageMin}min old and could not be refreshed` +
            `${res.backoffUntil ? " (usage endpoint rate-limited, retry ~" + new Date(res.backoffUntil).toLocaleTimeString() + ")" : ""}; ` +
            `it is within ${cfg.staleBlockMarginPct}% of your ${cfg.minRemaining}% threshold, so blocking as a precaution. ` +
            `Set OPENCODE_QUOTA_STALE_BLOCK_MARGIN=0 (or --stale-margin 0) to disable the stale fail-safe.`;
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
  lastWarnAt,
  seenKeys,
  fallbackWarned,
  cacheKey,
  getCacheEntry,
  getCached,
  isCacheFresh,
  refreshQuota,
  clearState() {
    cache.clear();
    inflight.clear();
    lastWarnAt.clear();
    seenKeys.clear();
    fallbackWarned.clear();
    quotaReader = readWeekly;
  },
  setQuotaReader(fn) {
    quotaReader = typeof fn === "function" ? fn : readWeekly;
  },
  resetQuotaReader() {
    quotaReader = readWeekly;
  },
};

export default QuotaHardStopPlugin;
