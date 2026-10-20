// test/star.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askToStarRepo,
  githubRepoFromPackageJson,
  markStarPrompted,
  shouldPromptForStar,
  starMarkerPath,
  STAR_MARKER_FILENAME,
} from "../lib/star.js";

function sandbox() {
  return mkdtempSync(join(tmpdir(), "qhl-star-"));
}

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

// A prompt harness: records what was printed and whether gh was invoked.
function harness({ answer = true, starOk = true, ...rest } = {}) {
  const printed = [];
  const calls = { confirm: 0, star: 0, starredRepo: null };
  return {
    printed,
    calls,
    opts: {
      repo: "owner/repo",
      isTTY: true,
      env: {},
      confirm: async () => {
        calls.confirm += 1;
        return answer;
      },
      star: (repo) => {
        calls.star += 1;
        calls.starredRepo = repo;
        return starOk;
      },
      print: (s = "") => printed.push(s),
      ...rest,
    },
  };
}

// ---------------------------------------------------------------------------
// githubRepoFromPackageJson
// ---------------------------------------------------------------------------

test("githubRepoFromPackageJson: accepts the shapes npm allows", () => {
  const cases = [
    [{ repository: { url: "git+https://github.com/felipesotero/opencode-hard-limit.git" } }, "felipesotero/opencode-hard-limit"],
    [{ repository: { url: "https://github.com/owner/repo" } }, "owner/repo"],
    [{ repository: "github:owner/repo" }, "owner/repo"],
    [{ repository: "owner/repo" }, "owner/repo"],
    [{ repository: { url: "git@github.com:owner/repo.git" } }, "owner/repo"],
    [{ repository: { url: "git://github.com/owner/repo.git" } }, "owner/repo"],
  ];
  for (const [pkg, expected] of cases) {
    assert.equal(githubRepoFromPackageJson(pkg), expected, JSON.stringify(pkg));
  }
});

test("githubRepoFromPackageJson: null when absent, blank, or not GitHub", () => {
  for (const pkg of [null, undefined, {}, { repository: "" }, { repository: { url: "   " } }, { repository: { url: "https://gitlab.com/owner/repo" } }]) {
    assert.equal(githubRepoFromPackageJson(pkg), null, JSON.stringify(pkg));
  }
});

test("githubRepoFromPackageJson: this package resolves to its own repository field", () => {
  // Guards the real wiring: the prompt must target whatever package.json
  // declares, so a fork that repoints `repository` sends stars to itself
  // instead of to upstream.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(githubRepoFromPackageJson(pkg), "felipesotero/opencode-hard-limit");
});

// ---------------------------------------------------------------------------
// shouldPromptForStar
// ---------------------------------------------------------------------------

test("shouldPromptForStar: every guard suppresses the prompt", () => {
  const base = { repo: "owner/repo", isTTY: true, env: {}, markerExists: false };
  assert.equal(shouldPromptForStar(base), true);

  assert.equal(shouldPromptForStar({ ...base, repo: null }), false, "no repo");
  assert.equal(shouldPromptForStar({ ...base, isTTY: false }), false, "not a TTY");
  assert.equal(shouldPromptForStar({ ...base, noStar: true }), false, "--no-star");
  assert.equal(shouldPromptForStar({ ...base, env: { CI: "1" } }), false, "CI");
  assert.equal(shouldPromptForStar({ ...base, env: { OPENCODE_QUOTA_NO_STAR: "1" } }), false, "opt-out env");
  assert.equal(shouldPromptForStar({ ...base, markerExists: true }), false, "already asked");
  assert.equal(shouldPromptForStar(), false, "no args at all");
});

// ---------------------------------------------------------------------------
// markStarPrompted / starMarkerPath
// ---------------------------------------------------------------------------

test("starMarkerPath lives beside the global config, not inside it", async () => {
  const root = sandbox();
  await withEnv({ XDG_CONFIG_HOME: root }, () => {
    const p = starMarkerPath();
    assert.equal(p, join(root, "opencode", "opencode-hard-limit", STAR_MARKER_FILENAME));
    assert.ok(!p.endsWith("config.json"), "must not touch the user's config file");
  });
});

