# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`claude-cache-warm` is a Claude Code plugin that keeps the prompt cache of **idle** sessions warm. A ping is sent only when a session has gone a full interval without any request, so coming back to it doesn't cost a full-price rewrite of its context. The repo root *is* the plugin (`cache-warm`) and its own marketplace (`.claude-plugin/marketplace.json`). Private GitHub repo: `FiredMosquito831/claude-cache-warm`. Users install with `/plugin marketplace add FiredMosquito831/claude-cache-warm`, and must run `/plugin` update plus `/reload-plugins` in each open session to pick up a new version.

Parts:
- **Plugin**: `hooks/`, `skills/`, `scripts/`.
- **`ccw` CLI**: `scripts/ccw.mjs`; `bin/ccw` puts it on the Bash tool's PATH.
- **Status line segment**: `scripts/statusline*.mjs`.
- **Local dashboard**: `dashboard/`.
- **Optional Tauri v2 tray app**: `desktop/`.

User-facing docs live in `README.md`, `docs/TUTORIAL.md`, `docs/CONTRACT.md` and `CHANGELOG.md`. CONTRACT documents every state file and the HTTP API; update it whenever their shape changes. The CHANGELOG records why each version changed what it did; read it before redesigning anything.

## Stack

- **Plugin, CLI, dashboard:** Node 18+, ES modules (`.mjs`), **zero runtime dependencies** on purpose. Hooks run on every prompt and must start fast (~150 ms). Don't add npm deps to the plugin.
- **Dashboard UI:** one static `dashboard/public/index.html` with inline JS/SVG charts, no framework. The server is `node:http`, loopback only.
- **Tray app:** Tauri v2 (Rust 1.93, `tauri`, `tauri-plugin-global-shortcut`, `tauri-plugin-notification`), built with **npm**.
- **Tests:** `node:test`, end-to-end, spawning the real hook, waker and CLI processes.

## Commands

```sh
npm test                                                     # all e2e tests (~15 s)
node --test --test-name-pattern="status line" test/e2e.test.mjs   # one test (or a regex)
claude plugin validate .                                     # marketplace manifest
claude plugin validate .claude-plugin/plugin.json            # plugin manifest
node --check scripts/<file>.mjs                              # quick syntax check
node scripts/ccw.mjs <command>                               # run the CLI from the repo
CCW_HOME=<tmp> CCW_PORT=4795 node dashboard/server.mjs       # dashboard against a scratch state dir
cd desktop/src-tauri && cargo check                          # tray app (no warnings expected)
cd desktop && npm run dev | npm run build                    # tray app run/bundle (never run so far)
```

To try the plugin locally without publishing: `claude --plugin-dir "C:/Users/fgghk/PycharmProjects/claude cache warm"`.

## Architecture (0.4)

**Engine: one waker per session, no shared engine.** `hooks/hooks.json` wires four hook events:
- **Stop → `scripts/waker.mjs`**, registered with `asyncRewake: true, timeout: 7200`. At every turn end it records the turn and Claude Code's own `background_tasks` / `session_crons` from the Stop input, then sleeps until *last request + interval*. If the session should still be warm it exits 2, which makes Claude Code wake the idle session with our stderr as a "Stop hook feedback" note. Claude answers `ok`, and that one turn reads the whole context from the cache. The waker exits 0 on a final status, after its lifetime (110 min), or when superseded.
- **SessionStart / UserPromptSubmit / SessionEnd / ConfigChange → `scripts/hook.mjs`.**
  - A new turn supersedes the sleeping waker by overwriting `waker.gen` in `<id>.state.json`.
  - It records activity clocks and classifies who sent each prompt.
  - It syncs plugin-tab options, keeps the status line wrapped, migrates old state, and prunes dead sessions.
- **Single source of truth:** `computeStatus()` in `scripts/lib.mjs` decides "ping now / when / why not". The waker acts on it; the CLI, status line and dashboard only display it. Statuses: `warming busy no-work off small-context idle-cap ping-cap suspended expired ended`.

