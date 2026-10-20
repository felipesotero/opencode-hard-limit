// lib/claude-warm.js
//
// Runs a deliberately isolated, minimal Claude CLI call for profiles that an
// upstream scheduler has already decided to warm. This module never discovers
// accounts or chooses when a profile is eligible.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { quotaCachePath } from "./quota.js";

export const DEFAULT_WARM_MODEL = "haiku";
export const DEFAULT_WARM_PROMPT = "Reply with just: ok";
export const DEFAULT_WARM_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 10_000;
const AUTH_OVERRIDE_HELPERS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"];
const AUTH_OVERRIDE_ENV_PATTERN = /^(?:ANTHROPIC_|CLAUDE_CODE_)/;
const ACTIVE_WARM_PIDS = new Set();
const ACTIVE_WARM_LOCKS = new Map();
let exitHandlerInstalled = false;

function isAuthOverrideEnvKey(key) {
  return AUTH_OVERRIDE_ENV_PATTERN.test(key) || key === "AWS_BEARER_TOKEN_BEDROCK";
}

function buildEnv(configDir, baseEnv) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (isAuthOverrideEnvKey(key)) delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasCliVersion(cliPath, env, spawnSyncFn) {
  try {
    const result = spawnSyncFn(cliPath, ["--version"], {
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return !result.error
      && result.status === 0
      && /\d+\.\d+\.\d+/.test(result.stdout || "");
  } catch {
    return false;
  }
}

/** Resolve an executable Claude CLI to an absolute path without PATH's empty or relative entries. */
export function findClaudeBinary(env = process.env, { spawnSyncFn = spawnSync, platform = process.platform } = {}) {
  if (platform === "win32") return null;

  const home = typeof env.HOME === "string" && isAbsolute(env.HOME) ? env.HOME : homedir();
  const candidates = [];
  if (typeof env.PATH === "string") {
    for (const entry of env.PATH.split(delimiter)) {
      if (!entry || !isAbsolute(entry)) continue;
      candidates.push(resolve(entry, "claude"));
    }
  }
  candidates.push(resolve(home, ".local", "bin", "claude"));

  for (const candidate of candidates) {
    if (isExecutable(candidate) && hasCliVersion(candidate, env, spawnSyncFn)) return candidate;
  }
  return null;
}

function detectClaudeFlags(cliPath, env, spawnSyncFn) {
  try {
    const result = spawnSyncFn(cliPath, ["--help"], {
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    if (result.error || result.status !== 0) {
      return { supported: new Set(), error: "could not read Claude CLI help" };
    }
    const help = `${result.stdout || ""}\n${result.stderr || ""}`;
    return { supported: new Set(help.match(/--[A-Za-z0-9][A-Za-z0-9-]*/g) || []) };
  } catch {
    return { supported: new Set(), error: "could not read Claude CLI help" };
  }
}

function missingRequiredFlags(supported) {
  const required = [
    "--print",
    "--model",
    "--output-format",
    "--tools",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  return required.filter((flag) => !supported.has(flag));
}

function buildWarmArgs(model, supported) {
  const args = [
    "-p", DEFAULT_WARM_PROMPT,
    "--model", model,
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (supported.has("--safe-mode")) args.push("--safe-mode");
  if (supported.has("--max-budget-usd")) args.push("--max-budget-usd", "0.05");
  return args;
}

async function readClaudeCredentialState(credentialsPath) {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, "utf8"));
    const oauth = parsed?.claudeAiOauth;
    const rawExpiresAt = oauth?.expiresAt;
    const expiresAt = rawExpiresAt !== null && rawExpiresAt !== undefined && rawExpiresAt !== ""
      && Number.isFinite(Number(rawExpiresAt))
      ? Number(rawExpiresAt)
      : null;
    const accessToken = typeof oauth?.accessToken === "string" && oauth.accessToken.trim()
      ? oauth.accessToken
      : null;
    const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken.trim() : "";
    return { accessToken, expiresAt, hasRefreshToken: Boolean(refreshToken) };
  } catch {
    return null;
  }
}

function credentialsRefreshed(before, after) {
  if (!before || !after) return false;
  const accessTokenChanged = Boolean(after.accessToken) && after.accessToken !== before.accessToken;
  const expiryAdvanced = after.expiresAt !== null
    && (before.expiresAt === null || after.expiresAt > before.expiresAt);
  return accessTokenChanged || expiryAdvanced;
}

async function settingsOverrideKey(configDir) {
  const settingsPath = join(configDir, "settings.json");
  let source;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? null : "settings.json";
  }

  let settings;
  try {
    settings = JSON.parse(source);
  } catch {
    return "settings.json";
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "settings.json";

  for (const key of AUTH_OVERRIDE_HELPERS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) return key;
  }
  if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) {
    return Object.keys(settings.env).find(isAuthOverrideEnvKey) || null;
  }
  return null;
}

async function makePrivateCwd(env) {
  const home = typeof env.HOME === "string" && isAbsolute(env.HOME) ? env.HOME : homedir();
  const cacheHome = typeof env.XDG_CACHE_HOME === "string" && isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : join(home, ".cache");
  const parent = join(resolve(cacheHome), "opencode-hard-limit");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(parent, "warm-"));
  await chmod(cwd, 0o700);
  return cwd;
}

