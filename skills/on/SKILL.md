---
description: Turn prompt-cache warming on (add "session" to switch only this session)
argument-hint: "[session]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" on` — append `--session` if the arguments below say "session" — then `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" status`. Relay the result in one or two lines. If the status shows `[no monitor]` for this session, mention `/cache-warm:config engine cron` as the fallback.

Arguments: $ARGUMENTS
