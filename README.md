# claude-cache-warm

Keeps the prompt cache of **idle Claude Code sessions** warm, so coming back to a session doesn't cost a full-price rewrite of its whole context.

- **Plugin** for Claude Code. Works the same in the CLI, the IDE extensions and the Desktop app.
- **Scoped settings**: global, per surface (CLI / Desktop app / IDE), per project folder, per session. Anything unset inherits.
- **Status line segment**, on automatically: warming state, ping countdown, context and cached tokens, time until the cache expires. Wraps your existing status line instead of replacing it; one setting turns it off and restores the original.
- **Self-checking**: every ping is verified against the transcript; a session whose pings miss the cache is suspended. `/cache-warm:test` proves the whole loop in any session, CLI or Desktop app.
- **Dashboard** (local web UI): live sessions, every scope's settings, analytics mined from your own transcripts.
- **Tray app** (Tauri, optional): global hotkeys and a tray toggle.

**New here? Read the [usage tutorial](docs/TUTORIAL.md).** Upgrading from 0.2: see [what changed](#upgrading-from-02).

Zero runtime dependencies. Node 18+. Needs a Claude Code recent enough to pass `background_tasks` to Stop hooks and to support `asyncRewake` hooks (2.1.29x has both).

## Why

Claude Code re-sends the whole conversation on every turn; the prompt cache makes that cheap (a cache read is 0.1x input price, 0.025x on Fable 5.1). But the cache expires after a period of silence: **5 minutes** on an API key, **1 hour** on a Claude subscription or with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. The first turn after expiry re-writes everything at 1.25x (5m) or 2x (1h) input price, and is slow.

Every cache hit resets the timer. One tiny turn shortly before expiry keeps a big context alive for a fraction of the rebuild:

| 800K-token context on Opus 5, 1h cache | Cost |
| :--- | ---: |
| One keep-alive ping (cache read) | ~$0.40 |
| Cold return after 90 minutes (cache write) | ~$8.00 |

## Install

```text
/plugin marketplace add FiredMosquito831/claude-cache-warm
/plugin install cache-warm@claude-cache-warm
```

Start a new session (or run `/reload-plugins`). Defaults: warming on, interval `auto` (50 minutes on a 1-hour cache), only for sessions that are waiting on background work.

## How it works

```
Stop hook (asyncRewake)                                  UserPromptSubmit hook
  every turn end starts one "waker" for that session       a new turn starts: the sleeping
  │ records: turn ended, what's running in the background  waker stands down. The next turn
  │ (Claude Code's own background_tasks / session_crons)   end starts a fresh one.
  ▼
  sleeps until  last request + interval
  │ re-checks: still idle? background work pending? settings for THIS session?
  ▼
  exit 2  ──►  Claude Code wakes the idle session and shows Claude one line
               → Claude answers "ok" → one cache read of the whole context → TTL reset
```

- **The timer restarts on every request.** A prompt you type, a background agent reporting back, a scheduled task firing: each one supersedes the sleeping waker, and the next turn end starts a new one. A session in use is never pinged, and nothing fires mid-turn.
- **Nothing is shared between sessions.** Each session has its own waker and resolves its own settings. A Desktop session can't change how a CLI session behaves, and neither can switch an engine for everyone. There is no engine to switch.
- **No scheduled tasks, no monitor process.** It's an ordinary hook, so it runs identically wherever Claude Code runs hooks.

Every ping is checked: once Claude's `ok` reaches the transcript, the next waker looks at that turn's usage. A cache read is a hit. If two pings in a row had to re-write the context instead (a miss), warming is suspended for that session until someone is active again, so a broken setup can't keep paying for rewrites.

It refuses to ping when:

- nothing is pending in the background (default `warmWhen: background-work`: a running subagent, background shell, workflow or scheduled task),
- the cache has already expired (laptop slept: a ping would *be* the expensive rewrite),
- nobody has typed and no real work has happened for `maxIdleMinutes`,
- it has already pinged `ceil(maxIdleMinutes / interval) + 1` times since the last activity (hard cap 24),
- the context is below `minContextTokens`,
- warming is off for that session's scope,
- the session is headless (`claude -p`, Agent SDK): those are never registered.

Keep-alive turns, scheduled-task prompts and background-task reports don't count as you being active, so the idle cap really means "nobody has been here".

## Settings and scopes

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `enabled` | `true` | On/off |
| `warmWhen` | `background-work` | `background-work`: only while something is pending in the background. `always`: any idle session |
| `intervalMinutes` | `auto` | From the last request. `auto` = 50 on a 1h cache, 4 on a 5m cache. Must be shorter than the TTL |
| `maxIdleMinutes` | `180` | Stop after this long with no activity. 0 = never |
| `minContextTokens` | `20000` | Small contexts are cheap to rebuild; skip them |
| `dashboardPort` | `4777` | Global only |
| `statusline` | `auto` | Global only. `auto`: keep the segment on your status line, creating one if you have none. `wrap-only`: only on existing ones. `off`: restore the originals |

Each session resolves every setting from the most specific scope that sets it:

```
session  >  project folder  >  surface (cli | desktop | ide)  >  global  >  plugin tab  >  defaults
```

```sh
ccw interval 30 --global              # every session (the default only from a plain terminal)
ccw when always --desktop             # every Desktop-app session
ccw off --cli                         # every CLI session
ccw interval 20 --project             # this folder and everything below it
ccw set maxIdleMinutes 600 --session  # just this session
ccw config --session                  # effective values, and which scope each comes from
ccw reset --desktop                   # that scope inherits everything again
```

**CLI and Desktop never overlap by accident.** Run inside a Claude Code session (or by Claude, or via `/cache-warm:on|off`), an unscoped `ccw` change applies only to that session's surface: `ccw off` in the Desktop app turns off Desktop sessions, not your CLI ones. Changing every surface at once needs `--global`. From a plain terminal, unscoped means global. The dashboard says on each tab which sessions it reaches.

The plugin tab (`/plugin` → cache-warm → configure) sets the global layer plus a "Desktop app sessions" override. A value you change there applies right away (Claude Code's `ConfigChange` hook; running timers pick it up within a minute) and wins over the older override it would otherwise sit behind; values you didn't change never undo edits made with `ccw` or the dashboard.

## Commands

| In Claude Code | Shell (`bin/ccw` is on the Bash tool's PATH) | |
| :--- | :--- | :--- |
| `/cache-warm:on [scope]` | `ccw on [scope]` | Switch on |
| `/cache-warm:off [scope]` | `ccw off [scope]` | Switch off |
| `/cache-warm:status` | `ccw status` | Sessions, what each waits on, next-ping countdown |
| `/cache-warm:config ...` | `ccw config`, `ccw scopes` | Effective settings / every scope that has settings |
| `/cache-warm:dashboard` | `ccw dashboard` | Web dashboard |
| `/cache-warm:statusline` | `ccw statusline install` | Status line segment (`uninstall` restores the previous one) |
| `/cache-warm:test` | `ccw test` | Self-test: one ping a minute after this turn, verified, settings restored |
| | `ccw doctor`, `ccw events 30` | Health checks (incl. verified pings per surface), recent log |

Scope words for the slash commands: `session`, `project`, `desktop`, `cli`, `ide`.

## Status line

On by default (`statusline: auto`). At every session start the plugin makes sure the segment sits on the status line that session will show, and nothing else:

- It wraps your status line in `~/.claude/settings.json`, or creates one there if you have none (`wrap-only` skips that).
- A project's personal `.claude/settings.local.json` status line is wrapped the same way.
- A status line defined in a project's shared `.claude/settings.json` is never edited. The segment goes into a personal `settings.local.json` overlay, and only when git ignores that file.
- If you change your own status line command later, the next session start wraps the new one.
- `ccw statusline off` (or the plugin tab, or the dashboard) restores every original exactly and keeps it that way.

```sh
ccw statusline auto | wrap-only | off
ccw statusline install             # one-off manual install into user settings
ccw statusline install --newline   # segment on its own row
ccw statusline install --file=<project>/.claude/settings.local.json   # also a folder with its own line
ccw statusline                     # what's installed, and what this folder actually uses
ccw statusline uninstall           # restore every wrapped status line exactly
```

```text
⬆ /gsd-update │ Opus 5.5 │ me │ ● warm on, ping in 31m 55s (1 bg job) · ctx 245.3k, cached 243.8k (99%) · 1h cache, 41m 55s left
```

It refreshes every 5 seconds (`--refresh=<s>` to change). Your own status line command runs first, concurrently, without an extra shell when it doesn't need one; its output is reused on timer-only refreshes so the 5-second tick stays cheap. If the plugin is ever removed, the launcher falls back to your original line.

## Dashboard

```sh
ccw dashboard
```

Binds to `127.0.0.1` only; write endpoints reject cross-origin requests. The Settings panel edits every scope (Global, CLI, Desktop app, IDE, project folders) with "Inherit" showing what each field would fall back to. Per-session settings live in the sessions table. Analytics are computed read-only from `~/.claude/projects/**/*.jsonl`.

## Tray app

```sh
cd desktop && npm install && npm run dev    # or: npm run build
```

`Ctrl+Alt+W` toggles global warming, `Ctrl+Alt+D` opens the dashboard. See [desktop/README.md](desktop/README.md).

## Costs and caveats

- A ping is a real model turn: one cache read of the full context plus a few output tokens. On a subscription it counts against your usage limits. `ccw status` shows the estimate per session.
- Each ping adds two short messages to the conversation: a "Stop hook feedback" note carrying the keep-alive line, and Claude's `ok`.
- A foreground subagent blocks the main conversation inside a tool call; nothing can refresh the main cache until it returns. Warming covers background work.
- Things that invalidate the cache anyway (model switch, `/compact`, MCP tools changing, upgrading Claude Code) are outside this plugin's reach. See [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching).

## Upgrading from 0.2

0.2 used a plugin monitor (CLI only) with a scheduled-task fallback for everything else, and one global `engine` switch. A Desktop session would flip that switch to `cron` for every session, and cron-fired prompts reset the idle clock, so CLI sessions got fixed 25-30 minute pings all night. 0.3 replaces both engines with the per-session Stop-hook waker described above.

On the first hook run after updating, the state directory is migrated automatically:

- `config.json` moves to the scoped layout (backup: `config.v1.backup.json`); values that only mirrored the plugin tab go back to the plugin tab.
- `engine` and `fallbackCron` are gone. The file keeps a top-level `enabled: false` that only switches off monitors and scheduled tasks still running from 0.2 in sessions you haven't restarted.
- Per-session switches become session overrides; ping history is kept.
- Junk registrations (headless helper runs, sessions silent for days) are pruned.
- A 0.2 keep-alive scheduled task that fires again is told to delete itself instead of running.

## Development

```sh
npm test                    # spawns the real hook, waker and CLI against fake transcripts
claude plugin validate .
```

Layout: `.claude-plugin/` manifest + marketplace, `hooks/`, `skills/`, `scripts/` (`lib.mjs` core, `hook.mjs`, `waker.mjs`, `ccw.mjs`, status line), `dashboard/`, `desktop/`, `docs/` (tutorial, state contract).

## License

MIT
