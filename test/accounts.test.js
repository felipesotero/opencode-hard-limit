// test/accounts.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAnthropicProfiles, discoverOpenAIAccounts } from "../lib/accounts.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "qhl-accounts-"));
  return root;
}

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
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
// discoverAnthropicProfiles
// ---------------------------------------------------------------------------

test("discoverAnthropicProfiles: explicit profileDirs -> one account per dir with a .credentials.json", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const max = join(root, "profiles", "max");
  writeCredentials(pro);
  writeCredentials(max);

  const accounts = await discoverAnthropicProfiles({ profileDirs: [pro, max] });
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((a) => a.id), ["pro", "max"]);
  assert.deepEqual(accounts.map((a) => a.label), ["Claude Pro", "Claude Max"]);
  assert.equal(accounts[0].credentialsPath, join(pro, ".credentials.json"));
  assert.equal(accounts[0].configDir, pro);
});

test("discoverAnthropicProfiles: skips directories without a .credentials.json", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  const empty = join(root, "profiles", "empty");
  writeCredentials(pro);
  mkdirSync(empty, { recursive: true });

  const accounts = await discoverAnthropicProfiles({ profileDirs: [pro, empty] });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "pro");
});

test("discoverAnthropicProfiles: dedupes an explicitly repeated directory", async () => {
  const root = sandbox();
  const pro = join(root, "profiles", "pro");
  writeCredentials(pro);

  const accounts = await discoverAnthropicProfiles({ profileDirs: [pro, pro] });
  assert.equal(accounts.length, 1);
});

test("discoverAnthropicProfiles: nonexistent profileDirs entries are ignored, never throw", async () => {
  const root = sandbox();
  const accounts = await discoverAnthropicProfiles({ profileDirs: [join(root, "does-not-exist")] });
  assert.deepEqual(accounts, []);
});

test("discoverAnthropicProfiles: default convention scans ~/.claude-profiles/*, ignoring ~/.claude", async () => {
  const home = sandbox();
  writeCredentials(join(home, ".claude-profiles", "max"));
  writeCredentials(join(home, ".claude-profiles", "pro"));
  // A distinct leftover login in the bare default dir: nothing routes to it
  // once named profiles exist, so polling it only burns the usage endpoint's
  // rate limit.
  writeCredentialsWithRefresh(join(home, ".claude"), "refresh-leftover");

  await withEnv({ HOME: home }, async () => {
    const accounts = await discoverAnthropicProfiles();
    // Profiles are read in directory-name sort order (max, pro).
    assert.deepEqual(accounts.map((a) => a.id), ["max", "pro"]);
    assert.deepEqual(accounts.map((a) => a.label), ["Claude Max", "Claude Pro"]);
  });
});

test("discoverAnthropicProfiles: profiles dir without credentials does not discover ~/.claude", async () => {
  const home = sandbox();
  // A stray directory is not a profile, and the default ~/.claude login is
  // handled by the legacy credential chain, not profile discovery.
  mkdirSync(join(home, ".claude-profiles", "pro.lock"), { recursive: true });
  writeCredentials(join(home, ".claude"));

  await withEnv({ HOME: home }, async () => {
    assert.deepEqual(await discoverAnthropicProfiles(), []);
  });
});

test("discoverAnthropicProfiles: default convention ignores ~/.claude when no named profiles exist", async () => {
  const home = sandbox();
  writeCredentials(join(home, ".claude"));

  await withEnv({ HOME: home }, async () => {
    const accounts = await discoverAnthropicProfiles();
    assert.deepEqual(accounts, []);
  });
});

test("discoverAnthropicProfiles: no profiles dir and no default credentials -> []", async () => {
  const home = sandbox();
  await withEnv({ HOME: home }, async () => {
    assert.deepEqual(await discoverAnthropicProfiles(), []);
  });
});

test("discoverAnthropicProfiles: two named profiles sharing one login collapse to the first", async () => {
  const home = sandbox();
  writeCredentialsWithRefresh(join(home, ".claude-profiles", "max"), "refresh-same");
  writeCredentialsWithRefresh(join(home, ".claude-profiles", "pro"), "refresh-same");

  await withEnv({ HOME: home }, async () => {
    assert.deepEqual((await discoverAnthropicProfiles()).map((a) => a.id), ["max"]);
  });
});

test("discoverAnthropicProfiles: credentials without a readable refresh token are never deduped", async () => {
  const home = sandbox();
  // Refresh-less or unparseable credentials must stay distinct accounts rather
  // than collapsing into one on a shared null identity.
  writeCredentials(join(home, ".claude-profiles", "max"));
  writeCredentials(join(home, ".claude-profiles", "pro"));
  mkdirSync(join(home, ".claude-profiles", "work"), { recursive: true });
  writeFileSync(join(home, ".claude-profiles", "work", ".credentials.json"), "{ not json", "utf8");

  await withEnv({ HOME: home }, async () => {
    assert.deepEqual((await discoverAnthropicProfiles()).map((a) => a.id), ["max", "pro", "work"]);
  });
});

// ---------------------------------------------------------------------------
// discoverOpenAIAccounts
// ---------------------------------------------------------------------------

function writeAccountsFile(path, data) {
  writeFileSync(path, JSON.stringify(data), "utf8");
}

test("discoverOpenAIAccounts: parses accounts, marks the activeIndex entry, builds email+planType labels", async () => {
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

  const accounts = await discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, "acc-1");
  assert.equal(accounts[0].label, "a@example.com (team)");
  assert.equal(accounts[0].accessToken, "t1");
  assert.equal(accounts[0].accountId, "acc-1");
  assert.equal(accounts[0].isActive, false);
  assert.equal(accounts[1].label, "a@example.com");
  assert.equal(accounts[1].isActive, true);
});

test("discoverOpenAIAccounts: entries without an accessToken are filtered out", async () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, {
    activeIndex: 0,
    accounts: [{ accountId: "acc-1", email: "a@example.com" }, { accountId: "acc-2", accessToken: "t2" }],
  });

  const accounts = await discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "acc-2");
});

test("discoverOpenAIAccounts: missing accountId falls back to a positional id and #n label", async () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [{ accessToken: "t1" }] });

  const accounts = await discoverOpenAIAccounts({ accountsFile: path });
  assert.equal(accounts[0].id, "openai-0");
  assert.equal(accounts[0].label, "OpenAI #1");
  assert.equal(accounts[0].accountId, null);
});

test("discoverOpenAIAccounts: missing file -> null", async () => {
  const root = sandbox();
  assert.equal(await discoverOpenAIAccounts({ accountsFile: join(root, "nope.json") }), null);
});

test("discoverOpenAIAccounts: invalid JSON -> null", async () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, "{ not json", "utf8");
  assert.equal(await discoverOpenAIAccounts({ accountsFile: path }), null);
});

test("discoverOpenAIAccounts: empty accounts array -> null", async () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [] });
  assert.equal(await discoverOpenAIAccounts({ accountsFile: path }), null);
});

test("discoverOpenAIAccounts: accounts array present but all entries lack a usable token -> null", async () => {
  const root = sandbox();
  const path = join(root, "accounts.json");
  writeAccountsFile(path, { activeIndex: 0, accounts: [{ accountId: "acc-1" }] });
  assert.equal(await discoverOpenAIAccounts({ accountsFile: path }), null);
});
