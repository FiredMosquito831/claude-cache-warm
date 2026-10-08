---
description: Configure prompt-cache warming (keep-alive pings for idle Claude Code sessions) per scope - global, CLI, desktop app, project folder or single session - interval, idle cap, when to warm, dashboard. Use when the user asks to change how often the cache is warmed, to stop or start cache warming somewhere, or to open the cache-warm dashboard.
argument-hint: "interval <min|auto> | idle <min> | when <background-work|always> | show | dashboard | doctor  [session|project|desktop|cli]"
allowed-tools: Bash(node:*)
---

Control the cache-warm plugin through its CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" <command> [scope flag]`.

| User wants | Command |
| :--- | :--- |
| See effective settings and where each comes from | `config` |
| Change ping interval | `interval <minutes>` or `interval auto` |
| Stop pinging after N idle minutes | `set maxIdleMinutes <N>` (0 = never) |
| Warm only while background work is pending (default), or any idle session | `when background-work` / `when always` |
| Skip small sessions | `set minContextTokens <N>` |
| On / off | `on` / `off` |
| Go back to inheriting one setting / everything at a scope | `unset <key>` / `reset` |
| List every scope that has settings | `scopes` |
| Open the dashboard | `dashboard` |
| Something seems broken | `doctor`, then `events 30` |

Scope flags (default: global): `--session` (this session), `--project` (the current folder and its subfolders; `--project=<folder>` for another), `--cli`, `--desktop`, `--ide`. Most specific wins: session > project > surface > global > plugin tab > defaults. Change only the scope the user asked for; never change global settings to fix one session.

Changes apply live; never tell the user to restart. Never create scheduled tasks (CronCreate) for cache warming: the plugin's Stop hook times the pings and resets the timer on every request.

## Rules of thumb to share when asked

- The interval must be shorter than the cache TTL (5 minutes by default on API keys, 1 hour on a Claude subscription or with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`). `auto` handles this: 50 minutes on a 1-hour cache.
- The timer counts from the conversation's last request, so a session in use is never pinged.
- A ping costs one cache read of the whole context; a cold return costs one cache write of it. `status` prints both.

Arguments: $ARGUMENTS
