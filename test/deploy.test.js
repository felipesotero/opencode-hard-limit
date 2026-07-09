import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTuiDeployed, cleanupLegacyCopies } from "../lib/deploy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-deploy-"));
  // xdg is used as XDG_CONFIG_HOME.
  // configDir()  = join(xdg, "opencode")
  // pluginsDir() = join(xdg, "opencode", "plugins")
  // tuiConfigPath() = join(xdg, "opencode", "tui.json")
  const xdg = join(root, "xdg");
  mkdirSync(xdg, { recursive: true });
  return { root, xdg };
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Create a minimal fake package root with quota-sidebar.tsx and its lib deps
 * (lib/quota.js + lib/config.js), matching the real npm package layout.
 */
function fakePkgRoot(dir, tsxContent = "// fake sidebar\nexport default function() {}") {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "quota-sidebar.tsx"), tsxContent, "utf8");
  writeFileSync(
    join(dir, "lib", "quota.js"),
    "// lib/quota.js\nexport function readWeekly() {}",
    "utf8",
  );
  writeFileSync(
    join(dir, "lib", "config.js"),
    "// lib/config.js\nexport function resolveConfig() {}",
    "utf8",
  );
  return dir;
}

// ---------------------------------------------------------------------------
// ensureTuiDeployed tests
// ---------------------------------------------------------------------------

test("ensureTuiDeployed: deploys sidebar on first call", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const r = ensureTuiDeployed({ pkgRoot: pkg });
    assert.equal(r.copied, true, "should copy on first deploy");
    assert.equal(r.tuiWarning, false, "no tui warning expected");
    assert.equal(r.error, undefined, "no error expected");
  });
});

test("ensureTuiDeployed: deploys lib/quota.js and lib/config.js alongside the tsx", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg });
    const plugins = join(xdg, "opencode", "plugins");
    assert.ok(
      existsSync(join(plugins, "lib", "quota.js")),
      "lib/quota.js should be deployed into plugins/lib/",
    );
    assert.ok(
      existsSync(join(plugins, "lib", "config.js")),
      "lib/config.js should be deployed into plugins/lib/",
    );
    // Verify bytes match the source.
    const srcQuota = readFileSync(join(pkg, "lib", "quota.js"));
    const dstQuota = readFileSync(join(plugins, "lib", "quota.js"));
    assert.ok(srcQuota.equals(dstQuota), "deployed lib/quota.js bytes must match source");
    const srcConfig = readFileSync(join(pkg, "lib", "config.js"));
    const dstConfig = readFileSync(join(plugins, "lib", "config.js"));
    assert.ok(srcConfig.equals(dstConfig), "deployed lib/config.js bytes must match source");
  });
});

test("ensureTuiDeployed: idempotent when bytes match (no-op on second call)", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg }); // first call: copies everything
    const r = ensureTuiDeployed({ pkgRoot: pkg }); // second call: same bytes
    assert.equal(r.copied, false, "should not re-copy when all bytes match");
    assert.equal(r.error, undefined, "no error expected");
  });
});

test("ensureTuiDeployed: redeploys tsx when source bytes differ", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"), "// version 1");
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg });
    // Simulate a package update: overwrite tsx source with different content.
    writeFileSync(join(pkg, "quota-sidebar.tsx"), "// version 2", "utf8");
    const r = ensureTuiDeployed({ pkgRoot: pkg });
    assert.equal(r.copied, true, "should redeploy when source bytes differ");
  });
});

test("ensureTuiDeployed: redeploys lib dep when its source bytes differ", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg });
    // Simulate a package update: overwrite lib/quota.js source.
    writeFileSync(join(pkg, "lib", "quota.js"), "// lib/quota.js\n// updated", "utf8");
    const r = ensureTuiDeployed({ pkgRoot: pkg });
    assert.equal(r.copied, true, "should redeploy when a lib dep source differs");
    const plugins = join(xdg, "opencode", "plugins");
    const deployed = readFileSync(join(plugins, "lib", "quota.js"), "utf8");
    assert.ok(deployed.includes("// updated"), "deployed lib/quota.js should have new content");
  });
});

test("ensureTuiDeployed: creates tui.json with correct schema when absent", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg });
    const tuiPath = join(xdg, "opencode", "tui.json");
    assert.ok(existsSync(tuiPath), "tui.json should be created");
    const data = JSON.parse(readFileSync(tuiPath, "utf8"));
    assert.equal(data.$schema, "https://opencode.ai/tui.json");
    assert.ok(Array.isArray(data.plugin), "plugin should be an array");
    assert.ok(data.plugin.some((p) => String(p).endsWith("quota-sidebar.tsx")));
  });
});

