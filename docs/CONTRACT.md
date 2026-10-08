# Shared contract (schema 2, cache-warm 0.3)

The plugin hooks, the CLI, the status line, the dashboard and the tray app talk
through one state directory and one local HTTP API. Nothing else is shared.

## State directory

`CCW_HOME` env var, else `~/.claude-cache-warm/`.

| Path | Writers | Content |
| :--- | :--- | :--- |
| `config.json` | CLI, dashboard, tray, SessionStart hook | Settings per scope (below). |
| `plugin-options.json` | SessionStart hook | Snapshot of the plugin-tab options: `{ raw: { key: "string" }, seenAt }`. |
| `sessions/<id>.json` | hooks, waker, CLI, dashboard | One session: identity, activity clocks, background-work snapshot, overrides. |
| `sessions/<id>.state.json` | waker, hooks | Ping history and the session's current waker. |
| `sessions/<id>.monitor.json` | cache-warm 0.2 only | Left alone so 0.2 monitors in unrestarted sessions don't crash. |
| `statusline.json`, `statusline-launcher.mjs` | `ccw statusline` | Status line installs and the launcher they point at. |
| `statusline-cache/` | status line | Last output of each wrapped status line command. Safe to delete. |
| `desktop.json` | user | Tray app hotkeys: `{ toggleHotkey, dashboardHotkey }`. |
| `analytics-cache.json` | dashboard | Incremental transcript parse cache. Safe to delete. |
| `events.jsonl` (+ `events.1.jsonl`) | everyone | Append-only log, rotated at 4 MB. |
| `config.v1.backup.json` | migration | The 0.2 config, as it was. |

Every JSON write is atomic (`<file>.<pid>.tmp`, then rename). Every
read-modify-write of `config.json`, a session file or a state file holds
`<file>.lock` (a directory; stale after 5 s; writers give up waiting after 2 s
rather than stall a hook). The tray app takes the same lock.

### config.json

```json
{
  "schema": 2,
  "global": { "intervalMinutes": 40 },
  "surfaces": { "desktop": { "warmWhen": "always" }, "cli": {} },
  "projects": { "C:/Users/me/work/api": { "intervalMinutes": 20 } },
  "enabled": false,
  "fallbackCron": false,
  "_note": "..."
}
```

- Only explicitly set values are stored. A missing key inherits.
- `projects` keys are absolute folders with forward slashes. A project covers the folder and every folder below it; the deepest match wins. Matching is case-insensitive on Windows.
- Top-level `enabled: false` / `fallbackCron: false` are **not settings**. They switch off monitors and cron fallbacks from cache-warm 0.2 that may still run in sessions started before the update. Always written as-is.

### Settings and resolution

| Key | Values | Scopes |
| :--- | :--- | :--- |
| `enabled` | boolean | all |
| `warmWhen` | `background-work` \| `always` | all |
| `intervalMinutes` | `auto` \| 1-59 | all |
| `maxIdleMinutes` | number >= 0 (0 = never) | all |
| `minContextTokens` | number >= 0 | all |
| `dashboardPort` | 1024-65535 | global only |
| `statusline` | `auto` \| `wrap-only` \| `off` | global only |

Effective value: the first defined in
`session.overrides` > `projects[<deepest folder containing cwd>]` > `surfaces[<surface>]` > `global` > plugin tab (desktop part only for desktop sessions, then the global part) > built-in defaults.

Surface comes from `CLAUDE_CODE_ENTRYPOINT`: `cli`; anything containing `desktop` → `desktop`; IDE entrypoints → `ide`; `sdk-*` (`claude -p`, Agent SDK) → `headless`, which is never registered or warmed.

### sessions/<id>.json

