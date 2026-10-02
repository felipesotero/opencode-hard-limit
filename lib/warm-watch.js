// lib/warm-watch.js
//
// Loop driver for `opencode-hard-limit warm --watch`: each tick, reads every
// discovered Claude account's current quota + credentials-file mtime, asks
// lib/warm-schedule.js's decideWarmAction() what to do, warms the accounts
// that need it, and reports back the earliest next-tick time across all
// accounts so the caller (bin/cli.js) knows how long to sleep.
//
// State (the previous tick's mtime per account) is owned by the CALLER and
// passed back in on every call -- this file holds no process-lifetime state
// of its own, which keeps tickWarmSchedule() a plain testable async function.

import { statSync } from "node:fs";

import { discoverAnthropicAccounts } from "./accounts.js";
import { warmClaudeAccounts, DEFAULT_WARM_MODEL } from "./claude-warm.js";
import { readAccountsWeekly } from "./quota.js";
import { decideWarmAction, DEFAULT_IDLE_INTERVAL_MS, DEFAULT_POST_RESET_BUFFER_MS } from "./warm-schedule.js";

/**
 * Run one scheduling tick across every discovered Claude account.
 *
 * Options:
 *   cliPath          - path to the `claude` binary (required to actually warm;
 *                       with no cliPath, ticks still run and report decisions,
 *                       but never spawn anything).
 *   model            - model alias/name to warm with (default: haiku).
 *   window           - quota window to evaluate exhaustion against (default: "5h").
 *   idleIntervalMs / postResetBufferMs - forwarded to decideWarmAction().
 *   profileDirs      - forwarded to account discovery + the quota reader.
 *   state            - Map<accountId, { mtimeMs }>, mutated in place; pass the
 *                       same Map back on every tick so "in-use" detection
 *                       (the credentials file changing between ticks) works
 *                       across calls.
 *   now              - epoch ms "now" (injectable for tests).
 *   quotaReader, warmFn, statFn - injectable for tests.
 *
 * Returns { results, nextTickAt }, where each result is
 * { id, label, action, reason, nextCheckAt, warmResult }. Never throws: a
 * quota-read failure just means exhaustion can't be evaluated this tick
 * (falls through to "idle", so the account still gets warmed).
 */
export async function tickWarmSchedule({
  cliPath,
  model = DEFAULT_WARM_MODEL,
  window = "5h",
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  postResetBufferMs = DEFAULT_POST_RESET_BUFFER_MS,
  profileDirs,
  state = new Map(),
  now = Date.now(),
  quotaReader = readAccountsWeekly,
  warmFn = warmClaudeAccounts,
  statFn = statSync,
} = {}) {
  const accounts = discoverAnthropicAccounts({ profileDirs });
  if (accounts.length === 0) return { results: [], nextTickAt: now + idleIntervalMs };

  const quotaByAccount = new Map();
  try {
    const quotaResults = await quotaReader({ provider: "anthropic", window, anthropicProfileDirs: profileDirs });
    for (const r of quotaResults) quotaByAccount.set(r.accountId, r);
  } catch {
    // Unreadable this tick -- each account below falls back to remaining=null,
    // which decideWarmAction() treats as "idle, spendable" (safe default).
  }

  const results = [];
  // Seeded null, not now+idleIntervalMs: an exhausted account's nextCheckAt
  // can be much LATER than idleIntervalMs (e.g. ~76min out), and a fixed
  // ceiling here would wrongly cap the whole tick back down to idleIntervalMs.
  let nextTickAt = null;

  for (const account of accounts) {
    let currentMtimeMs;
    try {
      currentMtimeMs = statFn(account.credentialsPath).mtimeMs;
    } catch {
      // Unreadable -- treat as "just changed" so a vanished/unreadable file
      // never gets stuck reporting false "in-use" skips forever.
      currentMtimeMs = now;
    }

    const prev = state.get(account.id);
    const q = quotaByAccount.get(account.id);
    const remaining = q && q.ok ? q.remaining : null;
    const resetAtMs = q && q.ok && q.resetAt ? Date.parse(q.resetAt) : null;

    const decision = decideWarmAction({
      previousMtimeMs: prev ? prev.mtimeMs : null,
      currentMtimeMs,
      remaining,
      resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
      now,
      idleIntervalMs,
      postResetBufferMs,
    });

    let warmResult = null;
    if (decision.action === "warm" && cliPath) {
      const [r] = await warmFn({ cliPath, model, profileDirs: [account.configDir] });
      warmResult = r ?? null;
      // Our own warm just bumped mtime -- that must become the new baseline,
      // not get mistaken for external use on the next tick.
      try {
        currentMtimeMs = statFn(account.credentialsPath).mtimeMs;
      } catch {
        // keep the pre-warm value
      }
    }

    state.set(account.id, { mtimeMs: currentMtimeMs });
    nextTickAt = nextTickAt === null ? decision.nextCheckAt : Math.min(nextTickAt, decision.nextCheckAt);
    results.push({ id: account.id, label: account.label, ...decision, warmResult });
  }

  return { results, nextTickAt };
}