function appendHead(current, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = MAX_OUTPUT_BYTES - current.length;
  if (remaining <= 0) return current;
  return Buffer.concat([current, bytes.subarray(0, remaining)]);
}

function appendTail(current, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (bytes.length >= MAX_OUTPUT_BYTES) return bytes.subarray(bytes.length - MAX_OUTPUT_BYTES);
  const combined = Buffer.concat([current, bytes]);
  return combined.length > MAX_OUTPUT_BYTES ? combined.subarray(combined.length - MAX_OUTPUT_BYTES) : combined;
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/sk-ant-[\w-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .trim();
}

function sanitizeMessage(value) {
  return sanitizeText(value).slice(0, 200);
}

function lastStderrLine(stderr) {
  const lines = sanitizeText(stderr).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) || "").slice(0, 200);
}

function parsedCliOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout.toString("utf8"));
    return {
      costUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      isError: typeof parsed?.is_error === "boolean" ? parsed.is_error : null,
    };
  } catch {
    return { costUsd: null, isError: null };
  }
}

function ensureExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const pid of ACTIVE_WARM_PIDS) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    for (const [lockPath, ownerPid] of ACTIVE_WARM_LOCKS) {
      try {
        if (readFileSync(lockPath, "utf8").trim() === String(ownerPid)) unlinkSync(lockPath);
      } catch {}
    }
  });
}

function signalProcessGroup(pid, signal, killFn = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { killFn(-pid, signal); } catch {}
}

