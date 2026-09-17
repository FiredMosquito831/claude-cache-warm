---
description: Show prompt-cache warming status, next ping countdown and per-ping cost for every live session
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" status` and show the output verbatim in a code block. Add at most one sentence if something needs attention (a `warning:` line, `[no monitor]`, or `expired`).
