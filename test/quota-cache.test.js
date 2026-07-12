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
          assert.equal(fetchCalls, 1);
        });
      },
    );
  } finally {
    Date.now = savedNow;
    global.fetch = savedFetch;
  }
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
