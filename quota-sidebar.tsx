/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup, onMount } from "solid-js";

import { MONITORED_PROVIDERS, readAccountsWeekly, quotaCachePath } from "./lib/quota.js";
import { resolveConfig, windowForProvider } from "./lib/config.js";
import { formatReset } from "./lib/reset.js";
import { isPostponeActive, DEFAULT_POSTPONE_MINUTES } from "./lib/postpone.js";

const PLUGIN_ID = "felipesotero.quota-sidebar";
const SIDEBAR_ORDER = 175;
const DEFAULT_POLL_INTERVAL_MS = 120_000;
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.OPENCODE_QUOTA_SIDEBAR_POLL_MS;
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
})();
const READ_TIMEOUT_MS = 10_000;
const BAR_WIDTH = 14;
const SAFE_HEADROOM_BAND = 30;
const STALE_ANNOTATION_MIN_AGE_MS = 5 * 60 * 1000; // only show the stale hint once the snapshot is older than 5 minutes

type WeeklyQuotaResult = {
  ok: boolean;
  status: "ok" | "error";
  remaining: number | null;
  resetAt: string | number | null;
  unlimited: boolean;
  window?: string;
  windowFallback?: boolean;
  requestedWindow?: string;
  error?: string;
  stale?: boolean;
  receivedAt?: number;
};

// One entry per discovered account (or a single synthetic "default" entry
// when no multi-account store is found for that provider) — see
// lib/quota.js's readAccountsWeekly() and lib/accounts.js.
type AccountQuotaResult = WeeklyQuotaResult & {
  accountId: string;
  accountLabel: string;
  isActive: boolean;
};

type QuotaSnapshot = WeeklyQuotaResult & {
  receivedAt: number;
  accountLabel: string;
  isActive: boolean;
};

// Keyed by `${providerId}:${accountId}` so pro/max/multiple-OpenAI-accounts
// each hold their own independent signal slot.
type QuotaMap = Record<string, QuotaSnapshot | undefined>;

