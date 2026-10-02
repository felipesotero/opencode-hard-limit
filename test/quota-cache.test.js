import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWeekly } from "../lib/quota.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-cache-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const cacheFile = join(root, "quota-cache.json");
  const bin = join(root, "claude");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(xdg, { recursive: true });
  return { root, home, xdg, cacheFile, bin };
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

function writeClaudeStub(file) {
  writeFileSync(
    file,
    `#!/usr/bin/env node
const mode = process.env.QHL_CLAUDE_MODE || "good";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude 1.0.0"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  if (mode === "good") {
    console.log(JSON.stringify({
      authenticated: true,
      five_hour: { used_percentage: 20, resets_at: "2030-01-01T00:00:00Z" },
      seven_day: { used_percentage: 10, resets_at: "2030-01-02T00:00:00Z" }
    }));
  } else {
    console.log(JSON.stringify({ authenticated: true }));
  }
  process.exit(0);
}
process.exit(1);
`,
    "utf8",
  );
  chmodSync(file, 0o755);
}

function goodResponse(remaining = 80) {
  return {
    ok: true,
    status: "ok",
    remaining,
    resetAt: null,
    unlimited: false,
    window: "Weekly",
  };
}

test("fresh cache short-circuits before any fetch", async () => {
  const { cacheFile, bin } = sandbox();
  writeClaudeStub(bin);
  const entry = {
    at: 1000,
    result: goodResponse(77),
    nextAllowedAt: 0,
  };
  writeFileSync(cacheFile, JSON.stringify({ "anthropic:Weekly": entry }, null, 2) + "\n", "utf8");

  const savedNow = Date.now;
  Date.now = () => 1500;
  let fetchCalls = 0;
  const savedFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network should not be called");
  };
  try {
    await withEnv({ OPENCODE_QUOTA_CLAUDE_BIN: bin, QHL_CLAUDE_MODE: "noWindows" }, async () => {
      const result = await readWeekly({
        provider: "anthropic",
        window: "Weekly",
        cacheFile,
        cacheTtlMs: 10_000,
        minRefreshIntervalMs: 5_000,
        rateLimitBackoffMs: 30_000,
        timeoutMs: 1000,
      });
      assert.equal(result.ok, true);
      assert.equal(result.remaining, 77);
      assert.equal(result.stale, undefined);
      assert.equal(fetchCalls, 0);
    });
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
  }
});

test("429 preserves last-known-good, sets nextAllowedAt, and honors Retry-After", async () => {
  const { home, xdg, cacheFile, bin } = sandbox();
  writeClaudeStub(bin);
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");

  const savedNow = Date.now;
  const savedFetch = global.fetch;
  let now = 1_000;
  Date.now = () => now;

  try {
    await withEnv(
      {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        OPENCODE_QUOTA_CLAUDE_BIN: bin,
        QHL_CLAUDE_MODE: "good",
      },
      async () => {
        const first = await readWeekly({
          provider: "anthropic",
          window: "Weekly",
          cacheFile,
          cacheTtlMs: 500,
          minRefreshIntervalMs: 500,
          rateLimitBackoffMs: 30_000,
          timeoutMs: 1000,
        });
        assert.equal(first.ok, true);
        assert.equal(first.remaining, 90);
        assert.equal(first.stale, undefined);
        assert.equal(first.backoffUntil, undefined);

        const before = JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"];
        assert.equal(before.result.remaining, 90);
        assert.equal(before.nextAllowedAt, 0);

        now = 5_000;
        let fetchCalls = 0;
        global.fetch = async () => {
          fetchCalls += 1;
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? "7" : null) },
            text: async () => "rate limited",
          };
        };

        await withEnv({ QHL_CLAUDE_MODE: "noWindows" }, async () => {
          const second = await readWeekly({
            provider: "anthropic",
            window: "Weekly",
            cacheFile,
            cacheTtlMs: 500,
            minRefreshIntervalMs: 500,
            rateLimitBackoffMs: 30_000,
            timeoutMs: 1000,
          });
          assert.equal(second.ok, true);
          assert.equal(second.remaining, 90);
          assert.equal(second.stale, true);
          assert.equal(second.backoffUntil, 12000);
          assert.equal(fetchCalls, 1);

          const after = JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"];
          assert.equal(after.result.remaining, 90);
          assert.equal(after.nextAllowedAt, 12_000);

          const third = await readWeekly({
            provider: "anthropic",
            window: "Weekly",
            cacheFile,
            cacheTtlMs: 500,
            minRefreshIntervalMs: 500,
            rateLimitBackoffMs: 30_000,
            timeoutMs: 1000,
          });
          assert.equal(third.ok, true);
          assert.equal(third.remaining, 90);
          assert.equal(third.stale, true);
          assert.equal(third.backoffUntil, 12000);
          assert.equal(fetchCalls, 1);
        });
      },
    );
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
  }
});