**Settings are scoped** (`lib.resolveSettings`). The most specific scope wins: `session overrides > project folder (deepest prefix match) > surface (cli|desktop|ide) > global > plugin tab > DEFAULTS`.
- Storage: `config.json` `{schema: 2, global, surfaces, projects}`, session overrides in `sessions/<id>.json`, plugin-tab snapshot in `plugin-options.json`.
- `dashboardPort` and `statusline` are global-only keys.
- The surface comes from `CLAUDE_CODE_ENTRYPOINT`: `cli`; anything containing `desktop` → `desktop` (the Desktop app reports `claude-desktop-3p`); IDE entrypoints → `ide`; `sdk-*` → `headless`, which is never registered or warmed.

**State dir:** `~/.claude-cache-warm/`, overridable with `CCW_HOME`. Per session there are two files:
- `<id>.json`: identity, activity clocks, background snapshot, overrides.
- `<id>.state.json`: ping history, `lastPing` verdict, `suspended`, current `waker`.

Every read-modify-write goes through `lib.withLock(file)`, a `<file>.lock` directory: stale after 5 s, writers give up waiting after 2 s rather than stall a hook. The Rust tray uses the same lock. All writes are atomic (tmp + rename, retried on Windows `EPERM`/`EBUSY`).

**Ping verification:** `lib.verifyLastPing`, run on every waker pass, judges the ping's turn from the transcript usage: a cache read is a hit, a rewrite is a miss. Two misses in a row suspend the session until a human prompt. It also ends `ccw test` self-tests and restores the session's prior overrides.

**Status line:**
- `statusline-install.mjs` points settings at `~/.claude-cache-warm/statusline-launcher.mjs <key>`. The launcher resolves the *currently installed* plugin copy from `~/.claude/plugins/installed_plugins.json` (plugin dirs move on every update) and falls back to the user's own command.
- `statusline.mjs` runs the wrapped command concurrently, without a shell when the command line is simple, and reuses its output on timer-only refreshes. Speed matters because Claude Code cancels slow runs, which blanks the line.
- `ensureStatusline` (SessionStart, setting `statusline: auto|wrap-only|off`) only edits **personal** files: user `settings.json` and a project's `settings.local.json`. A shared project `settings.json` gets a git-ignored `settings.local.json` overlay instead.

**Dashboard:** `dashboard/server.mjs` serves `/api/state`, `/api/analytics` (transcript mining in `analytics.mjs`, incremental parse cache) and `/api/scope`. Writes require a loopback Host, a same-origin Origin and a JSON body.

## Rules and invariants (don't break these)

- **Hooks never fail or block a turn.** `hook.mjs` always exits 0. The waker exits 0 except for the deliberate exit 2. Every hook error goes to `events.jsonl`, never to stderr.
- **Never use scheduled tasks (CronCreate), plugin monitors, `decision: "block"` Stop hooks, or Claude tool calls to time pings.** 0.2 did, and it broke users' configs: a global `engine` switch let Desktop sessions force wall-clock cron pings on every CLI session, cron prompts reset the idle clock (one session was pinged all night), and the fallback needed `node` in Bash. Skills must never tell Claude to create cron jobs for warming.
- **Only a human prompt resets the idle clock.** `UserPromptSubmit` also fires for scheduled tasks, background-agent reports (`<task-notification…`) and asyncRewake wakes; `lib.classifyPrompt` filters them. A ping's own Stop (`closesPing`) must not count as work either.
- **Never ping an expired cache.** That ping would *be* the expensive rewrite.
- **Isolation:** one session's state or settings must never steer another. An unscoped `ccw` change run inside a session applies to that session's surface only; changing all surfaces needs `--global`. From a plain terminal, unscoped means global.
- **The waker never sleeps if the Stop input lacks `background_tasks`.** That signals a Claude Code old enough to run it as a blocking hook.
- **0.2 compatibility:** `config.json` and session files keep a top-level `enabled: false` (and `config.json` keeps `fallbackCron: false`). This is a kill switch for 0.2 monitors and crons still running in unrestarted sessions, not a setting; 0.3+ reads `global.enabled` / `overrides.enabled`. `statusline.json` mirrors a top-level `wrapped`/`placement` because 0.2's status line code reads them. `ensureMigrated()` upgrades v1 state and keeps `config.v1.backup.json`.
- **Plugin-tab sync must merge snapshots** (`{...prev, ...raw}`). Hook env (`CLAUDE_PLUGIN_OPTION_*`) and `settings.json` `pluginConfigs` may list different keys, and a key one source omits must not look like an edit.
- **Settings files are user property.** Back up (`.ccw-backup`) before the first change, never wrap our own launcher, restore originals exactly on `off`/uninstall, and never write a file that isn't valid JSON.

