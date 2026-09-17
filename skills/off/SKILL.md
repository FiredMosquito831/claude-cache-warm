---
description: Turn prompt-cache warming off (add "session" to switch only this session)
argument-hint: "[session]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" off` — append `--session` if the arguments below say "session". Confirm in one line. If a cache-warm cron task exists in this session (check with CronList), delete it with CronDelete.

Arguments: $ARGUMENTS