test("429 without LKG returns ratelimit error and backoffUntil", async () => {
  const { home, xdg, cacheFile, bin } = sandbox();
  writeClaudeStub(bin);
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");

  const savedNow = Date.now;
  const savedFetch = global.fetch;
  let now = 1_000;
  Date.now = () => now;

  try {
    await withEnv(
      {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        OPENCODE_QUOTA_CLAUDE_BIN: bin,
        QHL_CLAUDE_MODE: "noWindows",
      },
      async () => {
        global.fetch = async () => ({
          ok: false,
          status: 429,
          headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? "7" : null) },
          text: async () => "rate limited",
        });

        const result = await readWeekly({
          provider: "anthropic",
          window: "Weekly",
          cacheFile,
          cacheTtlMs: 500,
          minRefreshIntervalMs: 500,
          rateLimitBackoffMs: 30_000,
          timeoutMs: 1000,
        });

        assert.equal(result.ok, false);
        assert.equal(result.errorKind, "ratelimit");
        assert.equal(result.backoffUntil, 8000);
        const after = JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"];
        assert.equal(after.nextAllowedAt, 8000);
      },
    );
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
  }
});

// Shared scaffolding for the backoff-cap and stale-fallback cases below:
// a sandbox whose only quota source is a stubbed HTTP response.
async function withStubbedUsage({ respond, mode = "noWindows", at = 1_000 }, fn) {
  const { home, xdg, cacheFile, bin } = sandbox();
  writeClaudeStub(bin);
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");

  const savedNow = Date.now;
  const savedFetch = global.fetch;
  Date.now = () => at;
  try {
    await withEnv(
      { HOME: home, XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_CLAUDE_BIN: bin, QHL_CLAUDE_MODE: mode },
      async () => {
        global.fetch = respond;
        await fn({ cacheFile, setNow: (t) => { Date.now = () => t; } });
      },
    );
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
  }
}

function rateLimited(retryAfter) {
  return async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => "rate limited",
  });
}

test("a Retry-After longer than the cap is clamped to maxRateLimitBackoffMs", async () => {
  // Anthropic's usage endpoint can answer a 429 with the better part of an
  // hour; honoring that verbatim pinned an account as unreadable long after it
  // would have served a fresh number.
  await withStubbedUsage({ respond: rateLimited("3600") }, async ({ cacheFile }) => {
    const result = await readWeekly({
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      maxRateLimitBackoffMs: 60_000,
      timeoutMs: 1000,
    });
    assert.equal(result.errorKind, "ratelimit");
    assert.equal(result.backoffUntil, 61_000); // now(1_000) + cap, not + 3_600_000
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"].nextAllowedAt, 61_000);
  });
});

test("a Retry-After under the cap is still honored verbatim", async () => {
  await withStubbedUsage({ respond: rateLimited("7") }, async ({ cacheFile }) => {
    const result = await readWeekly({
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      maxRateLimitBackoffMs: 600_000,
      timeoutMs: 1000,
    });
    assert.equal(result.backoffUntil, 8_000);
  });
});

test("no Retry-After falls back to rateLimitBackoffMs, uncapped by maxRateLimitBackoffMs", async () => {
  // The local cooldown is the user's own setting, so the cap must not shrink it.
  await withStubbedUsage({ respond: rateLimited(null) }, async ({ cacheFile }) => {
    const result = await readWeekly({
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 90_000,
      maxRateLimitBackoffMs: 60_000,
      timeoutMs: 1000,
    });
    assert.equal(result.backoffUntil, 91_000);
  });
});

