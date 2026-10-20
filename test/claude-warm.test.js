// test/claude-warm.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { makeFakeClaude } from "./helpers/fake-claude.js";
import { readClaudeCredentialState } from "../lib/quota.js";
import {
  acquireWarmLock,
  DEFAULT_WARM_MODEL,
  DEFAULT_WARM_PROMPT,
  findClaudeBinary,
  warmClaudeAccounts,
} from "../lib/claude-warm.js";

const REQUIRED_HELP = [
  "--print",
  "--model <model>",
  "--output-format <format>",
  "--tools <tools>",
  "--strict-mcp-config",
  "--no-session-persistence",
].join("\n");
const FULL_HELP = `${REQUIRED_HELP}\n--safe-mode\n--max-budget-usd <amount>\n--bare\n`;

function sandbox(t) {
  const root = mkdtempSync(join(process.cwd(), ".test-warm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCredentials(configDir, { accessToken = "access-token", expiresAt = 1_000, refreshToken = "refresh-token" } = {}) {
  mkdirSync(configDir, { recursive: true });
  const credentialsPath = join(configDir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken, expiresAt, refreshToken },
  }), "utf8");
  return credentialsPath;
}

function makeProfile(configDir, id = basename(configDir)) {
  const title = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    id,
    label: `Claude ${title}`,
    configDir,
    credentialsPath: join(configDir, ".credentials.json"),
  };
}

function sandboxEnv(root, path = "") {
  return {
    HOME: root,
    PATH: path,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
  };
}

function helpProbe(help = FULL_HELP, calls = []) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: help, stderr: "", error: null };
  };
}

function fakeChild(pid = undefined) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function completeSpawn({
  exitCode = 0,
  stdout = JSON.stringify({ total_cost_usd: 0.015, is_error: false }),
  stderr = "",
  onSpawn = undefined,
} = {}) {
  return (cmd, args, options) => {
    onSpawn?.({ cmd, args, options });
    const child = fakeChild();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

function readLogLines(logFile) {
  return readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("readClaudeCredentialState: returns normalized OAuth state and null for unreadable files", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir, { expiresAt: 1000, refreshToken: " refresh-token " });

  assert.deepEqual(await readClaudeCredentialState(profile.credentialsPath), {
    accessToken: "access-token",
    expiresAt: 1000,
    hasRefreshToken: true,
  });
  assert.equal(await readClaudeCredentialState(join(root, "missing.credentials.json")), null);
  writeFileSync(profile.credentialsPath, "{");
  assert.equal(await readClaudeCredentialState(profile.credentialsPath), null);
});

test("warmClaudeAccounts: missing CLI or profiles returns an empty result", async () => {
  assert.deepEqual(await warmClaudeAccounts({ profiles: [{ id: "pro" }] }), []);
  assert.deepEqual(await warmClaudeAccounts({ cliPath: "/sandbox/claude" }), []);
});

test("warmClaudeAccounts: synchronous spawnFn exception resolves as a failure", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);

  const results = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: () => { throw new Error("synchronous spawn failure"); },
  });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].refreshed, false);
  assert.equal(results[0].error, "synchronous spawn failure");
});

test("warmClaudeAccounts: executes selected profiles sequentially and probes help once", async (t) => {
  const root = sandbox(t);
  const profiles = ["pro", "max"].map((id) => makeProfile(join(root, "profiles", id)));
  for (const profile of profiles) writeCredentials(profile.configDir);
  const helpCalls = [];
  const warmedDirs = [];

  const results = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles,
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(FULL_HELP, helpCalls),
    spawnFn: completeSpawn({
      onSpawn: ({ options }) => {
        const configDir = options.env.CLAUDE_CONFIG_DIR;
        warmedDirs.push(configDir);
        const credentialsPath = join(configDir, ".credentials.json");
        const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
        credentials.claudeAiOauth.accessToken += "-renewed";
        writeFileSync(credentialsPath, JSON.stringify(credentials));
      },
    }),
  });

  assert.deepEqual(warmedDirs, profiles.map((profile) => profile.configDir));
  assert.equal(helpCalls.length, 1);
  assert.ok(results.every((result) => result.ok));
});

