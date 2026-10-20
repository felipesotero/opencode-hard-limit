import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { makeFakeClaude } from "./helpers/fake-claude.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "bin/cli.js");

function makeSandbox(t, { mode = "refresh" } = {}) {
  const root = mkdtempSync(join(ROOT, ".test-cli-warm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const binDir = join(root, "bin");
  const logFile = join(root, "calls.jsonl");
  const invocationFile = join(root, "invocations.jsonl");
  mkdirSync(home, { recursive: true });
  makeFakeClaude(binDir, { logFile, invocationFile, mode });

  return {
    root,
    home,
    logFile,
    invocationFile,
    env: {
      HOME: home,
      PATH: binDir,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
    },
  };
}

function addProfile(sandbox, slug, { expiresAt = Date.now() + 2 * 60 * 60_000 } = {}) {
  const profileDir = join(sandbox.home, ".claude-profiles", slug);
  const credentialsPath = join(profileDir, ".credentials.json");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${slug}-secret`,
      refreshToken: `refresh-${slug}`,
      expiresAt,
    },
  }));
  return { profileDir, credentialsPath };
}

function runCli(sandbox, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox.root,
    env: sandbox.env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function readCalls(sandbox) {
  if (!existsSync(sandbox.logFile)) return [];
  return readFileSync(sandbox.logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function readInvocations(sandbox) {
  if (!existsSync(sandbox.invocationFile)) return [];
  return readFileSync(sandbox.invocationFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("warm flag validation exits 2 before spawning the fake Claude CLI", (t) => {
  const sandbox = makeSandbox(t);
  const cases = [
    { args: ["warm", "--watch", "--idle-interval", "abc"], message: "integer number of milliseconds" },
    { args: ["warm", "--watch", "--idle-interval", "0"], message: "integer number of milliseconds" },
    { args: ["warm", "--watch", "--idle-interval", "-5"], message: "integer number of milliseconds" },
    { args: ["warm", "--watch", "--idle-interval", "10"], message: "Did you mean 600000 (10 min)?" },
    { args: ["warm", "--warm-timeout", "1000"], message: "integer number of milliseconds" },
    { args: ["warm", "--model", "-x"], message: "--model must match" },
    { args: ["warm", "--post-reset-buffer", "1"], message: "post-reset-buffer" },
  ];

  for (const { args, message } of cases) {
    const result = runCli(sandbox, args);
    assert.equal(result.status, 2, `${args.join(" ")} should exit 2: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.deepEqual(readCalls(sandbox), []);
  assert.deepEqual(readInvocations(sandbox), []);
});

test("warm exits cleanly outside named-profile mode", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCli(sandbox, ["warm"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no named Claude profiles; warm only applies to ~\/\.claude-profiles\/\* or anthropicProfileDirs/);
  assert.deepEqual(readCalls(sandbox), []);
  assert.deepEqual(readInvocations(sandbox).map(({ argv }) => argv), [["--version"], ["--help"]]);
});

test("warm skips fresh profiles and only refreshes expired profiles", (t) => {
  const sandbox = makeSandbox(t);
  const expired = addProfile(sandbox, "expired", { expiresAt: Date.now() - 1_000 });
  addProfile(sandbox, "fresh");

  const result = runCli(sandbox, ["warm"]);
  const calls = readCalls(sandbox);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Expired: warmed \(\$0\.015\)/);
  assert.match(result.stdout, /Claude Fresh: skipped \(fresh, expires \d{2}:\d{2}\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, expired.profileDir);
  assert.deepEqual(Object.keys(calls[0].env), ["CLAUDE_CONFIG_DIR"]);
  assert.equal(calls[0].cwd.startsWith(join(sandbox.env.XDG_CACHE_HOME, "opencode-hard-limit", "warm-")), true);
  assert.equal(calls[0].cwd.startsWith(tmpdir()), false);

  const renewed = JSON.parse(readFileSync(expired.credentialsPath, "utf8")).claudeAiOauth;
  assert.ok(renewed.expiresAt > Date.now());
  assert.equal(renewed.accessToken, `fake-refreshed-${calls[0].pid}`);
});

test("warm --force calls the fake Claude CLI for a fresh profile", (t) => {
  const sandbox = makeSandbox(t);
  const profile = addProfile(sandbox, "fresh");

  const result = runCli(sandbox, ["warm", "--force"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warmed/);
  assert.equal(readCalls(sandbox).length, 1);
  assert.equal(readCalls(sandbox)[0].env.CLAUDE_CONFIG_DIR, profile.profileDir);
});

test("failed or no-op warm calls return exit 1", (t) => {
  for (const mode of ["fail", "noop"]) {
    const sandbox = makeSandbox(t, { mode });
    addProfile(sandbox, "expired", { expiresAt: Date.now() - 1_000 });

    const result = runCli(sandbox, ["warm"]);

    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stdout, /Claude Expired: failed \(/);
    assert.equal(readCalls(sandbox).length, 1);
  }
});

test("warm --json prints result data without credential tokens", (t) => {
  const sandbox = makeSandbox(t);
  addProfile(sandbox, "expired", { expiresAt: Date.now() - 1_000 });

  const result = runCli(sandbox, ["warm", "--json"]);
  const rows = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows[0].id, "expired");
  assert.equal(result.stdout.includes("access-expired-secret"), false);
  assert.equal(result.stdout.includes("refresh-expired"), false);
});
