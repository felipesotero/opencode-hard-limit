// lib/evaluate.js
//
// Provider id resolution and evaluate() logic for opencode-hard-limit.
//
// Extracted from quota-hard-stop.js so tests can import these helpers
// without exposing them as named exports on the server-plugin file.
// (OpenCode calls every named export of an autoloaded server plugin as a
// plugin factory; having evaluate/resolveQuotaProvider as top-level exports
// there caused "undefined is not an object (evaluating 'res.ok')" at startup.)

// Map an OpenCode provider id to a quota CLI provider id.
// Returns null for providers we do not monitor (plugin then no-ops).
export function resolveQuotaProvider(id) {
  if (!id) return null;
  const v = String(id).toLowerCase();
  if (v.includes("anthropic") || v.includes("claude")) return "anthropic";
  if (v.includes("openai") || v.includes("codex")) return "openai";
  return null;
}

// Decide whether to block and why.
// Returns { block: boolean, reason: string }.
//
// Reason tokens:
//   ok                        - quota read successfully, above threshold
//   unlimited                 - provider has unlimited quota
//   below-threshold           - quota < cfg.minRemaining (always blocks)
//   unreadable                - ok===true but remaining is null/non-finite
//   unreadable-allowed        - same but cfg.blockOnAuthError===false
//   auth-error:<msg>          - errorKind auth|unreadable and blockOnAuthError===true
//   auth-error-allowed:<msg>  - same but cfg.blockOnAuthError===false (allow + warn)
//   error-allowed:rate-limited - errorKind ratelimit (always allowed + warn)
//   stale-failsafe            - blind + near-threshold stale result blocks
//   error:<msg>               - errorKind timeout|unknown and cfg.blockOnError===true
//   error-allowed:<msg>       - same but cfg.blockOnError===false (allow + warn)
//
// _quotaProvider is kept in the signature for backward compatibility.
function parseResetAt(resetAt) {
  if (resetAt == null || resetAt === "") return null;
  if (typeof resetAt === "number") {
    return Number.isFinite(resetAt) ? (resetAt < 1e12 ? resetAt * 1000 : resetAt) : null;
  }
  if (typeof resetAt === "string") {
    const t = resetAt.trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
    }
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function evaluate(_quotaProvider, res, cfg, now = Date.now()) {
  if (res.ok) {
    if (res.unlimited) {
      return { block: false, reason: "unlimited" };
    }
    const remaining = res.remaining;
    if (remaining === null || !Number.isFinite(Number(remaining))) {
      return cfg.blockOnAuthError
        ? { block: true, reason: "unreadable" }
        : { block: false, reason: "unreadable-allowed" };
    }
    if (remaining < cfg.minRemaining) {
      return { block: true, reason: "below-threshold" };
    }

    const receivedAt = Number.isFinite(res.receivedAt) ? res.receivedAt : null;
    const backoffBlind = Number.isFinite(res.backoffUntil) && now < res.backoffUntil;
    const minRefreshIntervalMs = Number.isFinite(cfg.minRefreshIntervalMs) ? cfg.minRefreshIntervalMs : 0;
    const cacheTtlMs = Number.isFinite(cfg.cacheTtlMs) ? cfg.cacheTtlMs : 0;
    const blindAgeThreshold = Math.max(3 * minRefreshIntervalMs, cacheTtlMs); // derived: guard only once staleness is well beyond one poll window
    const ageBlind = receivedAt !== null && now - receivedAt >= blindAgeThreshold;
    const blind = backoffBlind || ageBlind;
    const staleMargin = Number.isFinite(cfg.staleBlockMarginPct) ? cfg.staleBlockMarginPct : 10;
    const windowAlreadyReset = (() => {
      const resetAt = parseResetAt(res.resetAt);
      return resetAt !== null && resetAt < now;
    })();
    if (blind && !windowAlreadyReset && remaining < cfg.minRemaining + staleMargin) {
      return { block: true, reason: "stale-failsafe" };
    }
    return { block: false, reason: "ok" };
  }

  // ok === false: route by errorKind.
  const kind = res.errorKind;
  if (kind === "ratelimit") {
    return { block: false, reason: "error-allowed:rate-limited" };
  }
  if (kind === "auth" || kind === "unreadable") {
    return cfg.blockOnAuthError
      ? { block: true, reason: `auth-error:${res.error}` }
      : { block: false, reason: `auth-error-allowed:${res.error}` };
  }
  // timeout / unknown (and undefined for backward compat)
  return cfg.blockOnError
    ? { block: true, reason: `error:${res.error}` }
    : { block: false, reason: `error-allowed:${res.error}` };
}
