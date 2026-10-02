// test/warm-schedule.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideWarmAction, DEFAULT_IDLE_INTERVAL_MS, DEFAULT_POST_RESET_BUFFER_MS } from "../lib/warm-schedule.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");

test("decideWarmAction: first-ever tick, idle, spendable -> warm now, re-check after idleInterval", () => {
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 123, remaining: 80, resetAtMs: null, now: NOW });
  assert.equal(d.action, "warm");
  assert.equal(d.reason, "idle");
  assert.equal(d.nextCheckAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
});

test("decideWarmAction: credentials mtime advanced since last tick -> in-use, skip", () => {
  const d = decideWarmAction({ previousMtimeMs: 100, currentMtimeMs: 200, remaining: 50, resetAtMs: null, now: NOW });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "in-use");
  assert.equal(d.nextCheckAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
});

test("decideWarmAction: mtime unchanged since last tick -> not in-use, falls through", () => {
  const d = decideWarmAction({ previousMtimeMs: 100, currentMtimeMs: 100, remaining: 50, resetAtMs: null, now: NOW });
  assert.equal(d.action, "warm");
  assert.equal(d.reason, "idle");
});

test("decideWarmAction: exhausted (0% left) with a known future reset -> skip until just past reset", () => {
  const resetAtMs = NOW + 75 * 60_000; // 75 minutes out, matching the user's example
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 1, remaining: 0, resetAtMs, now: NOW });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "exhausted");
  assert.equal(d.nextCheckAt, resetAtMs + DEFAULT_POST_RESET_BUFFER_MS);
  // 75 min + the default 1-minute buffer = next check ~76 min out.
  assert.equal(Math.round((d.nextCheckAt - NOW) / 60_000), 76);
});

test("decideWarmAction: exhausted but resetAtMs is in the past -> treated as unknown/stale, warms anyway", () => {
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 1, remaining: 0, resetAtMs: NOW - 1000, now: NOW });
  assert.equal(d.action, "warm");
});

test("decideWarmAction: exhausted but resetAtMs is unknown (null) -> falls through to idle warm", () => {
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 1, remaining: 0, resetAtMs: null, now: NOW });
  assert.equal(d.action, "warm");
  assert.equal(d.reason, "idle");
});

test("decideWarmAction: remaining unknown (null, e.g. quota read failed) -> falls through to idle warm", () => {
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 1, remaining: null, resetAtMs: null, now: NOW });
  assert.equal(d.action, "warm");
});

test("decideWarmAction: remaining nonzero (not exhausted) ignores resetAtMs entirely -> idle warm", () => {
  const d = decideWarmAction({ previousMtimeMs: null, currentMtimeMs: 1, remaining: 1, resetAtMs: NOW + 1000, now: NOW });
  assert.equal(d.action, "warm");
  assert.equal(d.reason, "idle");
});

test("decideWarmAction: in-use signal takes priority over an exhausted reading", () => {
  const resetAtMs = NOW + 75 * 60_000;
  const d = decideWarmAction({ previousMtimeMs: 100, currentMtimeMs: 200, remaining: 0, resetAtMs, now: NOW });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "in-use");
  assert.equal(d.nextCheckAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
});

test("decideWarmAction: custom idleIntervalMs/postResetBufferMs are honored", () => {
  const resetAtMs = NOW + 10_000;
  const exhausted = decideWarmAction({
    previousMtimeMs: null, currentMtimeMs: 1, remaining: 0, resetAtMs, now: NOW,
    postResetBufferMs: 5_000,
  });
  assert.equal(exhausted.nextCheckAt, resetAtMs + 5_000);

  const idle = decideWarmAction({
    previousMtimeMs: null, currentMtimeMs: 1, remaining: 80, resetAtMs: null, now: NOW,
    idleIntervalMs: 1_000,
  });
  assert.equal(idle.nextCheckAt, NOW + 1_000);
});
