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
      OPENCODE_QUOTA_MIN_REFRESH_MS: undefined,
      OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS: undefined,
    },
    () => {
      const { values, sources } = resolveConfig({ projectDir: proj });
      assert.equal(values.minRemaining, DEFAULTS.minRemaining);
      assert.equal(sources.minRemaining, "default");
      assert.equal(values.minRefreshIntervalMs, DEFAULTS.minRefreshIntervalMs);
      assert.equal(sources.minRefreshIntervalMs, "default");
      assert.equal(values.rateLimitBackoffMs, DEFAULTS.rateLimitBackoffMs);
      assert.equal(sources.rateLimitBackoffMs, "default");
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

test("refresh spacing values reject invalid inputs", () => {
  const { xdg, proj } = sandbox();
  withEnv(
    {
      XDG_CONFIG_HOME: xdg,
      OPENCODE_QUOTA_MIN_REFRESH_MS: "0",
      OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS: "12.5",
    },
    () => {
      const r = resolveConfig({ projectDir: proj });
      assert.equal(r.values.minRefreshIntervalMs, DEFAULTS.minRefreshIntervalMs);
      assert.equal(r.values.rateLimitBackoffMs, DEFAULTS.rateLimitBackoffMs);
    },
  );
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

test("blockOnAuthError default is false", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR: undefined }, () => {
    const { values, sources } = resolveConfig({ projectDir: proj });
    assert.equal(values.blockOnAuthError, false);
    assert.equal(sources.blockOnAuthError, "default");
  });
});

test("blockOnAuthError coercion and env override", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR: "1" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.blockOnAuthError, true);
  });
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR: "false" }, () => {
    assert.equal(resolveConfig({ projectDir: proj }).values.blockOnAuthError, false);
  });
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_BLOCK_ON_AUTH_ERROR: "maybe" }, () => {
    // invalid -> falls through to default (false)
    assert.equal(resolveConfig({ projectDir: proj }).values.blockOnAuthError, false);
  });
});

test("refresh spacing and rate-limit backoff resolve from env", () => {
  const { xdg, proj } = sandbox();
  withEnv(
    {
      XDG_CONFIG_HOME: xdg,
      OPENCODE_QUOTA_MIN_REFRESH_MS: "120000",
      OPENCODE_QUOTA_RATE_LIMIT_BACKOFF_MS: "300000",
    },
    () => {
      const { values, sources } = resolveConfig({ projectDir: proj });
      assert.equal(values.minRefreshIntervalMs, 120000);
      assert.equal(sources.minRefreshIntervalMs, "env");
      assert.equal(values.rateLimitBackoffMs, 300000);
      assert.equal(sources.rateLimitBackoffMs, "env");
    },
  );
});

test("window: default is 5h", () => {
  const { xdg, proj } = sandbox();
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: undefined }, () => {
    const { values, sources } = resolveConfig({ projectDir: proj });
    assert.equal(values.window, "5h");
    assert.equal(sources.window, "default");
  });
});

test("window: invalid value falls through to 5h default", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "config.json"), JSON.stringify({ window: "monthly" }));
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.window, "5h");
    assert.equal(r.sources.window, "default");
  });
});

test("window: alias normalization (5h, 5, daily -> '5h'; week, 7d -> 'Weekly')", () => {
  const { xdg, proj } = sandbox();
  for (const alias of ["5h", "5", "daily", "5H", "DAILY"]) {
    withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: alias }, () => {
      assert.equal(resolveConfig({ projectDir: proj }).values.window, "5h", `alias '${alias}' should map to '5h'`);
    });
  }
  for (const alias of ["Weekly", "weekly", "week", "7d", "WEEKLY"]) {
    withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: alias }, () => {
      assert.equal(resolveConfig({ projectDir: proj }).values.window, "Weekly", `alias '${alias}' should map to 'Weekly'`);
    });
  }
});

test("window: precedence (env > project > global)", () => {
  const { xdg, proj } = sandbox();
  const gdir = join(xdg, "opencode", "opencode-hard-limit");
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "config.json"), JSON.stringify({ window: "5h" }));
  writeFileSync(join(proj, ".opencode-hard-limit.json"), JSON.stringify({ window: "Weekly" }));

  // project overrides global
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: undefined }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.window, "Weekly");
    assert.equal(r.sources.window, "project");
  });

  // env overrides project
  withEnv({ XDG_CONFIG_HOME: xdg, OPENCODE_QUOTA_WINDOW: "5h" }, () => {
    const r = resolveConfig({ projectDir: proj });
    assert.equal(r.values.window, "5h");
    assert.equal(r.sources.window, "env");
  });
});
