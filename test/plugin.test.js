import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, resolveQuotaProvider } from "../quota-hard-stop.js";

const CFG = { minRemaining: 30, blockOnError: true, cacheTtlMs: 60000, timeoutMs: 20000 };

function okRes(provider, weeklyRemaining, extra = {}) {
  return {
    ok: true,
    parsed: {
      providers: {
        [provider]: {
          status: "ok",
          entries: [
            { name: "5h", window: "5h", percentRemaining: 95, unlimited: false },
            { name: "Weekly", window: "Weekly", percentRemaining: weeklyRemaining, unlimited: false, ...extra },
          ],
        },
      },
    },
  };
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
  const r = evaluate("anthropic", okRes("anthropic", 82), CFG);
  assert.equal(r.block, false);
});

test("blocks when weekly remaining < threshold", () => {
  const r = evaluate("anthropic", okRes("anthropic", 20), CFG);
  assert.equal(r.block, true);
});

test("unlimited weekly never blocks", () => {
  const r = evaluate("anthropic", okRes("anthropic", 0, { unlimited: true }), CFG);
  assert.equal(r.block, false);
});

test("fail-safe: blocks on error when blockOnError=true", () => {
  const r = evaluate("anthropic", { ok: false, reason: "cli-failed" }, CFG);
  assert.equal(r.block, true);
});

test("fail-open: allows on error when blockOnError=false", () => {
  const r = evaluate("anthropic", { ok: false, reason: "cli-failed" }, { ...CFG, blockOnError: false });
  assert.equal(r.block, false);
});

test("blocks when provider node missing (fail-safe)", () => {
  const r = evaluate("anthropic", { ok: true, parsed: { providers: {} } }, CFG);
  assert.equal(r.block, true);
});

test("blocks when Weekly window absent (fail-safe)", () => {
  const res = {
    ok: true,
    parsed: { providers: { anthropic: { status: "ok", entries: [{ window: "5h", percentRemaining: 90 }] } } },
  };
  assert.equal(evaluate("anthropic", res, CFG).block, true);
});
