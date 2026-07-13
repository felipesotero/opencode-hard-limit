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

test("chat.params throws stale-failsafe message for a seeded backoff cache entry", async () => {
  const { xdg, proj } = sandbox();
  const cacheDir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "quota-cache.json"),
    JSON.stringify(
      {
        "anthropic:5h": {
          at: 100_000,
          nextAllowedAt: 800_000,
          result: {
            ok: true,
            status: "ok",
            remaining: 35,
            resetAt: null,
            unlimited: false,
            window: "5h",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const savedNow = Date.now;
  Date.now = () => 500_000;
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      const plugin = await QuotaHardStopPlugin({ directory: proj, client: { tui: { showToast: () => Promise.resolve() } } });
      await assert.rejects(
        plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
        /stale fail-safe/,
      );
    });
  } finally {
    Date.now = savedNow;
    __test__.clearState();
  }
});
