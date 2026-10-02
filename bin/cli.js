#!/usr/bin/env node
// bin/cli.js
//
// CLI for opencode-hard-limit: configure the weekly-quota hard-stop threshold
// (and related settings) at either global or project scope, and install the
// plugin into OpenCode.

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULTS,
  resolveConfig,
  writeScope,
  globalConfigPath,
  projectConfigPath,
  PROVIDER_WINDOW_KEYS,
  windowForProvider,
} from "../lib/config.js";

import { readAccountsWeekly } from "../lib/quota.js";

import { warmClaudeAccounts, findClaudeBinary, DEFAULT_WARM_MODEL } from "../lib/claude-warm.js";

import { tickWarmSchedule } from "../lib/warm-watch.js";
import { DEFAULT_IDLE_INTERVAL_MS, DEFAULT_POST_RESET_BUFFER_MS } from "../lib/warm-schedule.js";

import {
  configDir,
  pluginsDir,
  tuiConfigPath,
  isSidebarEntry,
  ensureTuiDeployed,
  cleanupLegacyCopies,
} from "../lib/deploy.js";

import {
  writePostpone,
  readPostpone,
  clearPostpone,
  isPostponeActive,
  DEFAULT_POSTPONE_MINUTES,
} from "../lib/postpone.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

