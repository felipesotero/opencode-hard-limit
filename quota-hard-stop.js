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

import { readWeekly, quotaCachePath, resolveQuotaAccount } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { resolveQuotaProvider, evaluate } from "./lib/evaluate.js";
import { ensureCliInstalled, ensureTuiDeployed, cleanupLegacyCopies } from "./lib/deploy.js";
import { isPostponeActive } from "./lib/postpone.js";

const cache = new Map(); // "provider:accountKey:window" -> { at, result, ttl }
const inflight = new Map(); // cache key -> Promise (dedupe concurrent checks)
const seenKeys = new Map(); // cache key -> { provider, providerId, window }
const ERROR_TTL_CAP_MS = 10000; // cap transient failures; stale entries can be background-refreshed
let quotaReader = readWeekly;
let cliInstaller = ensureCliInstalled;

function cacheKey(provider, accountKey, window) {
  return `${provider}:${accountKey}:${window}`;
}

function getCached(provider, accountKey, window) {
  return cache.get(cacheKey(provider, accountKey, window))?.result ?? null;
}

function getCacheEntry(provider, accountKey, window) {
  return cache.get(cacheKey(provider, accountKey, window)) ?? null;
}

function isCacheFresh(entry) {
  return Boolean(entry && Date.now() - entry.at < entry.ttl);
}

async function refreshQuota(
  provider,
  cfg,
  { window = windowForProvider(cfg, provider), force = false, account = undefined, providerId = provider } = {},
) {
  const quotaWindow = window || "Weekly";
  const resolvedAccount = account ?? await resolveQuotaAccount({
    provider,
    providerId,
    accountsFile: cfg.anthropicAccountsFile,
    credentialSource: cfg.anthropicCredentialSource,
    anthropicProfileDirs: cfg.anthropicProfileDirs,
    openaiAccountsFile: cfg.openaiAccountsFile,
  });
  const key = cacheKey(provider, resolvedAccount.accountKey, quotaWindow);
  if (resolvedAccount.error) {
    return quotaReader({
      provider,
      providerId,
      window: quotaWindow,
      account: resolvedAccount,
      timeoutMs: cfg.timeoutMs,
      cacheTtlMs: cfg.cacheTtlMs,
      rateLimitBackoffMs: cfg.rateLimitBackoffMs,
      minRefreshIntervalMs: cfg.minRefreshIntervalMs,
      accountsFile: cfg.anthropicAccountsFile,
      credentialSource: cfg.anthropicCredentialSource,
      cacheFile: quotaCachePath(),
      anthropicProfileDirs: cfg.anthropicProfileDirs,
      openaiAccountsFile: cfg.openaiAccountsFile,
    });
  }

  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const pendingFetch = quotaReader({
    provider,
    providerId,
    window: quotaWindow,
    account: resolvedAccount,
    timeoutMs: cfg.timeoutMs,
    cacheTtlMs: cfg.cacheTtlMs,
    rateLimitBackoffMs: cfg.rateLimitBackoffMs,
    maxRateLimitBackoffMs: cfg.maxRateLimitBackoffMs,
    minRefreshIntervalMs: cfg.minRefreshIntervalMs,
    accountsFile: cfg.anthropicAccountsFile,
    credentialSource: cfg.anthropicCredentialSource,
    cacheFile: quotaCachePath(),
    anthropicProfileDirs: cfg.anthropicProfileDirs,
    openaiAccountsFile: cfg.openaiAccountsFile,
  })
    .then((result) => {
      const finishedAt = Date.now();
      const at = typeof result?.receivedAt === "number" ? result.receivedAt : finishedAt;
      const ttl = result.ok ? cfg.cacheTtlMs : Math.min(cfg.cacheTtlMs, ERROR_TTL_CAP_MS);
      cache.set(key, { at, result, ttl });
      return result;
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
  ensureTuiDeployed();
  cliInstaller();
  setTimeout(() => { try { cleanupLegacyCopies(); } catch {} }, 30_000).unref?.();

  return {
    "chat.params": async (input) => {
      const cfg = resolveConfig({ projectDir: directory }).values;
      const providerId =
        input?.provider?.info?.id ??
        input?.model?.providerID ??
        input?.model?.provider;
      const quotaProvider = resolveQuotaProvider(providerId);
      if (!quotaProvider) return;

      const quotaWindow = windowForProvider(cfg, quotaProvider);
      const account = await resolveQuotaAccount({
        provider: quotaProvider,
        providerId,
        accountsFile: cfg.anthropicAccountsFile,
        credentialSource: cfg.anthropicCredentialSource,
        anthropicProfileDirs: cfg.anthropicProfileDirs,
        openaiAccountsFile: cfg.openaiAccountsFile,
      });
      const key = cacheKey(quotaProvider, account.accountKey, quotaWindow);
      seenKeys.set(key, { provider: quotaProvider, providerId, window: quotaWindow });

      const cachedEntry = getCacheEntry(quotaProvider, account.accountKey, quotaWindow);
      let res;
      if (!cachedEntry || account.error) {
        res = await refreshQuota(quotaProvider, cfg, {
          window: quotaWindow,
          force: true,
          account,
          providerId,
        });
      } else {
        res = cachedEntry.result;
        if (!isCacheFresh(cachedEntry)) {
          refreshQuota(quotaProvider, cfg, { window: quotaWindow, account, providerId }).catch(() => {});
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
        const defaultAccount = account.accountKey === "cli" || account.accountKey === "oc:default";
        const quotaProviderLabel = defaultAccount
          ? quotaProvider
          : `${quotaProvider}:${account.accountKey} (${account.label})`;
        throw new Error(`[quota-hard-stop] Blocked ${providerId} (${quotaProviderLabel}): ${blockMsg}`);
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
        const refreshes = new Map();
        for (const { provider, providerId, window } of seenKeys.values()) {
          const account = await resolveQuotaAccount({
            provider,
            providerId,
            accountsFile: cfg.anthropicAccountsFile,
            credentialSource: cfg.anthropicCredentialSource,
            anthropicProfileDirs: cfg.anthropicProfileDirs,
            openaiAccountsFile: cfg.openaiAccountsFile,
          });
          const key = cacheKey(provider, account.accountKey, window);
          if (!refreshes.has(key)) {
            refreshes.set(key, refreshQuota(provider, cfg, { window, account, providerId }));
          }
        }
        await Promise.allSettled(refreshes.values());
      } catch {
        // Event hooks must not interfere with the agent lifecycle.
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
