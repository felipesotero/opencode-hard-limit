import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig, DEFAULTS } from "../lib/config.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-cfg-"));
  const xdg = join(root, "xdg");
  const proj = join(root, "proj");
  mkdirSync(proj, { recursive: true });
  return { root, xdg, proj };
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

test("defaults apply when nothing is set", () => {
  const { xdg, proj } = sandbox();
  withEnv(
    {
      XDG_CONFIG_HOME: xdg,
      OPENCODE_QUOTA_MIN_REMAINING: undefined,
      OPENCODE_QUOTA_BLOCK_ON_ERROR: undefined,
      OPENCODE_QUOTA_CACHE_TTL_MS: undefined,
      OPENCODE_QUOTA_TIMEOUT_MS: undefined,
    },
    () => {
      const { values, sources } = resolveConfig({ projectDir: proj });
      assert.equal(values.minRemaining, DEFAULTS.minRemaining);
      assert.equal(sources.minRemaining, "default");
    },
  );
});

test("precedence: env > project > global > default", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "config.json"), JSON.stringify({ minRemaining: 30 }));
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ minRemaining: 55 }));

  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.minRemaining, 55);
    assert.equal(r.sources.minRemaining, "project");
  });

  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: "90" }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.minRemaining, 90);
    assert.equal(r.sources.minRemaining, "env");
  });
});

test("global applies when project has no file", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "config.json"), JSON.stringify({ minRemaining: 42 }));
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.minRemaining, 42);
    assert.equal(r.sources.minRemaining, "global");
  });
});

test("invalid values fall through to default", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  // invalid minRemaining (non-numeric) and bogus boolean
  writeFileSync(
    join(gdir, "config.json"),
    JSON.stringify({ minRemaining: "banana", blockOnError: "maybe" }),
  );
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: undefined, OPENCODE_QUOTA_BLOCK_ON_ERROR: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.minRemaining, DEFAULTS.minRemaining);
    assert.equal(r.values.blockOnError, DEFAULTS.blockOnError);
  });
});

test("minRemaining clamps to 0..100", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: "999" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.minRemaining, 100);
  });
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_MIN_REMAINING: "-5" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.minRemaining, 0);
  });
});
