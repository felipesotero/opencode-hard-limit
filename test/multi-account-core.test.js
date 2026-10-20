import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import QuotaHardStopPlugin from "../quota-hard-stop.js";
import {
  __internals,
  listQuotaAccounts,
  quotaCachePath,
  readAccountsWeekly,
  readWeekly,
  resolveQuotaAccount,
} from "../lib/quota.js";

const { __test__ } = QuotaHardStopPlugin;
__test__.setCliInstaller(() => {});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-multi-account-core-"));
  const box = {
    root,
    home: join(root, "home"),
    config: join(root, "xdg-config"),
    data: join(root, "xdg-data"),
    project: join(root, "project"),
    accountsFile: join(root, "anthropic-accounts.json"),
    openaiAccountsFile: join(root, "openai-accounts.json"),
    cacheFile: join(root, "quota-cache.json"),
  };
  mkdirSync(join(box.home, ".claude"), { recursive: true });
  mkdirSync(box.project, { recursive: true });
  return box;
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withSandbox(box, fn, overrides = {}) {
  const savedFetch = global.fetch;
  const env = {
    HOME: box.home,
    XDG_CONFIG_HOME: box.config,
    XDG_DATA_HOME: box.data,
    OPENCODE_QUOTA_ANTHROPIC_ACCOUNTS_FILE: box.accountsFile,
    OPENCODE_QUOTA_OPENAI_ACCOUNTS_FILE: box.openaiAccountsFile,
    OPENCODE_QUOTA_CLAUDE_BIN: undefined,
    OPENCODE_QUOTA_ANTHROPIC_PROFILE_DIRS: undefined,
    OPENCODE_QUOTA_CACHE_FILE: undefined,
    ...overrides,
  };
  __internals.__resetMultiAccountSticky();
  __test__.clearState();
  try {
    return await withEnv(env, fn);
  } finally {
    global.fetch = savedFetch;
    __internals.__resetMultiAccountSticky();
    __test__.resetQuotaReader();
    __test__.clearState();
  }
}

function writeCredentials(dir, accessToken, refreshToken = `refresh-${accessToken}`) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } }),
    "utf8",
  );
}

function writeProjectConfig(box, config) {
  writeFileSync(join(box.project, ".opencode-hard-limit.json"), JSON.stringify(config), "utf8");
}

function writeAnthropicAuth(box, accessToken) {
  const authDir = join(box.data, "opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    join(authDir, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: accessToken,
        refresh: `refresh-${accessToken}`,
        expires: Date.now() + 3_600_000,
      },
    }),
    "utf8",
  );
}

function writeUsageResponse(utilization) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ five_hour: { utilization } }),
  };
}

function writeOpenAIResponse(usedPercent) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: usedPercent },
      },
    }),
  };
}

function readCache(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeTrackingClaudeStub(file, marker) {
  writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(marker)}, "called\\n");