## Testing practices

- `test/e2e.test.mjs` runs everything in a temp dir, with **`CCW_HOME` and `CLAUDE_CONFIG_DIR` both pointed at temp folders**. SessionStart hooks edit status lines, so a test must never reach the real `~/.claude/settings.json`. Keep that isolation in any new test.
- The runner deletes `CLAUDE_CODE_ENTRYPOINT` from the env, because the tests usually run *inside* a Claude Code session and `ccw` scopes changes by entrypoint. Pass entrypoints explicitly when needed (`claude-desktop-3p`, `sdk-cli`).
- Time travel instead of waiting: `age(id, minutes)` rewrites the clocks and transcript under the same locks the hooks use. `runWaker(id, { whileSleeping })` mutates state once the waker has claimed its slot. Fast polling comes from `CCW_POLL_MS=100` and `CCW_WAKER_LIFETIME_MS`.
- The machine is often heavily loaded (several Claude sessions open). Avoid tight timeouts; the status line fallback timeout is 8 s for that reason.
- Before claiming done: `npm test`, both `claude plugin validate` commands, and `cargo check` if `desktop/` changed.

## Versioning and releases

**Version numbers.** One version for the plugin, in three places that must always match:
- `.claude-plugin/plugin.json` (`version`)
- `scripts/lib.mjs` (`VERSION`, shown by `ccw help` and `/api/health`)
- `package.json`

`desktop/` (tray app, `package.json` + `Cargo.toml`) is versioned separately and only bumps when it changes.

Pre-1.0 semver:
- **Minor (0.x.0):** anything user-visible, especially new behaviour, a new setting, or a state/schema change. Examples: 0.3 replaced the engine and config layout; 0.4 added the self-test, the automatic status line, and ping verification.
- **Patch (0.x.y):** fixes that change no setting, file shape, or default.

Every release gets a `CHANGELOG.md` entry (newest first). It says what changed for the user, why (root cause for fixes), and what they must do (migration, settings to check).

**Release checklist** (all of it, in order):
1. `npm test` green; both `claude plugin validate` commands pass; `cargo check` if `desktop/` changed.
2. Docs match the code: README, `docs/TUTORIAL.md`, and `docs/CONTRACT.md` for any state-file or API change. Skills (`skills/*/SKILL.md`) must not describe removed behaviour; a stale skill once told Claude to create cron jobs.
3. Bump the version in the three places, and add the CHANGELOG entry.
4. Commit: a subject line, then a body that explains root causes rather than just listing files, then a blank line and `by FiredMosquito831`. Use the git identity already configured; never pass `-c user.name/-c user.email` (that once had to be undone with `--amend --reset-author`).
5. Push to `origin/main` once the user wants it shipped. Then tell them: `/plugin` → update, then `/reload-plugins` in every open session, then `ccw doctor` and `/cache-warm:test` (in the CLI *and* the Desktop app).

