# opencode-hard-limit

An [OpenCode](https://opencode.ai) plugin that puts a **hard stop** on model
calls when a provider's **weekly** AI quota drops below a configurable
percent-remaining threshold.

It builds on [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota),
which surfaces quota UI/toasts but does **not** block calls. This plugin adds the
enforcement layer: it runs before every model call, reads the weekly quota via
the quota CLI, and throws (aborting the call) when you are over budget.

Goal: avoid burning past ~70% of your weekly Claude/Anthropic and Codex/OpenAI
quota (i.e. keep at least 30% remaining).

## How it works

On the `chat.params` hook (fired before each model request):

1. Detect the provider from `input.provider.info.id`.
   Only `anthropic` (Claude) and `openai` (Codex/OpenAI) are monitored; any other
   provider is ignored.
2. Run `npx -y @slkiser/opencode-quota show --json --provider <provider>`.
3. Parse the JSON and select the entry where `window === "Weekly"`.
4. If `percentRemaining < threshold`, throw and block the call.
5. If the quota **cannot be verified** (timeout, error, non-`ok` status, missing
   `Weekly` window, invalid JSON), block by default (fail-safe).

Results are cached in-memory per provider (default 60s) to avoid spawning the CLI
on every turn.

> Note: the plugin reads the `Weekly` window directly instead of relying on the
> CLI `--threshold` flag, because `--threshold` evaluates all windows (including
> the `5h` window).

## Requirements

- OpenCode with plugin support.
- `@slkiser/opencode-quota` configured (`npx @slkiser/opencode-quota init`) and
  reporting quota correctly inside OpenCode.

## Install

### Option A: local plugin file

Copy the plugin into your OpenCode plugins directory:

```sh
cp quota-hard-stop.js ~/.config/opencode/plugins/quota-hard-stop.js
```

OpenCode auto-loads plugin files from `~/.config/opencode/plugins/`.

### Option B: from this repo

Clone and symlink (keeps updates easy):

```sh
git clone https://github.com/felipesotero/opencode-hard-limit.git
ln -s "$PWD/opencode-hard-limit/quota-hard-stop.js" \
  ~/.config/opencode/plugins/quota-hard-stop.js
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_QUOTA_MIN_REMAINING` | `30` | Minimum weekly `%` remaining to allow a call. `30` blocks once >70% is used. |
| `OPENCODE_QUOTA_BLOCK_ON_ERROR` | `1` | `1` blocks when quota can't be verified. Set `0` to fail open (allow on error). |
| `OPENCODE_QUOTA_CACHE_TTL_MS` | `60000` | In-memory cache TTL per provider. |
| `OPENCODE_QUOTA_TIMEOUT_MS` | `20000` | Max time to wait for the quota CLI. |

## Verify it works

Check quota manually:

```sh
npx -y @slkiser/opencode-quota show --json --provider anthropic
npx -y @slkiser/opencode-quota show --json --provider openai
```

Force a block (threshold above current remaining) to confirm enforcement:

```sh
OPENCODE_QUOTA_MIN_REMAINING=90 opencode
```

With weekly quota at, say, 81% remaining, the next Claude/Codex call is blocked.
Set it back to `30` (or unset) for normal operation.

## License

MIT
