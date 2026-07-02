#!/usr/bin/env node
// bin/cli.js
//
// CLI for opencode-hard-limit: configure the weekly-quota hard-stop threshold
// (and related settings) at either global or project scope, and install the
// plugin into OpenCode.

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULTS,
  resolveConfig,
  writeScope,
  globalConfigPath,
  projectConfigPath,
} from "../lib/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");

function pluginsDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "plugins");
}

function tuiConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode", "tui.json");
}

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
  if (values["cache-ttl"] !== undefined) patch.cacheTtlMs = values["cache-ttl"];
  if (values["timeout"] !== undefined) patch.timeoutMs = values["timeout"];
  return patch;
}

const SHARED_OPTIONS = {
  global: { type: "boolean" },
  project: { type: "boolean" },
  threshold: { type: "string" },
  "min-remaining": { type: "string" },
  "block-on-error": { type: "string" },
  "cache-ttl": { type: "string" },
  timeout: { type: "string" },
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

function installPlugin() {
  const dest = pluginsDir();
  mkdirSync(join(dest, "lib"), { recursive: true });

  // Server plugin files
  copyFileSync(join(PKG_ROOT, "quota-hard-stop.js"), join(dest, "quota-hard-stop.js"));
  copyFileSync(join(PKG_ROOT, "lib", "config.js"), join(dest, "lib", "config.js"));
  copyFileSync(join(PKG_ROOT, "lib", "quota.js"), join(dest, "lib", "quota.js"));

  // TUI sidebar widget
  const sidebarDest = join(dest, "quota-sidebar.tsx");
  copyFileSync(join(PKG_ROOT, "quota-sidebar.tsx"), sidebarDest);

  // Register TUI widget in tui.json (idempotent, deduplicated)
  const tuiPath = tuiConfigPath();
  let tuiData = null;
  let tuiParseOk = true;
  if (existsSync(tuiPath)) {
    try {
      const raw = JSON.parse(readFileSync(tuiPath, "utf8"));
      if (!Array.isArray(raw.plugin)) raw.plugin = [];
      tuiData = raw;
    } catch {
      tuiParseOk = false;
    }
  } else {
    tuiData = { $schema: "https://opencode.ai/tui.json", plugin: [] };
  }

  if (!tuiParseOk) {
    print(`warning: ${tuiPath} could not be parsed as JSON.`);
    print(`  Add "${sidebarDest}" to the "plugin" array in that file manually.`);
  } else {
    if (!tuiData.plugin.includes(sidebarDest)) {
      tuiData.plugin.push(sidebarDest);
    }
    mkdirSync(dirname(tuiPath), { recursive: true });
    writeFileSync(tuiPath, JSON.stringify(tuiData, null, 2) + "\n", "utf8");
  }

  print(`Installed server hard-stop plugin:`);
  print(`  quota-hard-stop.js -> ${join(dest, "quota-hard-stop.js")}`);
  print(`  lib/config.js      -> ${join(dest, "lib", "config.js")}`);
  print(`  lib/quota.js       -> ${join(dest, "lib", "quota.js")}`);
  print(`  quota-sidebar.tsx  -> ${sidebarDest}`);
  if (tuiParseOk) {
    print(`TUI sidebar widget registered in: ${tuiPath}`);
  }
  print(``);
  print(`Restart OpenCode to load the sidebar widget.`);
}

function showResolved() {
  const { values, sources, paths } = resolveConfig({ projectDir: process.cwd() });
  print("Effective configuration (highest-precedence source wins):");
  for (const key of Object.keys(DEFAULTS)) {
    print(`  ${key.padEnd(13)} = ${String(values[key]).padEnd(8)} (from ${sources[key]})`);
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

Scope:
  --global    apply to all OpenCode projects (~/.config/opencode/opencode-hard-limit/config.json)
  --project   apply to the current directory only (./.opencode-hard-limit.json)
  (if omitted, you are asked interactively; global is recommended)

Settings (all optional except threshold for 'set'):
  --threshold N        weekly % remaining required to allow a call (default ${DEFAULTS.minRemaining})
  --block-on-error b   block when quota can't be checked: true|false (default ${DEFAULTS.blockOnError})
  --cache-ttl ms       in-memory cache TTL (default ${DEFAULTS.cacheTtlMs})
  --timeout ms         quota CLI timeout (default ${DEFAULTS.timeoutMs})

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

  if (cmd === "set" || cmd === "init") {
    const patch = buildPatch(values);

    if (cmd === "set" && Object.keys(patch).length === 0) {
      fail("nothing to set. Pass --threshold N (and optionally --block-on-error / --cache-ttl / --timeout).");
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