```json
{
  "schema": 2,
  "sessionId": "uuid",
  "surface": "cli",
  "entrypoint": "cli",
  "cwd": "C:\\path",
  "transcriptPath": "C:\\Users\\me\\.claude\\projects\\slug\\uuid.jsonl",
  "claudePid": 1234,
  "startedAt": 0,
  "lastHumanAt": 0,
  "lastPromptAt": 0,
  "lastPromptKind": "human",
  "turnStartedAt": 0,
  "lastStopAt": 0,
  "lastWorkStopAt": 0,
  "background": { "at": 0, "tasks": [{ "id": "", "type": "subagent", "status": "running", "description": "" }], "crons": [{ "id": "", "schedule": "*/10 * * * *", "recurring": true, "prompt": "" }] },
  "overrides": { "intervalMinutes": 20 },
  "endedAt": 0,
  "enabled": false
}
```

Timestamps are epoch ms.

- `lastHumanAt`: a prompt classified as typed by a person. Scheduled-task prompts, `<task-notification>` reports, keep-alive pings and other machine prompts update `lastPromptAt` only.
- `lastWorkStopAt`: a turn end that wasn't just answering a ping. Activity for the idle clock = max(`lastHumanAt`, `lastWorkStopAt`, `startedAt`).
- `background`: Claude Code's `background_tasks` / `session_crons` from the last Stop. Pending work = tasks not finished and not `monitor`, plus crons whose prompt doesn't start with `[cache-warm]`. `null` after a fresh start/resume.
- `enabled: false` at top level is the 0.2 kill switch, like in `config.json`. 0.3 reads `overrides.enabled`.

### sessions/<id>.state.json

```json
{ "pingTimes": [0], "pingsTotal": 0, "lastPing": { "at": 0, "result": "hit", "read": 0, "write": 0 }, "consecutiveMisses": 0, "suspended": null, "waker": { "gen": "pid.startedAt", "pid": 0, "startedAt": 0, "heartbeatAt": 0, "status": "sleeping", "lastStatus": "warming", "nextPingAt": 0, "exitReason": null } }
```

Exactly one waker owns a session at a time: the one whose `gen` is stored. A
prompt, a session start or end overwrites `gen`, and the sleeping waker exits
at its next check. `status`: `sleeping` → `pinged` (exited 2) or `done`
(`exitReason`: `expired`, `idle-cap`, `ping-cap`, `session ended`,
`claude exited`, `lifetime`) or `superseded`.

### events.jsonl

`{"t": <ms>, "type": "ping" | "session_start" | "session_end" | "config" | "plugin_options" | "migrated" | "legacy_cron_cleanup" | "waker_error" | "hook_error", ...}`

`ping_result` events carry `result` (`hit` / `miss` / `unknown`), `read`, `write`, `surface`; `self_test_start` / `self_test_end` bracket a `ccw test`; `statusline` events record automatic wraps, overlays and removals.

`ping` events carry `engine: "rewake"` (0.2 wrote `monitor` or `cron`), `surface`, `ttl`, `intervalMinutes`, `idleMs`, `sinceRequestMs`, `work`, `contextTokens`, `model`, `estCostUsd`.

## HTTP API (dashboard server, `127.0.0.1:<dashboardPort>`)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/health` | `{ "ok": true, "version": "..." }` |
| GET | `/api/state` | `{ scopes: [{ scope, label, own, values, sources }], sessions, folders, pluginTab, defaults, now }` |
| GET | `/api/analytics?days=7` | Aggregates parsed from transcripts + `events.jsonl` |
| POST | `/api/scope` | `{ scope, patch }` sets settings at a scope (null clears a key); `{ scope, reset: true }` clears the scope. `scope`: `global`, `cli`, `desktop`, `ide`, `project:<folder>`, `session:<id>` |
| POST | `/api/config` | 0.2 compatibility: patch the global scope |
| POST | `/api/sessions/<id>` | 0.2 compatibility: patch one session's overrides |
| GET | `/` | Dashboard UI |

Writes require a loopback `Host`, a same-origin (or absent) `Origin` and a JSON body.
