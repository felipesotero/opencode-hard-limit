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

// Decide whether to block. Returns { block: boolean, message: string }.
// Consumes the normalized result returned by readWeekly() in lib/quota.js.
// _quotaProvider is kept in the signature for backward compatibility.
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
