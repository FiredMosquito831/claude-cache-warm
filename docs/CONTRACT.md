# Shared contract

Everything in this repo (plugin, dashboard, desktop app) talks through one state
directory and one local HTTP API. Nothing else is shared.

## State directory

`CCW_HOME` env var, else `~/.claude-cache-warm/`.

| Path | Writer | Content |
| :--- | :--- | :--- |
| `config.json` | CLI, dashboard, desktop | Global config (below). Re-read by every monitor on each tick, so edits apply live. |
| `sessions/<sessionId>.json` | hooks, CLI, dashboard | Activity timestamps and the per-session toggle. |
| `sessions/<sessionId>.monitor.json` | monitor | Heartbeat and ping history. Separate file so the two writers never collide. |
| `sessions/<sessionId>.agents/<id>.json` | hooks | One marker per running subagent or background shell command: `{ kind: "agent" \| "shell", agentId, type, startedAt }`. Removed on SubagentStop; shell markers age out. |
| `statusline.json`, `statusline-launcher.mjs` | `ccw statusline` | Wrapped status line command, placement, current plugin root. |
| `desktop.json` | user | Tray app hotkeys: `{ toggleHotkey, dashboardHotkey }`. |
| `analytics-cache.json` | dashboard | Incremental transcript parse cache. Safe to delete. |
| `events.jsonl` | monitor, hooks | Append-only log: one JSON object per line. |

All JSON writes are atomic: write `<file>.<pid>.tmp`, then rename over the target.

### config.json

```json
{
  "enabled": true,
  "intervalMinutes": "auto",
  "maxIdleMinutes": 180,
  "minContextTokens": 20000,
  "warmWhen": "background-work",
  "engine": "monitor",
  "dashboardPort": 4777
}
```

- `enabled` — master switch.
- `intervalMinutes` — number, or `"auto"` (50 when the session writes a 1h cache, 4 when 5m).
- `maxIdleMinutes` — stop pinging a session once the human has been away this long. `0` = never stop.
- `warmWhen` — `"background-work"` (default: ping only while a subagent or background task is running in the session) or `"always"` (any idle session).
- `minContextTokens` — don't bother warming sessions whose context is smaller than this.
- `engine` — `"monitor"` (plugin monitor process) or `"cron"` (in-session CronCreate fallback).

### sessions/<sessionId>.json

```json
{
  "sessionId": "uuid",
  "cwd": "C:/path",
  "transcriptPath": "C:/Users/me/.claude/projects/slug/uuid.jsonl",
  "claudePid": 1234,
  "startedAt": 0,
  "lastUserActivityAt": 0,
  "lastStopAt": 0,
  "lastWorkStopAt": 0,
  "enabled": null,
  "overrides": { "intervalMinutes": 20, "maxIdleMinutes": 600, "warmWhen": "always" },
  "endedAt": 0
}
```

Timestamps are epoch milliseconds. `lastWorkStopAt` ignores Stops that merely close a keep-alive turn, so pings never reset the idle clock. `enabled: null` means "follow global"; `true`/`false` override it for this session. `overrides` holds per-session values for `intervalMinutes`, `maxIdleMinutes` and `warmWhen`; an absent key follows the global config.

### sessions/<sessionId>.monitor.json

```json
{ "monitorPid": 0, "heartbeatAt": 0, "pingTimes": [0], "pingsTotal": 0 }
```

### events.jsonl

`{"t": <ms>, "type": "ping" | "skip" | "session_start" | "session_end" | "config", "sessionId": "...", ...}`

## HTTP API (dashboard server, `127.0.0.1:<dashboardPort>`)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/health` | `{ "ok": true, "version": "..." }` |
| GET | `/api/state` | `{ config, sessions: [...], now }` — sessions enriched with `status`, `nextPingAt`, `ttl`, `contextTokens`, `model`, `estPingCostUsd` |
| GET | `/api/analytics?days=7` | Aggregates parsed from transcripts + `events.jsonl` |
| POST | `/api/config` | Partial config patch, returns the new config |
| POST | `/api/sessions/<id>` | Any of `{ enabled, intervalMinutes, maxIdleMinutes, warmWhen }`; `null` clears that override |
| GET | `/` | Dashboard UI |

Start it with `node dashboard/server.mjs` (zero dependencies, Node 18+).
