import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import QuotaHardStopPlugin from "../quota-hard-stop.js";
import { resolveConfig } from "../lib/config.js";
import { writePostpone, clearPostpone } from "../lib/postpone.js";

const { __test__ } = QuotaHardStopPlugin;
__test__.setCliInstaller(() => {});

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

test("plugin initialization invokes the CLI installer", async () => {
  let calls = 0;
  __test__.setCliInstaller(() => { calls += 1; });
  await QuotaHardStopPlugin({ directory: process.cwd() });
  __test__.setCliInstaller(() => {});

  assert.equal(calls, 1);
});

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
      const plugin = await QuotaHardStopPlugin({ directory: proj });

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

      const plugin = await QuotaHardStopPlugin({ directory: proj });

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
      const plugin = await QuotaHardStopPlugin({ directory: proj });
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

test("chat.params: windowFallback result allows the call silently (no toast/client dependency)", async () => {
  const { xdg, proj } = sandbox();

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => fallbackResult(80, { window: "Weekly", requestedWindow: "5h" }));

      const plugin = await QuotaHardStopPlugin({ directory: proj });

      await plugin["chat.params"]({ provider: { info: { id: "openai" } } });
      await plugin["chat.params"]({ provider: { info: { id: "openai" } } });
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("chat.params: windowFallback result still blocks when below threshold", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ minRemaining: 90 }));

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => fallbackResult(10, { window: "Weekly", requestedWindow: "5h" }));

      const plugin = await QuotaHardStopPlugin({ directory: proj });

      await assert.rejects(plugin["chat.params"]({ provider: { info: { id: "openai" } } }), /Blocked/);
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("chat.params: claude-pro and claude-max resolve to SEPARATE accounts/cache keys (regression for the shared-credential bug)", async () => {
  const { root, xdg, proj } = sandbox();
  const proDir = join(root, "profiles", "pro");
  const maxDir = join(root, "profiles", "max");
  mkdirSync(proDir, { recursive: true });
  mkdirSync(maxDir, { recursive: true });
  writeFileSync(join(proDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  writeFileSync(join(maxDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ anthropicProfileDirs: [proDir, maxDir] }));

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      const calls = [];
      __test__.setQuotaReader(async (args) => {
        calls.push(args);
        return okResult(80);
      });

      const plugin = await QuotaHardStopPlugin({ directory: proj });

      await plugin["chat.params"]({ provider: { info: { id: "claude-pro" } } });
      await plugin["chat.params"]({ provider: { info: { id: "claude-max" } } });

      const proCall = calls.find((c) => c.accountId === "pro");
      const maxCall = calls.find((c) => c.accountId === "max");
      assert.ok(proCall, "expected a quotaReader call for the pro account");
      assert.ok(maxCall, "expected a quotaReader call for the max account");

      assert.ok(__test__.seenKeys.has("anthropic:pro:5h"), "expected a distinct cache key for the pro account");
      assert.ok(__test__.seenKeys.has("anthropic:max:5h"), "expected a distinct cache key for the max account");
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("chat.params: a generic 'anthropic' provider id keeps the legacy shared cache key even when profiles exist", async () => {
  const { root, xdg, proj } = sandbox();
  const proDir = join(root, "profiles", "pro");
  mkdirSync(proDir, { recursive: true });
  writeFileSync(join(proDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ anthropicProfileDirs: [proDir] }));

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      const calls = [];
      __test__.setQuotaReader(async (args) => {
        calls.push(args);
        return okResult(80);
      });

      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });

      assert.equal(calls[0].accountId, undefined);
      assert.ok(__test__.seenKeys.has("anthropic:5h"));
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("active postpone suppresses an otherwise-blocking result when allowPostpone is enabled", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({
      minRemaining: 30,
      allowPostpone: true,
      cacheTtlMs: 100000,
      minRefreshIntervalMs: 100000,
    }),
  );

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5)); // below 30% threshold -> would block
      writePostpone(30);

      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.doesNotReject(() =>
        plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
      );
    });
  } finally {
    clearPostpone();
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("stale postpone file is ignored when allowPostpone is disabled (still blocks)", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({
      minRemaining: 30,
      allowPostpone: false,
      cacheTtlMs: 100000,
      minRefreshIntervalMs: 100000,
    }),
  );

  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      writePostpone(30); // orphaned postpone state from when the flag was previously on

      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.rejects(
        () => plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
        /Blocked/,
      );
    });
  } finally {
    clearPostpone();
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("block message mentions the postpone hint only when allowPostpone is enabled", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({ minRemaining: 30, allowPostpone: true, cacheTtlMs: 100000, minRefreshIntervalMs: 100000 }),
  );
  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      const plugin = await QuotaHardStopPlugin({ directory: proj });
      await assert.rejects(
        () => plugin["chat.params"]({ provider: { info: { id: "anthropic" } } }),
        /opencode-hard-limit postpone/,
      );
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});

test("block message omits the postpone hint when allowPostpone is disabled (default)", async () => {
  const { xdg, proj } = sandbox();
  writeFileSync(
    join(proj, ".opencode-hard-limit.json"),
    JSON.stringify({ minRemaining: 30, cacheTtlMs: 100000, minRefreshIntervalMs: 100000 }),
  );
  __test__.clearState();
  try {
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      __test__.setQuotaReader(async () => okResult(5));
      const plugin = await QuotaHardStopPlugin({ directory: proj });
      try {
        await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
        assert.fail("expected chat.params to throw");
      } catch (err) {
        assert.doesNotMatch(err.message, /postpone/);
      }
    });
  } finally {
    __test__.resetQuotaReader();
    __test__.clearState();
  }
});