test("ensureTuiDeployed: skips tui.json write and returns tuiWarning when unparseable", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  const opencodeCfg = join(xdg, "opencode");
  mkdirSync(opencodeCfg, { recursive: true });
  writeFileSync(join(opencodeCfg, "tui.json"), "{ not valid json }", "utf8");

  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    const r = ensureTuiDeployed({ pkgRoot: pkg });
    assert.equal(r.tuiWarning, true, "should return tuiWarning when tui.json is unparseable");
    // Verify tui.json was NOT modified.
    const after = readFileSync(join(opencodeCfg, "tui.json"), "utf8");
    assert.equal(after, "{ not valid json }", "tui.json must not be destroyed");
  });
});

test("ensureTuiDeployed: dedupes sidebar entry in existing tui.json", () => {
  const { root, xdg } = sandbox();
  const pkg = fakePkgRoot(join(root, "pkg"));
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    ensureTuiDeployed({ pkgRoot: pkg }); // first: creates entry
    ensureTuiDeployed({ pkgRoot: pkg }); // second: should not duplicate
    const tuiPath = join(xdg, "opencode", "tui.json");
    const data = JSON.parse(readFileSync(tuiPath, "utf8"));
    const entries = data.plugin.filter((p) => String(p).endsWith("quota-sidebar.tsx"));
    assert.equal(entries.length, 1, "should have exactly one sidebar entry after two calls");
  });
});

// ---------------------------------------------------------------------------
// cleanupLegacyCopies tests
// ---------------------------------------------------------------------------

test("cleanupLegacyCopies: removes truly-legacy files with header markers", () => {
  const { root, xdg } = sandbox();
  const plugins = join(xdg, "opencode", "plugins");
  mkdirSync(join(plugins, "lib"), { recursive: true });

  // Truly-legacy server files (no longer needed — should be deleted).
  writeFileSync(
    join(plugins, "quota-hard-stop.js"),
    "// quota-hard-stop.js\nconsole.log('old server plugin');",
    "utf8",
  );
  writeFileSync(
    join(plugins, "lib", "evaluate.js"),
    "// lib/evaluate.js\nconsole.log('old evaluate');",
    "utf8",
  );
  writeFileSync(join(plugins, "quota-sidebar.js"), "// quota-sidebar.js\nbundled sidebar", "utf8");

  // Sidebar runtime deps — must NOT be deleted even when they bear the old marker.
  writeFileSync(
    join(plugins, "lib", "quota.js"),
    "// lib/quota.js\nexport function readWeekly() {}",
    "utf8",
  );
  writeFileSync(
    join(plugins, "lib", "config.js"),
    "// lib/config.js\nexport function resolveConfig() {}",
    "utf8",
  );

  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    cleanupLegacyCopies();

    // Legacy files removed.
    assert.equal(
      existsSync(join(plugins, "quota-hard-stop.js")),
      false,
      "quota-hard-stop.js should be removed",
    );
    assert.equal(
      existsSync(join(plugins, "lib", "evaluate.js")),
      false,
      "lib/evaluate.js should be removed",
    );
    assert.equal(
      existsSync(join(plugins, "quota-sidebar.js")),
      false,
      "quota-sidebar.js should be removed",
    );

    // Sidebar runtime deps preserved.
    assert.equal(
      existsSync(join(plugins, "lib", "quota.js")),
      true,
      "lib/quota.js must NOT be removed (sidebar runtime dep)",
    );
    assert.equal(
      existsSync(join(plugins, "lib", "config.js")),
      true,
      "lib/config.js must NOT be removed (sidebar runtime dep)",
    );

    // plugins/lib/ dir itself must survive.
    assert.equal(
      existsSync(join(plugins, "lib")),
      true,
      "plugins/lib/ directory must not be removed",
    );
  });
});

test("cleanupLegacyCopies: does NOT remove files lacking our header markers", () => {
  const { root, xdg } = sandbox();
  const plugins = join(xdg, "opencode", "plugins");
  mkdirSync(join(plugins, "lib"), { recursive: true });

  // User-authored files without our markers — must be preserved.
  writeFileSync(
    join(plugins, "quota-hard-stop.js"),
    "// user's own quota script\nconsole.log('mine');",
    "utf8",
  );
  writeFileSync(
    join(plugins, "lib", "evaluate.js"),
    "// user's evaluate helper\nexport const x = 1;",
    "utf8",
  );

  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    cleanupLegacyCopies();

    assert.equal(
      existsSync(join(plugins, "quota-hard-stop.js")),
      true,
      "user's quota-hard-stop.js must be preserved",
    );
    assert.equal(
      existsSync(join(plugins, "lib", "evaluate.js")),
      true,
      "user's lib/evaluate.js must be preserved",
    );
  });
});

test("cleanupLegacyCopies: does not throw when plugins dir is absent", () => {
  const { xdg } = sandbox();
  // No plugins dir created — function must still succeed silently.
  withEnv({ XDG_CONFIG_HOME: xdg }, () => {
    assert.doesNotThrow(() => cleanupLegacyCopies());
  });
});