function print(s = "") {
  process.stdout.write(s + "\n");
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function promptScope() {
  if (!process.stdin.isTTY) {
    fail(
      "no scope given and not a TTY. Pass --global (all projects) or --project (current dir).",
    );
  }
  print("Where should this setting apply?");
  print(`  [1] Global   all OpenCode projects on this machine (recommended)`);
  print(`              -> ${globalConfigPath()}`);
  print(`  [2] Project  only the current directory`);
  print(`              -> ${projectConfigPath(process.cwd())}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Choose [1/2] (default 1): ")).trim();
  rl.close();
  if (answer === "2" || answer.toLowerCase() === "project") return "project";
  return "global";
}

function resolveScopeFlag(values) {
  if (values.global && values.project) {
    fail("pass only one of --global or --project.");
  }
  if (values.global) return "global";
  if (values.project) return "project";
  return null;
}

function buildPatch(values) {
  const patch = {};
  if (values.threshold !== undefined) patch.minRemaining = values.threshold;
  if (values["min-remaining"] !== undefined) patch.minRemaining = values["min-remaining"];
  if (values["block-on-error"] !== undefined) patch.blockOnError = values["block-on-error"];
  if (values["block-on-auth-error"] !== undefined) patch.blockOnAuthError = values["block-on-auth-error"];
  if (values["cache-ttl"] !== undefined) patch.cacheTtlMs = values["cache-ttl"];
  if (values["timeout"] !== undefined) patch.timeoutMs = values["timeout"];
  if (values["min-refresh"] !== undefined) patch.minRefreshIntervalMs = values["min-refresh"];
  if (values["rate-limit-backoff"] !== undefined) patch.rateLimitBackoffMs = values["rate-limit-backoff"];
  if (values["max-rate-limit-backoff"] !== undefined) patch.maxRateLimitBackoffMs = values["max-rate-limit-backoff"];
  if (values["no-baseline-rate-limit-backoff"] !== undefined) patch.noBaselineRateLimitBackoffMs = values["no-baseline-rate-limit-backoff"];
  if (values["stale-margin"] !== undefined) patch.staleBlockMarginPct = values["stale-margin"];
  if (values.window !== undefined) patch.window = values.window;
  if (values["window-anthropic"] !== undefined) patch.windowAnthropic = values["window-anthropic"];
  if (values["window-openai"] !== undefined) patch.windowOpenai = values["window-openai"];
  if (values["allow-postpone"] !== undefined) patch.allowPostpone = values["allow-postpone"];
  if (values["anthropic-profile-dirs"] !== undefined) patch.anthropicProfileDirs = values["anthropic-profile-dirs"];
  if (values["openai-accounts-file"] !== undefined) patch.openaiAccountsFile = values["openai-accounts-file"];
  return patch;
}

const SHARED_OPTIONS = {
  global: { type: "boolean" },
  project: { type: "boolean" },
  threshold: { type: "string" },
  "min-remaining": { type: "string" },
  "block-on-error": { type: "string" },
  "block-on-auth-error": { type: "string" },
  "cache-ttl": { type: "string" },
  timeout: { type: "string" },
  "min-refresh": { type: "string" },
  "rate-limit-backoff": { type: "string" },
  "max-rate-limit-backoff": { type: "string" },
  "no-baseline-rate-limit-backoff": { type: "string" },
  "stale-margin": { type: "string" },
  window: { type: "string" },
  "window-anthropic": { type: "string" },
  "window-openai": { type: "string" },
  "allow-postpone": { type: "string" },
  "anthropic-profile-dirs": { type: "string" },
  "openai-accounts-file": { type: "string" },
  model: { type: "string" },
  "warm-timeout": { type: "string" },
  watch: { type: "boolean" },
  "idle-interval": { type: "string" },
  "post-reset-buffer": { type: "string" },
  clear: { type: "boolean" },
  install: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function parse(argv) {
  return parseArgs({
    args: argv,
    options: SHARED_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
}

// Matches "opencode-hard-limit" or any pinned/versioned variant like
// "opencode-hard-limit@0.8.0" so dedupe and uninstall cover all forms.
const isOurs = (p) =>
  p === "opencode-hard-limit" || String(p).startsWith("opencode-hard-limit@");

function installPlugin() {
  // 1. Register the server plugin in opencode.json for native auto-update.
  //    OpenCode reads this on startup and runs BunProc.install + isOutdated.
  const ocPath = join(configDir(), "opencode.json");
  let ocData;
  let ocParseOk = true;

  if (existsSync(ocPath)) {
    try {
      const raw = JSON.parse(readFileSync(ocPath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      ocData = raw;
      if (!Array.isArray(ocData.plugin)) ocData.plugin = [];
    } catch {
      ocParseOk = false;
    }
  } else {
    ocData = { $schema: "https://opencode.ai/config.json", plugin: [] };
  }

  if (!ocParseOk) {
    print(`warning: ${ocPath} could not be parsed as JSON.`);
    print(`  Add "opencode-hard-limit" to the "plugin" array in that file manually.`);
  } else {
    // Dedupe: remove any pinned/versioned variants, then push bare name.
    ocData.plugin = ocData.plugin.filter((p) => !isOurs(p));
    ocData.plugin.push("opencode-hard-limit");
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(ocPath, JSON.stringify(ocData, null, 2) + "\n", "utf8");
  }

  // 2. Remove any legacy server files previously copied into plugins/
  //    (quota-hard-stop.js, lib/config.js, lib/quota.js, lib/evaluate.js).
  //    Skip when ocParseOk is false to avoid destroying a working legacy install
  //    while registration has failed.
  if (ocParseOk) cleanupLegacyCopies();

  // 3. Deploy TUI sidebar (atomic, idempotent), update tui.json, ensure deps.
  const { tuiWarning } = ensureTuiDeployed({ pkgRoot: PKG_ROOT });

  const pDir = pluginsDir();
  const tuiPath = tuiConfigPath();
  const pkgJsonPath = join(configDir(), "package.json");
  const sidebarTsxDest = join(pDir, "quota-sidebar.tsx");

  // 4. Print summary.
  print(`Server plugin registered for auto-update:`);
  if (ocParseOk) {
    print(`  Added "opencode-hard-limit" to ${ocPath}`);
    print(`  OpenCode will install/update the server plugin automatically on next startup.`);
  }
  print(``);
  print(`TUI sidebar widget deployed:`);
  print(`  quota-sidebar.tsx -> ${sidebarTsxDest}`);
  if (!tuiWarning) {
    print(`  Registered in ${tuiPath}`);
  } else {
    print(`  warning: ${tuiPath} could not be parsed.`);
    print(`  Add "${sidebarTsxDest}" to the "plugin" array in that file manually.`);
  }
  print(`  TUI runtime deps ensured in: ${pkgJsonPath}`);
  print(``);
  print(`Restart OpenCode to activate.`);
}

function uninstallPlugin() {
  const pDir = pluginsDir();
  const tuiPath = tuiConfigPath();

  // 1. Remove "opencode-hard-limit" from opencode.json plugin array.
  const ocPath = join(configDir(), "opencode.json");
  let ocCleaned = false;
  if (existsSync(ocPath)) {
    try {
      const ocData = JSON.parse(readFileSync(ocPath, "utf8"));
      if (Array.isArray(ocData.plugin)) {
        const before = ocData.plugin.length;
        ocData.plugin = ocData.plugin.filter((p) => !isOurs(p));
        if (ocData.plugin.length !== before) {
          writeFileSync(ocPath, JSON.stringify(ocData, null, 2) + "\n", "utf8");
          ocCleaned = true;
        }
      }
    } catch {
      print(
        `warning: ${ocPath} could not be parsed; remove "opencode-hard-limit" from the "plugin" array manually.`,
      );
    }
  }

  // 2. Remove sidebar tsx from plugins/ (and stale .js if present).
  const removed = [];
  const targets = [
    join(pDir, "quota-sidebar.tsx"),
    join(pDir, "quota-sidebar.js"), // stale bundle from older versions
  ];
  for (const file of targets) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  }

  // 3. Drop the sidebar entry from tui.json, preserving $schema and other plugins.
  let tuiCleaned = false;
  if (existsSync(tuiPath)) {
    try {
      const raw = JSON.parse(readFileSync(tuiPath, "utf8"));
      if (Array.isArray(raw.plugin)) {
        const before = raw.plugin.length;
        raw.plugin = raw.plugin.filter((s) => !isSidebarEntry(s));
        if (raw.plugin.length !== before) {
          writeFileSync(tuiPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
          tuiCleaned = true;
        }
      }
    } catch {
      print(`warning: ${tuiPath} could not be parsed; remove the quota-sidebar entry manually.`);
    }
  }

  // 4. Remove any remaining legacy server copies (guarded by content-signature).
  cleanupLegacyCopies();

  if (!ocCleaned && removed.length === 0 && !tuiCleaned) {
    print("Nothing to uninstall. No installed files or registrations were found.");
    return;
  }

  if (ocCleaned) print(`Unregistered server plugin from: ${ocPath}`);
  if (removed.length > 0) {
    print("Removed sidebar files:");
    for (const file of removed) print(`  ${file}`);
  }
  if (tuiCleaned) print(`Unregistered the sidebar widget from: ${tuiPath}`);
  print(``);
  print("Left untouched: your threshold config and the shared @opentui/solid deps");
  print("in ~/.config/opencode/ (other plugins may rely on them).");
  print(``);
  print("Restart OpenCode to complete removal.");
}

function showResolved() {
  const { values, sources, paths } = resolveConfig({ projectDir: process.cwd() });
  print("Effective configuration (highest-precedence source wins):");
  const allKeys = [...Object.keys(DEFAULTS), ...Object.values(PROVIDER_WINDOW_KEYS)];
  for (const key of allKeys) {
    if (Object.values(PROVIDER_WINDOW_KEYS).includes(key) && values[key] === undefined) {
      print(`  ${key.padEnd(17)} = ${values.window} (inherits window)`);
      continue;
    }
    if (values[key] === undefined) {
      print(`  ${key.padEnd(17)} = (not set, auto-detected)`);
      continue;
    }
    print(`  ${key.padEnd(17)} = ${String(values[key]).padEnd(8)} (from ${sources[key]})`);
  }
  print("");
  print("Config files:");
  print(`  global : ${paths.global}${existsSync(paths.global) ? "" : "  (not created)"}`);
  print(`  project: ${paths.project}${existsSync(paths.project) ? "" : "  (not created)"}`);
  print("");
  print("Precedence: env var > project file > global file > default");

  if (values.allowPostpone) {
    const entry = readPostpone();
    print("");
    if (entry && entry.until > Date.now()) {
      const remainMin = Math.ceil((entry.until - Date.now()) / 60000);
      print(`Postpone: ACTIVE for ${remainMin} more min (until ${new Date(entry.until).toLocaleTimeString()})`);
    } else {
      print("Postpone: not active");
    }
  }
}

// Lists every discovered account per monitored provider with its current
// quota — one row per Claude profile dir (see lib/accounts.js) and one row
// per oc-codex-multi-auth-style OpenAI account, or a single "default" row
// per provider when no multi-account store is found for it.
async function accountsCommand(values) {
  const cfg = resolveConfig({ projectDir: process.cwd() }).values;
  const asJson = Boolean(values.json);
  const providers = [
    { id: "anthropic", label: "Claude" },
    { id: "openai", label: "OpenAI" },
  ];

  const out = [];
  for (const provider of providers) {
    const window = windowForProvider(cfg, provider.id);
    let results;
    try {
      results = await readAccountsWeekly({
        provider: provider.id,
        window,
        timeoutMs: cfg.timeoutMs,
        cacheTtlMs: cfg.cacheTtlMs,
        rateLimitBackoffMs: cfg.rateLimitBackoffMs,
        maxRateLimitBackoffMs: cfg.maxRateLimitBackoffMs,
        noBaselineRateLimitBackoffMs: cfg.noBaselineRateLimitBackoffMs,
        minRefreshIntervalMs: cfg.minRefreshIntervalMs,
        anthropicProfileDirs: cfg.anthropicProfileDirs,
        openaiAccountsFile: cfg.openaiAccountsFile,
      });
    } catch (err) {
      results = [
        { ok: false, error: err?.message || String(err), accountId: "default", accountLabel: provider.label, isActive: true },
      ];
    }
    for (const r of results) {
      out.push({ provider: provider.id, providerLabel: provider.label, window, ...r });
    }
  }

  if (asJson) {
    print(JSON.stringify(out, null, 2));
    return;
  }

  for (const provider of providers) {
    const rows = out.filter((r) => r.provider === provider.id);
    print(`${provider.label}:`);
    for (const r of rows) {
      const tag = r.isActive && rows.length > 1 ? " (active)" : "";
      if (!r.ok) {
        print(`  ${r.accountLabel}${tag}: unavailable (${r.error ?? "unknown error"})`);
        continue;
      }
      if (r.unlimited) {
        print(`  ${r.accountLabel}${tag}: unlimited`);
        continue;
      }
      const resetPart = r.resetAt ? ` (resets ${new Date(r.resetAt).toLocaleString()})` : "";
      print(`  ${r.accountLabel}${tag}: ${r.remaining}% left, ${r.window} window${resetPart}`);
    }
    print("");
  }
}

// Forces one minimal, real, authenticated `claude` CLI call per discovered
// Claude profile (default model: Haiku, the cheapest), so each profile's
// OAuth access token gets refreshed even when nothing in OpenCode is
// actually using that profile right now. See lib/claude-warm.js for why
// this is necessary: the quota-read path never refreshes a token itself.
async function warmCommand(values) {
  if (values.watch) {
    await warmWatchCommand(values);
    return;
  }

  const asJson = Boolean(values.json);
  const cfg = resolveConfig({ projectDir: process.cwd() }).values;
  const cliPath = findClaudeBinary();

  if (!cliPath) {
    const message = "claude CLI not found on PATH or ~/.local/bin. Install it first (https://claude.ai/code).";
    if (asJson) {
      print(JSON.stringify({ ok: false, error: message }));
      return;
    }
    fail(message);
  }

  const model = values.model || DEFAULT_WARM_MODEL;
  const timeoutMs = values["warm-timeout"] !== undefined ? Number(values["warm-timeout"]) : undefined;

  const results = await warmClaudeAccounts({
    cliPath,
    model,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    profileDirs: cfg.anthropicProfileDirs,
  });

  if (asJson) {
    print(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    print("No Claude accounts discovered to warm.");
    return;
  }

  print(`Warming ${results.length} Claude account(s) with ${model}:`);
  for (const r of results) {
    if (r.ok) {
      const costPart = typeof r.costUsd === "number" ? ` ($${r.costUsd.toFixed(4)})` : "";
      print(`  ${r.label}: warmed${costPart}`);
    } else {
      print(`  ${r.label}: failed (${r.error})`);
    }
  }
}

const WATCH_SLEEP_CHUNK_MS = 30_000;

/** Sleeps up to ms, in chunks, so SIGINT/SIGTERM are noticed promptly rather than after a possibly 76-minute wait. */
async function sleepInterruptible(ms, isStopped) {
  let remaining = ms;
  while (remaining > 0 && !isStopped()) {
    const chunk = Math.min(WATCH_SLEEP_CHUNK_MS, remaining);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

// Adaptive, signal-driven alternative to running `warm` on a fixed interval:
// each account is warmed or skipped per tick based on two signals --
//   - exhausted: the window is at 0% with a known reset time -> sleep until
//     just past that reset instead of polling idly in between;
//   - in-use: the credentials file changed since the last tick (something
//     real refreshed the token elsewhere) -> skip, nothing to do;
// otherwise the account is idle and spendable, so it's warmed, and the next
// check happens after --idle-interval (default 10 min). See
// lib/warm-schedule.js for the (pure, unit-tested) decision logic.
async function warmWatchCommand(values) {
  const cfg = resolveConfig({ projectDir: process.cwd() }).values;
  const cliPath = findClaudeBinary();
  if (!cliPath) {
    fail("claude CLI not found on PATH or ~/.local/bin. Install it first (https://claude.ai/code).");
  }

  const model = values.model || DEFAULT_WARM_MODEL;
  const window = windowForProvider(cfg, "anthropic");
  const idleIntervalMs = values["idle-interval"] !== undefined ? Number(values["idle-interval"]) : DEFAULT_IDLE_INTERVAL_MS;
  const postResetBufferMs = values["post-reset-buffer"] !== undefined ? Number(values["post-reset-buffer"]) : DEFAULT_POST_RESET_BUFFER_MS;

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  print(`Watching Claude accounts (window: ${window}, idle interval: ${Math.round(idleIntervalMs / 60000)}min). Ctrl+C to stop.`);

  const state = new Map();
  while (!stopped) {
    const { results, nextTickAt } = await tickWarmSchedule({
      cliPath, model, window, idleIntervalMs, postResetBufferMs,
      profileDirs: cfg.anthropicProfileDirs, state,
    });

    const ts = new Date().toLocaleTimeString();
    if (results.length === 0) {
      print(`[${ts}] No Claude accounts discovered.`);
    }
    for (const r of results) {
      const nextAt = new Date(r.nextCheckAt).toLocaleTimeString();
      if (r.action === "warm") {
        const status = r.warmResult?.ok ? "warmed" : `failed (${r.warmResult?.error ?? "unknown error"})`;
        print(`[${ts}] ${r.label}: ${status} — next check ~${nextAt}`);
      } else {
        print(`[${ts}] ${r.label}: skipped (${r.reason}) — next check ~${nextAt}`);
      }
    }

    if (stopped) break;
    await sleepInterruptible(Math.max(0, nextTickAt - Date.now()), () => stopped);
  }
  print("Stopped.");
}

function postponeCommand(values, positionals) {
  const cfg = resolveConfig({ projectDir: process.cwd() }).values;
  if (!cfg.allowPostpone) {
    fail(
      "postpone is disabled. Enable it first with: opencode-hard-limit set --allow-postpone true",
    );
  }

  if (values.clear) {
    clearPostpone();
    print("Postpone cleared. Quota blocks will apply immediately again.");
    return;
  }

  const rawMinutes = positionals[1];
  const minutes = rawMinutes === undefined ? DEFAULT_POSTPONE_MINUTES : Number(rawMinutes);
  if (rawMinutes !== undefined && !Number.isFinite(minutes)) {
    fail(`invalid minutes: "${rawMinutes}". Pass a number, e.g. "opencode-hard-limit postpone 60".`);
  }

  const { until, minutes: clamped } = writePostpone(minutes);
  print(
    `Quota block postponed for ${clamped} minute(s) (the number after "postpone" is minutes). ` +
      `Active until ${new Date(until).toLocaleTimeString()}.`,
  );
  print(`Cancel early with: opencode-hard-limit postpone --clear`);
}

function usage() {
  print(`opencode-hard-limit - weekly AI quota hard-stop for OpenCode

Usage:
  opencode-hard-limit init [--global|--project] [--threshold N] [--install]
  opencode-hard-limit set  --threshold N [--global|--project]
  opencode-hard-limit get
  opencode-hard-limit accounts [--json]       show quota for every discovered Claude/OpenAI account
  opencode-hard-limit warm [--model m] [--json]  force a real, minimal call per Claude account to refresh its OAuth token
  opencode-hard-limit warm --watch               adaptive loop: warm when idle, skip when in-use or exhausted (see below)
  opencode-hard-limit postpone [minutes]      postpone a block for N minutes (default ${DEFAULT_POSTPONE_MINUTES}; requires --allow-postpone)
  opencode-hard-limit postpone --clear        cancel an active postpone early
  opencode-hard-limit install
  opencode-hard-limit uninstall

Scope:
  --global    apply to all OpenCode projects (~/.config/opencode/opencode-hard-limit/config.json)
  --project   apply to the current directory only (./.opencode-hard-limit.json)
  (if omitted, you are asked interactively; global is recommended)

Settings (all optional except threshold for 'set'):
  --threshold N        % remaining required to allow a call (default ${DEFAULTS.minRemaining})
  --block-on-error b   block when quota can't be checked: true|false (default ${DEFAULTS.blockOnError})
  --cache-ttl ms       in-memory cache TTL (default ${DEFAULTS.cacheTtlMs})
  --timeout ms         quota CLI timeout (default ${DEFAULTS.timeoutMs})
  --min-refresh ms     minimum spacing between real quota fetches (default ${DEFAULTS.minRefreshIntervalMs})
  --rate-limit-backoff ms  extra cooldown after a 429/rate-limit (default ${DEFAULTS.rateLimitBackoffMs})
  --max-rate-limit-backoff ms  cap on a 429's server-sent Retry-After (default ${DEFAULTS.maxRateLimitBackoffMs})
  --no-baseline-rate-limit-backoff ms  tighter cap used instead when there's no last-known-good reading yet (default ${DEFAULTS.noBaselineRateLimitBackoffMs})
  --stale-margin pct   extra block margin while quota is blind/stale (default ${DEFAULTS.staleBlockMarginPct}; 0 disables)
  --window w           quota window to track: 5h | Weekly (default ${DEFAULTS.window})
  --window-anthropic w quota window for Claude only: 5h | Weekly (default: inherits --window)
  --window-openai w    quota window for OpenAI/Codex only: 5h | Weekly (default: inherits --window)
  --allow-postpone b   enable the "opencode-hard-limit postpone" bypass command: true|false (default ${DEFAULTS.allowPostpone})

Multi-account (optional; auto-detected when present):
  Claude profiles under ~/.claude-profiles/*/.credentials.json (as set up by
  @openchamber/opencode-claude's CLAUDE_CONFIG_DIR-per-instance pattern) and
  a multi-account OpenAI/Codex store such as oc-codex-multi-auth's
  ~/.opencode/oc-codex-multi-auth-accounts.json are both picked up
  automatically — no extra setup needed. Override the locations with:
    --anthropic-profile-dirs, comma-separated (config key: anthropicProfileDirs)
    --openai-accounts-file (config key: openaiAccountsFile)
  Run 'opencode-hard-limit accounts' to see what was discovered.

Warm (optional; needs the real \`claude\` CLI on PATH, not just a quota read):
  Each discovered Claude profile is idle-only as far as quota reads go --
  reading quota never refreshes an expired OAuth access token, so a profile
  nothing uses goes "unavailable" until something makes a real call through
  it. 'warm' makes that real call for you: one minimal, untooled, single-turn
  prompt per account (default model: ${DEFAULT_WARM_MODEL}, the cheapest), just
  to let the CLI's own OAuth client refresh the token as a side effect.
    --model m         model alias/name to warm with (default: ${DEFAULT_WARM_MODEL})
    --warm-timeout ms per-account spawn timeout (default: 30000)

  'warm --watch' runs that same call on an adaptive, signal-driven schedule
  instead of once: per account, per tick, it skips rather than warms when
  either signal says there's no point --
    - exhausted: window is at 0% with a known reset time -> sleeps until just
      past that reset (e.g. 75min left on the window -> next check in ~76min)
      instead of polling idly in between.
    - in-use: the credentials file changed since the last tick (something
      real already refreshed the token elsewhere) -> skips, nothing to do.
  Otherwise the account is idle and spendable, so it warms it, then checks
  again after --idle-interval. Runs until Ctrl+C.
    --idle-interval ms     re-check cadence while idle (default: ${DEFAULT_IDLE_INTERVAL_MS})
    --post-reset-buffer ms extra wait added past a known reset time (default: ${DEFAULT_POST_RESET_BUFFER_MS})

Examples:
  opencode-hard-limit init --global --threshold 30 --install
  opencode-hard-limit set --threshold 30 --global
  opencode-hard-limit get
  opencode-hard-limit accounts
  opencode-hard-limit warm
  opencode-hard-limit warm --watch
  opencode-hard-limit set --allow-postpone true --global
  opencode-hard-limit postpone 60`);
}

async function main() {
  const { values, positionals } = parse(process.argv.slice(2));
  const cmd = positionals[0] || (values.help ? "help" : "");

  if (!cmd || cmd === "help" || values.help) {
    usage();
    return;
  }

  if (cmd === "get" || cmd === "show") {
    showResolved();
    return;
  }

  if (cmd === "accounts") {
    await accountsCommand(values);
    return;
  }

  if (cmd === "postpone") {
    postponeCommand(values, positionals);
    return;
  }

  if (cmd === "warm") {
    await warmCommand(values);
    return;
  }

  if (cmd === "install") {
    installPlugin();
    return;
  }

  if (cmd === "uninstall") {
    uninstallPlugin();
    return;
  }

  if (cmd === "set" || cmd === "init") {
    const patch = buildPatch(values);

    if (cmd === "set" && Object.keys(patch).length === 0) {
      fail("nothing to set. Pass --threshold N (and optionally --block-on-error / --cache-ttl / --timeout / --min-refresh / --rate-limit-backoff / --stale-margin / --window / --window-anthropic / --window-openai).");
    }
    if (cmd === "init" && patch.minRemaining === undefined) {
      patch.minRemaining = DEFAULTS.minRemaining; // sane default for first-time setup
    }

    let scope = resolveScopeFlag(values);
    if (!scope) scope = await promptScope();

    const { path, data } = writeScope(scope, patch, process.cwd());
    print(`Saved ${scope} config -> ${path}`);
    print(`  ${JSON.stringify(data)}`);

    if (cmd === "init" && values.install) {
      installPlugin();
    }
    if (cmd === "init" && !values.install) {
      print("");
      print("Next: install the plugin into OpenCode with:");
      print("  opencode-hard-limit install");
    }
    print("");
    print("Verify effective config with: opencode-hard-limit get");
    return;
  }

  fail(`unknown command: ${cmd}. Run 'opencode-hard-limit help'.`);
}

main().catch((e) => fail(e?.message || String(e)));
