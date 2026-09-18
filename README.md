# claude-cache-warm

Keeps the prompt cache of **idle Claude Code sessions** warm, so coming back from a break doesn't cost a full-price rewrite of your whole context.

- **Plugin** for Claude Code: on/off switch, configurable interval, idle cap, per-session overrides. By default it only warms sessions that are waiting on a subagent or background task.
- **Status line segment**: warming state, context tokens, cached tokens, time until the cache expires. Wraps your existing status line instead of replacing it.
- **Dashboard** (local web UI): live sessions with ping countdowns, per-session settings, and analytics mined from your own transcripts: hit ratio, cold rebuilds, what warming would have saved.
- **Tray app** (Tauri, optional): global hotkeys (`Ctrl+Alt+W` toggle, `Ctrl+Alt+D` dashboard), toggle and interval from the system tray.

**New here? Read the [usage tutorial](docs/TUTORIAL.md).**

Zero runtime dependencies. Node 18+.

## Why

Claude Code re-sends the whole conversation on every turn; the API's prompt cache makes that cheap (a cache read is 0.1x input price, 0.025x on Fable 5.1). But the cache expires after a period of silence: **5 minutes** on an API key, **1 hour** on a Claude subscription or with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. The first turn after expiry re-writes everything at 1.25x (5m) or 2x (1h) input price, and is slow.

Every cache hit resets the timer. So one tiny turn shortly before expiry keeps a big context alive for a fraction of the rebuild cost:

| 800K-token context on Opus 5, 1h cache | Cost |
| :--- | ---: |
| One keep-alive ping (cache read) | ~$0.40 |
| Cold return after 90 minutes (cache write) | ~$8.00 |

## Install

```text
/plugin marketplace add FiredMosquito831/claude-cache-warm
/plugin install cache-warm@claude-cache-warm
```

Start a new session. That's it: warming is on, with `auto` interval, for sessions that are waiting on background work.

Local development: `claude --plugin-dir "path/to/claude cache warm"`.

## Use

