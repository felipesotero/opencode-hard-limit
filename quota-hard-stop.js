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
// by default (blockOnAuthError: false) and the call proceeds silently — no
// toast is shown (the sidebar widget is the only UI surface for quota state).
//
// Configuration is resolved by ./lib/config.js with this precedence:
//   env var > project file > global file > built-in default.
// See README.md and `opencode-hard-limit --help` for details.

import { readWeekly, MONITORED_PROVIDERS, quotaCachePath } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { resolveQuotaProvider, resolveAnthropicProfileSlug, evaluate } from "./lib/evaluate.js";
import { discoverAnthropicAccounts } from "./lib/accounts.js";
import { ensureCliInstalled, ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";
import { isPostponeActive } from "./lib/postpone.js";

const cache = new Map(); // "quotaProvider[:accountId]:window" -> { at, result, ttl }
const inflight = new Map(); // "quotaProvider[:accountId]:window" -> Promise (dedupe concurrent checks)
const seenKeys = new Set(); // tracked provider[:accountId]:window combos seen in chat.params
const ERROR_TTL_CAP_MS = 10000; // cap transient failures; stale entries can be background-refreshed
let quotaReader = readWeekly;
let cliInstaller = ensureCliInstalled;

function cacheKey(provider, window, accountId) {
  return accountId ? `${provider}:${accountId}:${window}` : `${provider}:${window}`;
}

function getCached(provider, window, accountId) {
  return cache.get(cacheKey(provider, window, accountId))?.result ?? null;
}

function getCacheEntry(provider, window, accountId) {
  return cache.get(cacheKey(provider, window, accountId)) ?? null;
}

function isCacheFresh(entry) {
  return Boolean(entry && Date.now() - entry.at < entry.ttl);
}

// Resolve which specific Claude account/profile a call to `providerId`
// targets, when multiple isolated Claude Code logins are registered as
// separate provider instances (see @openchamber/opencode-claude's
// CLAUDE_CONFIG_DIR-per-instance pattern, e.g. "claude-pro" / "claude-max").
// Returns undefined when there's no such match — callers then fall back to
// the single default-login behavior, unchanged from before multi-account
// support existed. Never throws (fs access inside discoverAnthropicAccounts
// is already best-effort).
function resolveAnthropicAccountId(providerId, quotaProvider, cfg) {
  if (quotaProvider !== "anthropic") return undefined;
  const slug = resolveAnthropicProfileSlug(providerId);
  if (!slug) return undefined;
  const accounts = discoverAnthropicAccounts({ profileDirs: cfg.anthropicProfileDirs });
  return accounts.some((a) => a.id === slug) ? slug : undefined;
}

// A key holds either 2 parts ("provider:window") or 3 ("provider:accountId:window").
function parseSeenKey(key) {
  const parts = key.split(":");
  if (parts.length >= 3) {
    return [parts[0], parts[parts.length - 1] || "Weekly", parts[1]];
  }
  const i = key.indexOf(":");
  return i < 0 ? [key, "Weekly", undefined] : [key.slice(0, i), key.slice(i + 1) || "Weekly", undefined];
}

async function refreshQuota(
  provider,
  cfg,
  { window = windowForProvider(cfg, provider), force = false, accountId = undefined } = {},
) {
  const quotaWindow = window || "Weekly";
  const key = cacheKey(provider, quotaWindow, accountId);
  const cached = cache.get(key);

  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const pendingFetch = quotaReader({
    provider,
    window: quotaWindow,
    accountId,
    timeoutMs: cfg.timeoutMs,
    cacheTtlMs: cfg.cacheTtlMs,
    rateLimitBackoffMs: cfg.rateLimitBackoffMs,
    maxRateLimitBackoffMs: cfg.maxRateLimitBackoffMs,
    noBaselineRateLimitBackoffMs: cfg.noBaselineRateLimitBackoffMs,
    minRefreshIntervalMs: cfg.minRefreshIntervalMs,
    cacheFile: quotaCachePath(),
    anthropicProfileDirs: cfg.anthropicProfileDirs,
    openaiAccountsFile: cfg.openaiAccountsFile,
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

export const QuotaHardStopPlugin = async ({ directory } = {}) => {
  // Self-heal: ensure deployed sidebar and globally callable CLI match the installed npm version.
  // ensureTuiDeployed never throws — outer try/catch is not needed.
  ensureTuiDeployed();
  cliInstaller();
  // Defer cleanupLegacyCopies to avoid racing opencode's plugins-dir autoloader.
  setTimeout(() => { try { cleanupLegacyCopies(); } catch {} }, 30_000).unref?.();

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
      // When this call targets a specific Claude profile (e.g. provider id
      // "claude-pro" / "claude-max" from @openchamber/opencode-claude's
      // one-instance-per-account pattern), check THAT account's quota
      // instead of always falling back to the single default login shared
      // by every Anthropic provider id.
      const accountId = resolveAnthropicAccountId(providerId, quotaProvider, cfg);

      const key = cacheKey(quotaProvider, quotaWindow, accountId);
      seenKeys.add(key);

      const cachedEntry = getCacheEntry(quotaProvider, quotaWindow, accountId);
      let res;
      if (!cachedEntry) {
        res = await refreshQuota(quotaProvider, cfg, { window: quotaWindow, force: true, accountId });
      } else {
        res = cachedEntry.result;
        if (!isCacheFresh(cachedEntry)) {
          refreshQuota(quotaProvider, cfg, { window: quotaWindow, accountId }).catch(() => {});
        }
      }
      let { block, reason } = evaluate(quotaProvider, res, cfg);

      if (block && cfg.allowPostpone && isPostponeActive()) {
        block = false;
        reason = "postponed";
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
        if (cfg.allowPostpone) {
          blockMsg +=
            ` To postpone this block: in OpenCode, type ! by itself first to enter shell mode ` +
            `(pasting a whole "!opencode-hard-limit ..." line at once won't trigger it — type the ! ` +
            `yourself, then paste the rest), then run: opencode-hard-limit postpone <minutes> ` +
            `(default 30, e.g. "opencode-hard-limit postpone 60") — no LLM cost.`;
        } else {
          blockMsg +=
            ` There is no override configured for this. Wait for quota to refresh, or raise the ` +
            `threshold: opencode-hard-limit set --threshold <value> --global.`;
        }
        const quotaProviderLabel = accountId ? `${quotaProvider}:${accountId}` : quotaProvider;
        throw new Error(`[quota-hard-stop] Blocked ${providerId} (${quotaProviderLabel}): ${blockMsg}`);
      }
      // Otherwise allow silently — no toast/sound; the sidebar widget is the
      // only surface for quota state (including unreadable/fallback cases).
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
          const [provider, window, accountId] = parseSeenKey(key);
          refreshes.push(refreshQuota(provider, cfg, { window, accountId }));
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
  seenKeys,
  cacheKey,
  getCacheEntry,
  getCached,
  isCacheFresh,
  refreshQuota,
  clearState() {
    cache.clear();
    inflight.clear();
    seenKeys.clear();
    quotaReader = readWeekly;
  },
  setQuotaReader(fn) {
    quotaReader = typeof fn === "function" ? fn : readWeekly;
  },
  resetQuotaReader() {
    quotaReader = readWeekly;
  },
  setCliInstaller(fn) {
    cliInstaller = typeof fn === "function" ? fn : ensureCliInstalled;
  },
  resetCliInstaller() {
    cliInstaller = ensureCliInstalled;
  },
};

export default QuotaHardStopPlugin;
