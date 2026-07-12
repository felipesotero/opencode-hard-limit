/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup, onMount } from "solid-js";

import { MONITORED_PROVIDERS, readWeekly, quotaCachePath } from "./lib/quota.js";
import { resolveConfig } from "./lib/config.js";

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

type WeeklyQuotaResult = {
  ok: boolean;
  status: "ok" | "error";
  remaining: number | null;
  resetAt: string | number | null;
  unlimited: boolean;
  window?: string;
  error?: string;
  stale?: boolean;
  receivedAt?: number;
};

type QuotaSnapshot = WeeklyQuotaResult & {
  receivedAt: number;
};

type QuotaMap = Record<string, QuotaSnapshot | undefined>;

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

function safeWindow(projectDir: string): string {
  try {
    const cfg = resolveConfig({ projectDir }).values;
    const w = String(cfg.window ?? "Weekly");
    return w === "5h" ? "5h" : "Weekly";
  } catch {
    return "Weekly";
  }
}

function normalizeResult(result: WeeklyQuotaResult): QuotaSnapshot {
  const receivedAt = typeof result.receivedAt === "number" ? result.receivedAt : Date.now();
  return {
    ...result,
    receivedAt,
  };
}

function errorSnapshot(message?: string): QuotaSnapshot {
  return normalizeResult({
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
  return `stale ${minutes}m`;
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

function formatResetCountdown(resetAt: string | number | null | undefined): string | null {
  if (resetAt === null || resetAt === undefined || resetAt === "") return null;

  // resetAt may arrive as an ISO string, an epoch in seconds, or an epoch in
  // milliseconds. The quota CLI currently returns epoch seconds as a number, so
  // normalize before constructing a Date. Values below 1e12 are treated as
  // seconds and scaled to milliseconds; larger numeric values are already ms.
  let resetTime: number;
  if (typeof resetAt === "number") {
    resetTime = resetAt < 1e12 ? resetAt * 1000 : resetAt;
  } else {
    const digits = /^\d+$/.test(resetAt.trim());
    if (digits) {
      const n = Number(resetAt.trim());
      resetTime = n < 1e12 ? n * 1000 : n;
    } else {
      resetTime = new Date(resetAt).getTime();
    }
  }
  if (!Number.isFinite(resetTime)) return null;

  const diff = resetTime - Date.now();
  if (diff <= 0) return null;

  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);

  return `Resets in ${hours}h ${minutes}min`;
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
  const quotaWindow = safeWindow(projectDir);
  const [snapshot, setSnapshot] = createSignal<QuotaMap>({});

  let inFlight = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    if (inFlight || props.api.lifecycle.signal.aborted) return;
    inFlight = true;

    try {
      await Promise.all(
        MONITORED_PROVIDERS.map(async (provider) => {
          let next: QuotaSnapshot;

          try {
            const result = (await readWeekly({
              provider: provider.id,
              window: quotaWindow,
              timeoutMs: READ_TIMEOUT_MS,
              cacheTtlMs: cfg.cacheTtlMs,
              minRefreshIntervalMs: cfg.minRefreshIntervalMs,
              rateLimitBackoffMs: cfg.rateLimitBackoffMs,
              cacheFile: quotaCachePath(),
            })) as WeeklyQuotaResult;
            next = result.status === "ok" ? normalizeResult(result) : errorSnapshot(result.error ?? "quota unavailable");
          } catch (error) {
            next = errorSnapshot(error instanceof Error ? error.message : "quota unavailable");
          }

          if (props.api.lifecycle.signal.aborted) return;

          setSnapshot((current) => {
            const previous = current[provider.id];
            if (next.status === "error" && previous?.status === "ok") {
              return {
                ...current,
                [provider.id]: {
                  ...previous,
                  stale: true,
                },
              };
            }

            const carriedResetAt = next.status === "ok" && (next.resetAt === null || next.resetAt === undefined) && hasResetAt(previous)
              ? previous.resetAt
              : next.resetAt;

            return {
              ...current,
              [provider.id]: {
                ...next,
                resetAt: carriedResetAt,
              },
            };
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

  const providerStates = () =>
    MONITORED_PROVIDERS.map((provider) => ({
      provider,
      state: snapshot()[provider.id],
    }));

  const hasAnyResult = () => providerStates().some(({ state }) => Boolean(state));
  const renderableProviders = () => providerStates().filter(({ state }) => Boolean(state));
  const shouldShowChecking = () => !hasAnyResult();

  return (
    <box gap={1} flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.text} wrapMode="none">
          <b>Quota ({quotaWindow})</b>
        </text>
      </box>

      <box gap={1} flexDirection="column">
        {shouldShowChecking() ? (
          <text fg={theme.textMuted} wrapMode="none">
            checking...
          </text>
        ) : (
          renderableProviders().map(({ provider, state }) => {
            const unlimited = state?.unlimited === true;

            if (state?.status === "error" && !unlimited) {
              const warnTone = theme.warning ?? theme.error;
              const reason =
                typeof state?.error === "string" && state.error.trim() ? state.error : "unavailable";
              return (
                <box flexDirection="column">
                  <text fg={theme.text} wrapMode="none">
                    <b>{provider.label}</b>
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
            const resetText = formatResetCountdown(state?.resetAt);
            const staleText = state?.stale ? `· ${formatStaleAge(state.receivedAt)}` : null;

            return (
              <box gap={0} flexDirection="column">
                <box flexDirection="row">
                  <text fg={theme.text} wrapMode="none">
                    <b>{provider.label}</b>
                  </text>
                  <text fg={tone} wrapMode="none">
                    {` ${stateText}`}
                  </text>
                  {staleText ? (
                    <text fg={theme.textMuted} wrapMode="none">
                      {` ${staleText}`}
                    </text>
                  ) : null}
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

              </box>
            );
          })
        )}
      </box>
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
