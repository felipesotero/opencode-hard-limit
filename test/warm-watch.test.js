// test/warm-watch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKOFF_BASE_MS, DEFAULT_IDLE_INTERVAL_MS } from "../lib/warm-schedule.js";
import { runWarmWatch, tickWarmSchedule } from "../lib/warm-watch.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "qhl-warm-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCredentials(dir, {
  accessToken = "access-token",
  expiresAt = NOW + 60 * 60_000,
  refreshToken = `${dir}-refresh`,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const credentialsPath = join(dir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken, expiresAt, refreshToken },
  }), "utf8");
  return credentialsPath;
}

test("tickWarmSchedule: warms only the expired profile among two discovered profiles", async (t) => {
  const root = sandbox(t);
  const pro = join(root, "profiles", "pro");
  const max = join(root, "profiles", "max");
  writeCredentials(pro, { expiresAt: NOW - 1 });
  writeCredentials(max, { expiresAt: NOW + 2 * 60 * 60_000 });
  const warmCalls = [];

  const result = await tickWarmSchedule({
    cliPath: "/sandbox/claude",
    profileDirs: [pro, max],
    now: NOW,
    warmFn: async ({ profiles }) => {
      warmCalls.push(profiles.map((profile) => profile.id));
      return [{ ok: true, refreshed: true }];
    },
  });

  assert.equal(result.profileMode, true);
  assert.deepEqual(warmCalls, [["pro"]]);
  assert.equal(result.results.find((entry) => entry.id === "pro").reason, "expired");
  assert.equal(result.results.find((entry) => entry.id === "max").reason, "fresh");
  assert.equal(result.nextTickAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
});

test("tickWarmSchedule: a readable fresh profile stays unwarmed across ten idle scans", async (t) => {
  const root = sandbox(t);
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro, { expiresAt: NOW + 24 * 60 * 60_000 });
  const state = new Map();
  let warmCalls = 0;

  for (let tick = 0; tick < 10; tick += 1) {
    await tickWarmSchedule({
      cliPath: "/sandbox/claude",
      profileDirs: [pro],
      state,
      now: NOW + tick * DEFAULT_IDLE_INTERVAL_MS,
      warmFn: async () => { warmCalls += 1; throw new Error("fresh profile must not warm"); },
    });
  }

  assert.equal(warmCalls, 0);
});

test("tickWarmSchedule: failed warms back off per profile for five minutes, then ten", async (t) => {
  const root = sandbox(t);
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro, { expiresAt: NOW - 1 });
  const state = new Map();
  let warmCalls = 0;
  const warmFn = async () => {
    warmCalls += 1;
    return [{ ok: false, error: "credential was not refreshed" }];
  };
  const tick = (now) => tickWarmSchedule({
    cliPath: "/sandbox/claude",
    profileDirs: [pro],
    state,
    now,
    warmFn,
  });

  await tick(NOW);
  assert.deepEqual(state.get("cp:pro"), { failures: 1, backoffUntil: NOW + BACKOFF_BASE_MS });

  const duringBackoff = await tick(NOW + BACKOFF_BASE_MS - 1);
  assert.equal(duringBackoff.results[0].reason, "backoff");
  assert.equal(warmCalls, 1);

  const retried = await tick(NOW + BACKOFF_BASE_MS);
  assert.equal(retried.results[0].action, "warm");
  assert.deepEqual(state.get("cp:pro"), {
    failures: 2,
    backoffUntil: NOW + BACKOFF_BASE_MS + 2 * BACKOFF_BASE_MS,
  });
  assert.equal(warmCalls, 2);
});

test("tickWarmSchedule: settings overrides are skipped without counting as failures", async (t) => {
  const root = sandbox(t);
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro, { expiresAt: NOW - 1 });
  const state = new Map();

  const result = await tickWarmSchedule({
    cliPath: "/sandbox/claude",
    profileDirs: [pro],
    state,
    now: NOW,
    warmFn: async () => ({ ok: false, reason: "settings-override" }),
  });

  assert.equal(result.results[0].action, "skip");
  assert.equal(result.results[0].reason, "settings-override");
  assert.equal(state.has("cp:pro"), false);
});

test("tickWarmSchedule: the default ~/.claude credentials do not enable profile mode", async (t) => {
  const root = sandbox(t);
  writeCredentials(join(root, ".claude"), { expiresAt: NOW - 1 });
  const originalHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const result = await tickWarmSchedule({
      now: NOW,
      warmFn: async () => { throw new Error("default Claude credentials must not warm"); },
    });

    assert.equal(result.profileMode, false);
    assert.deepEqual(result.results, []);
    assert.equal(result.nextTickAt, NOW + DEFAULT_IDLE_INTERVAL_MS);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("runWarmWatch: logs a failed tick and continues after its own backoff", async () => {
  const controller = new AbortController();
  const logMessages = [];
  const sleepDurations = [];
  let ticks = 0;

  await runWarmWatch({
    signal: controller.signal,
    tick: async () => {
      ticks += 1;
      if (ticks === 1) throw new Error("tick failed");
      controller.abort();
      return { nextTickAt: Date.now() };
    },
    sleep: async (duration) => { sleepDurations.push(duration); },
    log: (message) => logMessages.push(message),
  });

  assert.equal(ticks, 2);
  assert.deepEqual(logMessages, ["tick failed"]);
  assert.ok(sleepDurations[0] >= BACKOFF_BASE_MS);
});

test("runWarmWatch: invalid or past deadlines sleep at least one second", async () => {
  const controller = new AbortController();
  const sleepDurations = [];
  let ticks = 0;

  await runWarmWatch({
    signal: controller.signal,
    tick: async () => ({ nextTickAt: ticks++ === 0 ? Number.NaN : Date.now() - 10_000 }),
    sleep: async (duration) => {
      sleepDurations.push(duration);
      if (sleepDurations.length === 2) controller.abort();
    },
  });

  assert.equal(sleepDurations.length, 2);
  assert.ok(sleepDurations.every((duration) => duration >= 1_000));
});

test("runWarmWatch: aborting during the real sleep exits without another tick", async () => {
  const controller = new AbortController();
  let ticks = 0;
  const abortTimer = setTimeout(() => controller.abort(), 10);

  try {
    await runWarmWatch({
      signal: controller.signal,
      tick: async () => {
        ticks += 1;
        return { nextTickAt: Date.now() + DEFAULT_IDLE_INTERVAL_MS };
      },
    });
  } finally {
    clearTimeout(abortTimer);
  }

  assert.equal(ticks, 1);
});
