// test/claude-warm.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { warmClaudeAccounts, findClaudeBinary, DEFAULT_WARM_MODEL } from "../lib/claude-warm.js";

function sandbox() {
  return mkdtempSync(join(tmpdir(), "qhl-warm-"));
}

function writeCredentials(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");
}

/** A fake child_process.ChildProcess: stdout/stderr are EventEmitters too. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.killed = true; };
  return child;
}

function spawnFnThatSucceeds(calls, { stdout = JSON.stringify({ total_cost_usd: 0.0003 }) } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", stdout);
      child.emit("exit", 0);
    });
    return child;
  };
}

function spawnFnThatFails(calls, { stderr = "boom: auth failed" } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = fakeChild();
    queueMicrotask(() => {
      child.stderr.emit("data", stderr);
      child.emit("exit", 1);
    });
    return child;
  };
}

// ---------------------------------------------------------------------------
// warmClaudeAccounts
// ---------------------------------------------------------------------------

test("warmClaudeAccounts: returns [] when no cliPath is given", async () => {
  const results = await warmClaudeAccounts({ cliPath: undefined });
  assert.deepEqual(results, []);
});

test("warmClaudeAccounts: returns [] when no accounts are discovered", async () => {
  const root = sandbox();
  const calls = [];
  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [join(root, "does-not-exist")],
    spawnFn: spawnFnThatSucceeds(calls),
  });
  assert.deepEqual(results, []);
  assert.equal(calls.length, 0);
});

test("warmClaudeAccounts: warms one account per discovered profile, in order", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const max = join(root, "profiles", "max");
  writeCredentials(pro);
  writeCredentials(max);

  const calls = [];
  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro, max],
    spawnFn: spawnFnThatSucceeds(calls),
  });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.id), ["pro", "max"]);
  assert.deepEqual(results.map((r) => r.label), ["Claude Pro", "Claude Max"]);
  assert.ok(results.every((r) => r.ok === true));
  assert.deepEqual(results.map((r) => r.costUsd), [0.0003, 0.0003]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, "claude");
  assert.ok(calls[0].args.includes("-p"));
  assert.ok(calls[0].args.includes("--model"));
  assert.ok(calls[0].args.includes(DEFAULT_WARM_MODEL));
  assert.ok(calls[0].args.includes("--disallowedTools"));
  assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR, pro);
  assert.equal(calls[1].opts.env.CLAUDE_CONFIG_DIR, max);
});

test("warmClaudeAccounts: strips credential-override env vars from the child env", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const calls = [];
  await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    env: { ...process.env, ANTHROPIC_API_KEY: "leaked", PATH: process.env.PATH },
    spawnFn: spawnFnThatSucceeds(calls),
  });

  assert.equal(calls[0].opts.env.ANTHROPIC_API_KEY, undefined);
});

test("warmClaudeAccounts: uses the given model and prompt", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const calls = [];
  await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    model: "sonnet",
    prompt: "custom warm prompt",
    spawnFn: spawnFnThatSucceeds(calls),
  });

  const args = calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("-p") + 1], "custom warm prompt");
});

test("warmClaudeAccounts: a non-zero exit code is reported as a failure with the last stderr line", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const calls = [];
  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    spawnFn: spawnFnThatFails(calls, { stderr: "line one\nboom: auth failed" }),
  });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, "boom: auth failed");
});

test("warmClaudeAccounts: non-JSON stdout on a successful exit still counts as warmed", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const calls = [];
  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    spawnFn: spawnFnThatSucceeds(calls, { stdout: "not json" }),
  });

  assert.equal(results[0].ok, true);
  assert.equal(results[0].costUsd, null);
});

test("warmClaudeAccounts: a spawn error is reported as a failure, not thrown", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    spawnFn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
  });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, "ENOENT");
});

test("warmClaudeAccounts: a hung process is killed and reported as a timeout", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const killed = [];
  const results = await warmClaudeAccounts({
    cliPath: "claude",
    profileDirs: [pro],
    timeoutMs: 10,
    spawnFn: () => {
      const child = fakeChild();
      child.kill = () => killed.push(true);
      // never emits exit -- simulates a hang
      return child;
    },
  });

  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /timed out/);
  assert.deepEqual(killed, [true]);
});

// ---------------------------------------------------------------------------
// findClaudeBinary
// ---------------------------------------------------------------------------

test("findClaudeBinary: returns 'claude' when it resolves on PATH", () => {
  const found = findClaudeBinary(process.env, {
    spawnSyncFn: () => ({ status: 0, stdout: "2.1.0", error: null }),
  });
  assert.equal(found, "claude");
});

test("findClaudeBinary: returns null when no probe succeeds", () => {
  const home = sandbox();
  const found = findClaudeBinary(
    { ...process.env, HOME: home },
    { spawnSyncFn: () => ({ status: 1, stdout: "", error: null }) },
  );
  assert.equal(found, null);
});

test("findClaudeBinary: falls back to ~/.local/bin/claude when PATH probe fails", () => {
  const home = sandbox();
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\necho ok", "utf8");

  const found = findClaudeBinary(
    { ...process.env, HOME: home },
    {
      spawnSyncFn: (candidate) => ({
        status: candidate === "claude" ? 1 : 0,
        stdout: candidate === "claude" ? "" : "2.1.0",
        error: null,
      }),
    },
  );
  assert.equal(found, join(home, ".local", "bin", "claude"));
});

test("findClaudeBinary: never throws when spawnSyncFn throws", () => {
  const found = findClaudeBinary(process.env, {
    spawnSyncFn: () => { throw new Error("spawn failed"); },
  });
  assert.equal(found, null);
});
