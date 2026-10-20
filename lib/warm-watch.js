// lib/warm-watch.js
//
// Schedules credential-expiry checks for named Claude profiles and owns the
// abortable watch loop. All expensive warm calls are injected or delegated to
// claude-warm.js, which runs them sequentially.

import { discoverAnthropicProfiles } from "./accounts.js";
import { DEFAULT_WARM_MODEL, warmClaudeAccounts } from "./claude-warm.js";
import { readClaudeCredentialState } from "./quota.js";
import {
  DEFAULT_IDLE_INTERVAL_MS,
  decideWarmAction,
  nextBackoffMs,
} from "./warm-schedule.js";

const MIN_TICK_DELAY_MS = 1_000;

function clampNextTickAt(nextTickAt, now, idleIntervalMs) {
  const minAt = now + MIN_TICK_DELAY_MS;
  const maxAt = Math.max(minAt, now + idleIntervalMs);
  const candidate = Number.isFinite(nextTickAt) ? nextTickAt : maxAt;
  return Math.max(minAt, Math.min(maxAt, candidate));
}

/** Run one scheduling tick across the discovered named Claude profiles. */
export async function tickWarmSchedule({
  cliPath,
  flags,
  model = DEFAULT_WARM_MODEL,
  timeoutMs,
  profileDirs,
  state = new Map(),
  now = Date.now(),
  force = false,
  signal,
  discoverFn = discoverAnthropicProfiles,
  credStateFn = readClaudeCredentialState,
  warmFn = warmClaudeAccounts,
} = {}) {
  const requestedIdleIntervalMs = flags?.idleIntervalMs;
  const idleIntervalMs = Number.isFinite(requestedIdleIntervalMs)
    ? requestedIdleIntervalMs
    : DEFAULT_IDLE_INTERVAL_MS;
  const profiles = await discoverFn({ profileDirs });
  if (profiles.length === 0) {
    return { results: [], nextTickAt: now + idleIntervalMs, profileMode: false };
  }

  const results = [];
  let earliestNextCheckAt = Infinity;

  for (const profile of profiles) {
    if (signal?.aborted) break;

    const key = `cp:${profile.id}`;
    const previous = state.get(key) ?? { failures: 0, backoffUntil: 0 };
    const cred = await credStateFn(profile.credentialsPath);
    if (signal?.aborted) break;

    let decision = decideWarmAction({
      cred,
      now,
      backoffUntil: previous.backoffUntil,
      force,
      idleIntervalMs,
    });
    let warmResult = null;

    if (decision.action === "warm") {
      try {
        const warmResults = await warmFn({
          cliPath,
          flags,
          supportedFlags: flags?.supportedFlags,
          model,
          timeoutMs,
          profiles: [profile],
          signal,
        });
        warmResult = Array.isArray(warmResults) ? warmResults[0] ?? null : warmResults ?? null;
      } catch (error) {
        warmResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      if (warmResult?.reason === "settings-override" || warmResult?.reason === "no-refresh-token") {
        decision = {
          ...decision,
          action: "skip",
          reason: warmResult.reason,
          nextCheckAt: now + idleIntervalMs,
        };
      } else if (warmResult?.ok) {
        state.set(key, { failures: 0, backoffUntil: 0 });
      } else {
        const failures = (Number.isFinite(previous.failures) ? previous.failures : 0) + 1;
        const backoffUntil = now + nextBackoffMs(failures);
        state.set(key, { failures, backoffUntil });
        decision = { ...decision, nextCheckAt: backoffUntil };
      }
    }

    results.push({ id: profile.id, label: profile.label, expiresAt: cred?.expiresAt ?? null, ...decision, warmResult });
    earliestNextCheckAt = Math.min(earliestNextCheckAt, decision.nextCheckAt);
  }

  const nextCheckAt = results.length === 0 ? now + idleIntervalMs : earliestNextCheckAt;
  return {
    results,
    nextTickAt: clampNextTickAt(nextCheckAt, now, idleIntervalMs),
    profileMode: true,
  };
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Run scheduling ticks until the supplied AbortSignal is aborted. */
export async function runWarmWatch({
  tick,
  sleep = sleepAbortable,
  signal,
  log = (message) => console.error(message),
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
} = {}) {
  if (typeof tick !== "function") throw new TypeError("runWarmWatch requires a tick function");

  let consecutiveTickErrors = 0;
  const maxSleepMs = Number.isFinite(idleIntervalMs)
    ? Math.max(MIN_TICK_DELAY_MS, idleIntervalMs)
    : DEFAULT_IDLE_INTERVAL_MS;

  while (!signal?.aborted) {
    let nextTickAt;
    try {
      const result = await tick();
      nextTickAt = result?.nextTickAt;
      consecutiveTickErrors = 0;
    } catch (error) {
      consecutiveTickErrors += 1;
      log(error instanceof Error ? error.message : String(error));
      nextTickAt = Date.now() + nextBackoffMs(consecutiveTickErrors);
    }

    if (signal?.aborted) break;
    const remainingMs = Number.isFinite(nextTickAt) ? nextTickAt - Date.now() : 0;
    const sleepMs = Math.max(MIN_TICK_DELAY_MS, Math.min(maxSleepMs, remainingMs));
    await sleep(sleepMs, signal);
  }
}
