// lib/deploy.js
//
// Shared TUI-deployment helpers for opencode-hard-limit.
// Called from both bin/cli.js (at install time) and quota-hard-stop.js
// (self-heal: ensures the deployed .tsx always matches the installed npm version).
//
// Design constraints:
//   - ensureTuiDeployed() and cleanupLegacyCopies() must NEVER throw to the caller.
//   - bun install is launched async/detached — never awaited, swallow errors.
//   - tui.json is never destroyed when unparseable; fail silently and return tuiWarning.
//   - Legacy file removal is guarded by content-signature to avoid deleting user files.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
// lib/deploy.js lives in lib/; package root is one level up.
const DEFAULT_PKG_ROOT = dirname(__dir);

const TUI_SCHEMA = "https://opencode.ai/tui.json";

// ---------------------------------------------------------------------------
// XDG-aware path helpers
// ---------------------------------------------------------------------------

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "opencode");
}

export function pluginsDir() {
  return join(configDir(), "plugins");
}

export function tuiConfigPath() {
  return join(configDir(), "tui.json");
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Returns true when s looks like one of our sidebar file paths. */
export function isSidebarEntry(s) {
  return String(s).endsWith("quota-sidebar.tsx") || String(s).endsWith("quota-sidebar.js");
}

/**
 * Atomic write: write data to a tmp file, then rename over target.
 * Cleans up the tmp on failure and re-throws.
 */
function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/** Atomically write obj as 2-space-indented JSON with a trailing newline. */
const writeJson = (path, obj) => atomicWrite(path, JSON.stringify(obj, null, 2) + "\n");

/**
 * Read a file and JSON-parse it, enforcing that the result is a plain object.
 * Returns { exists, ok, data } — never throws.
 */
function readJsonObject(filePath) {
  if (!existsSync(filePath)) return { exists: false, ok: false, data: null };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { exists: true, ok: false, data: null };
    return { exists: true, ok: true, data: raw };
  } catch {
    return { exists: true, ok: false, data: null };
  }
}

// ---------------------------------------------------------------------------
// Private helpers for ensureTuiDeployed
// ---------------------------------------------------------------------------

/**
 * Copy src → dest atomically if bytes differ. Creates parent dirs as needed.
 * Returns true when a copy was made, false when bytes already matched.
 */
function deployFile(src, dest) {
  const srcBytes = readFileSync(src);
  let needsCopy = true;
  if (existsSync(dest)) {
    try {
      const destBytes = readFileSync(dest);
      needsCopy = !srcBytes.equals(destBytes);
    } catch {
      needsCopy = true;
    }
  }
  if (!needsCopy) return false;
  mkdirSync(dirname(dest), { recursive: true });
  atomicWrite(dest, srcBytes);
  return true;
}

/**
 * Ensure dest is registered in tui.json, pruning stale sidebar paths.
 * Returns false when tui.json exists but is unparseable (tuiWarning case).
 */
function registerSidebar(dest) {
  const tuiPath = tuiConfigPath();
  const cDir = configDir();

  const { exists, ok, data } = readJsonObject(tuiPath);
  if (exists && !ok) return false; // unparseable — never destroy user config

  const tuiData = exists ? data : { $schema: TUI_SCHEMA, plugin: [] };
  if (!Array.isArray(tuiData.plugin)) tuiData.plugin = [];

  const originalLen = tuiData.plugin.length;
  tuiData.plugin = tuiData.plugin.filter((s) => s === dest || !isSidebarEntry(s));
  const filteredSomething = tuiData.plugin.length !== originalLen;
  const alreadyHasDest = tuiData.plugin.includes(dest);

  // Skip write when already idempotent (dest registered, no stale entries removed).
  if (!alreadyHasDest || filteredSomething) {
    if (!alreadyHasDest) tuiData.plugin.push(dest);
    mkdirSync(cDir, { recursive: true });
    writeJson(tuiPath, tuiData);
  }
  return true;
}

/**
 * Ensure @opentui/solid, @opentui/core, solid-js are in the config-dir package.json.
 * Returns true when deps were added (triggers a detached bun install).
 */
