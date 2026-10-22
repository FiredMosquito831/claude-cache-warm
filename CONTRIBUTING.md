# Contributing

Thanks for taking a look. This repository is a Claude Code plugin with a deliberately small runtime: Node.js ES modules, no npm dependencies for the plugin, and a static dashboard. Changes that add a runtime dependency to the plugin are unlikely to be accepted.

## Setup

```sh
# Node 18+ and npm. Do not use Bun for this repository.
npm test
node scripts/ccw.mjs --help
```

Read [CLAUDE.md](CLAUDE.md) first; it documents the architecture, invariants and release process. Read [CLAUDE.md's release checklist](CLAUDE.md#versioning-and-releases) before opening a release PR.

## Tests

The end-to-end suite spawns the real hook, waker and CLI against fake transcripts in a temporary state directory:

```sh
npm test
node --test --test-name-pattern="waker" test/e2e.test.mjs   # a subset
```

Tests set both `CCW_HOME` and `CLAUDE_CONFIG_DIR` to temporary folders. Never let a test reach the real `~/.claude` or `~/.claude-cache-warm`. When adding a test, keep that isolation and prefer simulated time (`age()`, `runWaker({ whileSleeping })`) over sleeping.

Before claiming a change is done: `npm test` green, and — if `desktop/` changed — `cd desktop/src-tauri && cargo check`.

## Documentation site

The site in `docs/` is generated; do not edit generated files by hand.

```sh
python -m pip install -r requirements-site.txt
python scripts/build_site.py            # regenerate docs/
python scripts/build_site.py --check    # what CI runs: fail if docs/ is stale
```

Sources:

- `site/templates/` — Jinja2 pages and the shared base template.
- `site/static/` — stylesheet, self-hosted fonts, favicon, JS, screenshots, `og.png`.
- `scripts/build_site.py` — derives the version, defaults, option metadata and session states from `package.json`, `scripts/lib.mjs` and `.claude-plugin/plugin.json`. If you change a setting or default, the site updates on the next build.
- `SITE_URL` in `scripts/build_site.py` is the single source for canonical URLs, Open Graph, sitemap, robots and the CNAME file.

Screenshots are real captures, not mockups:

```sh
python -m pip install playwright
python -m playwright install chromium
python scripts/capture_site.py
```

The script starts the real dashboard against seeded sample state, captures it, renders `og.png`, then serves `docs/` and captures the site at 1440 px and 390 px. Commit the changed PNGs under `site/static/screenshots/` and `site/static/og.png`, then rebuild so `docs/assets/` matches.

## Code style

- **Plugin and dashboard:** zero runtime dependencies, `.mjs`, Node 18-compatible. Hooks must stay fast and must never throw or block a turn.
- **Never add** scheduled tasks, plugin monitors, `decision: "block"` Stop hooks, or Claude tool calls to time pings. The waker exists for that.
- **State writes** go through `withLock()` and `writeJsonAtomic()`. Do not write a settings file without a backup and an exact restore path.
- **Dashboard UI:** one static HTML file with inline CSS/JS; render untrusted strings with `textContent`/DOM nodes, not HTML.
- **Settings invariants:** only a human prompt resets the idle clock; scoped changes must never leak across sessions or surfaces; headless runs are never registered.
- **Docs:** update README, `docs/TUTORIAL.md`, `docs/CONTRACT.md` and relevant `skills/*/SKILL.md` when behaviour, state files or the HTTP API change.

## Commits and pull requests

- Work on a branch, open a pull request against `main`, and wait for review. Do not push to `main` directly.
- A commit subject states the change; the body explains the root cause, not just the files.
- End commits and PR descriptions with `by FiredMosquito831` (this repository's attribution convention).
- Add a `CHANGELOG.md` entry for every user-visible change. Pre-1.0: minor for user-visible behaviour or a new setting, patch for a fix that changes no setting, file shape or default.
- Bump the version in all three places when releasing: `package.json`, `.claude-plugin/plugin.json`, and `VERSION` in `scripts/lib.mjs`.

## License

By contributing you agree your changes are released under the project's [MIT license](LICENSE).