test("429 without LKG is capped by noBaselineRateLimitBackoffMs, tighter than maxRateLimitBackoffMs", async () => {
  // Nothing is being protected when there is no last-known-good reading yet,
  // so a long server Retry-After should be clamped much sooner than the
  // (looser) cap that applies once a stale-but-good value exists to serve.
  await withStubbedUsage({ respond: rateLimited("3600") }, async ({ cacheFile }) => {
    const result = await readWeekly({
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      maxRateLimitBackoffMs: 600_000,
      noBaselineRateLimitBackoffMs: 45_000,
      timeoutMs: 1000,
    });
    assert.equal(result.errorKind, "ratelimit");
    assert.equal(result.backoffUntil, 46_000); // now(1_000) + no-baseline cap, not + maxRateLimitBackoffMs
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"].nextAllowedAt, 46_000);
  });
});

test("noBaselineRateLimitBackoffMs never loosens maxRateLimitBackoffMs when no LKG exists", async () => {
  // A no-baseline cap set LARGER than maxRateLimitBackoffMs must not widen
  // the backoff window — maxRateLimitBackoffMs still wins via Math.min.
  await withStubbedUsage({ respond: rateLimited("3600") }, async ({ cacheFile }) => {
    const result = await readWeekly({
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      maxRateLimitBackoffMs: 60_000,
      noBaselineRateLimitBackoffMs: 500_000,
      timeoutMs: 1000,
    });
    assert.equal(result.backoffUntil, 61_000); // now(1_000) + maxRateLimitBackoffMs, not + 500_000
  });
});

test("a transient non-429 failure serves the last-known-good as stale", async () => {
  let calls = 0;
  const respond = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          seven_day: { utilization: 25, resets_at: "2030-01-02T00:00:00Z" },
        }),
      };
    }
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => "upstream blew up" };
  };

  await withStubbedUsage({ respond }, async ({ cacheFile, setNow }) => {
    const opts = {
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      timeoutMs: 1000,
    };

    const first = await readWeekly(opts);
    assert.equal(first.ok, true);
    assert.equal(first.remaining, 75);
    assert.equal(first.stale, undefined);

    setNow(5_000);
    const second = await readWeekly(opts);
    // Previously this returned the error, so an account with a perfectly good
    // reading showed up as unavailable on one blip.
    assert.equal(second.ok, true);
    assert.equal(second.remaining, 75);
    assert.equal(second.stale, true);
    assert.equal(second.receivedAt, 1_000, "keeps the original timestamp, so staleness stays honest");
    // No backoff: a 503 is not a rate limit, so the next call may refetch.
    assert.equal(second.backoffUntil, undefined);
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"].result.remaining, 75);
  });
});

test("an auth failure surfaces instead of hiding behind the last-known-good", async () => {
  let calls = 0;
  const respond = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          seven_day: { utilization: 25, resets_at: "2030-01-02T00:00:00Z" },
        }),
      };
    }
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => "unauthorized" };
  };

  await withStubbedUsage({ respond }, async ({ cacheFile, setNow }) => {
    const opts = {
      provider: "anthropic",
      window: "Weekly",
      cacheFile,
      cacheTtlMs: 500,
      minRefreshIntervalMs: 500,
      rateLimitBackoffMs: 30_000,
      timeoutMs: 1000,
    };

    assert.equal((await readWeekly(opts)).remaining, 75);

    setNow(5_000);
    const second = await readWeekly(opts);
    // A revoked login can never be refreshed, so a stale number would be a
    // quota the plugin keeps trusting forever.
    assert.equal(second.ok, false);
    assert.equal(second.errorKind, "auth");
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8"))["anthropic:Weekly"].result.ok, false);
  });
});

test("cacheFile null skips file I/O", async () => {
  const { home, xdg, bin } = sandbox();
  writeClaudeStub(bin);
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");

  await withEnv(
    {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      OPENCODE_QUOTA_CLAUDE_BIN: bin,
      QHL_CLAUDE_MODE: "good",
      OPENCODE_QUOTA_CACHE_FILE: undefined,
    },
    async () => {
      const result = await readWeekly({
        provider: "anthropic",
        window: "Weekly",
        cacheFile: null,
        timeoutMs: 1000,
      });
      assert.equal(result.ok, true);
      assert.equal(result.remaining, 90);
      assert.equal(result.stale, undefined);
      assert.equal(existsSync(join(xdg, "opencode", "opencode-hard-limit", "quota-cache.json")), false);
      assert.equal(existsSync(join(home, ".config", "opencode", "opencode-hard-limit", "quota-cache.json")), false);
    },
  );
});
