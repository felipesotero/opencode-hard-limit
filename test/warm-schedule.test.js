// test/warm-schedule.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_IDLE_INTERVAL_MS,
  MIN_IDLE_INTERVAL_MS,
  POST_EXPIRY_GRACE_MS,
  decideWarmAction,
  nextBackoffMs,
} from "../lib/warm-schedule.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const freshCred = (expiresAt = NOW + 60_000) => ({
  accessToken: "access-token",
  expiresAt,
  hasRefreshToken: true,
});

test("warm schedule constants define the expiry grace, idle interval, and retry limits", () => {
  assert.equal(POST_EXPIRY_GRACE_MS, 30_000);
  assert.equal(DEFAULT_IDLE_INTERVAL_MS, 600_000);
  assert.equal(MIN_IDLE_INTERVAL_MS, 60_000);
  assert.equal(BACKOFF_BASE_MS, 300_000);
  assert.equal(BACKOFF_MAX_MS, 21_600_000);
});

test("decideWarmAction: fresh credentials are checked at expiry plus grace when sooner than idle", () => {
  const expiresAt = NOW + 2 * 60_000;
  const decision = decideWarmAction({ cred: freshCred(expiresAt), now: NOW });

  assert.deepEqual(decision, {
    action: "skip",
    reason: "fresh",
    nextCheckAt: expiresAt + POST_EXPIRY_GRACE_MS,
  });
});

test("decideWarmAction: fresh credentials beyond idle use the idle check time", () => {
  const decision = decideWarmAction({ cred: freshCred(NOW + 2 * 60 * 60_000), now: NOW });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "fresh");
  assert.equal(decision.nextCheckAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
});

test("decideWarmAction: expired credentials warm, including when expiry equals now", () => {
  for (const expiresAt of [NOW - 1, NOW]) {
    const decision = decideWarmAction({ cred: freshCred(expiresAt), now: NOW });
    assert.equal(decision.action, "warm");
    assert.equal(decision.reason, "expired");
  }
});

test("decideWarmAction: missing expiry is skipped unless force is set", () => {
  const cred = freshCred(null);
  const skipped = decideWarmAction({ cred, now: NOW });
  const forced = decideWarmAction({ cred, now: NOW, force: true });

  assert.equal(skipped.action, "skip");
  assert.equal(skipped.reason, "no-expiry");
  assert.equal(forced.action, "warm");
  assert.equal(forced.reason, "forced");
});

test("decideWarmAction: missing refresh token takes precedence over force", () => {
  const decision = decideWarmAction({
    cred: { ...freshCred(NOW - 1), hasRefreshToken: false },
    now: NOW,
    force: true,
  });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "no-refresh-token");
});

test("decideWarmAction: active backoff takes precedence over force", () => {
  const backoffUntil = NOW + 10_000;
  const decision = decideWarmAction({
    cred: freshCred(NOW - 1),
    now: NOW,
    backoffUntil,
    force: true,
  });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "backoff");
  assert.equal(decision.nextCheckAt, backoffUntil);
});

test("decideWarmAction: unreadable credentials are skipped", () => {
  const decision = decideWarmAction({ cred: null, now: NOW, force: true });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "unreadable");
});

test("decideWarmAction: invalid idle intervals or expiry values never return a non-finite check time", () => {
  const badIdle = decideWarmAction({ cred: freshCred(NOW + 1_000), now: NOW, idleIntervalMs: Number.NaN });
  const badExpiry = decideWarmAction({ cred: freshCred(Number.NaN), now: NOW });

  assert.equal(Number.isFinite(badIdle.nextCheckAt), true);
  assert.equal(Number.isFinite(badExpiry.nextCheckAt), true);
});

test("nextBackoffMs doubles from five minutes and caps at six hours", () => {
  assert.equal(nextBackoffMs(1), BACKOFF_BASE_MS);
  assert.equal(nextBackoffMs(2), 10 * 60_000);
  assert.equal(nextBackoffMs(10), BACKOFF_MAX_MS);
});
