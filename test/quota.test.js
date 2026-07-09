// test/quota.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../lib/quota.js";

const {
  classifyError, parseAnthropicUsage, mapAnthropicWindow, extractAuthBoolean,
  mapOpenAIWindow, parseJwt, firstNumeric, extractClaudeCredToken,
} = __internals;

test("classifyError maps auth/timeout/unreadable", () => {
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

test("parseAnthropicUsage requires both windows, tries nested roots", () => {
  const flat = parseAnthropicUsage({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } });
  assert.equal(flat.five_hour.percentRemaining, 90);
  assert.equal(flat.seven_day.percentRemaining, 80);

  const nested = parseAnthropicUsage({ usage: { fiveHour: { used_percent: 0 }, sevenDay: { used_percent: 50 } } });
  assert.equal(nested.five_hour.percentRemaining, 100);
  assert.equal(nested.seven_day.percentRemaining, 50);

  assert.equal(parseAnthropicUsage({ five_hour: { utilization: 10 } }), null); // missing seven_day
  assert.equal(parseAnthropicUsage(null), null);
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
