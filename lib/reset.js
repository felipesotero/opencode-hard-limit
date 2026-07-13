// lib/reset.js
//
// Pure, dependency-free helpers for parsing/formatting a quota window's
// "resets at" timestamp. Used by both lib/evaluate.js (the windowAlreadyReset
// stale-failsafe exemption) and quota-sidebar.tsx (the "Resets ..." hint).
//
// No imports on purpose: this module must be safe to deploy standalone into
// the sidebar's plugins/lib/ directory alongside quota.js and config.js.
// Never throws.

export const WINDOW_DURATION_MS = Object.freeze({ "5h": 18_000_000, Weekly: 604_800_000 });
export const RESET_PLAUSIBILITY_TOLERANCE = 1.25;

// Look up a window's nominal duration in ms. Unknown/missing windows fall
// back to the Weekly duration (the more permissive of the two).
export function windowDurationMs(window) {
  return WINDOW_DURATION_MS[window] ?? WINDOW_DURATION_MS.Weekly;
}

// Parse a resetAt value (ISO string, epoch seconds, or epoch ms) into an
// absolute epoch-ms number, or null if it can't be parsed. Moved verbatim
// from the previous lib/evaluate.js implementation.
export function parseResetAt(resetAt) {
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

// Bound only the future delta: a rolling window's reset can never be further
// out than its own duration; the 1.25x tolerance absorbs clock skew/rounding
// in the upstream quota API. Past values are considered "plausible" here —
// bounding how far in the past a reset can be is evaluate.js's concern (the
// windowAlreadyReset exemption), not this function's.
export function isPlausibleResetAt(resetAtMs, window, now = Date.now()) {
  return Number.isFinite(resetAtMs) && (resetAtMs - now) <= windowDurationMs(window) * RESET_PLAUSIBILITY_TOLERANCE;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Format a resetAt value for display, keyed off the window string (not the
// delta magnitude) — deliberate: a magnitude-keyed format would have masked
// the bug this module fixes (a bogus weekly-scale delta rendered under the
// 5h label). Plausibility (magnitude) and format (window) are orthogonal
// checks and stay in separate functions.
export function formatReset(resetAt, window, now = Date.now()) {
  const parsed = parseResetAt(resetAt);
  if (parsed === null) return null;

  const delta = parsed - now;
  if (delta <= 0) return null; // already reset

  if (!isPlausibleResetAt(parsed, window, now)) return null; // implausible for this window -> suppress

  if (window === "Weekly") {
    const d = new Date(parsed);
    const day = DAYS[d.getDay()];
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    const ampm = hours < 12 ? "am" : "pm";
    const minutePart = minutes === 0 ? "" : `:${pad2(minutes)}`;
    return `Resets ${day} ${hour12}${minutePart}${ampm}`;
  }

  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  return `Resets in ${hours}h ${minutes}min`;
}
