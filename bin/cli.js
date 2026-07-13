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
} from "../lib/config.js";

import {
  configDir,
  pluginsDir,
  tuiConfigPath,
  isSidebarEntry,
  ensureTuiDeployed,
  cleanupLegacyCopies,
} from "../lib/deploy.js";

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
  if (values["stale-margin"] !== undefined) patch.staleBlockMarginPct = values["stale-margin"];
  if (values.window !== undefined) patch.window = values.window;
  if (values["window-anthropic"] !== undefined) patch.windowAnthropic = values["window-anthropic"];
  if (values["window-openai"] !== undefined) patch.windowOpenai = values["window-openai"];
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
  "stale-margin": { type: "string" },
  window: { type: "string" },
  "window-anthropic": { type: "string" },
  "window-openai": { type: "string" },
  install: { type: "boolean" },
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
    print(`  ${key.padEnd(17)} = ${String(values[key]).padEnd(8)} (from ${sources[key]})`);
  }
  print("");
  print("Config files:");
  print(`  global : ${paths.global}${existsSync(paths.global) ? "" : "  (not created)"}`);
  print(`  project: ${paths.project}${existsSync(paths.project) ? "" : "  (not created)"}`);
  print("");
  print("Precedence: env var > project file > global file > default");
}

function usage() {
  print(`opencode-hard-limit - weekly AI quota hard-stop for OpenCode

Usage:
  opencode-hard-limit init [--global|--project] [--threshold N] [--install]
  opencode-hard-limit set  --threshold N [--global|--project]
  opencode-hard-limit get
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
  --stale-margin pct   extra block margin while quota is blind/stale (default ${DEFAULTS.staleBlockMarginPct}; 0 disables)
  --window w           quota window to track: 5h | Weekly (default ${DEFAULTS.window})
  --window-anthropic w quota window for Claude only: 5h | Weekly (default: inherits --window)
  --window-openai w    quota window for OpenAI/Codex only: 5h | Weekly (default: inherits --window)

Examples:
  opencode-hard-limit init --global --threshold 30 --install
  opencode-hard-limit set --threshold 30 --global
  opencode-hard-limit get`);
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
