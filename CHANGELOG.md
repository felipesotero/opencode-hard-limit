# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: new
features bump the minor version).

Versions before 0.14.3 were not documented here; see the
[git history](https://github.com/felipesotero/opencode-hard-limit/commits/main)
and the published tarballs on npm.

## [Unreleased]

## [0.18.1] - 2026-10-20

### Documentation

- README: guide for single vs. multi-account usage, a settings table, and a
  "what's new in 0.18.0" section. No code changes.

## [0.18.0] - 2026-10-20

With a single account nothing changes: no new setup, same `threshold`.

### Added

- Multi-account quota: named Claude profiles and OpenAI/Codex account stores are
  read per account, the gate checks the account that serves each request, and
  the sidebar shows one row per account.
- `warm` and `warm --watch` commands that keep idle Claude profiles logged in
  by refreshing their OAuth tokens. Opt-in: they never run unless called.
  `warm` refreshes only expired profiles, with per-account backoff, and runs
  its child process with isolated args, a clean environment and group kill.

### Changed

- A server-sent `Retry-After` on a 429 is capped (`maxRateLimitBackoffMs`,
  10 min; `noBaselineRateLimitBackoffMs`, 1 min when there is no earlier
  reading), and good data keeps being served through the blip.
- A transient error (timeout, 5xx, malformed response) no longer blocks on its
  own. The gate keeps using the last good reading and blocks only when that
  reading is below the threshold, or is too old and close to it
  (`staleBlockMarginPct`).
- A named Claude profile whose OAuth token has expired is allowed through with
  a warning, so the call itself can renew the token.
- `~/.claude` is no longer treated as an extra account beside named profiles.
- Quota account resolution is unified between the gate and the library.

## [0.17.0] - 2026-10-20

### Added

- `init` and `install` ask once, on an interactive terminal, whether to star the
  repo on GitHub. Starring needs an explicit yes and goes through your own
  authenticated `gh`; the plugin handles no GitHub token. Skip it with
  `--no-star`, `OPENCODE_QUOTA_NO_STAR=1` or `CI`.
- Tiered Anthropic credential resolution for `opencode-anthropic-multi-account`:
  reads its `accounts.json` first, falls back to OpenCode's `auth.json`, and
  keeps the legacy `claude` CLI/keychain path for single-account users. Cache
  entries are stamped with an account key, so switching accounts forces a fresh
  read. New config: `anthropicAccountsFile`, `anthropicCredentialSource`.

### Fixed

- The published CLI crashed with `ERR_MODULE_NOT_FOUND` because `lib/star.js`
  was missing from the `files` allowlist of the tarball.
- The star prompt no longer appears on `set`, only on `init` and `install`.

### Tests

- `test/package-files.test.js` checks that every relative import reachable from
  `bin/cli.js` and `quota-hard-stop.js` is listed in `files`.

## [0.15.0] - 2026-07-29

### Added

- When the server plugin starts, it installs the matching published package
  globally in the background, so `opencode-hard-limit` is available in OpenCode
  shell mode (for example `opencode-hard-limit postpone 30`).

## [0.14.3] - 2026-07-24

### Added

- Fail-postpone mode, a third quota-block failure mode next to fail-closed and
  fail-open: temporarily bypass a legitimate block when you accept the risk of
  running over quota. Opt-in via `allowPostpone` (`--allow-postpone`,
  `OPENCODE_QUOTA_ALLOW_POSTPONE`).
- `opencode-hard-limit postpone [minutes]` (default 30, clamped 1-240) and
  `opencode-hard-limit postpone --clear`. It runs through OpenCode's shell
  escape (`!command`), so it costs no tokens.
- A block's error message and the sidebar widget hint how to postpone; `get`
  shows whether a postpone is active and how much time is left.

### Fixed

- The sidebar widget crashed on OpenCode restart because the deploy step did
  not ship `lib/postpone.js` alongside the sidebar plugin.
- Simplified the quota-block error message and removed AI-directed instruction
  text that had no effect.
- Clarified that OpenCode's shell mode only triggers when `!` is the first
  character typed into an empty prompt, not when the whole line is pasted.

### Documentation

- New README section on fail-postpone mode, including the known limitation that
  a blocked subagent's error is not relayed to its parent.

[Unreleased]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.18.1...HEAD
[0.18.1]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.15.0...v0.17.0
[0.15.0]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.14.3...v0.15.0
[0.14.3]: https://github.com/felipesotero/opencode-hard-limit/compare/v0.12.2...v0.14.3
