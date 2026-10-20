import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SIDEBAR_LIB_FILES } from "../lib/deploy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^"'`;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

// Walks static relative imports starting at `entry` and returns every file
// (relative to the package root) reachable from it.
function collectImports(entry, seen = new Set()) {
  const abs = resolve(ROOT, entry);
  const rel = relative(ROOT, abs);
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const source = readFileSync(abs, "utf8");
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const spec = match[1] ?? match[2];
    collectImports(relative(ROOT, resolve(dirname(abs), spec)), seen);
  }
  return seen;
}

test("every sidebar lib import is deployed and shipped", () => {
  const libImports = [...collectImports("quota-sidebar.tsx")].filter((file) => file.startsWith("lib/"));
  const deployed = new Set(SIDEBAR_LIB_FILES.map((file) => `lib/${file}`));
  const shipped = new Set(pkg.files);

  assert.deepEqual(libImports.filter((file) => !deployed.has(file)), [], "sidebar lib imports must be in SIDEBAR_LIB_FILES");
  assert.deepEqual(libImports.filter((file) => !shipped.has(file)), [], "sidebar lib imports must be in package.json files");
});

// A file that is imported at runtime but missing from package.json "files"
// works from a checkout (and from a path-loaded plugin) yet throws
// ERR_MODULE_NOT_FOUND for every user of the published tarball.
for (const entry of ["bin/cli.js", "quota-hard-stop.js"]) {
  test(`every file reachable from ${entry} is listed in package.json "files"`, () => {
    const shipped = new Set(pkg.files);
    const missing = [...collectImports(entry)].filter((f) => !shipped.has(f));
    assert.deepEqual(missing, [], `not shipped in the npm tarball: ${missing.join(", ")}`);
  });
}

test("warm modules ship with the CLI but stay outside the sidebar bundle", () => {
  const warmModules = [
    "lib/claude-warm.js",
    "lib/warm-schedule.js",
    "lib/warm-watch.js",
  ];
  const shipped = new Set(pkg.files);
  const sidebarLibs = new Set(SIDEBAR_LIB_FILES.map((file) => `lib/${file}`));
  const sidebarImports = collectImports("quota-sidebar.tsx");
  const cliImports = collectImports("bin/cli.js");

  assert.deepEqual(warmModules.filter((file) => !shipped.has(file)), []);
  assert.deepEqual(warmModules.filter((file) => sidebarLibs.has(file)), []);
  assert.deepEqual(warmModules.filter((file) => sidebarImports.has(file)), []);
  assert.deepEqual([...cliImports].filter((file) => !shipped.has(file)), []);
});