test("warmClaudeAccounts: clean env, isolated args, refresh proof, private cwd, and optional CLI flags", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  const logFile = join(root, "calls.jsonl");
  const binDir = join(root, "bin");
  const cliPath = makeFakeClaude(binDir, { logFile, mode: "refresh" });
  const env = {
    ...sandboxEnv(root, binDir),
    ANTHROPIC_BASE_URL: "https://invalid.example",
    ANTHROPIC_API_KEY: "test-key-must-not-leak",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "test-token-must-not-leak",
    AWS_BEARER_TOKEN_BEDROCK: "test-aws-token-must-not-leak",
  };

  const [result] = await warmClaudeAccounts({ cliPath, profiles: [profile], env });
  const [call] = readLogLines(logFile);
  const args = call.argv;

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.isError, false);
  assert.equal(result.costUsd, 0.015);
  assert.equal(args[args.indexOf("-p") + 1], DEFAULT_WARM_PROMPT);
  assert.equal(args[args.indexOf("--model") + 1], DEFAULT_WARM_MODEL);
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--safe-mode"));
  assert.deepEqual(args.slice(args.indexOf("--max-budget-usd")), ["--max-budget-usd", "0.05"]);
  assert.ok(!args.includes("--bare"));
  assert.ok(!args.includes("--disallowedTools"));
  assert.equal(call.env.CLAUDE_CONFIG_DIR, profile.configDir);
  assert.equal(call.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(call.env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(call.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  assert.ok(call.cwd.startsWith(join(env.XDG_CACHE_HOME, "opencode-hard-limit", "warm-")));
  assert.ok(!call.cwd.startsWith(`${tmpdir()}/`));
  assert.equal(call.cwdMode, 0o700);
  assert.equal(existsSync(call.cwd), false);
  assert.ok(!JSON.stringify(result).includes("fake-refreshed"));
});

test("warmClaudeAccounts: optional flags are only passed when advertised", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  const calls = [];
  const argsSeen = [];

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(REQUIRED_HELP, calls),
    spawnFn: completeSpawn({
      onSpawn: ({ args }) => {
        argsSeen.push(args);
        const credentials = JSON.parse(readFileSync(profile.credentialsPath, "utf8"));
        credentials.claudeAiOauth.accessToken = "updated-token";
        credentials.claudeAiOauth.expiresAt += 1;
        writeFileSync(profile.credentialsPath, JSON.stringify(credentials));
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(!argsSeen[0].includes("--safe-mode"));
  assert.ok(!argsSeen[0].includes("--max-budget-usd"));
  assert.ok(!argsSeen[0].includes("--bare"));
});

test("warmClaudeAccounts: missing required help flag rejects the CLI before warming", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  let warmCalls = 0;

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(REQUIRED_HELP.replace("--strict-mcp-config\n", "")),
    spawnFn: () => { warmCalls += 1; return fakeChild(); },
  });

  assert.match(result.error, /too old.*missing: --strict-mcp-config/);
  assert.equal(warmCalls, 0);
});

test("warmClaudeAccounts: profile settings that override OAuth are skipped without spawning", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  writeFileSync(join(profile.configDir, "settings.json"), JSON.stringify({ apiKeyHelper: "custom-helper" }));
  let warmCalls = 0;

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: () => { warmCalls += 1; return fakeChild(); },
  });

  assert.equal(result.reason, "settings-override");
  assert.match(result.error, /apiKeyHelper/);
  assert.equal(result.ok, false);
  assert.equal(warmCalls, 0);
});

test("warmClaudeAccounts: invalid settings JSON is treated as an unsafe override", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  writeFileSync(join(profile.configDir, "settings.json"), "{");
  let warmCalls = 0;

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: () => { warmCalls += 1; return fakeChild(); },
  });

  assert.equal(result.reason, "settings-override");
  assert.match(result.error, /settings.json/);
  assert.equal(warmCalls, 0);
});

test("warmClaudeAccounts: timeout kills the process group and waits for close", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  const child = fakeChild(75_001);
  const signals = [];
  const killFn = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
  };
  let settled = false;

  const pending = warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    timeoutMs: 5,
    killGraceMs: 35,
    killFn,
    spawnSyncFn: helpProbe(),
    spawnFn: () => child,
  }).then((results) => {
    settled = true;
    return results;
  });

  // Wait for the escalation itself instead of a fixed sleep: spawn setup time
  // varies under load, so a wall-clock guess made this test flaky.
  const deadline = Date.now() + 5_000;
  while (!signals.some(([, sig]) => sig === "SIGKILL") && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.deepEqual(signals, [[-75_001, "SIGTERM"], [-75_001, "SIGKILL"]]);
  assert.equal(settled, false, "exit alone must not settle the warm call");
  child.emit("close", null, "SIGKILL");
  const [result] = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(result.exitSignal, "SIGKILL");
});

test("warmClaudeAccounts: AbortSignal terminates the child group and reports aborted", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  const child = fakeChild(75_002);
  const signals = [];
  const controller = new AbortController();
  const killFn = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
  };

  const pending = warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    signal: controller.signal,
    killFn,
    spawnSyncFn: helpProbe(),
    spawnFn: () => child,
  });
  controller.abort();
  const [result] = await pending;

  assert.equal(result.error, "aborted");
  assert.deepEqual(signals, [[-75_002, "SIGTERM"]]);
});

test("warmClaudeAccounts: bounds stderr and redacts credentials in its last line", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);
  const child = fakeChild();
  const largeStderr = Buffer.concat([
    Buffer.from("x".repeat(1024 * 1024)),
    Buffer.from("\n\u001b[31msk-ant-abc Bearer secret-value\u001b[0m\n"),
  ]);

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", largeStderr);
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      });
      return child;
    },
  });

  assert.ok(result.error.length <= 200);
  assert.equal(result.error, "[redacted] [redacted]");
  assert.ok(!result.error.includes("sk-ant-abc"));
  assert.ok(!result.error.includes("secret-value"));
});