test("markStarPrompted creates the dir and is best-effort on failure", () => {
  const root = sandbox();
  const marker = join(root, "nested", "deeper", STAR_MARKER_FILENAME);
  assert.equal(markStarPrompted(marker), true);
  assert.ok(existsSync(marker));
  // A path that cannot be a file (its parent is a file) must not throw.
  const asFile = join(root, "afile");
  writeFileSync(asFile, "x", "utf8");
  assert.equal(markStarPrompted(join(asFile, "marker")), false);
});

// ---------------------------------------------------------------------------
// askToStarRepo
// ---------------------------------------------------------------------------

test("askToStarRepo: yes stars the repo and records that we asked", async () => {
  const root = sandbox();
  const markerPath = join(root, STAR_MARKER_FILENAME);
  const h = harness();

  const outcome = await askToStarRepo({ ...h.opts, markerPath });

  assert.equal(outcome, "starred");
  assert.equal(h.calls.star, 1);
  assert.equal(h.calls.starredRepo, "owner/repo");
  assert.ok(h.printed.join("\n").includes("Thanks for starring"));
  assert.ok(existsSync(markerPath));
});

test("askToStarRepo: declining still records the ask, and never calls gh", async () => {
  const root = sandbox();
  const markerPath = join(root, STAR_MARKER_FILENAME);
  const h = harness({ answer: false });

  const outcome = await askToStarRepo({ ...h.opts, markerPath });

  assert.equal(outcome, "declined");
  assert.equal(h.calls.star, 0, "a no must not touch the user's GitHub account");
  assert.ok(existsSync(markerPath), "a no is remembered too, so we stop asking");
  assert.ok(h.printed.join("\n").includes("https://github.com/owner/repo"));
});

test("askToStarRepo: asks only once, even across runs", async () => {
  const root = sandbox();
  const markerPath = join(root, STAR_MARKER_FILENAME);

  const first = harness();
  assert.equal(await askToStarRepo({ ...first.opts, markerPath }), "starred");
  assert.equal(first.calls.confirm, 1);

  const second = harness();
  assert.equal(await askToStarRepo({ ...second.opts, markerPath }), "skipped");
  assert.equal(second.calls.confirm, 0, "re-install must not nag");
  assert.equal(second.calls.star, 0);
});

test("askToStarRepo: a failing gh degrades to a printed URL", async () => {
  const root = sandbox();
  const h = harness({ starOk: false });

  const outcome = await askToStarRepo({ ...h.opts, markerPath: join(root, STAR_MARKER_FILENAME) });

  assert.equal(outcome, "failed");
  const out = h.printed.join("\n");
  assert.ok(out.includes("Couldn't star automatically"));
  assert.ok(out.includes("https://github.com/owner/repo"));
});

test("askToStarRepo: never prompts without a TTY", async () => {
  const root = sandbox();
  const h = harness({ isTTY: false });

  assert.equal(await askToStarRepo({ ...h.opts, markerPath: join(root, STAR_MARKER_FILENAME) }), "skipped");
  assert.equal(h.calls.confirm, 0);
  assert.equal(h.printed.length, 0, "a non-interactive install stays silent");
});

test("askToStarRepo: --no-star and the opt-out env are honored", async () => {
  const root = sandbox();

  const flagged = harness({ noStar: true });
  assert.equal(await askToStarRepo({ ...flagged.opts, markerPath: join(root, "a") }), "skipped");
  assert.equal(flagged.calls.confirm, 0);

  const envd = harness({ env: { OPENCODE_QUOTA_NO_STAR: "1" } });
  assert.equal(await askToStarRepo({ ...envd.opts, markerPath: join(root, "b") }), "skipped");
  assert.equal(envd.calls.confirm, 0);
});

test("askToStarRepo: a broken stdin is a skip, not a crash", async () => {
  const root = sandbox();
  const h = harness();
  h.opts.confirm = async () => {
    throw new Error("stdin closed");
  };

  assert.equal(await askToStarRepo({ ...h.opts, markerPath: join(root, STAR_MARKER_FILENAME) }), "skipped");
  assert.equal(h.calls.star, 0);
});

test("askToStarRepo: no resolvable repo means no prompt", async () => {
  const root = sandbox();
  const pkgRoot = join(root, "pkg");
  const h = harness({ repo: undefined });

  // pkgRoot has no package.json at all -> nothing to star.
  assert.equal(
    await askToStarRepo({ ...h.opts, pkgRoot, markerPath: join(root, STAR_MARKER_FILENAME) }),
    "skipped",
  );
  assert.equal(h.calls.confirm, 0);
});
