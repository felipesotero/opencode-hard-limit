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

### Quick start (recommended)

One command writes the config and installs the plugin:

```sh
npx opencode-hard-limit init --global --threshold 30 --install
```

`--install` copies the plugin (and its `lib/`) into
`~/.config/opencode/plugins/`, which OpenCode auto-loads.

Prefer to be walked through it? Run `npx opencode-hard-limit init` with no flags:
it asks **where** the threshold should apply (global vs project, see below),
writes the config file, and then prints the install command. Note that `init`
**without** `--install` only writes config; you still run
`opencode-hard-limit install` afterwards.

### Manual install

```sh
git clone https://github.com/felipesotero/opencode-hard-limit.git
cd opencode-hard-limit
node bin/cli.js install
```

### Upgrade / uninstall

- **Upgrade:** after updating the package (or pulling this repo), re-run
  `opencode-hard-limit install` to copy the new files over.
- **Uninstall:** remove the copied files and the tui.json entry:
  ```sh
  rm ~/.config/opencode/plugins/quota-hard-stop.js
  rm ~/.config/opencode/plugins/quota-sidebar.tsx
  rm ~/.config/opencode/plugins/lib/config.js
  rm ~/.config/opencode/plugins/lib/quota.js
  ```
  Then remove the `quota-sidebar.tsx` entry from
  `~/.config/opencode/tui.json` and restart OpenCode.

> Runtime note: at check time the plugin runs
> `npx -y @slkiser/opencode-quota ...`. The first uncached run may fetch that
> package and needs network access; it deliberately tracks the latest `3.x`.
> `@slkiser/opencode-quota` is declared as an optional peer dependency because it
> is invoked as a CLI rather than imported.

## Sidebar quota indicator (TUI)

The package includes `quota-sidebar.tsx`, a SolidJS TUI plugin for OpenCode's
sidebar that shows a live per-provider weekly usage bar for every monitored
provider (Claude/Anthropic and Codex/OpenAI).

**What it shows:**

- A usage bar for each provider with the weekly percent remaining.
- Your configured threshold so you can see how close you are.
- Color shifts from green (plenty left) to red as remaining usage nears the
  threshold.

**Installation (automatic):**

`opencode-hard-limit install` (and `init --install`) now also copies
`quota-sidebar.tsx` and `lib/quota.js` into
`~/.config/opencode/plugins/` and registers the widget in
`~/.config/opencode/tui.json` under the `"plugin"` array. Restart OpenCode
after install for the sidebar widget to appear.

**Manual alternative:**

If you prefer to register it yourself, add the absolute installed path to
your `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/<you>/.config/opencode/plugins/quota-sidebar.tsx"
  ]
}
```

A restart of OpenCode is required after editing `tui.json`.

**Configuration:**

The sidebar reads the same threshold as the hard-stop plugin, using the same
precedence (`env var > project file > global file > default`). No extra config
is needed.

**Uninstall:**

Remove the copied files and the `tui.json` entry:

```sh
rm ~/.config/opencode/plugins/quota-sidebar.tsx
rm ~/.config/opencode/plugins/lib/quota.js
```

Then remove the `quota-sidebar.tsx` entry from
`~/.config/opencode/tui.json` and restart OpenCode.

## Configuration

### Where config lives: global vs project

The threshold can be set at two scopes, and it is **your choice** which one to use:

| Scope | Applies to | File |
| --- | --- | --- |
| **Global** | every OpenCode project on this machine | `~/.config/opencode/opencode-hard-limit/config.json` |
| **Project** | only the current directory | `./.opencode-hard-limit.json` |

Most people want **global** (one budget for the whole machine). Use **project**
only when a specific repo needs a different budget.

The CLI makes the choice explicit: pass `--global` or `--project`, or omit both
and you will be prompted interactively with each target path shown.

### Set the threshold

```sh
# Global (all projects) - the common case
npx opencode-hard-limit set --threshold 30 --global

# Project (current directory only)
npx opencode-hard-limit set --threshold 55 --project

# See the effective value and where each setting came from
npx opencode-hard-limit get
```

### Precedence

When the same setting exists in more than one place, the highest wins:

```
env var  >  project file  >  global file  >  built-in default
```

`get` prints the resolved value for each setting **and** its source, so there is
no guessing.

### Settings

| CLI flag | Env var | File key | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--threshold` | `OPENCODE_QUOTA_MIN_REMAINING` | `minRemaining` | `30` | Minimum weekly `%` remaining to allow a call. `30` blocks once >70% is used. |
| `--block-on-error` | `OPENCODE_QUOTA_BLOCK_ON_ERROR` | `blockOnError` | `true` | Block when quota can't be verified. `false` fails open (allows on error). |
| `--cache-ttl` | `OPENCODE_QUOTA_CACHE_TTL_MS` | `cacheTtlMs` | `60000` | In-memory cache TTL per provider (ms). |
| `--timeout` | `OPENCODE_QUOTA_TIMEOUT_MS` | `timeoutMs` | `20000` | Max time to wait for the quota CLI (ms). |

Environment variables are useful for one-off overrides:

```sh
OPENCODE_QUOTA_MIN_REMAINING=90 opencode   # temporarily stricter
```

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