function ensureRuntimeDeps(cDir) {
  const pkgJsonPath = join(cDir, "package.json");
  const { ok, data } = readJsonObject(pkgJsonPath);
  const pkgJson = ok ? data : {};
  if (!pkgJson.dependencies || typeof pkgJson.dependencies !== "object") {
    pkgJson.dependencies = {};
  }

  const REQUIRED_DEPS = ["@opentui/solid", "@opentui/core", "solid-js"];
  let depsAdded = false;
  for (const dep of REQUIRED_DEPS) {
    if (!pkgJson.dependencies[dep]) {
      pkgJson.dependencies[dep] = "*";
      depsAdded = true;
    }
  }

  if (depsAdded) {
    mkdirSync(cDir, { recursive: true });
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
    spawnBunInstall(cDir);
  }
  return depsAdded;
}

/** Launch `bun install` detached in cDir — best-effort, never throws. */
function spawnBunInstall(cDir) {
  try {
    const bunCandidate = join(homedir(), ".bun", "bin", "bun");
    const bunBin = existsSync(bunCandidate) ? bunCandidate : "bun";
    const child = spawn(bunBin, ["install"], {
      cwd: cDir,
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort only — never propagate
  }
}

// ---------------------------------------------------------------------------
// ensureTuiDeployed
// ---------------------------------------------------------------------------

// Lib files that quota-sidebar.tsx imports via relative paths and therefore
// must live alongside the tsx in plugins/lib/.
const SIDEBAR_LIB_FILES = ["quota.js", "config.js"];

/**
 * Deploy the bundled quota-sidebar.tsx (and its lib deps) into the opencode
 * plugins dir. Idempotent: skips any file whose bytes already match.
 * Also updates tui.json and ensures TUI runtime deps in the opencode config dir.
 * Never throws to the caller.
 *
 * @param {{ pkgRoot?: string, quiet?: boolean }} [opts]
 * @returns {{ copied: boolean, tuiWarning: boolean, depsAdded: boolean, error?: unknown }}
 */
export function ensureTuiDeployed({ pkgRoot = DEFAULT_PKG_ROOT, quiet = false } = {}) {
  try {
    const pDir = pluginsDir();
    const tsxDest = join(pDir, "quota-sidebar.tsx");
    const libDest = join(pDir, "lib");

    // Deploy the tsx and its lib deps; track if anything actually changed.
    let copied = deployFile(join(pkgRoot, "quota-sidebar.tsx"), tsxDest);
    for (const name of SIDEBAR_LIB_FILES) {
      if (deployFile(join(pkgRoot, "lib", name), join(libDest, name))) copied = true;
    }

    const tuiOk = registerSidebar(tsxDest);
    if (!tuiOk) return { copied, tuiWarning: true, depsAdded: false };

    const depsAdded = ensureRuntimeDeps(configDir());
    return { copied, tuiWarning: false, depsAdded };
  } catch (err) {
    // Never throw to caller.
    return { copied: false, tuiWarning: false, depsAdded: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// cleanupLegacyCopies
// ---------------------------------------------------------------------------

/**
 * Remove truly-legacy server files that were copied into plugins/ by older installs.
 * Each removal is guarded by a content-signature check so user files are never
 * accidentally deleted. Never throws.
 *
 * Intentionally NOT in this list:
 *   lib/quota.js  — sidebar runtime dep, deployed by ensureTuiDeployed
 *   lib/config.js — sidebar runtime dep, deployed by ensureTuiDeployed
 */
export function cleanupLegacyCopies() {
  try {
    const pDir = pluginsDir();

    // Guard each legacy file by a known header marker (line 1 check).
    const guarded = [
      { path: join(pDir, "quota-hard-stop.js"), marker: "// quota-hard-stop.js" },
      { path: join(pDir, "lib", "evaluate.js"),  marker: "// lib/evaluate.js" },
      { path: join(pDir, "quota-sidebar.js"),    marker: "// quota-sidebar.js" },
    ];

    for (const { path, marker } of guarded) {
      try {
        if (!existsSync(path)) continue;
        const content = readFileSync(path, "utf8");
        if (content.startsWith(marker)) {
          rmSync(path, { force: true });
        }
      } catch {
        // skip individual file errors silently
      }
    }
    // plugins/lib/ is NOT removed — it legitimately holds sidebar runtime deps.
  } catch {
    // Never throw to caller.
  }
}
