#!/usr/bin/env node
// bin/cli.js
//
// CLI for opencode-hard-limit: configure the weekly-quota hard-stop threshold
// (and related settings) at either global or project scope, and install the
// plugin into OpenCode.

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

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
  if (values["block-on-auth-error"] !== undefined) patch.blockOnAuthError = values["block-on-auth-error"];
  if (values["cache-ttl"] !== undefined) patch.cacheTtlMs = values["cache-ttl"];
  if (values["timeout"] !== undefined) patch.timeoutMs = values["timeout"];
  if (values.window !== undefined) patch.window = values.window;
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
  window: { type: "string" },
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

  // Server plugin files (autoloaded by OpenCode from the plugins dir)
  copyFileSync(join(PKG_ROOT, "quota-hard-stop.js"), join(dest, "quota-hard-stop.js"));
  copyFileSync(join(PKG_ROOT, "lib", "config.js"), join(dest, "lib", "config.js"));
  copyFileSync(join(PKG_ROOT, "lib", "quota.js"), join(dest, "lib", "quota.js"));
  copyFileSync(join(PKG_ROOT, "lib", "evaluate.js"), join(dest, "lib", "evaluate.js"));

  // TUI sidebar widget: copy the raw .tsx source.
  // OpenCode's host transpiles .tsx with babel-preset-solid and virtualizes
  // @opentui/solid, @opentui/core, and solid-js at the package level, which
  // is the only supported path. Pre-bundling is NOT used here because bun
  // emits `from "@opentui/solid/jsx-runtime"` (a subpath specifier that
  // OpenCode does not virtualize), which would put JSX on a separate solid-js
  // instance from the virtualized createSignal and cause the widget to render
  // nothing silently.
  const sidebarTsxDest = join(dest, "quota-sidebar.tsx");
  copyFileSync(join(PKG_ROOT, "quota-sidebar.tsx"), sidebarTsxDest);

  // Remove any stale bundled .js left by a prior install.
  rmSync(join(dest, "quota-sidebar.js"), { force: true });

  // tui.json: remove stale entries (.tsx and .js), push the .tsx path.
  // Preserves $schema and all other plugin entries.
  const tuiPath = tuiConfigPath();
  const configDir = dirname(tuiPath); // ~/.config/opencode (XDG-aware)
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
    print(`  Add "${sidebarTsxDest}" to the "plugin" array in that file manually.`);
  } else {
    // Remove stale entries (migration from prior .js and dedupe).
    tuiData.plugin = tuiData.plugin.filter(
      (s) => !String(s).endsWith("quota-sidebar.tsx") && !String(s).endsWith("quota-sidebar.js"),
    );
    tuiData.plugin.push(sidebarTsxDest);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(tuiPath, JSON.stringify(tuiData, null, 2) + "\n", "utf8");
  }

  // Ensure TUI runtime deps are installed in the config dir so that
  // OpenCode's module resolution finds them when it transpiles the widget.
  const pkgJsonPath = join(configDir, "package.json");
  let pkgJson = { dependencies: {} };
  if (existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      pkgJson = parsed;
      if (!pkgJson.dependencies || typeof pkgJson.dependencies !== "object") {
        pkgJson.dependencies = {};
      }
    } catch {
      pkgJson = { dependencies: {} };
    }
  }

  const REQUIRED_DEPS = ["@opentui/solid", "@opentui/core", "solid-js"];
  let pkgChanged = false;
  for (const dep of REQUIRED_DEPS) {
    if (!pkgJson.dependencies[dep]) {
      pkgJson.dependencies[dep] = "*";
      pkgChanged = true;
    }
  }
  if (pkgChanged) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
  }

  // Run bun install in configDir (best-effort: warn on failure, do not throw).
  const bunCandidate = join(homedir(), ".bun", "bin", "bun");
  const bunBin = existsSync(bunCandidate) ? bunCandidate : "bun";
  try {
    execFileSync(bunBin, ["install"], {
      cwd: configDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    print(`warning: bun install failed in ${configDir}.`);
    if (detail) print(`  ${detail}`);
    print(`  To fix manually: cd ${configDir} && bun install`);
  }

  print(`Installed server hard-stop plugin:`);
  print(`  quota-hard-stop.js  -> ${join(dest, "quota-hard-stop.js")}`);
  print(`  lib/config.js       -> ${join(dest, "lib", "config.js")}`);
  print(`  lib/quota.js        -> ${join(dest, "lib", "quota.js")}`);
  print(`  lib/evaluate.js     -> ${join(dest, "lib", "evaluate.js")}`);
  print(`  quota-sidebar.tsx   -> ${sidebarTsxDest}`);
  if (tuiParseOk) {
    print(`TUI sidebar widget registered in: ${tuiPath}`);
  }
  print(`TUI runtime deps ensured in: ${pkgJsonPath}`);
  print(``);
  print(`Restart OpenCode to load the sidebar widget.`);
}

function uninstallPlugin() {
  const dest = pluginsDir();

  // Remove every file this plugin copies into the OpenCode plugins dir.
  const removed = [];
  const targets = [
    join(dest, "quota-hard-stop.js"),
    join(dest, "quota-sidebar.tsx"),
    join(dest, "quota-sidebar.js"), // stale bundle from older versions
    join(dest, "lib", "config.js"),
    join(dest, "lib", "quota.js"),
    join(dest, "lib", "evaluate.js"),
  ];
  for (const file of targets) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  }

  // Drop the sidebar entry from tui.json, preserving $schema and other plugins.
  const tuiPath = tuiConfigPath();
  let tuiCleaned = false;
  if (existsSync(tuiPath)) {
    try {
      const raw = JSON.parse(readFileSync(tuiPath, "utf8"));
      if (Array.isArray(raw.plugin)) {
        const before = raw.plugin.length;
        raw.plugin = raw.plugin.filter(
          (s) => !String(s).endsWith("quota-sidebar.tsx") && !String(s).endsWith("quota-sidebar.js"),
        );
        if (raw.plugin.length !== before) {
          writeFileSync(tuiPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
          tuiCleaned = true;
        }
      }
    } catch {
      print(`warning: ${tuiPath} could not be parsed; remove the quota-sidebar entry manually.`);
    }
  }

  if (removed.length === 0 && !tuiCleaned) {
    print("Nothing to uninstall. No installed files were found.");
    return;
  }

  print("Removed installed plugin files:");
  for (const file of removed) print(`  ${file}`);
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
  --window w           quota window to track: 5h | Weekly (default ${DEFAULTS.window})

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
