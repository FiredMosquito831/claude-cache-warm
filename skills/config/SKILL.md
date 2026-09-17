---
description: Configure prompt-cache warming (keep-alive pings for idle Claude Code sessions) - interval, idle cap, engine, dashboard. Use when the user asks to change how often the cache is warmed, to stop or start cache warming, or to open the cache-warm dashboard.
argument-hint: "interval <min|auto> | idle <min> | engine <monitor|cron> | dashboard | doctor"
allowed-tools: Bash(node:*)
---

Control the cache-warm plugin through its CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" <command>`.

| User wants | Command |
| :--- | :--- |
| Change ping interval | `interval <minutes>` or `interval auto` |
| Stop pinging after N idle minutes | `set maxIdleMinutes <N>` (0 = never) |
| Skip small sessions | `set minContextTokens <N>` |
| On / off | `on`, `off` (add `--session` for this session only) |
| Open the dashboard | `dashboard` |
| Something seems broken | `doctor`, then `events 30` |

Config changes apply live within 5 seconds; never tell the user to restart.

## Cron engine (fallback)

The default engine is a plugin monitor process, which only exists in interactive CLI sessions. If `status` shows `[no monitor]` for this session (desktop app, or monitors unavailable), or the user asks for `engine cron`:

1. Run `set engine cron`.
2. Run `cron` — it prints `{ cron, recurring, prompt }`.
3. Call CronList; if no task with that prompt exists, call CronCreate with exactly that cron expression and prompt, recurring.
4. Tell the user: cron tasks expire after 7 days and ping on a fixed schedule even while they are active, so the monitor engine is cheaper where it works.

Switching back to `engine monitor`: delete that cron task with CronDelete.

## Rules of thumb to share when asked

- The interval must be shorter than the cache TTL (5 minutes by default on API keys, 1 hour on a Claude subscription or with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`). `auto` handles this.
- The cheapest big win is the 1-hour TTL itself: 1 ping per 50 minutes instead of 1 per 4.
- A ping costs one cache read of the whole context; a cold return costs one cache write of it. `status` prints both so the user can judge the idle cap.

Arguments: $ARGUMENTS
