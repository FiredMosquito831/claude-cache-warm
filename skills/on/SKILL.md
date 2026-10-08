---
description: Turn prompt-cache warming on (globally, or for this session / project / desktop / cli)
argument-hint: "[session | project | desktop | cli]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" on <scope flag>`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" config`. Relay the result in one or two lines.

Scope words in the arguments map to flags: "session" or "this session" → `--session`; "project" or "this folder" → `--project`; "desktop" → `--desktop`; "cli" or "terminal" → `--cli`; "ide" → `--ide`; nothing → global.

Never create scheduled tasks (CronCreate) for cache warming: the plugin's own hooks do the timing.

Arguments: $ARGUMENTS
