import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, resolveQuotaProvider } from "../lib/evaluate.js";

const CFG = { minRemaining: 30, blockOnError: true, blockOnAuthError: false, cacheTtlMs: 60000, timeoutMs: 20000, minRefreshIntervalMs: 120000, staleBlockMarginPct: 10 };

// Build a normalized ok result as returned by readWeekly().
function okRes(weeklyRemaining, extra = {}) {
  return {
    ok: true,
    status: "ok",
    remaining: weeklyRemaining,
    resetAt: null,
    unlimited: false,
    window: "Weekly",
    ...extra,
  };
}

// Build a normalized error result as returned by readWeekly().
// errorKind defaults to "unknown" (uses blockOnError path in evaluate).
function errRes(error, errorKind = "unknown") {
  return { ok: false, status: "error", remaining: null, resetAt: null, unlimited: false, error, errorKind };
}

test("provider mapping", () => {
  assert.equal(resolveQuotaProvider("anthropic"), "anthropic");
  assert.equal(resolveQuotaProvider("claude-x"), "anthropic");
  assert.equal(resolveQuotaProvider("openai"), "openai");
  assert.equal(resolveQuotaProvider("codex"), "openai");
  assert.equal(resolveQuotaProvider("github-copilot"), null);
  assert.equal(resolveQuotaProvider(undefined), null);
});

test("allows when weekly remaining >= threshold", () => {
  const r = evaluate("anthropic", okRes(82), CFG);
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("blocks when weekly remaining < threshold", () => {
  const r = evaluate("anthropic", okRes(20), CFG);
  assert.equal(r.block, true);
  assert.equal(r.reason, "below-threshold");
});

test("unlimited weekly never blocks", () => {
  const r = evaluate("anthropic", okRes(0, { unlimited: true }), CFG);
  assert.equal(r.block, false);
  assert.equal(r.reason, "unlimited");
});

test("blind-by-backoff blocks inside margin", () => {
  const now = Date.now();
  const r = evaluate(
    "anthropic",
    okRes(35, { receivedAt: now, backoffUntil: now + 60000 }),
    CFG,
  );
  assert.equal(r.block, true);
  assert.equal(r.reason, "stale-failsafe");
});

test("blind-by-age blocks inside margin", () => {
  const now = Date.now();
  const r = evaluate("anthropic", okRes(35, { receivedAt: now - 400000 }), CFG, now);
  assert.equal(r.block, true);
  assert.equal(r.reason, "stale-failsafe");
});

test("ordinary stale age at defaults does not block", () => {
  const now = Date.now();
  const r = evaluate("anthropic", okRes(35, { receivedAt: now - 90000 }), CFG, now);
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("healthy blind LKG allows", () => {
  const now = Date.now();
  const r = evaluate(
    "anthropic",
    okRes(89, { receivedAt: now, backoffUntil: now + 60000 }),
    CFG,
  );
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("stale margin 0 disables the fail-safe", () => {
  const now = Date.now();
  const r = evaluate("anthropic", okRes(35, { receivedAt: now - 400000 }), { ...CFG, staleBlockMarginPct: 0 }, now);
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("resetAt in the past exempts stale fail-safe", () => {
  const now = Date.now();
  const r = evaluate(
    "anthropic",
    okRes(35, { receivedAt: now - 400000, backoffUntil: now + 60000, resetAt: new Date(now - 60000).toISOString() }),
    CFG,
    now,
  );
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("missing receivedAt stays non-blind", () => {
  const now = Date.now();
  const r = evaluate("anthropic", okRes(35, { backoffUntil: undefined }), CFG, now);
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("strict boundary at threshold plus margin allows", () => {
  const now = Date.now();
  const r = evaluate("anthropic", okRes(40, { receivedAt: now - 400000, backoffUntil: now + 60000 }), CFG, now);
  assert.equal(r.block, false);
  assert.equal(r.reason, "ok");
});

test("timeout/unknown error blocks when blockOnError=true", () => {
  const r = evaluate("anthropic", errRes("cli-failed", "unknown"), CFG);
  assert.equal(r.block, true);
});

test("timeout/unknown error allows when blockOnError=false", () => {
  const r = evaluate("anthropic", errRes("cli-failed", "unknown"), { ...CFG, blockOnError: false });
  assert.equal(r.block, false);
});

test("ratelimit errors always fail open", () => {
  const r = evaluate("anthropic", errRes("Anthropic API error 429: too many requests", "ratelimit"), CFG);
  assert.equal(r.block, false);
  assert.equal(r.reason, "error-allowed:rate-limited");
});

test("unreadable error allows by default (blockOnAuthError=false)", () => {
  const r = evaluate("anthropic", errRes("no provider data in response", "unreadable"), CFG);
  assert.equal(r.block, false);
  assert.ok(r.reason.startsWith("auth-error-allowed:"));
});

test("unreadable error blocks when blockOnAuthError=true", () => {
  const r = evaluate("anthropic", errRes("no provider data in response", "unreadable"), { ...CFG, blockOnAuthError: true });
  assert.equal(r.block, true);
  assert.ok(r.reason.startsWith("auth-error:"));
});

test("unreadable error (window absent) allows by default", () => {
  const r = evaluate("anthropic", errRes("no Weekly window entry", "unreadable"), CFG);
  assert.equal(r.block, false);
});

test("5h window: allows when 5h remaining >= threshold", () => {
  const r = evaluate("anthropic", okRes(82, { window: "5h" }), { ...CFG, window: "5h" });
  assert.equal(r.block, false);
});

test("5h window: blocks when 5h remaining < threshold", () => {
  const r = evaluate("anthropic", okRes(20, { window: "5h" }), { ...CFG, window: "5h" });
  assert.equal(r.block, true);
});

test("5h window: unreadable error allows by default", () => {
  const r = evaluate("anthropic", errRes("no 5h window entry", "unreadable"), { ...CFG, window: "5h" });
  assert.equal(r.block, false);
});

// New: auth error kind tests
test("auth error allows by default (blockOnAuthError=false)", () => {
  const r = evaluate("anthropic", errRes("Token expired", "auth"), CFG);
  assert.equal(r.block, false);
  assert.ok(r.reason.startsWith("auth-error-allowed:"));
});

test("auth error blocks when blockOnAuthError=true", () => {
  const r = evaluate("anthropic", errRes("Token expired", "auth"), { ...CFG, blockOnAuthError: true });
  assert.equal(r.block, true);
  assert.ok(r.reason.startsWith("auth-error:"));
});

// New: timeout error kind tests (uses blockOnError, not blockOnAuthError)
test("timeout error blocks when blockOnError=true", () => {
  const r = evaluate("anthropic", errRes("timed out after 20000ms", "timeout"), CFG);
  assert.equal(r.block, true);
  assert.ok(r.reason.startsWith("error:"));
});

test("timeout error allows when blockOnError=false", () => {
  const r = evaluate("anthropic", errRes("timed out after 20000ms", "timeout"), { ...CFG, blockOnError: false });
  assert.equal(r.block, false);
  assert.ok(r.reason.startsWith("error-allowed:"));
});
