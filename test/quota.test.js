// test/quota.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWeekly, __internals } from "../lib/quota.js";

const {
  classifyError, parseAnthropicUsage, mapAnthropicWindow, extractAuthBoolean,
  mapOpenAIWindow, parseJwt, firstNumeric, extractClaudeCredToken, pickOpenAIWindow,
} = __internals;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-quota-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg-data");
  const cacheFile = join(root, "quota-cache.json");
  const bin = join(root, "claude");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(xdg, "opencode"), { recursive: true });
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

function writeOpenAIAuth(xdg) {
  writeFileSync(
    join(xdg, "opencode", "auth.json"),
    JSON.stringify({ openai: { type: "oauth", access: "header.eyJ4IjoxfQ.sig", expires: Date.now() + 3_600_000 } }),
    "utf8",
  );
}

// Writes a fake `claude` CLI stub exposing only the windows present in `windows`
// (a subset of { five_hour, seven_day }), so fetchAnthropic's CLI path can be
// exercised for the single-window-account fallback case.
function writeClaudeStubWith(file, windows) {
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude 1.0.0"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ authenticated: true, ...${JSON.stringify(windows)} }));
  process.exit(0);
}
process.exit(1);
`,
    "utf8",
  );
  chmodSync(file, 0o755);
}

test("classifyError maps auth/timeout/ratelimit/unreadable", () => {
  assert.equal(classifyError("Anthropic API error 429: too many requests"), "ratelimit");
  assert.equal(classifyError("too many requests"), "ratelimit");
  assert.equal(classifyError("token expired"), "auth");
  assert.equal(classifyError("provider unavailable"), "auth");
  assert.equal(classifyError("Anthropic API error 401: nope"), "auth");
  assert.equal(classifyError("request timed out"), "timeout");
  assert.equal(classifyError("no Weekly window entry"), "unreadable");
});

test("firstNumeric accepts numbers and numeric strings, skips junk", () => {
  assert.equal(firstNumeric(undefined, null, "x", "42", 7), 42);
  assert.equal(firstNumeric("  ", NaN, 3.5), 3.5);
  assert.equal(firstNumeric(), null);
});

test("mapAnthropicWindow computes remaining from any used-percent alias", () => {
  assert.deepEqual(mapAnthropicWindow({ utilization: 30, resets_at: "2026-07-09T14:00:00Z" }), {
    percentRemaining: 70,
    resetTimeIso: "2026-07-09T14:00:00.000Z",
  });
  assert.equal(mapAnthropicWindow({ usedPercent: 12.4 }).percentRemaining, 88);
  assert.equal(mapAnthropicWindow({ percent_used: 99.6 }).percentRemaining, 0);
  assert.equal(mapAnthropicWindow({ resets_at: "x" }), null); // no used percent -> null
});

test("parseAnthropicUsage: both windows present, tries nested roots (regression)", () => {
  const flat = parseAnthropicUsage({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } });
  assert.equal(flat.five_hour.percentRemaining, 90);
  assert.equal(flat.seven_day.percentRemaining, 80);

  const nested = parseAnthropicUsage({ usage: { fiveHour: { used_percent: 0 }, sevenDay: { used_percent: 50 } } });
  assert.equal(nested.five_hour.percentRemaining, 100);
  assert.equal(nested.seven_day.percentRemaining, 50);

  assert.equal(parseAnthropicUsage(null), null);
});

test("parseAnthropicUsage: partial payload (only one window) is accepted", () => {
  const onlySeven = parseAnthropicUsage({ five_hour: null, seven_day: { utilization: 10 } });
  assert.deepEqual(onlySeven.five_hour, null);
  assert.equal(onlySeven.seven_day.percentRemaining, 90);

  const onlyFive = parseAnthropicUsage({ five_hour: { utilization: 30 } });
  assert.equal(onlyFive.five_hour.percentRemaining, 70);
  assert.equal(onlyFive.seven_day, null);
});

test("parseAnthropicUsage: neither window present -> null", () => {
  assert.equal(parseAnthropicUsage({ foo: "bar" }), null);
  assert.equal(parseAnthropicUsage({}), null);
});

test("extractAuthBoolean reads booleans and status string", () => {
  assert.equal(extractAuthBoolean({ authenticated: true }), true);
  assert.equal(extractAuthBoolean({ auth: { loggedIn: false } }), false);
  assert.equal(extractAuthBoolean({ status: "authenticated" }), true);
  assert.equal(extractAuthBoolean({ status: "unauthenticated" }), false);
  assert.equal(extractAuthBoolean({}), false);
});

test("mapOpenAIWindow: reset_at seconds -> ms ISO, fallback to reset_after_seconds", () => {
  const at = mapOpenAIWindow({ used_percent: 25, reset_at: 1752098400 });
  assert.equal(at.percentRemaining, 75);
  assert.equal(at.resetTimeIso, new Date(1752098400 * 1000).toISOString());

  const after = mapOpenAIWindow({ used_percent: 0, reset_after_seconds: 3600 });
  assert.equal(after.percentRemaining, 100);
  assert.ok(after.resetTimeIso); // computed from now + 3600s

  assert.equal(mapOpenAIWindow({ reset_at: 1 }), null); // no used_percent
  assert.equal(mapOpenAIWindow({ used_percent: 40 }).resetTimeIso, undefined);
});

test("parseJwt decodes payload, returns {} on junk", () => {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" } };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64").replace(/=+$/, "");
  const token = `header.${b64}.sig`;
  assert.equal(parseJwt(token)["https://api.openai.com/auth"].chatgpt_account_id, "acc_123");
  assert.deepEqual(parseJwt("not-a-jwt"), {});
});

test("extractClaudeCredToken walks claudeAiOauth/oauth/root", () => {
  assert.equal(extractClaudeCredToken({ claudeAiOauth: { accessToken: "  t1 " } }), "t1");
  assert.equal(extractClaudeCredToken({ oauth: { access_token: "t2" } }), "t2");
  assert.equal(extractClaudeCredToken({ token: "t3" }), "t3");
  assert.equal(extractClaudeCredToken({ nope: 1 }), null);
});

test("pickOpenAIWindow: exact duration match, reversed slots (the real-world broken case)", () => {
  const weekly = { limit_window_seconds: 604800, used_percent: 10 };
  const fiveHour = { limit_window_seconds: 18000, used_percent: 20 };
  // primary=weekly, secondary=5h — the opposite of the old positional assumption.
  const rateLimit = { primary_window: weekly, secondary_window: fiveHour };
  assert.equal(pickOpenAIWindow(rateLimit, "5h"), fiveHour);
});

test("pickOpenAIWindow: exact duration match, normal/expected ordering", () => {
  const fiveHour = { limit_window_seconds: 18000, used_percent: 20 };
  const weekly = { limit_window_seconds: 604800, used_percent: 10 };
  const rateLimit = { primary_window: fiveHour, secondary_window: weekly };
  assert.equal(pickOpenAIWindow(rateLimit, "Weekly"), weekly);
});

test("pickOpenAIWindow: neither exact match but both numeric -> relative-order classification", () => {
  const a = { limit_window_seconds: 99999, used_percent: 1 }; // longer, malformed
  const b = { limit_window_seconds: 111, used_percent: 2 }; // shorter, malformed
  const rateLimit = { primary_window: a, secondary_window: b };
  assert.equal(pickOpenAIWindow(rateLimit, "5h"), b); // shortest
  assert.equal(pickOpenAIWindow(rateLimit, "Weekly"), a); // longest
});

test("pickOpenAIWindow: no limit_window_seconds anywhere -> positional fallback", () => {
  const primary = { used_percent: 20 };
  const secondary = { used_percent: 10 };
  const rateLimit = { primary_window: primary, secondary_window: secondary };
  assert.equal(pickOpenAIWindow(rateLimit, "5h"), primary);
  assert.equal(pickOpenAIWindow(rateLimit, "Weekly"), secondary);
});

test("pickOpenAIWindow: no windows at all -> null", () => {
  assert.equal(pickOpenAIWindow({}, "5h"), null);
  assert.equal(pickOpenAIWindow(null, "5h"), null);
  assert.equal(pickOpenAIWindow({ primary_window: null, secondary_window: undefined }, "Weekly"), null);
});

test("pickOpenAIWindow: single candidate (free-tier, only weekly in primary_window)", () => {
  const weekly = { limit_window_seconds: 604800, used_percent: 5 };
  const rateLimit = { primary_window: weekly };
  // Exact duration match -> picked directly (step 1), unaffected by this fix.
  assert.equal(pickOpenAIWindow(rateLimit, "Weekly"), weekly);
  // No 5h candidate exists, and the only candidate's known duration (604800s)
  // doesn't match the requested "5h" (18000s). A single known-duration
  // candidate is not enough to classify by relative order, so we must not
  // guess -> null, not the mismatched weekly candidate.
  assert.equal(pickOpenAIWindow(rateLimit, "5h"), null);
});

// -----------------------------------------------------------------------
// Window fallback (fetchOpenAI / fetchAnthropic via readWeekly)
// -----------------------------------------------------------------------

test("fetchOpenAI: weekly-only payload + request 5h -> falls back with requestedWindow/windowFallback", async () => {
  const { xdg } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        rate_limit: {
          primary_window: { limit_window_seconds: 604800, used_percent: 8, reset_at: 2000000000 },
        },
      }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const result = await readWeekly({ provider: "openai", window: "5h", cacheFile: null, timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.equal(result.window, "Weekly");
      assert.equal(result.requestedWindow, "5h");
      assert.equal(result.windowFallback, true);
      assert.equal(result.remaining, 92);
      assert.equal(result.resetAt, new Date(2000000000 * 1000).toISOString());
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("fetchOpenAI: weekly-only payload + request Weekly -> plain ok, no fallback fields", async () => {
  const { xdg } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        rate_limit: {
          primary_window: { limit_window_seconds: 604800, used_percent: 8 },
        },
      }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const result = await readWeekly({ provider: "openai", window: "Weekly", cacheFile: null, timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.equal(result.window, "Weekly");
      assert.equal(result.requestedWindow, undefined);
      assert.equal(result.windowFallback, undefined);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("fetchOpenAI: both windows present + request 5h -> exact match, no fallback fields (regression)", async () => {
  const { xdg } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: 20 },
          secondary_window: { limit_window_seconds: 604800, used_percent: 10 },
        },
      }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const result = await readWeekly({ provider: "openai", window: "5h", cacheFile: null, timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.equal(result.window, "5h");
      assert.equal(result.requestedWindow, undefined);
      assert.equal(result.windowFallback, undefined);
      assert.equal(result.remaining, 80);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("fetchOpenAI: no windows at all -> existing error, unaffected by fallback logic", async () => {
  const { xdg } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ rate_limit: {} }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const result = await readWeekly({ provider: "openai", window: "5h", cacheFile: null, timeoutMs: 1000 });
      assert.equal(result.ok, false);
      assert.match(result.error, /no 5h window entry/);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("fetchAnthropic: CLI exposes only five_hour + request Weekly -> falls back via CLI, no HTTP call", async () => {
  const { bin } = sandbox();
  writeClaudeStubWith(bin, { five_hour: { used_percentage: 15, resets_at: "2030-01-01T00:00:00Z" } });
  const savedFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("HTTP should not be called when CLI provides a fallback window");
  };
  try {
    await withEnv({ OPENCODE_QUOTA_CLAUDE_BIN: bin }, async () => {
      const result = await readWeekly({ provider: "anthropic", window: "Weekly", cacheFile: null, timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.equal(result.window, "5h");
      assert.equal(result.requestedWindow, "Weekly");
      assert.equal(result.windowFallback, true);
      assert.equal(result.remaining, 85);
      assert.equal(fetchCalls, 0);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("fetchAnthropic: HTTP path exposes only seven_day + request 5h -> falls back", async () => {
  const { home, xdg, bin } = sandbox();
  // CLI present but authenticated with no quota windows at all -> falls through
  // to the HTTP path (mirrors the "noWindows" pattern in test/quota-cache.test.js).
  writeClaudeStubWith(bin, {});
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
    "utf8",
  );
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ seven_day: { utilization: 40 } }),
  });
  try {
    await withEnv(
      { HOME: home, XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_CLAUDE_BIN: bin },
      async () => {
        const result = await readWeekly({ provider: "anthropic", window: "5h", cacheFile: null, timeoutMs: 1000 });
        assert.equal(result.ok, true);
        assert.equal(result.window, "Weekly");
        assert.equal(result.requestedWindow, "5h");
        assert.equal(result.windowFallback, true);
        assert.equal(result.remaining, 60);
      },
    );
  } finally {
    global.fetch = savedFetch;
  }
});

test("readWeekly: fallback persisted under REQUESTED cache key with effective result.window", async () => {
  const { xdg, cacheFile } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 8 } } }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const result = await readWeekly({ provider: "openai", window: "5h", cacheFile, timeoutMs: 1000 });
      assert.equal(result.windowFallback, true);

      const stored = JSON.parse(readFileSync(cacheFile, "utf8"))["openai:5h"];
      assert.ok(stored, "expected the fallback result stored under the REQUESTED key openai:5h");
      assert.equal(stored.result.window, "Weekly");
      assert.equal(stored.result.requestedWindow, "5h");
      assert.equal(stored.result.windowFallback, true);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("readWeekly: a pre-seeded mislabeled ok-entry is overwritten by the next successful (fallback) refresh", async () => {
  const { xdg, cacheFile } = sandbox();
  writeOpenAIAuth(xdg);

  // Seed the REAL poisoned shape: an old positional-picker result mislabeled
  // as "5h" when it was actually 7d/Weekly data, cached under "openai:5h".
  writeFileSync(
    cacheFile,
    JSON.stringify(
      {
        "openai:5h": {
          at: 1000,
          nextAllowedAt: 0,
          result: { ok: true, status: "ok", remaining: 50, resetAt: null, unlimited: false, window: "5h" },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 8 } } }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      // cacheTtlMs/minRefreshIntervalMs = 0 and a huge elapsed time force the
      // stale cache entry to be bypassed and a real refresh to occur.
      const result = await readWeekly({
        provider: "openai",
        window: "5h",
        cacheFile,
        cacheTtlMs: 0,
        minRefreshIntervalMs: 0,
        timeoutMs: 1000,
      });
      assert.equal(result.ok, true);
      assert.equal(result.window, "Weekly");
      assert.equal(result.remaining, 92);

      const stored = JSON.parse(readFileSync(cacheFile, "utf8"))["openai:5h"];
      assert.equal(stored.result.window, "Weekly"); // poisoned "5h" label corrected
      assert.equal(stored.result.remaining, 92);
    });
  } finally {
    global.fetch = savedFetch;
  }
});

test("readWeekly: a fresh decorated cache read preserves windowFallback/requestedWindow", async () => {
  const { xdg, cacheFile } = sandbox();
  writeOpenAIAuth(xdg);
  const savedFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 8 } } }),
  });
  try {
    await withEnv({ XDG_DATA_HOME: xdg }, async () => {
      const first = await readWeekly({
        provider: "openai",
        window: "5h",
        cacheFile,
        cacheTtlMs: 60_000,
        minRefreshIntervalMs: 60_000,
        timeoutMs: 1000,
      });
      assert.equal(first.windowFallback, true);

      let fetchCallsAfterFirst = 0;
      global.fetch = async () => {
        fetchCallsAfterFirst += 1;
        throw new Error("should be served from fresh cache");
      };

      const second = await readWeekly({
        provider: "openai",
        window: "5h",
        cacheFile,
        cacheTtlMs: 60_000,
        minRefreshIntervalMs: 60_000,
        timeoutMs: 1000,
      });
      assert.equal(fetchCallsAfterFirst, 0);
      assert.equal(second.windowFallback, true);
      assert.equal(second.requestedWindow, "5h");
      assert.equal(second.window, "Weekly");
    });
  } finally {
    global.fetch = savedFetch;
  }
});
