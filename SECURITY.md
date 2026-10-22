# Security policy

## Supported versions

| Version | Supported |
| :--- | :--- |
| 0.5.x | Yes |
| 0.4.x and older | No — upgrade first |

The plugin updates through Claude Code's plugin system. Use `/plugin` → update, then `/reload-plugins` in every open session.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on the repository's **Security** tab:

<https://github.com/FiredMosquito831/claude-cache-warm/security/advisories/new>

Include what you can: affected version, platform, the state files or settings involved, and a minimal reproduction. You can expect an acknowledgement, a severity assessment, and a coordinated fix. Only versions of Claude Code, Node.js and the operating system matter; no account or credential is needed to use the plugin.

Ordinary bugs and feature requests belong in the public [issue tracker](https://github.com/FiredMosquito831/claude-cache-warm/issues).

## What the plugin touches

Cache Warm is a local Claude Code plugin. It has no runtime dependencies, no telemetry and no network client.

- **Hooks.** Five Claude Code hook events: `SessionStart`, `UserPromptSubmit`, `Stop` (with `asyncRewake`), `SessionEnd`, and `ConfigChange` for user settings.
- **State.** `~/.claude-cache-warm/` (override with `CCW_HOME`): settings, per-session state, an append-only event log and an analytics parse cache. Every JSON write is atomic; every read-modify-write holds a lock directory.
- **Transcripts.** Read-only. The waker reads the tail of the current session transcript to obtain context size, model and cache TTL, and to verify a ping. Dashboard analytics parse `~/.claude/projects/**/*.jsonl` read-only and keep an incremental offset cache.
- **Settings files.** The status line installer edits personal settings files (`~/.claude/settings.json`, a project's `.claude/settings.local.json`), backs them up as `*.ccw-backup` before the first change, never edits a shared project `settings.json`, and restores originals exactly on `off`/uninstall.
- **Dashboard.** Binds to `127.0.0.1` only. Reads are unauthenticated loopback reads; writes require a loopback `Host`, a same-origin (or absent) `Origin` and a JSON content type. Responses are `no-store` and `nosniff`.
- **No credentials.** The plugin never asks for, reads or stores an API key or token.

The ping itself is an ordinary Claude Code model turn. It goes wherever your Claude Code traffic already goes; the plugin does not proxy or intercept it.

## Design properties relevant to abuse

- Hooks fail closed: errors are logged locally and never block a prompt.
- An expired cache is never pinged.
- Two verified cache misses in a row suspend warming for that session until a human is active again.
- Headless runs (`claude -p`, Agent SDK) are never registered.
- A session's settings and timer cannot steer another session.
- The plugin contains no `eval` of user input, no shell interpolation of transcript or event data, and the dashboard renders untrusted values with `textContent`.

## Scope

Reports about Claude Code itself, Anthropic's API, Node.js or Tauri should go to their respective projects. Reports about how this plugin writes settings, parses state, or exposes the dashboard are in scope.
