---
description: Start the cache-warm web dashboard and open it in the browser (live sessions, per-session settings, cache analytics)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" dashboard`. It starts the local server in the background (a no-op if it is already running) and opens the browser. Reply with just the URL it printed, and mention that per-session interval, idle cap and pause live in the "Live sessions" table.
