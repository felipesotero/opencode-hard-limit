# opencode-hard-limit

Stop [OpenCode](https://opencode.ai) before it burns through your AI quota.

`opencode-hard-limit` is a plugin that watches your Claude/Anthropic and
Codex/OpenAI usage and puts a **hard stop** on model calls once you drop below a
percent-remaining threshold you choose. It also adds a live **sidebar bar** so
you can see exactly how much you have left and when the window resets.

It builds on [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota),
which surfaces quota numbers but does **not** block anything. This plugin adds
the missing enforcement layer.

## Why you might want this

Quota runs out at the worst possible time. Two common situations this is built for:

- **Shared quota, no surprises.** When a team splits one plan, you rarely want
  any single person to sprint to 100%. Set the goal so everyone stops with a
  buffer left (for example, block once 70% is used so 30% stays for the rest of
  the team).
- **Runaway prompts.** A single bloated prompt or an over-eager agent loop can
  drain a window shockingly fast. A hard stop keeps one bad turn from wiping out
  your whole budget.

**Your goal is a single number: the minimum percent you want to keep in
reserve.** That is the `threshold`. Everything else has a sensible default.

## Quick start

One command. It writes your config, installs the plugin, and wires up the
sidebar:

```sh
npx opencode-hard-limit init --global --threshold 30 --install
```

Then **restart OpenCode**. That is it.

You do **not** need to install `@slkiser/opencode-quota` separately. The plugin
invokes it on demand via `npx` at check time, so the quota reader is fetched
automatically the first time it runs (this needs network access on that first
call).

Prefer to be walked through it? Run `npx opencode-hard-limit init` with no
flags. It asks **where** the threshold should apply (global or project) and
prints the next step. `init` without `--install` only writes config; run
`npx opencode-hard-limit install` afterward to activate the plugin.

## Uninstall

One line removes every file and unregisters the sidebar:

```sh
npx opencode-hard-limit uninstall
```

Restart OpenCode to finish. Your saved threshold and the shared TUI runtime
dependencies are left in place (other plugins may use them).

## How it works

Before every model request, on OpenCode's `chat.params` hook:

1. Detect the provider. Only `anthropic` (Claude) and `openai` (Codex) are
   monitored; anything else passes straight through.
2. Read quota via `npx -y @slkiser/opencode-quota show --json --provider <p>`.
3. Pick the entry for your configured window (`5h` by default).
4. If `percentRemaining < threshold`, throw and block the call.
5. If quota **cannot be verified** (timeout, error, bad JSON, missing window),
   block by default. This is a fail-safe you can flip off with
   `--block-on-error false`.

Reads are cached in memory per provider (default 60s) so it does not spawn the
CLI on every turn.

## Which window: 5h or weekly

By **default the plugin watches the rolling 5h window**, so a burst of heavy
usage trips the limit quickly and recovers a few hours later. Prefer to pace
yourself across the whole week instead? Switch to the weekly window:

```sh
# Track the weekly window globally
npx opencode-hard-limit set --window Weekly --global

# Back to the default 5h window
npx opencode-hard-limit set --window 5h --global
```

Both the hard-stop and the sidebar follow whichever window you set.

## Sidebar usage bar

The install step also registers a small SolidJS TUI widget in OpenCode's
sidebar. For each monitored provider it shows:

- A usage bar with the percent remaining for your configured window.
- Your threshold, so you can see how close you are.
- A color that shifts from green to red as you approach the limit.
- A `Resets in Xh Ymin` line so you know when the window rolls over.

It reads the **same** threshold and window as the hard-stop (no extra config),
polls every 60s, and appears after you restart OpenCode.

<details>
<summary>Why the widget ships as raw <code>.tsx</code> (not bundled)</summary>

OpenCode transpiles the raw `.tsx` with babel-preset-solid and virtualizes
`@opentui/solid`, `@opentui/core`, and `solid-js` at the package level. That is
the only supported path. Pre-bundling emits `from "@opentui/solid/jsx-runtime"`,
a subpath OpenCode does not virtualize, which would put JSX on a separate
solid-js instance from the virtualized `createSignal` and make the widget render
nothing silently. So the installer copies the source and ensures the three TUI
runtime deps exist in `~/.config/opencode/`.
</details>

## Configuration

### Global vs project

The threshold can live at two scopes, and it is **your choice**:

| Scope | Applies to | File |
| --- | --- | --- |
| **Global** | every OpenCode project on this machine | `~/.config/opencode/opencode-hard-limit/config.json` |
| **Project** | only the current directory | `./.opencode-hard-limit.json` |

Most people want **global** (one budget for the whole machine). Use **project**
when a specific repo needs its own budget. The CLI keeps the choice explicit:
pass `--global` or `--project`, or omit both to be asked interactively.

```sh
# Global (all projects), the common case
npx opencode-hard-limit set --threshold 30 --global

# Project (current directory only)
npx opencode-hard-limit set --threshold 55 --project

# Show the effective value and where each setting came from
npx opencode-hard-limit get
```

### Precedence

When a setting exists in more than one place, the highest wins:

```
env var  >  project file  >  global file  >  built-in default
```

`get` prints the resolved value **and** its source for every setting, so there
is no guessing.

### Settings

| CLI flag | Env var | File key | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--threshold` | `OPENCODE_QUOTA_MIN_REMAINING` | `minRemaining` | `30` | Minimum `%` remaining to allow a call. `30` blocks once 70% is used. |
| `--window` | `OPENCODE_QUOTA_WINDOW` | `window` | `5h` | Quota window to track: `5h` or `Weekly`. |
| `--block-on-error` | `OPENCODE_QUOTA_BLOCK_ON_ERROR` | `blockOnError` | `true` | Block when quota can't be verified. `false` fails open. |
| `--cache-ttl` | `OPENCODE_QUOTA_CACHE_TTL_MS` | `cacheTtlMs` | `60000` | In-memory cache TTL per provider (ms). |
| `--timeout` | `OPENCODE_QUOTA_TIMEOUT_MS` | `timeoutMs` | `20000` | Max wait for the quota CLI (ms). |

Environment variables are handy for one-off overrides:

```sh
OPENCODE_QUOTA_MIN_REMAINING=90 opencode   # temporarily stricter
```

## Requirements

- OpenCode with plugin support.
- Network access on the first quota check (so `npx` can fetch
  `@slkiser/opencode-quota`). It is declared as an optional peer dependency
  because it is invoked as a CLI, not imported, and tracks the latest `3.x`.

## Verify it works

Check quota directly:

```sh
npx -y @slkiser/opencode-quota show --json --provider anthropic
npx -y @slkiser/opencode-quota show --json --provider openai
```

Force a block by setting the threshold above your current remaining:

```sh
OPENCODE_QUOTA_MIN_REMAINING=90 opencode
```

With, say, 81% remaining, the next Claude/Codex call is blocked. Set it back to
`30` (or unset) for normal operation.

## Upgrade

After updating the package (or pulling this repo), re-run
`npx opencode-hard-limit install` to copy the new files over, then restart
OpenCode.

## License

MIT