if (process.argv.includes("--version")) process.exit(0);
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ authenticated: true, five_hour: { utilization: 20 } }));
  process.exit(0);
}
process.exit(1);
`, "utf8");
  chmodSync(file, 0o755);
}

test("gate resolves two Claude profiles and fetches each profile's own token", async () => {
  const box = sandbox();
  const proDir = join(box.root, "profiles", "pro");
  const maxDir = join(box.root, "profiles", "max");
  writeCredentials(proDir, "tok-pro");
  writeCredentials(maxDir, "tok-max");
  writeProjectConfig(box, { anthropicProfileDirs: [proDir, maxDir] });
  const authorizations = [];

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      const authorization = options.headers.Authorization;
      authorizations.push(authorization);
      return writeUsageResponse(authorization === "Bearer tok-pro" ? 20 : 95);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });

    await plugin["chat.params"]({ provider: { info: { id: "claude-pro" } } });
    await assert.rejects(
      plugin["chat.params"]({ provider: { info: { id: "claude-max" } } }),
      /below the 30% threshold/,
    );

    assert.deepEqual(authorizations, ["Bearer tok-pro", "Bearer tok-max"]);
    assert.deepEqual(Object.keys(readCache(quotaCachePath())).sort(), [
      "anthropic:cp:max:5h",
      "anthropic:cp:pro:5h",
    ]);
  });
});

test("unknown profile fails closed without using ~/.claude or creating a quota cache entry", async () => {
  const box = sandbox();
  const proDir = join(box.root, "profiles", "pro");
  writeCredentials(proDir, "tok-pro");
  writeCredentials(join(box.home, ".claude"), "tok-default");
  writeProjectConfig(box, { anthropicProfileDirs: [proDir] });
  let fetchCalls = 0;

  await withSandbox(box, async () => {
    global.fetch = async () => {
      fetchCalls += 1;
      return writeUsageResponse(10);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });
    await assert.rejects(
      plugin["chat.params"]({ provider: { info: { id: "claude-ghost" } } }),
      (error) => {
        assert.match(error.message, /ghost/);
        return true;
      },
    );

    await withEnv({ OPENCODE_QUOTA_BLOCK_ON_ERROR: "0" }, async () => {
      await plugin["chat.params"]({ provider: { info: { id: "claude-ghost" } } });
    });

    assert.equal(fetchCalls, 0);
    assert.deepEqual(readCache(quotaCachePath()), {});
  });
});

test("claude-code stays on the generic Anthropic credential chain without profile mode", async () => {
  const box = sandbox();
  writeAnthropicAuth(box, "generic-token");
  const authorizations = [];

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return writeUsageResponse(20);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });
    await plugin["chat.params"]({ provider: { info: { id: "claude-code" } } });
    assert.deepEqual(authorizations, ["Bearer generic-token"]);
  });
});

test("gate and account listing share the same Anthropic cache slot", async () => {
  const box = sandbox();
  writeAnthropicAuth(box, "single-token");
  const authorizations = [];

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return writeUsageResponse(20);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });
    await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
    const gateAccount = await resolveQuotaAccount({
      provider: "anthropic",
      providerId: "anthropic",
      accountsFile: box.accountsFile,
      openaiAccountsFile: box.openaiAccountsFile,
    });
    const listedAccounts = await listQuotaAccounts({
      provider: "anthropic",
      accountsFile: box.accountsFile,
      openaiAccountsFile: box.openaiAccountsFile,
    });
    const sidebarResults = await readAccountsWeekly({
      provider: "anthropic",
      window: "5h",
      accountsFile: box.accountsFile,
      openaiAccountsFile: box.openaiAccountsFile,
      cacheFile: quotaCachePath(),
      timeoutMs: 1000,
    });

    assert.equal(authorizations.length, 1);
    assert.equal(sidebarResults.length, 1);
    assert.equal(listedAccounts.length, 1);
    assert.equal(listedAccounts[0].accountKey, gateAccount.accountKey);
    assert.equal(sidebarResults[0].accountKey, gateAccount.accountKey);
    assert.deepEqual(Object.keys(readCache(quotaCachePath())).filter((key) => key.startsWith("anthropic:")), [
      `anthropic:${gateAccount.accountKey}:5h`,
    ]);
  });
});

test("concurrent quota writes preserve every account and remove temporary files", async () => {
  const box = sandbox();
  const alphaDir = join(box.root, "profiles", "alpha");
  const betaDir = join(box.root, "profiles", "beta");
  writeCredentials(alphaDir, "tok-alpha");
  writeCredentials(betaDir, "tok-beta");

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      const token = options.headers.Authorization;
      await new Promise((resolve) => setTimeout(resolve, token === "Bearer tok-alpha" ? 25 : 5));
      return writeUsageResponse(10);
    };
    const common = {
      provider: "anthropic",
      window: "5h",
      cacheFile: box.cacheFile,
      accountsFile: box.accountsFile,
      anthropicProfileDirs: [alphaDir, betaDir],
      timeoutMs: 1000,
    };
    await Promise.all([
      readWeekly({ ...common, providerId: "claude-alpha" }),
      readWeekly({ ...common, providerId: "claude-beta" }),
    ]);

    const stateAfterReads = readCache(box.cacheFile);
    assert.ok(stateAfterReads["anthropic:cp:alpha:5h"]);
    assert.ok(stateAfterReads["anthropic:cp:beta:5h"]);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      __internals.writeCacheEntry(box.cacheFile, `openai:ox:direct-${index}:5h`, {
        at: Date.now(),
        result: { ok: true },
      }),
    ));
    const stateAfterWrites = readCache(box.cacheFile);
    assert.equal(Object.keys(stateAfterWrites).filter((key) => key.startsWith("openai:ox:direct-")).length, 20);
    assert.deepEqual(readdirSync(dirname(box.cacheFile)).filter((name) => name.includes(".tmp-")), []);
  });
});

test("OpenAI gate uses active store credentials and account listing reuses its cache slot", async () => {
  const box = sandbox();
  writeFileSync(box.openaiAccountsFile, JSON.stringify({
    activeIndex: 1,
    accounts: [
      { accountId: "acc-1", email: "one@example.com", accessToken: "tok-1" },
      { accountId: "acc-2", email: "two@example.com", accessToken: "tok-2" },
    ],
  }), "utf8");
  const requests = [];

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      requests.push({
        authorization: options.headers.Authorization,
        accountId: options.headers["ChatGPT-Account-Id"],
      });
      return writeOpenAIResponse(options.headers.Authorization === "Bearer tok-1" ? 30 : 10);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });
    await plugin["chat.params"]({ provider: { info: { id: "openai" } } });
    const gateAccount = await resolveQuotaAccount({
      provider: "openai",
      providerId: "openai",
      openaiAccountsFile: box.openaiAccountsFile,
    });
    const sidebarResults = await readAccountsWeekly({
      provider: "openai",
      window: "5h",
      openaiAccountsFile: box.openaiAccountsFile,
      cacheFile: quotaCachePath(),
      timeoutMs: 1000,
    });

    assert.deepEqual(requests, [
      { authorization: "Bearer tok-2", accountId: "acc-2" },
      { authorization: "Bearer tok-1", accountId: "acc-1" },
    ]);
    assert.equal(sidebarResults.length, 2);
    assert.equal(sidebarResults.find((result) => result.isActive).accountKey, gateAccount.accountKey);
  });
});

test("managed Anthropic accounts fail with auth errors when the active credential is expired or disabled", async () => {
  const box = sandbox();
  const marker = join(box.root, "claude-invocations.txt");
  const cli = join(box.root, "claude");
  writeTrackingClaudeStub(cli, marker);
  const account = (uuid, accessToken, expiresAt, extra = {}) => ({
    uuid,
    refreshToken: `refresh-${uuid}`,
    accessToken,
    expiresAt,
    ...extra,
  });
  const expiresSoon = Date.now() + 3_600_000;
  writeFileSync(box.accountsFile, JSON.stringify({
    activeAccountUuid: "A",
    accounts: [account("A", "access-A", expiresSoon), account("B", "access-B", expiresSoon)],
  }), "utf8");
  const authorizations = [];

  await withSandbox(box, async () => {
    global.fetch = async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return writeUsageResponse(20);
    };
    const plugin = await QuotaHardStopPlugin({ directory: box.project });
    await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
    writeFileSync(box.accountsFile, JSON.stringify({
      activeAccountUuid: "B",
      accounts: [account("A", "access-A", expiresSoon), account("B", "access-B", expiresSoon)],
    }), "utf8");
    __internals.__resetMultiAccountSticky();
    await plugin["chat.params"]({ provider: { info: { id: "anthropic" } } });
    assert.deepEqual(authorizations, ["Bearer access-A", "Bearer access-B"]);

    for (const active of [
      account("B", "access-B", Date.now() - 1000),
      account("B", "access-B", expiresSoon, { enabled: false }),
    ]) {
      writeFileSync(box.accountsFile, JSON.stringify({
        activeAccountUuid: "B",
        accounts: [account("A", "access-A", expiresSoon), active],
      }), "utf8");
      __internals.__resetMultiAccountSticky();
      const result = await readWeekly({
        provider: "anthropic",
        providerId: "anthropic",
        accountsFile: box.accountsFile,
        cacheFile: box.cacheFile,
        timeoutMs: 1000,
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorKind, "auth");
      assert.equal(result.accountKey, "ma:B");
    }
    assert.equal(authorizations.length, 2);
    assert.equal(existsSync(marker), false);
  }, { OPENCODE_QUOTA_CLAUDE_BIN: cli });
});

test("legacy two-segment cache entries are ignored and pruned on the next write", async () => {
  const box = sandbox();
  writeAnthropicAuth(box, "cache-token");
  writeFileSync(box.cacheFile, JSON.stringify({
    "anthropic:5h": {
      at: Date.now(),
      result: { ok: true, status: "ok", remaining: 99, window: "5h" },
    },
    "anthropic:oc:stale:Weekly": {
      at: Date.now() - 9 * 24 * 60 * 60 * 1000,
      result: { ok: true, status: "ok", remaining: 99, window: "Weekly" },
    },
  }), "utf8");
  let fetchCalls = 0;

  await withSandbox(box, async () => {
    global.fetch = async () => {
      fetchCalls += 1;
      return writeUsageResponse(20);
    };
    const account = await resolveQuotaAccount({
      provider: "anthropic",
      providerId: "anthropic",
      accountsFile: box.accountsFile,
    });
    const result = await readWeekly({
      provider: "anthropic",
      window: "5h",
      account,
      accountsFile: box.accountsFile,
      cacheFile: box.cacheFile,
      timeoutMs: 1000,
    });
    const state = readCache(box.cacheFile);

    assert.equal(result.remaining, 80);
    assert.equal(fetchCalls, 1);
    assert.equal(Object.hasOwn(state, "anthropic:5h"), false);
    assert.equal(Object.hasOwn(state, "anthropic:oc:stale:Weekly"), false);
    assert.deepEqual(Object.keys(state), [`anthropic:${account.accountKey}:5h`]);
  });
});
