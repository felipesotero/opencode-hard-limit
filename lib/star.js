// lib/star.js
//
// One-time "star the repo on GitHub?" prompt for the install/init flows.
//
// Deliberately narrow in scope:
//   - It only ever runs from the CLI's `install` / `init` commands, never from
//     the plugin's request path. A quota gate that runs on every model call has
//     no business prompting.
//   - It asks once per machine and records that it asked, so a re-install or a
//     second `init` does not nag. Declining is remembered exactly like
//     accepting; the marker records "we asked", not "they said yes".
//   - It is skipped entirely without a TTY (CI, pipes, non-interactive
//     installers), with --no-star, or with OPENCODE_QUOTA_NO_STAR / CI set.
//   - Starring happens only after an explicit yes, by shelling out to the
//     user's own authenticated `gh`. This module never handles a token, never
//     reads one from disk, and never talks to the GitHub API directly, so it
//     cannot act on an account the user has not already authorized locally.
//     No `gh`, no auth, no network -> print the URL and move on.
//
// Not part of SIDEBAR_LIB_FILES in lib/deploy.js: this is CLI-only and must
// not be copied into the sidebar runtime.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configDirGlobal } from "./config.js";

export const STAR_MARKER_FILENAME = "star-prompted";

// Where we record that the prompt already ran. Lives beside the global config
// rather than inside it: this is plugin bookkeeping, not a user setting, and
// `opencode-hard-limit get` should not list it as configuration.
export function starMarkerPath() {
  return join(configDirGlobal(), STAR_MARKER_FILENAME);
}

/**
 * Derive "owner/repo" from a package.json's `repository` field. Returns null
 * when absent or unrecognized, which callers treat as "no prompt" — a fork that
 * has not pointed `repository` at itself should not send stars to whoever the
 * upstream happens to be.
 *
 * Accepts both the object form ({ url }) and the string shorthand, with or
 * without a `git+` prefix, a `.git` suffix, or the `github:` scheme.
 */
export function githubRepoFromPackageJson(pkg) {
  const raw = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const text = raw.trim().replace(/^git\+/, "").replace(/\.git$/, "");
  const patterns = [
    /^github:([^/\s]+)\/([^/\s]+)$/i,
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)/i,
    /^git:\/\/github\.com\/([^/\s]+)\/([^/\s]+)/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+)/i,
    /^([^/\s:@]+)\/([^/\s]+)$/, // bare "owner/repo" shorthand
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/**
 * Whether the prompt should run at all. Pure, so the guard order is testable
 * without a TTY or a filesystem.
 */
export function shouldPromptForStar({
  repo,
  isTTY,
  noStar = false,
  env = {},
  markerExists = false,
} = {}) {
  if (!repo) return false;
  if (noStar) return false;
  if (!isTTY) return false;
  // Honor both our own opt-out and the de-facto CI marker, so automated
  // installs never block on a question nobody can answer.
  if (env.OPENCODE_QUOTA_NO_STAR || env.CI) return false;
  if (markerExists) return false;
  return true;
}

// Record that we asked, so the question is never repeated. Best-effort: an
// unwritable config dir must not break an otherwise successful install, it just
// means the prompt may appear again next time.
export function markStarPrompted(markerPath = starMarkerPath()) {
  try {
    const dir = dirname(markerPath);
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readPackageJson(pkgRoot) {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Run the prompt. Never throws and never exits non-zero: this is a courtesy
 * question at the tail of an install, so every failure mode degrades to a
 * printed URL.
 *
 * Injectable seams (`confirm`, `star`, `print`, `now`) keep the flow testable
 * without a TTY or a real `gh`.
 *
 * Returns one of: "skipped" | "declined" | "starred" | "failed".
 */
export async function askToStarRepo({
  pkgRoot,
  repo = undefined,
  isTTY = Boolean(process.stdin.isTTY),
  noStar = false,
  env = process.env,
  markerPath = undefined,
  confirm,
  star = starViaGhCli,
  print = (s = "") => process.stdout.write(s + "\n"),
} = {}) {
  const resolvedRepo = repo ?? githubRepoFromPackageJson(readPackageJson(pkgRoot));
  const resolvedMarker = markerPath ?? starMarkerPath();

  if (
    !shouldPromptForStar({
      repo: resolvedRepo,
      isTTY,
      noStar,
      env,
      markerExists: existsSync(resolvedMarker),
    })
  ) {
    return "skipped";
  }

  let yes = false;
  try {
    yes = await confirm("★ Star the repo on GitHub?");
  } catch {
    return "skipped"; // a closed//broken stdin is not a failure worth reporting
  }

  // Asked is asked: remember before acting, so an interrupted `gh` call does
  // not turn into a repeated question.
  markStarPrompted(resolvedMarker);

  const url = `https://github.com/${resolvedRepo}`;
  if (!yes) {
    print(`  No problem. If you change your mind: ${url}`);
    return "declined";
  }

  if (star(resolvedRepo)) {
    print("  Thanks for starring! ★");
    return "starred";
  }
  print(`  Couldn't star automatically (needs an authenticated 'gh'). You can star manually:`);
  print(`  ${url}`);
  return "failed";
}

/**
 * Star via the user's own `gh` CLI. Returns a boolean rather than throwing.
 *
 * Uses the already-authenticated `gh` on purpose: the alternative is handling a
 * GitHub token ourselves, which a quota plugin has no reason to touch. stdio is
 * ignored so `gh` cannot print over the installer's output, and the timeout
 * keeps a hung network call from stalling an install.
 */
function starViaGhCli(repo) {
  try {
    execFileSync("gh", ["api", "--silent", "--method", "PUT", `/user/starred/${repo}`], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export const __internals = { starViaGhCli };