test("warmClaudeAccounts: exit zero without a credential change is not success", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: completeSpawn({ stdout: JSON.stringify({ total_cost_usd: 0.001, is_error: false }) }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.refreshed, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "credential was not refreshed");
  assert.equal(result.costUsd, 0.001);
});

test("warmClaudeAccounts: a non-zero exit with an advanced credential is success", async (t) => {
  const root = sandbox(t);
  const profile = makeProfile(join(root, "profiles", "pro"));
  writeCredentials(profile.configDir);

  const [result] = await warmClaudeAccounts({
    cliPath: "/sandbox/claude",
    profiles: [profile],
    env: sandboxEnv(root),
    spawnSyncFn: helpProbe(),
    spawnFn: completeSpawn({
      exitCode: 1,
      stdout: JSON.stringify({ total_cost_usd: 0.012, is_error: true, result: "must not be returned" }),
      stderr: "rate limit reached",
      onSpawn: () => {
        const credentials = JSON.parse(readFileSync(profile.credentialsPath, "utf8"));
        credentials.claudeAiOauth.expiresAt += 1;
        writeFileSync(profile.credentialsPath, JSON.stringify(credentials));
      },
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.isError, true);
  assert.equal(result.costUsd, 0.012);
  assert.equal(result.refreshed, true);
  assert.equal(result.ok, true);
  assert.equal(result.error, "rate limit reached");
  assert.ok(!JSON.stringify(result).includes("must not be returned"));
});

test("findClaudeBinary: searches absolute PATH entries and returns an absolute path", (t) => {
  const root = sandbox(t);
  const binDir = join(root, "bin");
  const cliPath = makeFakeClaude(binDir);
  const env = sandboxEnv(root, binDir);
  const probes = [];
  const found = findClaudeBinary(env, {
    spawnSyncFn: (command, args, options) => {
      probes.push({ command, args, options });
      return spawnSync(command, args, options);
    },
  });

  assert.equal(found, cliPath);
  assert.ok(found.startsWith("/"));
  assert.deepEqual(probes.map(({ command, args }) => [command, args]), [[cliPath, ["--version"]]]);
  assert.deepEqual(probes[0].options.env, env);
});

test("findClaudeBinary: ignores an empty PATH entry even if cwd contains claude", (t) => {
  const root = sandbox(t);
  makeFakeClaude(root);
  const originalCwd = process.cwd();
  let found;
  try {
    process.chdir(root);
    found = findClaudeBinary({ HOME: join(root, "home"), PATH: ":/x" }, {
      spawnSyncFn: () => { throw new Error("no candidate should be probed"); },
    });
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(found, null);
});

test("findClaudeBinary: rejects failed version probes even when stdout has a version", (t) => {
  const root = sandbox(t);
  const binDir = join(root, "bin");
  const cliPath = makeFakeClaude(binDir);
  const probed = [];
  const found = findClaudeBinary(sandboxEnv(root, binDir), {
    spawnSyncFn: (command) => {
      probed.push(command);
      return { status: 1, stdout: "2.1.302", error: null };
    },
  });
  assert.equal(found, null);
  assert.deepEqual(probed, [cliPath]);
});

test("findClaudeBinary: never throws when the version probe throws", (t) => {
  const root = sandbox(t);
  const binDir = join(root, "bin");
  makeFakeClaude(binDir);
  const found = findClaudeBinary(sandboxEnv(root, binDir), {
    spawnSyncFn: () => { throw new Error("fake probe failure"); },
  });
  assert.equal(found, null);
});

test("findClaudeBinary: falls back to HOME/.local/bin/claude", (t) => {
  const root = sandbox(t);
  const fallbackDir = join(root, ".local", "bin");
  const cliPath = makeFakeClaude(fallbackDir);
  const found = findClaudeBinary(sandboxEnv(root, ""), {
    spawnSyncFn: (command, args, options) => spawnSync(command, args, options),
  });
  assert.equal(found, cliPath);
});

test("findClaudeBinary: returns null on Windows without probing", () => {
  let probed = false;
  const found = findClaudeBinary({ HOME: "/sandbox", PATH: "/bin" }, {
    platform: "win32",
    spawnSyncFn: () => { probed = true; },
  });
  assert.equal(found, null);
  assert.equal(probed, false);
});

test("acquireWarmLock: blocks a second owner and releases the lock", (t) => {
  const root = sandbox(t);
  const release = acquireWarmLock({ dir: root });
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(join(root, "warm.lock"), "utf8").trim(), String(process.pid));
  assert.deepEqual(acquireWarmLock({ dir: root }), { heldBy: process.pid });
  release();
  assert.equal(existsSync(join(root, "warm.lock")), false);
});

test("acquireWarmLock: removes a stale lock and acquires it once", (t) => {
  const root = sandbox(t);
  writeFileSync(join(root, "warm.lock"), "2000000000\n", "utf8");
  const release = acquireWarmLock({ dir: root });
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(join(root, "warm.lock"), "utf8").trim(), String(process.pid));
  release();
  assert.equal(existsSync(join(root, "warm.lock")), false);
});
