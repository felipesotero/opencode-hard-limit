import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, resolveQuotaProvider } from "../lib/evaluate.js";

const CFG = { minRemaining: 30, blockOnError: true, cacheTtlMs: 60000, timeoutMs: 20000 };

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
function errRes(error) {
  return { ok: false, status: "error", remaining: null, resetAt: null, unlimited: false, error };
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
});

test("blocks when weekly remaining < threshold", () => {
  const r = evaluate("anthropic", okRes(20), CFG);
  assert.equal(r.block, true);
});

test("unlimited weekly never blocks", () => {
  const r = evaluate("anthropic", okRes(0, { unlimited: true }), CFG);
  assert.equal(r.block, false);
});

test("fail-safe: blocks on error when blockOnError=true", () => {
  const r = evaluate("anthropic", errRes("cli-failed"), CFG);
  assert.equal(r.block, true);
});

test("fail-open: allows on error when blockOnError=false", () => {
  const r = evaluate("anthropic", errRes("cli-failed"), { ...CFG, blockOnError: false });
  assert.equal(r.block, false);
});

test("blocks when provider node missing (fail-safe)", () => {
  const r = evaluate("anthropic", errRes("no provider data in response"), CFG);
  assert.equal(r.block, true);
});

test("blocks when Weekly window absent (fail-safe)", () => {
  const r = evaluate("anthropic", errRes("no Weekly window entry"), CFG);
  assert.equal(r.block, true);
});

test("5h window: allows when 5h remaining >= threshold", () => {
  const r = evaluate("anthropic", okRes(82, { window: "5h" }), { ...CFG, window: "5h" });
  assert.equal(r.block, false);
});

test("5h window: blocks when 5h remaining < threshold", () => {
  const r = evaluate("anthropic", okRes(20, { window: "5h" }), { ...CFG, window: "5h" });
  assert.equal(r.block, true);
});

test("5h window: fail-safe blocks on error when blockOnError=true", () => {
  const r = evaluate("anthropic", errRes("no 5h window entry"), { ...CFG, window: "5h" });
  assert.equal(r.block, true);
});
