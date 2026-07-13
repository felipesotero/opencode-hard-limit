// test/reset.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseResetAt, isPlausibleResetAt, formatReset, windowDurationMs, WINDOW_DURATION_MS } from "../lib/reset.js";

// A realistic fixed epoch (2026-01-01T00:00:00 local) so numeric resetAt
// values used in tests are always >= 1e12 and unambiguously ms, not seconds.
const NOW = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();

// Find the next Date (starting strictly after `from`) matching the given
// local weekday index (0=Sun..6=Sat) and hour/minute. Avoids hardcoding any
// real calendar date's weekday, keeping the test TZ-safe and deterministic.
function nextLocal(from, targetDay, hour, minute) {
  const d = new Date(from);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  while (d.getDay() !== targetDay) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

test("parseResetAt: ISO string, epoch seconds, epoch ms, digit-string, garbage, epoch-0", () => {
  assert.equal(parseResetAt("2026-07-09T14:00:00Z"), Date.parse("2026-07-09T14:00:00Z"));
  assert.equal(parseResetAt(1752098400), 1752098400 * 1000); // epoch seconds (< 1e12)
  assert.equal(parseResetAt(1752098400000), 1752098400000); // epoch ms (>= 1e12)
  assert.equal(parseResetAt("1752098400"), 1752098400 * 1000); // digit-string, seconds
  assert.equal(parseResetAt("not a date"), null);
  assert.equal(parseResetAt(null), null);
  assert.equal(parseResetAt(undefined), null);
  assert.equal(parseResetAt(""), null);
  assert.equal(parseResetAt(0), 0); // documents the epoch-0 edge case
});

test("isPlausibleResetAt: bounds only the future delta by window duration * tolerance", () => {
  // 5h window: +4h is plausible, +162h (the actual bug case) is not.
  assert.equal(isPlausibleResetAt(NOW + 4 * 3_600_000, "5h", NOW), true);
  assert.equal(isPlausibleResetAt(NOW + 162 * 3_600_000, "5h", NOW), false);

  // Weekly window: +6.8d plausible, +9d not.
  assert.equal(isPlausibleResetAt(NOW + 6.8 * 86_400_000, "Weekly", NOW), true);
  assert.equal(isPlausibleResetAt(NOW + 9 * 86_400_000, "Weekly", NOW), false);

  // Tolerance boundary: exact <= equality is plausible.
  const threshold5h = WINDOW_DURATION_MS["5h"] * 1.25;
  assert.equal(isPlausibleResetAt(NOW + threshold5h, "5h", NOW), true);
  const thresholdWeekly = WINDOW_DURATION_MS.Weekly * 1.25;
  assert.equal(isPlausibleResetAt(NOW + thresholdWeekly, "Weekly", NOW), true);

  // Past values are plausible here (the past bound lives in evaluate.js).
  assert.equal(isPlausibleResetAt(NOW - 999_999_999, "5h", NOW), true);

  // Unknown window falls back to Weekly duration.
  assert.equal(windowDurationMs("bogus"), WINDOW_DURATION_MS.Weekly);
});

test("formatReset: 5h countdown uses exact floor semantics", () => {
  const delta = 3 * 3_600_000 + 12 * 60_000; // 3h 12min
  assert.equal(formatReset(NOW + delta, "5h", NOW), "Resets in 3h 12min");
});

test("formatReset: 5h implausible (bug case) delta is suppressed -> null", () => {
  const delta = 162 * 3_600_000; // the actual reported bug: 162h under a 5h window
  assert.equal(formatReset(NOW + delta, "5h", NOW), null);
});

test("formatReset: Weekly formats absolute local day+time, omitting :00 minutes", () => {
  const resetDate = nextLocal(NOW, 0 /* Sun */, 14, 0);
  assert.equal(formatReset(resetDate.getTime(), "Weekly", NOW), "Resets Sun 2pm");
});

test("formatReset: Weekly includes minutes when not :00", () => {
  const resetDate = nextLocal(NOW, 0 /* Sun */, 14, 35);
  assert.equal(formatReset(resetDate.getTime(), "Weekly", NOW), "Resets Sun 2:35pm");
});

test("formatReset: 12am/12pm hour boundaries", () => {
  const midnight = nextLocal(NOW, 1 /* Mon */, 0, 0);
  assert.equal(formatReset(midnight.getTime(), "Weekly", NOW), "Resets Mon 12am");

  const noon = nextLocal(NOW, 1 /* Mon */, 12, 0);
  assert.equal(formatReset(noon.getTime(), "Weekly", NOW), "Resets Mon 12pm");
});

test("formatReset: past resetAt -> null (already reset)", () => {
  assert.equal(formatReset(NOW - 1, "5h", NOW), null);
  assert.equal(formatReset(NOW, "5h", NOW), null); // delta === 0
});

test("formatReset: unparseable resetAt -> null", () => {
  assert.equal(formatReset("not a date", "5h", NOW), null);
  assert.equal(formatReset(null, "Weekly", NOW), null);
});

// Regression for the "missing OpenAI reset line" bug: a resetAt ~6.9 days out
// mislabeled as window "5h" (the old positional picker's poisoned cache shape)
// must suppress the reset line entirely rather than render a bogus countdown.
// The same resetAt correctly labeled "Weekly" must render normally — this is
// what self-heals once lib/quota.js's window-fallback labeling ships.
test("formatReset: resetAt ~6.9 days out mislabeled '5h' -> null; same value as 'Weekly' -> renders", () => {
  const sevenDaysOutIso = new Date(NOW + 6.9 * 86_400_000).toISOString();
  assert.equal(formatReset(sevenDaysOutIso, "5h", NOW), null);
  assert.match(formatReset(sevenDaysOutIso, "Weekly", NOW), /^Resets /);
});
