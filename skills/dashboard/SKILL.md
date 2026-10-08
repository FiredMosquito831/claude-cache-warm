---
description: Start the cache-warm web dashboard and open it in the browser (live sessions, global / surface / project / session settings, cache analytics)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" dashboard`. It starts the local server in the background (a no-op if it is already running) and opens the browser. Reply with just the URL it printed, and mention that scoped settings (global, CLI, desktop app, project folders) are in the Settings panel and per-session ones in the "Live sessions" table.
