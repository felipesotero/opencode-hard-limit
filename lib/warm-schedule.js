// lib/warm-schedule.js
//
// Pure scheduling decision for `opencode-hard-limit warm --watch`: given an
// account's last-observed credential state and its current quota reading,
// decide whether to skip warming it this tick (it's already being used
// elsewhere, or its window is fully exhausted until a known reset) or to
// warm it now, and when to check again.
//
// No I/O, no timers, no process spawning -- kept separate from
// lib/warm-watch.js's loop driver so the decision itself is unit-testable
// without mocking fs/spawn/setTimeout.

export const DEFAULT_IDLE_INTERVAL_MS = 10 * 60_000; // 10 min: re-check cadence while idle
export const DEFAULT_POST_RESET_BUFFER_MS = 60_000; // +1 min past a known reset time

/**
 * @param {object} params
 * @param {number|null} params.previousMtimeMs - .credentials.json mtime observed on the PRIOR tick for this account (null on the account's first-ever tick).
 * @param {number} params.currentMtimeMs - .credentials.json mtime observed just now.
 * @param {number|null} params.remaining - quota % remaining for the tracked window (null when unknown/unreadable).
 * @param {number|null} params.resetAtMs - epoch ms when the window resets (null when unknown).
 * @param {number} params.now - epoch ms "now" (injectable for tests).
 * @param {number} [params.idleIntervalMs]
 * @param {number} [params.postResetBufferMs]
 * @returns {{ action: "warm"|"skip", reason: "in-use"|"exhausted"|"idle", nextCheckAt: number }}
 */
export function decideWarmAction({
  previousMtimeMs,
  currentMtimeMs,
  remaining,
  resetAtMs,
  now,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  postResetBufferMs = DEFAULT_POST_RESET_BUFFER_MS,
}) {
  // Signal 1: the credentials file changed since the last tick without us
  // warming it ourselves in between -- something real refreshed the token
  // (actual usage of that profile elsewhere). No need to spend a warm call;
  // just keep watching at the normal idle cadence in case it goes quiet.
  if (previousMtimeMs !== null && currentMtimeMs > previousMtimeMs) {
    return { action: "skip", reason: "in-use", nextCheckAt: now + idleIntervalMs };
  }

  // Signal 2: the window is fully exhausted and the reset time is known --
  // warming now would be spent with nothing to show for it until the window
  // turns over, so wait just past the reset instead of polling idly.
  if (remaining === 0 && typeof resetAtMs === "number" && resetAtMs > now) {
    return { action: "skip", reason: "exhausted", nextCheckAt: resetAtMs + postResetBufferMs };
  }

  // Otherwise: idle and spendable -- warm it now, re-check after the idle interval.
  return { action: "warm", reason: "idle", nextCheckAt: now + idleIntervalMs };
}