**How updates reach users (learned the hard way):**
- Nothing changes until the user updates. Each running session keeps the hooks it loaded until `/reload-plugins` or a restart.
- Monitors started by an old version keep running until their session ends.
- Claude Code installs each version into a new directory under `~/.claude/plugins/cache/claude-cache-warm/cache-warm/` (named by version or commit sha). The old directory is marked `.orphaned_at` and deleted later. Never store a plugin path anywhere; resolve the current one from `installed_plugins.json`.
- So **every release has a mixed-version window**, often days long, with several versions reading and writing the same `~/.claude-cache-warm/`. Design for it:
  - New state must be harmless to old code: kill-switch fields, compatibility mirrors.
  - New code must read old state: `ensureMigrated()`, defensive field fallbacks.
  - Leftovers of old engines must retire themselves: legacy cron prompts are told to delete their task.

**State and schema changes:**
- Bump `config.json` `schema` and migrate in `lib.ensureMigrated()`. Migration is idempotent, runs under the config lock, and keeps a backup (`config.v1.backup.json`).
- Migration also moves per-session data forward (overrides, ping history) and prunes junk.
- Add a test that starts from an old-format fixture.
- Values that merely mirrored the plugin tab belong to the plugin tab, not to an override.

**Never touch the user's live state while developing:**
- Most `ccw` commands call `ensureMigrated()`. Running the repo's `ccw` against the real `~/.claude-cache-warm` would migrate it early, and the kill switch would stop warming in every unrestarted session.
- Exercise changes against a copy: `CCW_HOME=<scratch copy>`.
- Only `statusline`, `events` and `help` skip migration.
- Do changes to the user's own settings files only when they asked, and back them up first.

**Check features against the oldest surface.** The Desktop app bundles its own, older Claude Code (2.1.280 when the CLI was 2.1.294). Before relying on a hook field or flag, find when it shipped in Claude Code's changelog (`curl -sL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`), and degrade safely when it's missing (see the waker's `background_tasks` guard).

**Verify before documenting.** Claims about Claude Code behaviour go into docs only after a live check: a probe hook, a headless run, or the user's own transcripts and `events.jsonl`. Record what was verified, and on which version, under "Verified Claude Code behaviour" below.

## Environment quirks (Windows, this machine)

- In the Bash tool, start commands with `export PATH="/usr/bin:/mingw64/bin:/c/Program Files/nodejs:$PATH"`. `~/.claude/settings.json` `env.PATH` holds `;`-separated Windows paths that break Bash compound commands. Plugin hooks run under cmd.exe and are unaffected.
- Long inline `python - <<'EOF'` heredocs with mixed quotes and backticks sometimes fail in this Bash. Write patch scripts to the scratchpad and run them, or use the Edit/Write tools.
- Use **npm, never Bun**: Bun 1.3.14 corrupts installs on this machine.
- `.gitattributes` forces LF (`*.cmd` stays CRLF); write files with `\n`.
- Claude Code runs status line commands through Git Bash, so paths in a `command` need forward slashes.

## Verified Claude Code behaviour (2.1.280 Desktop / 2.1.294 CLI, Oct 2026)

- An `asyncRewake` hook's exit 2 reaches an interactive session as a system reminder ("Stop hook feedback") and triggers `UserPromptSubmit` with a `<task-notification>` prompt. `claude -p` tears down before a rewake can land, so test rewake interactively. A hidden `Start-Process claude` gets stuck before its first prompt and is useless for testing.
- The Stop input carries `background_tasks` (since 2.1.145) and `session_crons`. Hook env carries `CLAUDE_CODE_ENTRYPOINT` (`cli`, `claude-desktop-3p`, `sdk-cli`) and `CLAUDE_PID`.
- Hook edits in settings files are picked up live, which is useful for one-off probes. Remove the probe afterwards.
- Plugin dirs under `~/.claude/plugins/cache/...` change on every update and old ones get orphaned, so never persist a plugin path except through `installed_plugins.json` resolution.
- The status line takes the most specific settings file that defines one; the user-level file is `~/.claude/settings.json`. `refreshInterval` re-runs it on a timer.
- On 0.2 data, 69 of the 70 checkable pings were real cache hits, so the ping-turn mechanism works.
