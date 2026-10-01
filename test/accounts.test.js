// test/accounts.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAnthropicAccounts, discoverOpenAIAccounts } from "../lib/accounts.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-accounts-"));
  return root;
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

function writeCredentials(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), "utf8");
}

// Credentials carrying a refresh token, which is what identifies a login.
function writeCredentialsWithRefresh(dir, refreshToken) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken } }),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// discoverAnthropicAccounts
// ---------------------------------------------------------------------------

test("discoverAnthropicAccounts: explicit profileDirs -> one account per dir with a .credentials.json", () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const max = join(root, "profiles", "max");
  writeCredentials(pro);
  writeCredentials(max);

  const accounts = discoverAnthropicAccounts({ profileDirs: [pro, max] });
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((a) => a.id), ["pro", "max"]);
  assert.deepEqual(accounts.map((a) => a.label), ["Claude Pro", "Claude Max"]);
  assert.equal(accounts[0].credentialsPath, join(pro, ".credentials.json"));
  assert.equal(accounts[0].configDir, pro);
});

test("discoverAnthropicAccounts: skips directories without a .credentials.json", () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const empty = join(root, "profiles", "empty");
  writeCredentials(pro);
  mkdirSync(empty, { recursive: true });

  const accounts = discoverAnthropicAccounts({ profileDirs: [pro, empty] });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "pro");
});

test("discoverAnthropicAccounts: dedupes an explicitly repeated directory", () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const accounts = discoverAnthropicAccounts({ profileDirs: [pro, pro] });
  assert.equal(accounts.length, 1);
});

test("discoverAnthropicAccounts: nonexistent profileDirs entries are ignored, never throw", () => {
  const root = sandbox();
  const accounts = discoverAnthropicAccounts({ profileDirs: [join(root, "does-not-exist")] });
  assert.deepEqual(accounts, []);
});

test("discoverAnthropicAccounts: default convention scans ~/.claude-profiles/*, ignoring ~/.claude", () => {
  const home = sandbox();
  writeCredentials(join(home, ".claude-profiles", "max"));
  writeCredentials(join(home, ".claude-profiles", "pro"));
  // A distinct leftover login in the bare default dir: nothing routes to it
  // once named profiles exist, so polling it only burns the usage endpoint's
  // rate limit.
  writeCredentialsWithRefresh(join(home, ".claude"), "refresh-leftover");

  withEnv({ HOME: home }, () => {
    const accounts = discoverAnthropicAccounts();
    // Profiles are read in directory-name sort order (max, pro).
    assert.deepEqual(accounts.map((a) => a.id), ["max", "pro"]);
    assert.deepEqual(accounts.map((a) => a.label), ["Claude Max", "Claude Pro"]);
  });
});

test("discoverAnthropicAccounts: a profiles dir holding no credentials still falls back to ~/.claude", () => {
  const home = sandbox();
  // Mirrors a real setup where ~/.claude-profiles has stray entries (e.g. a
  // `pro.lock` dir) but no actual profile: the fallback must key off accounts
  // found, not dirs scanned.
  mkdirSync(join(home, ".claude-profiles", "pro.lock"), { recursive: true });
  writeCredentials(join(home, ".claude"));

  withEnv({ HOME: home }, () => {
    assert.deepEqual(discoverAnthropicAccounts().map((a) => a.id), ["default"]);
  });
});

test("discoverAnthropicAccounts: default convention with only ~/.claude (no profiles dir) -> one account", () => {
  const home = sandbox();
  writeCredentials(join(home, ".claude"));

  withEnv({ HOME: home }, () => {
    const accounts = discoverAnthropicAccounts();
    assert.deepEqual(accounts.map((a) => a.id), ["default"]);
  });
});

test("discoverAnthropicAccounts: no profiles dir and no default credentials -> []", () => {
  const home = sandbox();
  withEnv({ HOME: home }, () => {
    assert.deepEqual(discoverAnthropicAccounts(), []);
  });
});

test("discoverAnthropicAccounts: two named profiles sharing one login collapse to the first", () => {
  const home = sandbox();
  writeCredentialsWithRefresh(join(home, ".claude-profiles", "max"), "refresh-same");
  writeCredentialsWithRefresh(join(home, ".claude-profiles", "pro"), "refresh-same");

  withEnv({ HOME: home }, () => {
    assert.deepEqual(discoverAnthropicAccounts().map((a) => a.id), ["max"]);
  });
});

test("discoverAnthropicAccounts: credentials without a readable refresh token are never deduped", () => {
  const home = sandbox();
  // Refresh-less or unparseable credentials must stay distinct accounts rather
  // than collapsing into one on a shared null identity.
  writeCredentials(join(home, ".claude-profiles", "max"));
  writeCredentials(join(home, ".claude-profiles", "pro"));
  mkdirSync(join(home, ".claude-profiles", "work"), { recursive: true });
  writeFileSync(join(home, ".claude-profiles", "work", ".credentials.json"), "{ not json", "utf8");

  withEnv({ HOME: home }, () => {
    assert.deepEqual(discoverAnthropicAccounts().map((a) => a.id), ["max", "pro", "work"]);
  });
});

// ---------------------------------------------------------------------------
// discoverOpenAIAccounts
// ---------------------------------------------------------------------------

function writeAccountsFile(path, data) {
  writeFileSync(path, JSON.stringify(data), "utf8");
}

test("discoverOpenAIAccounts: parses accounts, marks the activeIndex entry, builds email+planType labels", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, {
    version: 3,
    activeIndex: 1,
    accounts: [
      { accountId: "acc-1", email: "a@example.com", planType: "team", accessToken: "t1", expiresAt: 111 },
      { accountId: "acc-2", email: "a@example.com", accessToken: "t2", expiresAt: 222 },
    ],
  });

  const accounts = discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, "acc-1");
  assert.equal(accounts[0].label, "a@example.com (team)");
  assert.equal(accounts[0].accessToken, "t1");
  assert.equal(accounts[0].accountId, "acc-1");
  assert.equal(accounts[0].isActive, false);
  assert.equal(accounts[1].label, "a@example.com");
  assert.equal(accounts[1].isActive, true);
});

test("discoverOpenAIAccounts: entries without an accessToken are filtered out", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, {
    activeIndex: 0,
    accounts: [{ accountId: "acc-1", email: "a@example.com" }, { accountId: "acc-2", accessToken: "t2" }],
  });

  const accounts = discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "acc-2");
});

test("discoverOpenAIAccounts: missing accountId falls back to a positional id and #n label", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [{ accessToken: "t1" }] });

  const accounts = discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts[0].id, "openai-0");
  assert.equal(accounts[0].label, "OpenAI #1");
  assert.equal(accounts[0].accountId, null);
});

test("discoverOpenAIAccounts: missing file -> null", () => {
  const root = sandbox();
  assert.equal(discoverOpenAIAccounts({ accountsFile: join(root, "nope.json") }), null);
});

test("discoverOpenAIAccounts: invalid JSON -> null", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, "{ not json", "utf8");
  assert.equal(discoverOpenAIAccounts({ accountsFile: path }), null);
});

test("discoverOpenAIAccounts: empty accounts array -> null", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [] });
  assert.equal(discoverOpenAIAccounts({ accountsFile: path }), null);
});

test("discoverOpenAIAccounts: accounts array present but all entries lack a usable token -> null", () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [{ accountId: "acc-1" }] });
  assert.equal(discoverOpenAIAccounts({ accountsFile: path }), null);
});
