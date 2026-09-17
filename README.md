# claude-cache-warm

Keeps the prompt cache of **idle Claude Code sessions** warm, so coming back from a break doesn't cost a full-price rewrite of your whole context.

- **Plugin** for Claude Code: on/off switch, configurable interval, idle cap, per-session pause.
- **Dashboard** (local web UI): live sessions with ping countdowns, settings, and analytics mined from your own transcripts: hit ratio, cold rebuilds, what warming would have saved.
- **Tray app** (Tauri, optional): toggle and interval from the system tray, opens the dashboard.

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

Start a new session. That's it: warming is on by default with `auto` interval.

Local development: `claude --plugin-dir "path/to/claude cache warm"`.

## Use

| In Claude Code | Shell (`bin/ccw` is on the Bash tool's PATH) | |
| :--- | :--- | :--- |
| `/cache-warm:on` | `ccw on` | Master switch on |
| `/cache-warm:off` | `ccw off` | Master switch off |
| `/cache-warm:off session` | `ccw off --session` | Pause only this session (`ccw follow` to undo) |
| `/cache-warm:status` | `ccw status` | Sessions, next-ping countdown, cost per ping |
| `/cache-warm:config interval 30` | `ccw interval 30` | Ping interval in minutes, or `auto` |
| `/cache-warm:config idle 240` | `ccw set maxIdleMinutes 240` | Stop pinging after this long away (0 = never) |
| `/cache-warm:config dashboard` | `ccw dashboard` | Open `http://127.0.0.1:4777/` |
| | `ccw doctor` | Check that hooks and the monitor are alive |

Every change applies to running sessions within 5 seconds. Nothing needs a restart.

### Settings

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `enabled` | `true` | Master switch |
| `intervalMinutes` | `auto` | `auto` = 50 on a 1h cache, 4 on a 5m cache (detected from the transcript). Must be shorter than the TTL. |
| `maxIdleMinutes` | `180` | Stop pinging once you've been away this long |
| `minContextTokens` | `20000` | Small contexts are cheap to rebuild; skip them |
| `engine` | `monitor` | `monitor` or `cron` (see below) |
| `dashboardPort` | `4777` | |

Stored in `~/.claude-cache-warm/config.json` (override the directory with `CCW_HOME`).

## How it works

```
hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd)
   └─ write activity timestamps ─────────┐
                                         ▼
                          ~/.claude-cache-warm/   ◄── ccw CLI, dashboard, tray app edit config.json
                                         ▲
plugin monitor (one process per session) ┘
   every 5s: silent for >= interval?  ──► prints one line to stdout
                                            └─ Claude Code delivers it to the idle session as a
                                               notification → a one-word turn → cache read → TTL reset
```

The ping goes **through the live session itself**, so it hits exactly the same cache prefix (same system prompt, tools, history). An external `claude -p --resume` or a raw API call can't guarantee that.

It is **activity-aware**. The timer counts from the last request of any kind, so a session you are actively using is never pinged. It also refuses to ping when:

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

Plugin monitors are an experimental Claude Code feature and only run in interactive CLI sessions. After your first real idle period, `ccw doctor` and the dashboard's "Pings sent" tile (n/m verified as cache hits) confirm that pings are landing on a warm cache. If `ccw status` shows `[no monitor]`, run `/cache-warm:config engine cron`.

## Picking an interval

1. **Get the 1-hour TTL first.** It turns 15 pings an hour into 1. Subscriptions get it automatically; with an API key set `"promptCacheTtl": "1h"` in settings or `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. If you go over plan limits into usage credits, Claude Code falls back to 5m unless you set it explicitly.
2. **Leave the interval on `auto`.** Shorter than needed just wastes reads; longer than the TTL does nothing.
3. **Set the idle cap from break-even.** Pings stop paying off once you've spent more on them than the rebuild would cost: about 19 pings (~16 h) on a 1h cache, about 11 pings (~45 min) on a 5m cache. On Fable 5.1 reads are 4x cheaper, so break-even is ~4x later. The default of 3 h is conservative; the dashboard's "Recent cold rebuilds" table shows what your real pauses look like.

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

See [desktop/README.md](desktop/README.md). It is a thin shell: tray toggle + interval menu, starts the dashboard server if it isn't running, and shows the dashboard in a window.

## Development

```sh
npm test                 # spawns real hook + monitor processes against a fake transcript
claude plugin validate .
```

Layout: `.claude-plugin/` manifest + marketplace, `hooks/`, `monitors/`, `skills/`, `scripts/` (core, hook, monitor, CLI), `dashboard/`, `desktop/`, `docs/CONTRACT.md` (state files + HTTP API shared by all three parts).

## License

MIT
