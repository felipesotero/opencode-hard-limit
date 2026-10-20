// lib/warm-schedule.js
//
// Pure scheduling decisions for named Claude profiles, based only on the
// local OAuth credential expiry and per-profile warm backoff state.

export const POST_EXPIRY_GRACE_MS = 30_000;
export const DEFAULT_IDLE_INTERVAL_MS = 10 * 60_000;
export const MIN_IDLE_INTERVAL_MS = 60_000;
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3_600_000;
// Kept temporarily so the CLI can load between dispatches; removed in 3d.
export const DEFAULT_POST_RESET_BUFFER_MS = 60_000;

/**
 * Decide whether a named profile should be warmed and when it should be checked
 * again. This function performs no I/O and starts no timers or processes.
 */
export function decideWarmAction({
  cred,
  now,
  backoffUntil = 0,
  force = false,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
} = {}) {
  const idleMs = Number.isFinite(idleIntervalMs) ? idleIntervalMs : DEFAULT_IDLE_INTERVAL_MS;
  const idleCheckAt = now + idleMs;
  const result = (action, reason, nextCheckAt = idleCheckAt) => ({
    action,
    reason,
    nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : idleCheckAt,
  });

  if (cred === null || cred === undefined) return result("skip", "unreadable");
  if (!cred.hasRefreshToken) return result("skip", "no-refresh-token");
  if (backoffUntil > now) return result("skip", "backoff", backoffUntil);
  if (force) return result("warm", "forced");
  if (cred.expiresAt === null) return result("skip", "no-expiry");
  if (cred.expiresAt <= now) return result("warm", "expired");

  const expiryCheckAt = cred.expiresAt + POST_EXPIRY_GRACE_MS;
  return result("skip", "fresh", Math.min(idleCheckAt, expiryCheckAt));
}

/** Return the exponential retry delay for a failed warm attempt. */
export function nextBackoffMs(failures) {
  const count = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  return Math.min(BACKOFF_BASE_MS * (2 ** (count - 1)), BACKOFF_MAX_MS);
}
