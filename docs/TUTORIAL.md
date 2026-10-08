# Usage tutorial

Everything in the order you will meet it. About ten minutes.

1. [Install](#1-install)
2. [What happens by default](#2-what-happens-by-default)
3. [Check that it works](#3-check-that-it-works)
4. [Scopes: global, surface, project, session](#4-scopes-global-surface-project-session)
5. [Turn it on and off](#5-turn-it-on-and-off)
6. [Choose when sessions get warmed](#6-choose-when-sessions-get-warmed)
7. [Tune interval and idle cap](#7-tune-interval-and-idle-cap)
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

Then `/reload-plugins` or start a new session. Updating later: `/plugin` → update, then `/reload-plugins`.

Requirements: Node 18 or newer on your PATH, and a Claude Code recent enough to give Stop hooks the list of running background tasks (2.1.29x does).

## 2. What happens by default

Nothing visible, and nothing at all for most sessions. A session is pinged only when **all** of these are true:

| Condition | Default | Why |
| :--- | :--- | :--- |
| Warming is on for that session | on | |
| Something is pending in the background: a subagent, a background shell, a workflow, a scheduled task | required | Its result lands in this conversation, so you are coming back; meanwhile the conversation sends nothing that would refresh its own cache |
| The conversation has sent no request for one interval | 50 min on a 1h cache, 4 min on a 5m cache | Any request already refreshes the cache for free |
| The cache is still alive | | Pinging an expired cache would *be* the expensive rewrite |
| Something happened within the idle cap | 180 min | Bounds what a forgotten session can cost |
| The context is at least 20K tokens | | Small contexts are cheap to rebuild |

How it's timed: every time a turn ends, a small background hook ("waker") starts for that session and sleeps until one interval after the conversation's last request. Any new turn (you typing, an agent reporting back, a scheduled task) makes it stand down, and the next turn end starts a fresh one. If it wakes up and the session should still be kept warm, Claude Code wakes the session with a one-line note, Claude answers `ok`, and that single small turn reads the whole conversation from the cache, resetting the cache timer.

Typical case: you start a 90-minute background agent, go for lunch, and come back to a 600K-token conversation. Without warming, the first turn back re-writes all 600K tokens at full price. With warming, one ping at minute 50 kept it alive.

## 3. Check that it works

```text
/cache-warm:status
```

```text
global: ON | warm while background work runs | interval 50m | stop after 180m idle
* 264db9fa  cli      no-work        243.7k ctx   ttl 1h  every 50m  idle 2m 10s    0 pings  ~$0.0609/ping  standing by: nothing running in the background
    C:\Users\me\project
  a3398cd8  desktop  warming        466.9k ctx   ttl 1h  every 30m  idle 4m 05s    0 pings  1 bg job  ~$0.1167/ping  next ping in 25m 55s
    scoped: intervalMinutes=30 (surface:desktop)
    C:\Users\me\api
```

Reading a row: session id (`*` = the one you're in), surface, state, context size, cache TTL, effective interval, time since the last activity, pings since then, background jobs, cost of one ping, what happens next. A `scoped:` line lists settings that come from a narrower scope than global.

| State | Meaning |
| :--- | :--- |
| `warming` | Will ping when the countdown reaches zero |
| `busy` | A turn is running; the conversation refreshes its own cache |
| `no-work` | Standing by: nothing pending in the background (default policy) |
| `off` | Switched off at some scope for this session |
| `idle-cap` | Nothing has happened for longer than the idle cap |
| `ping-cap` | Already pinged the maximum number of times since the last activity |
| `expired` | The cache already timed out; nothing left to keep warm |
| `small-context` | Below `minContextTokens` |

`ccw doctor` runs the health checks in one go, including how many recent pings were verified as cache reads on each surface.

**Self-test.** Run `/cache-warm:test` (or `ccw test`) in any session, CLI or Desktop app, then don't type for a minute. A keep-alive note arrives, Claude answers `ok`, the ping is checked against the transcript, and the session's settings go back to what they were. `ccw status` then shows `last self-test: hit`. If nothing arrives within two minutes, that surface isn't waking sessions (settings restore by themselves after 15 minutes).

**Ping verification.** Every ping is judged once its turn reaches the transcript: a cache read is a hit, a re-write is a miss. Two misses in a row suspend warming for that session (`suspended` in `status`) until you are active in it again.

## 4. Scopes: global, surface, project, session

Every setting can be set at several scopes. Each session takes each value from the most specific scope that sets it:

```
session  >  project folder  >  surface (cli | desktop | ide)  >  global  >  plugin tab  >  defaults
```

- **Global** applies to everything that doesn't say otherwise.
- **Surface** separates where Claude Code runs: the terminal (`cli`), the Claude desktop app (`desktop`), IDE extensions (`ide`). A Desktop setting never changes a CLI session, and the other way round.
- **Project** applies to sessions started in that folder or any folder below it.
- **Session** applies to one session only.

Leave something unset and it inherits from the next scope down. With nothing set anywhere you get the defaults: on, background work only, `auto` interval (50 minutes on a 1-hour cache), 3-hour idle cap.

```sh
ccw config --session        # what this session uses, and which scope each value comes from
ccw scopes                  # every scope that has settings
```

**Default scope.** Run inside a Claude Code session (including by Claude, or through `/cache-warm:on|off`), a `ccw` change without a scope flag applies to **that session's surface only**: in the Desktop app it changes Desktop sessions, in a terminal session it changes CLI sessions. One can never switch the other off by accident. To change both, say so with `--global`. From a plain terminal outside Claude Code, no flag means global.

The flags work on every settings command:

| Flag | Scope |
| :--- | :--- |
| (none) | this session's surface inside Claude Code; global from a plain terminal |
| `--global` | every session |
| `--cli`, `--desktop`, `--ide` | that surface |
| `--project` | the current folder and below (`--project=<folder>` for another) |
| `--session` | the session this shell belongs to (`--session=<id prefix>` for another) |

The slash commands take the same scopes as words: `/cache-warm:off desktop`, `/cache-warm:on session`, `/cache-warm:config interval 20 project`.

## 5. Turn it on and off

| | In Claude Code | In a shell |
| :--- | :--- | :--- |
| Everything off | `/cache-warm:off` | `ccw off` |
| Everything on | `/cache-warm:on` | `ccw on` |
| Only the desktop app off | `/cache-warm:off desktop` | `ccw off --desktop` |
| Only this project off | `/cache-warm:off project` | `ccw off --project` |
| Only this session off | `/cache-warm:off session` | `ccw off --session` |
| Undo a scope's settings | | `ccw reset --session` (or `--project`, `--desktop`, ...) |

Changes reach running sessions within seconds. Nothing needs a restart.

## 6. Choose when sessions get warmed

```sh
ccw when background-work   # default: only while something is pending in the background
ccw when always            # any idle session, until the idle cap
ccw when always --project  # ...only for this project
```

`always` is for large sessions you step away from and want to come back to warm regardless. It costs more: every idle session in that scope gets pinged each interval until the idle cap. Check the dashboard's "Recent cold rebuilds" table first; it shows what your real pauses cost and what warming would have cost instead.

What counts as pending background work comes straight from Claude Code (the list it hands to Stop hooks): background subagents, background shell commands, workflows, teammates, cloud sessions, MCP tasks, and scheduled tasks (`/loop`, cron). Monitors don't count: they are watchers that can run forever.

## 7. Tune interval and idle cap

```sh
ccw interval auto                    # recommended
ccw interval 30                      # minutes, 1 to 59
ccw set maxIdleMinutes 240           # 0 = never stop
ccw set minContextTokens 50000
ccw unset intervalMinutes --desktop  # back to inheriting
```

Plugin-tab edits apply right away (through Claude Code's `ConfigChange` hook); timers that are already sleeping pick them up within a minute.

**Interval.** Counted from the conversation's last request, and must be shorter than the cache TTL or pings land too late. `auto` reads the TTL from the session's own transcript. A `warning:` line in `status` means a fixed interval is too long for that session.

**Get the 1-hour TTL first.** It turns 15 pings an hour into 1. A Claude subscription gets it automatically inside plan limits. With an API key, or to keep it on usage credits, add `"promptCacheTtl": "1h"` to your Claude Code settings.

**Idle cap.** "Idle" means nobody typed and no real work happened: pings, scheduled-task prompts and background reports don't reset it. Pings stop paying for themselves once they cost more than one rebuild: about 19 pings (~16 h) on a 1h cache, about 11 (~45 min) on a 5m cache, roughly 4x later on Fable 5.1. On top of the idle cap there's a hard limit of `ceil(idle cap / interval) + 1` pings per idle stretch (24 when the cap is 0).

## 8. The dashboard

```text
/cache-warm:dashboard
```

or `ccw dashboard`. It starts a small local server (loopback only) and opens the page. Running it again just reopens it.

**Live sessions.** One row per open session: where it runs (CLI / Desktop app / IDE, project), state, what it's waiting on, a live countdown to the next ping. The right-hand columns are that session's own settings; "Inherit (…)" shows the value it gets otherwise and where from. Pause/Resume and Reset act on that session only.

**Settings.** Tabs for Global, CLI, Desktop app, IDE and each project folder. Every field starts on "Inherit (value from scope)". Pick a value to set it at that scope, set it back to Inherit to clear it. "Add project" creates a project scope for any folder (suggestions come from your sessions' folders). "Reset this scope" clears everything at that scope.

**Analytics.** Computed read-only from your transcripts under `~/.claude/projects`:

- *Cache hit ratio*: share of input tokens served from the cache.
- *Cold rebuilds*: times you came back after the TTL and paid to re-write the context.
- *Avoidable with warming*: rebuild cost minus what pings would have cost, for pauses inside your idle cap.
- *Pings sent*: and how many were verified from the transcript to have landed on a warm cache.
- *Where the cache dies*: your pauses by length, survived vs rebuilt.

## 9. The status line

It's on by default and maintained automatically (setting `statusline`, global only):

| Value | What happens at each session start |
| :--- | :--- |
| `auto` (default) | The segment is added to the status line the session will show; if you have none, one is created in your user settings |
| `wrap-only` | Only existing status lines get the segment |
| `off` | Every original status line is restored exactly, and stays that way |

Change it with `ccw statusline auto|wrap-only|off`, the plugin tab, or the dashboard's Global tab. Only personal files are edited: your user settings and a project's `settings.local.json`. A status line in a project's shared `settings.json` is never touched; the segment goes into a git-ignored `settings.local.json` overlay instead. Change your own status line later and the next session start wraps the new one.

```text
/cache-warm:statusline
```

```text
⬆ /gsd-update │ Opus 5.5 │ me │ ● warm on, ping in 31m 55s (1 bg job) · ctx 245.3k, cached 243.8k (99%) · 1h cache, 41m 55s left
```

| Part | Meaning |
| :--- | :--- |
| `● warm on, ping in …` / `◌ warm standby` / `○ warm off` | This session's warming state |
| `(1 bg job)` | Background work pending |
| `ctx 245.3k` | Tokens in the context window |
| `cached 243.8k (99%)` | How many of them the last request read from the cache |
| `1h cache, 41m left` | TTL in use and time until the cache goes cold; `cache cold` in red once it has |

**It adds to your status line; it does not replace it.** Claude Code supports one `statusLine` command per settings file, so the installer remembers the command that was there and points the setting at a small launcher that runs your command first (same input), prints its output untouched, and appends the segment.

**Where it shows up.** Claude Code uses the status line from the most specific settings file that has one: `<project>/.claude/settings.local.json`, then `<project>/.claude/settings.json`, then `~/.claude/settings.json`. `ccw statusline install` goes into your user settings, so every folder gets it unless that folder defines its own status line. The installer tells you when the current folder does, and `--file=` adds the segment there too.

```sh
ccw statusline install                    # user settings, refresh every 5 s
ccw statusline install --newline          # segment on its own row
ccw statusline install --refresh=10       # slower tick
ccw statusline install --file=.claude/settings.local.json
ccw statusline                            # installs, and what this folder uses
ccw statusline uninstall                  # restore every wrapped status line exactly
```

**Refresh.** Countdowns tick every 5 seconds even while the session sits idle (`refreshInterval`). Each tick only re-runs your own status line command when something it shows changed (or every 15 s); otherwise its last output is reused, so the tick stays fast. Claude Code cancels a status line run that's still going when the next update arrives, so speed is what keeps the line from flickering or going blank.

Each settings file is backed up as `*.ccw-backup` before it's changed. If the plugin is removed, the launcher falls back to just your original status line.

## 10. Hotkeys and the tray app

Claude Code's keybindings can only trigger built-in actions, not plugin commands, so the hotkeys come from the optional tray app:

| Hotkey | Action |
| :--- | :--- |
| `Ctrl+Alt+W` | Toggle warming on/off globally |
| `Ctrl+Alt+D` | Open the dashboard |

```sh
cd desktop
npm install
npm run dev        # or: npm run build, for an installer
```

Change or disable them in `~/.claude-cache-warm/desktop.json`, then restart the tray app:

```json
{ "toggleHotkey": "Ctrl+Alt+W", "dashboardHotkey": "" }
```

The tray menu drives the global scope (on/off, background-work only, interval); surfaces, projects and sessions are edited in the dashboard. See [desktop/README.md](../desktop/README.md).

## 11. Is this safe for my cache and my conversation?

**It can't invalidate your cache.** The cache matches the *start* of each request. A ping is appended at the *end* of the conversation like any other turn, so everything before it still matches. Claude Code's documentation lists plugin hooks and skills as components that keep the cache. The plugin ships no MCP server and changes no tools, system prompt, model or effort level.

**It doesn't interrupt you.** A waker only exists between turns; the moment a turn starts it stands down. It never creates scheduled tasks, so nothing fires on a wall-clock schedule while you work.

**Sessions can't interfere with each other.** Each session has its own waker and its own resolved settings. There's no global engine to flip. Writes to shared files are locked, so a Desktop session and a CLI session saving at the same moment can't lose each other's change.

**What it does change:**

- Each ping adds two short messages to the conversation: a "Stop hook feedback" note with the keep-alive line (that's how Claude Code shows a background hook waking the session), and Claude's `ok`.
- Each ping is a real request: one cache read of the context, counted toward subscription usage limits.
- Pings never count as activity, so they can't keep a session alive past the idle cap.

**It fails closed.** Hooks always exit successfully and never block a prompt. If the waker dies, pings simply stop until the next turn end. Headless runs (`claude -p`, Agent SDK) are never registered.

## 12. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| Session not listed | It registers on its first hook event after the plugin was enabled. `/reload-plugins` in an old session |
| Always `no-work` | Correct when nothing is pending in the background. `ccw when always` (optionally `--session` / `--project`) to warm plain idle sessions |
| `warming` but the dashboard says "no timer yet" | The waker starts when the current turn ends |
| `warning: interval … is not shorter than the … TTL` | That session uses the 5-minute cache. `ccw interval auto`, or enable the 1-hour TTL |
| `expired` right after a laptop sleep | The cache timed out while the machine slept. The next real turn rebuilds it |
| Pings not "verified as cache hits" on the dashboard | Something else invalidated the cache in between (model switch, `/compact`, MCP tools changing). `/usage` names the likely cause |
| Status line segment missing in one folder | That folder has its own status line. `ccw statusline` (run there) says which file wins; `ccw statusline install --file=<that file>` |
| Status line blank in a new folder | Claude Code keeps it blank until you trust the folder |
| A settings change didn't apply | `ccw config --session` shows which scope each value comes from; a narrower scope may override it |

`ccw events 30` prints the recent log: pings with their reason, config changes, migrations.

## 13. Command reference

| Slash command | Shell | |
| :--- | :--- | :--- |
| `/cache-warm:on [scope]` | `ccw on [scope]` | Enable |
| `/cache-warm:off [scope]` | `ccw off [scope]` | Disable |
| `/cache-warm:status` | `ccw status [--all] [--json]` | Sessions and countdowns |
| `/cache-warm:test` | `ccw test` | Self-test this session end to end |
| `/cache-warm:dashboard` | `ccw dashboard [--no-open]` | Web dashboard |
| `/cache-warm:statusline [install\|newline\|uninstall]` | `ccw statusline …` | Status line segment |
| `/cache-warm:config …` | | Natural-language settings |
| | `ccw config [scope]` | Effective settings and their sources |
| | `ccw scopes` | Every scope that has settings |
| | `ccw when <background-work\|always> [scope]` | Warming policy |
| | `ccw interval <minutes\|auto> [scope]` | Ping interval |
| | `ccw set <key> <value> [scope]` | `enabled`, `warmWhen`, `intervalMinutes`, `maxIdleMinutes`, `minContextTokens`, `dashboardPort` (global) |
| | `ccw unset <key> [scope]` / `ccw reset [scope]` | Inherit again |
| | `ccw doctor`, `ccw events [n]` | Diagnostics |

All state lives in `~/.claude-cache-warm/` (`CCW_HOME` overrides it). [CONTRACT.md](CONTRACT.md) documents every file.
