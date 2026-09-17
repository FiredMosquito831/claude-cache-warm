# Usage tutorial

A walk through everything, in the order you will meet it. Ten minutes.

1. [Install](#1-install)
2. [What happens by default](#2-what-happens-by-default)
3. [Check that it works](#3-check-that-it-works)
4. [Turn it on and off](#4-turn-it-on-and-off)
5. [Choose when sessions get warmed](#5-choose-when-sessions-get-warmed)
6. [Tune interval and idle cap](#6-tune-interval-and-idle-cap)
7. [Per-session settings](#7-per-session-settings)
8. [The dashboard](#8-the-dashboard)
9. [The status line](#9-the-status-line)
10. [Hotkeys and the tray app](#10-hotkeys-and-the-tray-app)
11. [Is this safe for my cache and my conversation?](#11-is-this-safe-for-my-cache-and-my-conversation)
12. [Troubleshooting](#12-troubleshooting)
13. [Command reference](#13-command-reference)

## 1. Install

In Claude Code:

```text
/plugin marketplace add FiredMosquito831/claude-cache-warm
/plugin install cache-warm@claude-cache-warm
```

Start a **new** session afterwards. Hooks and the monitor process attach when a session starts.

Requirements: Node 18 or newer on your PATH. Nothing else.

## 2. What happens by default

Nothing visible, and nothing at all for most sessions. With the defaults, a session is pinged only when **all** of these are true:

| Condition | Default | Why |
| :--- | :--- | :--- |
| Warming is on | on | Master switch |
| A subagent or background task is running in that session | required | You are certainly coming back for its result, and while it runs the main conversation sends nothing that would refresh its own cache |
| The main conversation has been silent for one interval | 50 min on a 1h cache, 4 min on a 5m cache | An active session refreshes its own cache for free |
| The cache is still alive | | Pinging an expired cache would *be* the expensive rewrite |
| You have not been away longer than the idle cap | 180 min | Bounds what a forgotten session can cost |
| The context is at least 20K tokens | | Small contexts are cheap to rebuild |

A ping is one line delivered to the idle session. Claude answers `ok`. That single small turn reads the whole conversation from the cache, which resets the cache timer.

Typical case it is built for: you launch a 90-minute background agent or a long build, go for lunch, and come back to a conversation with 600K tokens of context. Without warming, the first turn back re-writes all 600K tokens at full price and is slow. With warming, one ping at minute 50 kept it alive.

## 3. Check that it works

```text
/cache-warm:status
```

```text
cache-warm: ON | warm only while background work runs | interval auto | stop after 180m idle | engine monitor
* 264db9fa  no-work        243.7k ctx   ttl 1h  every 50m  idle 2m 10s    0 pings  ~$0.0609/ping  standing by: no subagent or background task running
    C:\Users\me\project
```

Reading a row: session id (`*` marks the one you are in), state, context size, detected cache TTL, effective interval, how long since you last did something, pings since then, estimated cost of one ping, and what happens next.

| State | Meaning |
| :--- | :--- |
| `warming` | Will ping when the countdown reaches zero |
| `no-work` | Standing by: nothing is running in the background (default policy) |
| `off` | Switched off globally or for this session |
| `idle-cap` | You have been away longer than the idle cap |
| `expired` | The cache already timed out, so there is nothing left to keep warm |
| `small-context` | Below `minContextTokens` |
| `[no monitor]` | The timer process is not running in this session: see [Troubleshooting](#12-troubleshooting) |

`ccw doctor` runs the health checks in one go.

## 4. Turn it on and off

| | In Claude Code | In a shell |
| :--- | :--- | :--- |
| Everything off | `/cache-warm:off` | `ccw off` |
| Everything on | `/cache-warm:on` | `ccw on` |
| Only this session off | `/cache-warm:off session` | `ccw off --session` |

Changes reach running sessions within 5 seconds. Nothing needs a restart.

## 5. Choose when sessions get warmed

```sh
ccw when background-work   # default: only while a subagent or background task runs
ccw when always            # any idle session, until the idle cap
```

`always` is for people who step away from large sessions a lot and want to come back to a warm cache regardless. It costs more: every idle session gets pinged every interval until the idle cap. Look at the dashboard's "Recent cold rebuilds" table before deciding; it shows what your real pauses cost and what warming would have cost instead.

What counts as background work:

- **Subagents**, from the moment they start until they stop, including background agents and workflow agents.
- **Background shell commands** (`run_in_background`). Claude Code has no event for one finishing, so these count as running for 2 hours.

## 6. Tune interval and idle cap

```sh
ccw interval auto          # recommended
ccw interval 30            # minutes, 1 to 59
ccw set maxIdleMinutes 240 # 0 = never stop
ccw set minContextTokens 50000
```

**Interval.** It must be shorter than the cache TTL or pings arrive too late. `auto` reads the TTL from the session's own transcript. If `status` prints a `warning:` line, your fixed interval is too long for that session.

**Get the 1-hour TTL first.** It turns 15 pings an hour into 1. A Claude subscription gets it automatically while you are inside plan limits. With an API key, or to keep it on usage credits, add `"promptCacheTtl": "1h"` to your Claude Code settings.

**Idle cap.** Pings stop paying for themselves once you have spent more on them than one rebuild costs: about 19 pings (~16 h) on a 1h cache, about 11 pings (~45 min) on a 5m cache, and roughly 4x later on Fable 5.1 where cache reads are cheaper. The 3-hour default is deliberately cautious.

## 7. Per-session settings

Every session can override the global on/off switch, the warming policy, the interval and the idle cap.

In a shell, add `--session` (the session this shell belongs to) or `--session=<first characters of the id>`:

```sh
ccw when always --session            # keep this one warm even with nothing in the background
ccw interval 20 --session=264d
ccw set maxIdleMinutes 600 --session
ccw off --session
ccw follow                           # drop all overrides, follow the global settings again
```

Or do it in the dashboard, which is usually easier.

## 8. The dashboard

```text
/cache-warm:dashboard
```

or `ccw dashboard` in a shell. It starts a small local web server (loopback only, port 4777) and opens `http://127.0.0.1:4777/`. Running the command again just reopens the page.

**Live sessions.** One row per open Claude Code session, with a live countdown to the next ping. The right-hand columns are the per-session settings:

| Column | What it does |
| :--- | :--- |
| Warm when | `Global`, `Background work`, or `Whenever idle` for this session |
| Interval | `Global`, `Auto`, or a fixed number of minutes |
| Idle cap | Empty means global |
| Pause / Resume | Per-session off switch |
| Reset | Drop all overrides for the session |

**Settings.** The global defaults. Same as the `ccw` commands.

**Analytics.** Computed from your own transcripts under `~/.claude/projects`, read-only:

- *Cache hit ratio*: share of input tokens served from the cache.
- *Cold rebuilds*: times you came back after the TTL and paid to re-write the context.
- *Avoidable with warming*: rebuild cost minus what the pings would have cost, for pauses inside your idle cap.
- *Pings sent*: and how many were verified, from the transcript, to have landed on a warm cache.
- *Where the cache dies*: your pauses by length, split into survived and rebuilt. This is the chart that tells you whether a longer idle cap is worth it.

The first scan of a busy week takes about half a minute; afterwards it is incremental.

## 9. The status line

```text
/cache-warm:statusline
```

```text
⬆ /gsd-update │ Fable 5.1 │ v1.0 · completed │ me │ ● warm on, ping in 31m 59s (1 bg job) · ctx 245.3k, cached 243.8k (99%) · 1h cache, 41m 59s left
```

| Part | Meaning |
| :--- | :--- |
| `● warm on, ping in …` / `◌ warm standby` / `○ warm off` | Warming state for this session |
| `(1 bg job)` | Background work detected |
| `ctx 245.3k` | Tokens currently in the context window |
| `cached 243.8k (99%)` | How many of them the last request read from the cache |
| `1h cache, 41m left` | TTL in use and time until the cache goes cold; `cache cold` in red once it has |

**It adds to your status line; it does not replace it.** Claude Code only supports one `statusLine` command, so the installer finds the one in effect, remembers it, and points the setting at a small launcher that runs your command first with the same input, prints its output untouched, then appends the segment.

```sh
ccw statusline install             # append to the last line of the existing status line
ccw statusline install --newline   # put the segment on its own row instead
ccw statusline                     # what is installed, what it wraps
ccw statusline uninstall           # restore the previous status line exactly
```

The settings file is backed up next to itself as `*.ccw-backup` before it is changed. If the plugin is ever removed, the launcher falls back to just running your original status line.

## 10. Hotkeys and the tray app

Claude Code's own keybindings can only trigger built-in actions; they cannot run a plugin command. So the hotkeys are global ones, provided by the optional tray app:

| Hotkey | Action |
| :--- | :--- |
| `Ctrl+Alt+W` | Toggle warming on/off |
| `Ctrl+Alt+D` | Open the dashboard |

```sh
cd desktop
npm install
npm run dev        # or: npm run build, for an installer
```

Change or disable them in `~/.claude-cache-warm/desktop.json`:

```json
{ "toggleHotkey": "Ctrl+Alt+W", "dashboardHotkey": "" }
```

Hotkey changes apply when the tray app restarts. The tray icon's tooltip and menu show the current state, and the menu has the same switches (on/off, background-work only, interval). See [desktop/README.md](../desktop/README.md).

Without the tray app, the fastest toggle inside Claude Code is typing `/cache-warm:off`.

## 11. Is this safe for my cache and my conversation?

**It cannot invalidate your cache.** The cache matches the *start* of each request. A ping is appended at the *end* of the conversation, like any other turn, so everything before it still matches. Claude Code's documentation lists hooks, monitors and skills from plugins as components that keep the cache. The plugin ships no MCP server and changes no tools, system prompt, model or effort level, which are the things that do invalidate it.

**It does not interrupt you.** Pings are only produced when the main conversation has been silent for a whole interval. A ping that arrives while Claude is busy is a queued notification like any other; it does not cut into the running turn.

**What it does change:**

- Each ping adds two short messages to the conversation (the ping line and `ok`). Over a long idle period that is a few hundred tokens.
- Each ping is a real request. It costs one cache read of the context and counts toward subscription usage limits.
- A ping's turn ending is not treated as you being active, so pings can never keep their own session alive past the idle cap.

**It fails closed.** Hooks always exit successfully and never block a prompt. If the monitor dies, pings simply stop. If the cache is already cold, it does nothing rather than trigger a rewrite.

## 12. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `[no monitor]` in status | Plugin monitors are experimental and only run in interactive CLI sessions. Start a new session after installing. In the desktop app, or if monitors are unavailable, use the fallback: `/cache-warm:config engine cron` |
| Session not listed | It registers on its first prompt after the plugin was enabled |
| Always `no-work` | Correct when nothing runs in the background. Use `ccw when always` (optionally `--session`) to warm plain idle sessions too |
| `warning: interval … is not shorter than the … TTL` | That session uses the 5-minute cache. Use `ccw interval auto`, or enable the 1-hour TTL |
| `expired` right after a laptop sleep | The cache timed out while the machine slept. The next real turn rebuilds it; warming resumes after that |
| Pings sent but not "verified as cache hits" on the dashboard | Something else invalidated the cache in between (model switch, `/compact`, MCP tools changing). See `/usage` for the likely cause |
| Status line segment missing | It appears after the next turn. `ccw statusline` shows which settings file is in effect |

`ccw events 30` prints the recent log: pings, skips with their reason, config changes.

## 13. Command reference

| Slash command | Shell | |
| :--- | :--- | :--- |
| `/cache-warm:on [session]` | `ccw on [--session]` | Enable |
| `/cache-warm:off [session]` | `ccw off [--session]` | Disable |
| `/cache-warm:status` | `ccw status [--all] [--json]` | Sessions and countdowns |
| `/cache-warm:dashboard` | `ccw dashboard [--no-open]` | Web dashboard |
| `/cache-warm:statusline [install\|newline\|uninstall]` | `ccw statusline …` | Status line segment |
| `/cache-warm:config …` | | Natural-language settings, cron fallback |
| | `ccw when <background-work\|always> [--session]` | Warming policy |
| | `ccw interval <minutes\|auto> [--session]` | Ping interval |
| | `ccw set <key> <value> [--session]` | `maxIdleMinutes`, `minContextTokens`, `engine`, `dashboardPort` |
| | `ccw follow [--session=<id>]` | Drop per-session overrides |
| | `ccw doctor`, `ccw events [n]` | Diagnostics |

All state lives in `~/.claude-cache-warm/` (`CCW_HOME` overrides it). Delete the directory to reset everything.