| In Claude Code | Shell (`bin/ccw` is on the Bash tool's PATH) | |
| :--- | :--- | :--- |
| `/cache-warm:on` | `ccw on` | Master switch on |
| `/cache-warm:off` | `ccw off` | Master switch off |
| `/cache-warm:off session` | `ccw off --session` | Pause only this session (`ccw follow` to undo) |
| `/cache-warm:status` | `ccw status` | Sessions, next-ping countdown, cost per ping |
| | `ccw when always` | Warm any idle session, not only ones with background work (`background-work` is the default) |
| `/cache-warm:config interval 30` | `ccw interval 30` | Ping interval in minutes, or `auto` |
| `/cache-warm:config idle 240` | `ccw set maxIdleMinutes 240` | Stop pinging after this long away (0 = never) |
| `/cache-warm:dashboard` | `ccw dashboard` | Open `http://127.0.0.1:4777/` (live sessions, per-session settings, analytics) |
| `/cache-warm:statusline` | `ccw statusline install` | Add the status line segment (`uninstall` restores the previous one) |
| | `ccw interval 20 --session` | Any of `on`, `off`, `when`, `interval`, `set maxIdleMinutes` for one session only; `ccw follow` clears |
| | `ccw doctor` | Check that hooks and the monitor are alive |

Every change applies to running sessions within 5 seconds. Nothing needs a restart.

### Settings

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `enabled` | `true` | Master switch |
| `warmWhen` | `background-work` | `background-work`: only while a subagent or background shell command is running in the session. `always`: any idle session |
| `intervalMinutes` | `auto` | `auto` = 50 on a 1h cache, 4 on a 5m cache (detected from the transcript). Must be shorter than the TTL. |
| `maxIdleMinutes` | `180` | Stop pinging once you've been away this long |
| `minContextTokens` | `20000` | Small contexts are cheap to rebuild; skip them |
| `fallbackCron` | `true` | When a session has no monitor process, ask Claude once (via a Stop hook) to schedule an in-session keep-alive task instead |
| `engine` | `monitor` | `monitor` or `cron` (see below) |
| `dashboardPort` | `4777` | |

Stored in `~/.claude-cache-warm/config.json` (override the directory with `CCW_HOME`). The same settings are exposed in the plugin's options (`/plugin` → cache-warm → configure); a value changed there is applied at the next session start without overwriting edits made elsewhere.

## How it works

```
hooks (SessionStart / UserPromptSubmit / Stop / SubagentStart / SubagentStop / PostToolUse / SessionEnd)
   └─ write activity + background-work markers ─┐
                                         ▼
                          ~/.claude-cache-warm/   ◄── ccw CLI, dashboard, tray app edit config.json
                                         ▲
plugin monitor (one process per session) ┘
   every 5s: silent for >= interval?  ──► prints one line to stdout
                                            └─ Claude Code delivers it to the idle session as a
                                               notification → a one-word turn → cache read → TTL reset
```

The ping goes **through the live session itself**, so it hits exactly the same cache prefix (same system prompt, tools, history). An external `claude -p --resume` or a raw API call can't guarantee that.

It is **activity-aware**. The timer counts from the last request of the main conversation, so a session you are actively using is never pinged. It also refuses to ping when:

- nothing is running in the background (default `warmWhen: background-work`; subagents are tracked through `SubagentStart`/`SubagentStop`, background shell commands through `PostToolUse`),
- the cache has already expired (laptop slept: a ping would *be* the expensive rewrite),
- you've been away longer than `maxIdleMinutes`,
- the context is below `minContextTokens`,
- warming is off globally or for that session.

Keep-alive turns don't reset the idle clock, so pings can't keep their own session "active" forever.

### Engines

| | `monitor` (default) | `cron` (fallback) |
| :--- | :--- | :--- |
| Mechanism | Plugin [monitor](https://code.claude.com/docs/en/plugins-reference#monitors) process | In-session `CronCreate` task |
| Timing | Exact, from last activity | Fixed schedule with jitter; fires even while you're active |
| Live config | Yes | Interval fixed at creation |
| Lifetime | Whole session | Expires after 7 days |
| Works in | Interactive CLI sessions | Anywhere scheduled tasks work, including the desktop app |

Plugin monitors are an experimental Claude Code feature and only run in interactive CLI sessions. In practice they did not start for a `claude --resume` session either. That is why the fallback exists: when a session has no monitor heartbeat and something needs warming, the Stop hook asks Claude once to `CronCreate` a keep-alive task (one tool call). That task runs `ccw cron-tick`, which reports STOP once there is nothing left to warm, and Claude deletes it. After your first real idle period, `ccw doctor` and the dashboard's "Pings sent" tile (n/m verified as cache hits) confirm that pings are landing on a warm cache. If `ccw status` shows `[no monitor]`, run `/cache-warm:config engine cron`.

## Picking an interval

1. **Get the 1-hour TTL first.** It turns 15 pings an hour into 1. Subscriptions get it automatically; with an API key set `"promptCacheTtl": "1h"` in settings or `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. If you go over plan limits into usage credits, Claude Code falls back to 5m unless you set it explicitly.
2. **Leave the interval on `auto`.** Shorter than needed just wastes reads; longer than the TTL does nothing.
3. **Decide who gets warmed.** The default only covers sessions waiting on background work, where you are certain to come back. `ccw when always` extends it to every idle session; check the dashboard's cold-rebuild table first to see whether your pauses justify it.
4. **Set the idle cap from break-even.** Pings stop paying off once you've spent more on them than the rebuild would cost: about 19 pings (~16 h) on a 1h cache, about 11 pings (~45 min) on a 5m cache. On Fable 5.1 reads are 4x cheaper, so break-even is ~4x later. The default of 3 h is conservative; the dashboard's "Recent cold rebuilds" table shows what your real pauses look like.

## Costs and caveats

- A ping is a real model turn: one cache read of the full context plus a few output tokens. On a subscription it counts against your usage limits. `ccw status` shows the estimate per session.
- Each ping adds two short messages to the transcript (the notification and "ok").
- Dollar figures use API list prices (see `scripts/lib.mjs`), and are estimates.
- Things that invalidate the cache anyway (model switch, `/compact`, MCP tools changing, upgrading Claude Code) are outside this plugin's reach. See [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching).

## Dashboard

```sh
ccw dashboard            # or: node dashboard/server.mjs
```

Binds to `127.0.0.1` only. Write endpoints reject cross-origin requests. Analytics are computed from `~/.claude/projects/**/*.jsonl` (read-only) and cached incrementally in `~/.claude-cache-warm/analytics-cache.json`; the first scan of a busy week can take half a minute.

## Tray app

```sh
cd desktop
npm install
npm run dev              # or: npm run build
```

See [desktop/README.md](desktop/README.md). It is a thin shell: global hotkeys (Claude Code's own keybindings cannot run plugin commands, so these are OS-level), tray toggle + interval menu, starts the dashboard server if it isn't running, and shows the dashboard in a window.

## Development

```sh
npm test                 # spawns real hook + monitor processes against a fake transcript
claude plugin validate .
```

Layout: `.claude-plugin/` manifest + marketplace, `hooks/`, `monitors/`, `skills/`, `scripts/` (core, hook, monitor, CLI), `dashboard/`, `desktop/`, `docs/CONTRACT.md` (state files + HTTP API shared by all three parts).

## License

MIT