function rowKey(providerId: string, accountId: string): string {
  return `${providerId}:${accountId}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundPercent(value: number): number {
  return Math.round(value);
}

function lerp(valueA: number, valueB: number, t: number): number {
  return valueA + (valueB - valueA) * t;
}

function lerpColor(from: RGBA, to: RGBA, t: number): RGBA {
  return RGBA.fromValues(lerp(from.r, to.r, t), lerp(from.g, to.g, t), lerp(from.b, to.b, t), lerp(from.a, to.a, t));
}

function safeMinRemaining(projectDir: string): number {
  try {
    const cfg = resolveConfig({ projectDir }).values;
    const value = typeof cfg.minRemaining === "number" && Number.isFinite(cfg.minRemaining) ? cfg.minRemaining : 30;
    return clamp(value, 0, 100);
  } catch {
    return 30;
  }
}

function safeWindowFor(projectDir: string, providerId: string): string {
  try {
    const cfg = resolveConfig({ projectDir }).values;
    const w = String(windowForProvider(cfg, providerId) ?? "Weekly");
    return w === "5h" ? "5h" : "Weekly";
  } catch {
    return "Weekly";
  }
}

function normalizeResult(result: AccountQuotaResult): QuotaSnapshot {
  const receivedAt = typeof result.receivedAt === "number" ? result.receivedAt : Date.now();
  return {
    ...result,
    receivedAt,
  };
}

function errorSnapshot(result: AccountQuotaResult, message?: string): QuotaSnapshot {
  return normalizeResult({
    ...result,
    ok: false,
    status: "error",
    remaining: null,
    resetAt: null,
    unlimited: false,
    error: message,
  });
}

function formatStaleAge(receivedAt: number): string {
  const diff = Math.max(0, Date.now() - receivedAt);
  const minutes = Math.max(1, Math.round(diff / 60_000));
  return `Last read ${minutes}m ago`;
}

function gradientTone(theme: { success: RGBA; warning: RGBA; error: RGBA }, remaining: number, minRemaining: number): RGBA {
  if (remaining <= minRemaining) return theme.error;

  const headroom = remaining - minRemaining;
  const proximity = clamp(1 - headroom / SAFE_HEADROOM_BAND, 0, 1);

  if (proximity < 0.5) {
    return lerpColor(theme.success, theme.warning, proximity * 2);
  }

  return lerpColor(theme.warning, theme.error, (proximity - 0.5) * 2);
}

function buildBar(remaining: number, minRemaining: number): { filled: string; empty: string; marker: string } {
  const filledCells = clamp(Math.round((remaining / 100) * BAR_WIDTH), 0, BAR_WIDTH);
  const markerIndex = clamp(Math.round((minRemaining / 100) * BAR_WIDTH), 0, BAR_WIDTH - 1);

  return {
    filled: "█".repeat(filledCells),
    empty: "░".repeat(BAR_WIDTH - filledCells),
    marker: `${" ".repeat(markerIndex)}^${" ".repeat(BAR_WIDTH - markerIndex - 1)}`,
  };
}

function hasResetAt(value: QuotaSnapshot | undefined): value is QuotaSnapshot & { resetAt: string | number } {
  return Boolean(value && value.resetAt !== null && value.resetAt !== undefined && value.resetAt !== "");
}

function SidebarContentView(props: { api: TuiPluginApi; sessionID: string }) {
  void props.sessionID;

  const theme = props.api.theme.current;
  const projectDir = props.api.state.path.directory;
  const cfg = resolveConfig({ projectDir }).values;
  const minRemaining = safeMinRemaining(projectDir);
  const windows: Record<string, string> = {};
  for (const provider of MONITORED_PROVIDERS) {
    windows[provider.id] = safeWindowFor(projectDir, provider.id);
  }
  const [snapshot, setSnapshot] = createSignal<QuotaMap>({});

  let inFlight = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    if (inFlight || props.api.lifecycle.signal.aborted) return;
    inFlight = true;

    try {
      await Promise.all(
        MONITORED_PROVIDERS.map(async (provider) => {
          let results: AccountQuotaResult[];

          try {
            results = (await readAccountsWeekly({
              provider: provider.id,
              window: windows[provider.id],
              timeoutMs: READ_TIMEOUT_MS,
              cacheTtlMs: cfg.cacheTtlMs,
              minRefreshIntervalMs: cfg.minRefreshIntervalMs,
              rateLimitBackoffMs: cfg.rateLimitBackoffMs,
              maxRateLimitBackoffMs: cfg.maxRateLimitBackoffMs,
              noBaselineRateLimitBackoffMs: cfg.noBaselineRateLimitBackoffMs,
              cacheFile: quotaCachePath(),
              anthropicProfileDirs: cfg.anthropicProfileDirs,
              openaiAccountsFile: cfg.openaiAccountsFile,
            })) as AccountQuotaResult[];
          } catch (error) {
            results = [
              {
                ok: false,
                status: "error",
                remaining: null,
                resetAt: null,
                unlimited: false,
                error: error instanceof Error ? error.message : "quota unavailable",
                accountId: "default",
                accountLabel: provider.label,
                isActive: true,
              },
            ];
          }

          if (props.api.lifecycle.signal.aborted) return;

          setSnapshot((current) => {
            const next = { ...current };
            for (const result of results) {
              const key = rowKey(provider.id, result.accountId);
              const normalized =
                result.status === "ok" ? normalizeResult(result) : errorSnapshot(result, result.error ?? "quota unavailable");

              const previous = next[key];
              if (normalized.status === "error" && previous?.status === "ok") {
                next[key] = { ...previous, stale: true };
                continue;
              }

              // quotaWindow is fixed per mount so a mismatch is currently unreachable;
              // guard is defensive against TUI reload/config-change semantics we don't control.
              const carriedResetAt =
                normalized.status === "ok" &&
                (normalized.resetAt === null || normalized.resetAt === undefined) &&
                hasResetAt(previous) &&
                previous.window === normalized.window
                  ? previous.resetAt
                  : normalized.resetAt;

              next[key] = { ...normalized, resetAt: carriedResetAt };
            }
            return next;
          });
        }),
      );
    } catch {
      // keep the polling cadence intact even if one refresh fails unexpectedly
    } finally {
      inFlight = false;
    }
  };

  onMount(() => {
    void refresh().catch(() => {});
    interval = setInterval(() => {
      void refresh().catch(() => {});
    }, POLL_INTERVAL_MS);

    props.api.lifecycle.onDispose(() => {
      if (interval) clearInterval(interval);
    });
  });

  onCleanup(() => {
    if (interval) clearInterval(interval);
  });

  // Flatten the snapshot map into a stable, provider-ordered list of rows —
  // one row per discovered account. Ordering: MONITORED_PROVIDERS order
  // first (Claude before OpenAI), then account id within a provider.
  const rows = () => {
    const map = snapshot();
    const providerOrder = MONITORED_PROVIDERS.map((p) => p.id);
    return Object.keys(map)
      .filter((key) => Boolean(map[key]))
      .sort((a, b) => {
        const pa = a.slice(0, a.indexOf(":"));
        const pb = b.slice(0, b.indexOf(":"));
        const oa = providerOrder.indexOf(pa);
        const ob = providerOrder.indexOf(pb);
        if (oa !== ob) return oa - ob;
        return a.localeCompare(b);
      })
      .map((key) => ({ key, providerId: key.slice(0, key.indexOf(":")), state: map[key]! }));
  };

  // Only tag a row "(active)" when its provider actually has more than one
  // account — the trivial single/"default" account case stays unlabeled, as
  // before this feature existed.
  const providerRowCounts = () => {
    const counts: Record<string, number> = {};
    for (const { providerId } of rows()) counts[providerId] = (counts[providerId] ?? 0) + 1;
    return counts;
  };

  const hasAnyResult = () => rows().length > 0;
  const shouldShowChecking = () => !hasAnyResult();

  const isRowBlocked = (state: QuotaSnapshot | undefined) => {
    if (!state || state.unlimited === true) return false;
    const remainingValue = typeof state.remaining === "number" ? clamp(state.remaining, 0, 100) : null;
    return typeof remainingValue === "number" && remainingValue <= minRemaining;
  };
  const showPostponeHint = () =>
    cfg.allowPostpone === true && !isPostponeActive() && rows().some(({ state }) => isRowBlocked(state));

  return (
    <box gap={1} flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.text} wrapMode="none">
          <b>Quota</b>
        </text>
      </box>

      <box gap={1} flexDirection="column">
        {shouldShowChecking() ? (
          <text fg={theme.textMuted} wrapMode="none">
            checking...
          </text>
        ) : (
          (() => {
            const counts = providerRowCounts();
            return rows().map(({ key, providerId, state }) => {
              const unlimited = state?.unlimited === true;
              const showActiveTag = state.isActive && (counts[providerId] ?? 0) > 1;
              const label = showActiveTag ? `${state.accountLabel} (active)` : state.accountLabel;

              if (state?.status === "error" && !unlimited) {
                const warnTone = theme.warning ?? theme.error;
                const reason = typeof state?.error === "string" && state.error.trim() ? state.error : "unavailable";
                return (
                  <box flexDirection="column">
                    <text fg={theme.text} wrapMode="none">
                      <b>{label}</b>
                    </text>
                    <text fg={warnTone} wrapMode="wrap">
                      {`unavailable (${reason})`}
                    </text>
                  </box>
                );
              }
              const remainingValue = typeof state?.remaining === "number" ? clamp(state.remaining, 0, 100) : null;
              const blocked = typeof remainingValue === "number" && remainingValue <= minRemaining;
              const tone = unlimited
                ? theme.success
                : remainingValue === null
                  ? theme.textMuted
                  : gradientTone(theme, remainingValue, minRemaining);
              const stateText = unlimited
                ? "unlimited"
                : typeof remainingValue === "number"
                  ? `${roundPercent(remainingValue)}% left, limit ${roundPercent(minRemaining)}%`
                  : "quota unavailable";
              const bar = typeof remainingValue === "number" ? buildBar(remainingValue, minRemaining) : null;
              const markerTone = blocked ? theme.error : theme.border;
              const effectiveWindow = state?.window ?? windows[providerId];
              const resetText = formatReset(state?.resetAt, effectiveWindow);
              const staleText =
                state?.stale && Number.isFinite(state.receivedAt) && Date.now() - state.receivedAt > STALE_ANNOTATION_MIN_AGE_MS
                  ? `· ${formatStaleAge(state.receivedAt)}`
                  : null;

              return (
                <box gap={0} flexDirection="column">
                  <box flexDirection="row">
                    <text fg={theme.text} wrapMode="none">
                      <b>{label}</b>
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {` ${effectiveWindow}`}
                    </text>
                    <text fg={tone} wrapMode="none">
                      {` ${stateText}`}
                    </text>
                  </box>

                  {bar ? (
                    <box gap={0} flexDirection="column">
                      <box flexDirection="row">
                        <text fg={tone} wrapMode="none">
                          {bar.filled}
                        </text>
                        <text fg={theme.textMuted} wrapMode="none">
                          {bar.empty}
                        </text>
                      </box>
                      <box flexDirection="row">
                        <text fg={markerTone} wrapMode="none">
                          {bar.marker}
                        </text>
                      </box>
                    </box>
                  ) : null}

                  {resetText ? (
                    <text fg={theme.textMuted} wrapMode="none">
                      {resetText}
                    </text>
                  ) : null}

                  {staleText ? (
                    <text fg={theme.textMuted} wrapMode="none">
                      {staleText}
                    </text>
                  ) : null}
                </box>
              );
            });
          })()
        )}
      </box>

      {showPostponeHint() ? (
        <box gap={0} flexDirection="column">
          <text fg={theme.error} wrapMode="wrap">
            {`To postpone the blockage for ${DEFAULT_POSTPONE_MINUTES} min: `}
          </text>
          <text fg={theme.error} wrapMode="wrap">
            {`type !, then paste: `}
          </text>
          <text fg={theme.error} wrapMode="wrap">
            {`opencode-hard-limit postpone ${DEFAULT_POSTPONE_MINUTES}`}
          </text>
        </box>
      ) : null}
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarContentView api={api} sessionID={props.session_id} />;
      },
    },
  });
};

export default {
  id: PLUGIN_ID,
  tui,
} satisfies TuiPluginModule;
