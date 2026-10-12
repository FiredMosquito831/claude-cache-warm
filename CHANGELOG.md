# Changelog

Newest first. Each entry: what changed for you, why, and what you need to do.

## 0.4.0 (2026-10-08)

- **Self-test**: `/cache-warm:test` (or `ccw test`) pings the current session once, a minute after the turn ends, verifies the ping against the transcript and restores the session's settings. It works the same in the CLI and the Desktop app. If no ping arrives, the settings undo themselves after 15 minutes.
- **Every ping is verified**: once a ping's turn reaches the transcript it is judged a hit (cache read) or a miss (rewrite). Two misses in a row suspend warming for that session until you're active in it again. `ccw doctor` shows verified pings per surface.
- **Automatic status line** (`statusline`: `auto` | `wrap-only` | `off`; plugin tab, dashboard, `ccw statusline <mode>`):
  - At every session start the segment is kept on the status line that session will show.
  - A status line command you change later is wrapped again.
  - Only personal files are edited. A shared project status line gets a git-ignored `settings.local.json` overlay instead.
  - `off` restores every original exactly.
- **Plugin-tab edits apply immediately** through the `ConfigChange` hook; sleeping timers pick them up within a minute.
- **CLI and Desktop can't change each other by accident**: inside a session, an unscoped `ccw` change (and `/cache-warm:on|off`) applies to that session's surface only. Use `--global` for both.
- The waker never sleeps when the Stop input lacks `background_tasks`: a Claude Code that old could run it as a blocking hook.
- To do: update the plugin and `/reload-plugins`. Run `/cache-warm:test` once in the CLI and once in the Desktop app.

## 0.3.0 (2026-10-08)

- **New engine: one waker per session.** It is a Stop hook with `asyncRewake`: it sleeps until one interval after the conversation's last request, then wakes the idle session. It replaces 0.2's plugin monitor and its scheduled-task (cron) fallback. Root causes it fixes:
  - One global `engine` switch was shared by every session. A Desktop session set it to `cron`, and every CLI session switched to wall-clock pings that fired even while you worked.
  - Scheduled-task prompts and background-agent reports were counted as you typing, so the idle cap never triggered. One session was pinged all night.
  - The fallback relied on Claude running `node` in Bash. It failed with a broken PATH, and it re-armed itself after you deleted it.
- **Scoped settings**: session > project folder > surface (CLI / Desktop / IDE) > global > plugin tab > defaults, with locked writes so concurrent sessions can't drop each other's changes.
- Background work now comes from Claude Code's own `background_tasks` / `session_crons`, not marker files that went stale.
- Headless runs (`claude -p`, Agent SDK) are never registered. Junk and stale registrations are pruned, even when Windows reuses their PID.
- **Status line**:
  - It installs into user settings, so every folder gets it, and several installs are supported.
  - It refreshes every 5 s.
  - It runs your command concurrently and caches its output, so Claude Code stops cancelling it.
  - It resolves the installed plugin copy instead of a stored path.
- **Automatic migration** from 0.2 (backup in `config.v1.backup.json`):
  - Monitors and crons still running from 0.2 are switched off.
  - A leftover 0.2 keep-alive task deletes itself the next time it fires.
- To do: update and `/reload-plugins`. Settings you changed are kept, including "off".

## 0.2.0 (2026-09-18)

- Warm only while background work runs (default), with per-session settings, a status line segment that wraps your existing one, global hotkeys in the tray app, and a usage tutorial.
- A scheduled-task fallback for sessions without a monitor. It was removed in 0.3; see above for why.
- Plugin-tab options synced into `config.json`.

## 0.1.0 (2026-09-17)

- First release: plugin-monitor keep-alive pings for idle sessions, the `ccw` CLI, the local dashboard with transcript analytics, and the Tauri tray app.
