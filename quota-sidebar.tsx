/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup, onMount } from "solid-js";

import { MONITORED_PROVIDERS, readWeekly } from "./lib/quota.js";
import { resolveConfig } from "./lib/config.js";

const PLUGIN_ID = "felipesotero.quota-sidebar";
const SIDEBAR_ORDER = 150;
const POLL_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
const BAR_WIDTH = 14;
const SAFE_HEADROOM_BAND = 30;

type WeeklyQuotaResult = {
  ok: boolean;
  status: "ok" | "error";
  remaining: number | null;
  resetAt: string | null;
  unlimited: boolean;
  error?: string;
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

function normalizeResult(result: WeeklyQuotaResult): QuotaSnapshot {
  return {
    ...result,
    receivedAt: Date.now(),
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

function SidebarContentView(props: { api: TuiPluginApi; sessionID: string }) {
  void props.sessionID;

  const theme = props.api.theme.current;
  const minRemaining = safeMinRemaining(props.api.state.path.directory);
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
            const result = (await readWeekly({ provider: provider.id, timeoutMs: READ_TIMEOUT_MS })) as WeeklyQuotaResult;
            next = result.status === "ok" ? normalizeResult(result) : errorSnapshot(result.error ?? "quota unavailable");
          } catch (error) {
            next = errorSnapshot(error instanceof Error ? error.message : "quota unavailable");
          }

          if (props.api.lifecycle.signal.aborted) return;

          setSnapshot((current) => ({
            ...current,
            [provider.id]: next,
          }));
        }),
      );
    } finally {
      inFlight = false;
    }
  };

  onMount(() => {
    void refresh();
    interval = setInterval(() => {
      void refresh();
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
  const visibleProviders = () => providerStates().filter(({ state }) => state?.status === "ok" || state?.unlimited);
  const shouldShowChecking = () => !hasAnyResult();
  const shouldShowUnavailable = () => hasAnyResult() && visibleProviders().length === 0;

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
        ) : shouldShowUnavailable() ? (
          <text fg={theme.textMuted} wrapMode="none">
            quota unavailable
          </text>
        ) : (
          visibleProviders().map(({ provider, state }) => {
            const unlimited = state?.unlimited === true;
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

            return (
              <box gap={0} flexDirection="column">
                <box flexDirection="row">
                  <text fg={theme.text} wrapMode="none">
                    <b>{provider.label}</b>
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
