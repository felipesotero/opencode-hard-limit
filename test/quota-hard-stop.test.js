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

function fallbackResult(remaining, { window = "Weekly", requestedWindow = "5h" } = {}) {
  return {
    ok: true,
    status: "ok",
    remaining,
    resetAt: null,
    unlimited: false,
    window,
    requestedWindow,
    windowFallback: true,
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

test("chat.params resolves per-provider window: anthropic uses base window, openai uses windowOpenai override", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({ window: "5h" }),
  );

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW_OPENAI: "Weekly" }, async () => {
      const calls = [];
      __test__.setQuotaReader(async (args) => {
        calls.push(args);
        return okResult(80);
      });

      const plugin = await QuotaHardStopPlugin({
        directory: proj,
        client: { tui: { showToast: () => Promise.resolve() } },
      });

      await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
      await plugin["chat.params"]({ provider: { info: { id: "openai" } } });

      const anthropicCall = calls.find((c) => c.provider === "anthropic");
      const openaiCall = calls.find((c) => c.provider === "openai");
      assert.ok(anthropicCall, "expected an anthropic quotaReader call");
      assert.ok(openaiCall, "expected an openai quotaReader call");
      assert.equal(anthropicCall.window, "5h");
      assert.equal(openaiCall.window, "Weekly");

      assert.ok(__test__.seenKeys.has("anthropic:5h"));
      assert.ok(__test__.seenKeys.has("openai:Weekly"));
    });
  } finally {
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

test("chat.params: windowFallback result warns exactly once across two calls, message mentions --window-openai Weekly", async () => {
  const { xdg, proj } = sandbox();

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => fallbackResult(80, { window: "Weekly", requestedWindow: "5h" }));

      const toasts = [];
      const plugin = await QuotaHardStopPlugin({
        directory: proj,
        client: { tui: { showToast: (opts) => { toasts.push(opts); return Promise.resolve(); } } },
      });

      await plugin["chat.params"]({ provider: { info: { id: "openai" } } });
      await plugin["chat.params"]({ provider: { info: { id: "openai" } } });

      const fallbackToasts = toasts.filter((t) => /has no 5h quota window/.test(t.body.message));
      assert.equal(fallbackToasts.length, 1, "expected exactly one fallback warning toast across two calls");
      assert.match(fallbackToasts[0].body.message, /--window-openai Weekly/);
      assert.equal(fallbackToasts[0].body.variant, "warning");
      assert.ok(__test__.fallbackWarned.has("openai"));
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("chat.params: fallback warning fires even when the call is blocked (below threshold)", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ minRemaining: 90 }));

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => fallbackResult(10, { window: "Weekly", requestedWindow: "5h" }));

      const toasts = [];
      const plugin = await QuotaHardStopPlugin({
        directory: proj,
        client: { tui: { showToast: (opts) => { toasts.push(opts); return Promise.resolve(); } } },
      });

      await assert.rejects(plugin["chat.params"]({ provider: { info: { id: "openai" } } }), /Blocked/);

      const fallbackToasts = toasts.filter((t) => /has no 5h quota window/.test(t.body.message));
      assert.equal(fallbackToasts.length, 1);
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("clearState() resets fallbackWarned", async () => {
  __test__.fallbackWarned.add("openai");
  __test__.clearState();
  assert.equal(__test__.fallbackWarned.size, 0);
});