function spawnWarmCall({
  cliPath,
  model,
  supported,
  timeoutMs,
  cwd,
  env,
  configDir,
  signal,
  spawnFn,
  killFn,
  killGraceMs,
}) {
  const args = buildWarmArgs(model, supported);
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer = null;
    let killTimer = null;
    let closeFailsafeTimer = null;
    let child = null;
    let pid = null;
    let spawnError = null;
    let terminationError = null;
    let exitCode = null;
    let exitSignal = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    const finish = (result, closed = false) => {
      if (settled) {
        if (closed && pid !== null) ACTIVE_WARM_PIDS.delete(pid);
        return;
      }
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (closeFailsafeTimer !== null) clearTimeout(closeFailsafeTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (closed && pid !== null) ACTIVE_WARM_PIDS.delete(pid);
      resolvePromise(result);
    };

    const terminate = (reason) => {
      if (settled || terminationError) return;
      terminationError = reason;
      signalProcessGroup(pid, "SIGTERM", killFn);
      killTimer = setTimeout(() => signalProcessGroup(pid, "SIGKILL", killFn), killGraceMs);
    };

    const onAbort = () => terminate("aborted");

    try {
      child = spawnFn(cliPath, args, {
        cwd,
        env: buildEnv(configDir, env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish({ error: sanitizeMessage(error?.message || error) });
      return;
    }

    pid = Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null;
    if (pid !== null) {
      ACTIVE_WARM_PIDS.add(pid);
      ensureExitHandler();
    }
    child.stdout?.on("data", (chunk) => { stdout = appendHead(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", (code, childSignal) => {
      exitCode = typeof code === "number" ? code : null;
      exitSignal = childSignal || null;
    });
    child.once("close", (code, childSignal) => {
      if (typeof code === "number") exitCode = code;
      if (childSignal) exitSignal = childSignal;
      const cliOutput = parsedCliOutput(stdout);
      let error = terminationError;
      if (!error && spawnError) error = sanitizeMessage(spawnError.message || spawnError);
      if (!error && exitCode !== 0) {
        error = lastStderrLine(stderr) || `exit code ${exitCode ?? "unknown"}`;
      }
      finish({ exitCode, exitSignal, ...cliOutput, error: error || undefined }, true);
    });

    timer = setTimeout(() => {
      terminate(`warm timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    closeFailsafeTimer = setTimeout(() => {
      finish({ exitCode, exitSignal, costUsd: null, isError: null, error: "kill-failed" });
    }, timeoutMs + CLOSE_GRACE_MS);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

function accountResult(profile, details = {}) {
  return { id: profile.id, label: profile.label, ...details };
}

function failedForProfiles(profiles, error) {
  return profiles.map((profile) => accountResult(profile, {
    ok: false,
    refreshed: false,
    error,
  }));
}

async function runOne(profile, {
  cliPath,
  model,
  supported,
  timeoutMs,
  env,
  signal,
  spawnFn,
  killFn,
  killGraceMs,
}) {
  if (signal?.aborted) {
    return accountResult(profile, { ok: false, refreshed: false, error: "aborted" });
  }

  const before = await readClaudeCredentialState(profile.credentialsPath);
  const overrideKey = await settingsOverrideKey(profile.configDir);
  if (overrideKey) {
    return accountResult(profile, {
      ok: false,
      refreshed: false,
      reason: "settings-override",
      error: `profile settings route auth away from OAuth (${overrideKey}); not warming`,
    });
  }

  let cwd = null;
  let callResult = {};
  let cleanupError = null;
  try {
    cwd = await makePrivateCwd(env);
    callResult = await spawnWarmCall({
      cliPath,
      model,
      supported,
      timeoutMs,
      cwd,
      env,
      configDir: profile.configDir,
      signal,
      spawnFn,
      killFn,
      killGraceMs,
    });
  } catch (error) {
    callResult = { error: sanitizeMessage(error?.message || error) };
  } finally {
    if (cwd) {
      try {
        await rm(cwd, { recursive: true, force: true });
      } catch (error) {
        cleanupError = sanitizeMessage(error?.message || error);
      }
    }
  }

  const after = await readClaudeCredentialState(profile.credentialsPath);
  const refreshed = credentialsRefreshed(before, after);
  const error = cleanupError
    ? `failed to clean private warm directory: ${cleanupError}`
    : callResult.error || (!refreshed ? "credential was not refreshed" : undefined);
  return accountResult(profile, {
    ok: refreshed,
    refreshed,
    exitCode: callResult.exitCode ?? null,
    isError: callResult.isError ?? null,
    costUsd: callResult.costUsd ?? null,
    ...(callResult.exitSignal ? { exitSignal: callResult.exitSignal } : {}),
    ...(error ? { error } : {}),
  });
}

/**
 * Execute warm calls sequentially for profiles already selected by the caller.
 * This function deliberately does not perform account discovery or scheduling.
 */
export async function warmClaudeAccounts({
  cliPath,
  profiles = [],
  model = DEFAULT_WARM_MODEL,
  timeoutMs = DEFAULT_WARM_TIMEOUT_MS,
  env = process.env,
  signal,
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  killFn = process.kill,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  if (!cliPath || !Array.isArray(profiles) || profiles.length === 0) return [];
  if (signal?.aborted) return failedForProfiles(profiles, "aborted");

  const detection = detectClaudeFlags(cliPath, env, spawnSyncFn);
  if (detection.error) return failedForProfiles(profiles, detection.error);
  const missing = missingRequiredFlags(detection.supported);
  if (missing.length) {
    return failedForProfiles(
      profiles,
      `claude CLI too old for an isolated warm call (missing: ${missing.join(", ")}); upgrade claude`,
    );
  }

  const results = [];
  for (const profile of profiles) {
    results.push(await runOne(profile, {
      cliPath,
      model,
      supported: detection.supported,
      timeoutMs,
      env,
      signal,
      spawnFn,
      killFn,
      killGraceMs,
    }));
  }
  return results;
}

function readLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  } catch {
    return null;
  }
}

function acquireLockFile(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`, "utf8");
  } catch (error) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
    throw error;
  }
  closeSync(fd);

  ACTIVE_WARM_LOCKS.set(lockPath, process.pid);
  ensureExitHandler();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ACTIVE_WARM_LOCKS.delete(lockPath);
    try {
      if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

/** Create the package-wide warm lock, removing one lock only when its PID is stale. */
export function acquireWarmLock({ dir = dirname(quotaCachePath()) } = {}) {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "warm.lock");
  let release = acquireLockFile(lockPath);
  if (release) return release;

  const heldBy = readLockOwner(lockPath);
  if (heldBy !== null) {
    try {
      process.kill(heldBy, 0);
      return { heldBy };
    } catch (error) {
      if (error?.code !== "ESRCH") return { heldBy };
    }
  }

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  release = acquireLockFile(lockPath);
  if (release) return release;
  return { heldBy: readLockOwner(lockPath) };
}
