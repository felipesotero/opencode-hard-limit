// test/warm-watch.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tickWarmSchedule } from "../lib/warm-watch.js";

function sandbox() {
  return mkdtempSync(join(tmpdir(), "qhl-warm-watch-"));
}

function writeCredentials(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");
}

function fakeStat(mtimesByPath) {
  return (path) => {
    if (!(path in mtimesByPath)) throw new Error(`ENOENT: ${path}`);
    return { mtimeMs: mtimesByPath[path] };
  };
}

function quotaReaderReturning(entries) {
  return async () => entries;
}

test("tickWarmSchedule: no accounts discovered -> empty results, nextTickAt is now + idleInterval", async () => {
  const root = sandbox();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const { results, nextTickAt } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [join(root, "nope")],
    now,
    idleIntervalMs: 1000,
  });
  assert.deepEqual(results, []);
  assert.equal(nextTickAt, now + 1000);
});

test("tickWarmSchedule: idle account gets warmed, state records its post-warm mtime", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const credPath = join(pro, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");

  const warmCalls = [];
  const warmFn = async ({ profileDirs }) => {
    warmCalls.push(profileDirs);
    return [{ id: "pro", label: "Claude Pro", ok: true, costUsd: 0.01 }];
  };

  const state = new Map();
  const { results, nextTickAt } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro],
    now,
    idleIntervalMs: 60_000,
    quotaReader: quotaReaderReturning([{ accountId: "pro", ok: true, remaining: 80, resetAt: null }]),
    warmFn,
    statFn: fakeStat({ [credPath]: 10 }),
    state,
  });

  assert.equal(warmCalls.length, 1);
  assert.deepEqual(warmCalls[0], [pro]);
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "warm");
  assert.equal(results[0].reason, "idle");
  assert.equal(results[0].warmResult.ok, true);
  assert.equal(nextTickAt, now + 60_000);
  assert.deepEqual(state.get("pro"), { mtimeMs: 10 });
});

test("tickWarmSchedule: in-use account (mtime advanced since last state) is skipped, not warmed", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const credPath = join(pro, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");

  const warmFn = async () => { throw new Error("warmFn must not be called"); };

  const state = new Map([["pro", { mtimeMs: 10 }]]);
  const { results } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro],
    now,
    quotaReader: quotaReaderReturning([{ accountId: "pro", ok: true, remaining: 80, resetAt: null }]),
    warmFn,
    statFn: fakeStat({ [credPath]: 200 }), // advanced since the recorded 10
    state,
  });

  assert.equal(results[0].action, "skip");
  assert.equal(results[0].reason, "in-use");
  assert.deepEqual(state.get("pro"), { mtimeMs: 200 });
});

test("tickWarmSchedule: exhausted account with a known reset is skipped until just past reset", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const credPath = join(pro, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");
  const resetAt = new Date(now + 75 * 60_000).toISOString();

  const warmFn = async () => { throw new Error("warmFn must not be called"); };

  const { results, nextTickAt } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro],
    now,
    postResetBufferMs: 60_000,
    quotaReader: quotaReaderReturning([{ accountId: "pro", ok: true, remaining: 0, resetAt }]),
    warmFn,
    statFn: fakeStat({ [credPath]: 10 }),
  });

  assert.equal(results[0].action, "skip");
  assert.equal(results[0].reason, "exhausted");
  assert.equal(Math.round((nextTickAt - now) / 60_000), 76);
});

test("tickWarmSchedule: quotaReader throwing is swallowed, account still ticks (treated as idle)", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const credPath = join(pro, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");

  const { results } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro],
    now,
    quotaReader: async () => { throw new Error("usage endpoint down"); },
    warmFn: async () => [{ id: "pro", label: "Claude Pro", ok: true, costUsd: 0.01 }],
    statFn: fakeStat({ [credPath]: 10 }),
  });

  assert.equal(results[0].action, "warm");
});

test("tickWarmSchedule: no cliPath -> decisions still computed, but warm is never invoked", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const credPath = join(pro, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");

  const warmFn = async () => { throw new Error("warmFn must not be called"); };

  const { results } = await tickWarmSchedule({
    cliPath: undefined,
    profileDirs: [pro],
    now,
    quotaReader: quotaReaderReturning([{ accountId: "pro", ok: true, remaining: 80, resetAt: null }]),
    warmFn,
    statFn: fakeStat({ [credPath]: 10 }),
  });

  assert.equal(results[0].action, "warm");
  assert.equal(results[0].warmResult, null);
});

test("tickWarmSchedule: unreadable credentials file is treated as 'just changed', not a crash", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);
  const now = Date.parse("2026-10-02T12:00:00Z");

  const { results } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro],
    now,
    quotaReader: quotaReaderReturning([{ accountId: "pro", ok: true, remaining: 80, resetAt: null }]),
    warmFn: async () => [{ id: "pro", label: "Claude Pro", ok: true, costUsd: 0.01 }],
    statFn: () => { throw new Error("ENOENT"); },
  });

  assert.equal(results.length, 1);
  assert.ok(results[0].action === "warm" || results[0].action === "skip");
});

test("tickWarmSchedule: multiple accounts each get their own decision; nextTickAt is the earliest", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const max = join(root, "profiles", "max");
  writeCredentials(pro);
  writeCredentials(max);
  const proCred = join(pro, ".credentials.json");
  const maxCred = join(max, ".credentials.json");
  const now = Date.parse("2026-10-02T12:00:00Z");
  const resetAt = new Date(now + 75 * 60_000).toISOString();

  const { results, nextTickAt } = await tickWarmSchedule({
    cliPath: "claude",
    profileDirs: [pro, max],
    now,
    idleIntervalMs: 60_000,
    quotaReader: quotaReaderReturning([
      { accountId: "pro", ok: true, remaining: 0, resetAt }, // exhausted -> ~76min out
      { accountId: "max", ok: true, remaining: 80, resetAt: null }, // idle -> warm, 1min out
    ]),
    warmFn: async () => [{ id: "max", label: "Claude Max", ok: true, costUsd: 0.01 }],
    statFn: fakeStat({ [proCred]: 10, [maxCred]: 10 }),
  });

  assert.equal(results.length, 2);
  const proResult = results.find((r) => r.id === "pro");
  const maxResult = results.find((r) => r.id === "max");
  assert.equal(proResult.action, "skip");
  assert.equal(maxResult.action, "warm");
  assert.equal(nextTickAt, now + 60_000); // the earlier of the two
});
