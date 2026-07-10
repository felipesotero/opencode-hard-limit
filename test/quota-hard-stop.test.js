import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import QuotaHardStopPlugin from "../quota-hard-stop.js";
import { resolveConfig } from "../lib/config.js";

const { __test__ } = QuotaHardStopPlugin;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-hard-stop-"));
  const xdg = join(root, "xdg");
  const proj = join(root, "proj");
  mkdirSync(proj, { recursive: true });
  return { root, xdg, proj };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function okResult(remaining) {
  return {
    ok: true,
    status: "ok",
    remaining,
    resetAt: null,
    unlimited: false,
    window: "Weekly",
  };
}

test("stale cache is served immediately and refreshes in the background", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({
      minRemaining: 30,
      blockOnError: true,
      blockOnAuthError: false,
      cacheTtlMs: 100,
      timeoutMs: 1000,
      window: "Weekly",
      minRefreshIntervalMs: 1,
      rateLimitBackoffMs: 5000,
    }),
  );

  const savedNow = Date.now;
  let now = 0;
  Date.now = () => now;

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      const cfg = resolveConfig({ projectDir: proj }).values;
      let calls = 0;
      let resolveSecond;
      const second = new Promise((resolve) => {
        resolveSecond = resolve;
      });

      __test__.setQuotaReader(async () => {
        calls += 1;
        return calls === 1 ? okResult(70) : second;
      });

      await __test__.refreshQuota("anthropic", cfg, { window: "Weekly", force: true });

      now = 200;
      const plugin = await QuotaHardStopPlugin({
        directory: proj,
        client: { tui: { showToast: () => Promise.resolve() } },
      });

      const chat = plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
      let settled = false;
      chat.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });

      await Promise.resolve();
      assert.equal(settled, true);
      assert.equal(calls, 2);

      resolveSecond(okResult(10));
      await Promise.resolve();
    });
  } finally {
    Date.now = savedNow;
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("429 cooldown lasts about rateLimitBackoffMs", async () => {
  const savedNow = Date.now;
  let now = 0;
  Date.now = () => now;

  __test__.clearState();
  try {
    const cfg = {
      cacheTtlMs: 1000,
      minRefreshIntervalMs: 1000,
      rateLimitBackoffMs: 5000,
      timeoutMs: 1000,
      window: "Weekly",
    };
    let calls = 0;
    __test__.setQuotaReader(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, error: "Anthropic API error 429: too many requests", errorKind: "ratelimit" };
      }
      return okResult(66);
    });

    const first = await __test__.refreshQuota("anthropic", cfg, { window: "Weekly", force: true });
    assert.equal(first.ok, false);
    assert.equal(first.errorKind, "ratelimit");
    assert.equal(calls, 1);

    now = 1000;
    const second = await __test__.refreshQuota("anthropic", cfg, { window: "Weekly" });
    assert.equal(second.ok, false);
    assert.equal(calls, 1);

    now = 4999;
    await __test__.refreshQuota("anthropic", cfg, { window: "Weekly" });
    assert.equal(calls, 1);

    now = 5000;
    const third = await __test__.refreshQuota("anthropic", cfg, { window: "Weekly" });
    assert.equal(third.ok, true);
    assert.equal(third.remaining, 66);
    assert.equal(calls, 2);
  } finally {
    Date.now = savedNow;
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});
