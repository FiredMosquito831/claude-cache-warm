---
description: Turn prompt-cache warming off (globally, or for this session / project / desktop / cli)
argument-hint: "[session | project | desktop | cli]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" off <scope flag>` and confirm in one line which scope is now off.

Scope words in the arguments map to flags: "session" or "this session" → `--session`; "project" or "this folder" → `--project`; "desktop" → `--desktop`; "cli" or "terminal" → `--cli`; "ide" → `--ide`; "global", "everywhere" or "all" → `--global`. With no scope word, pass no flag: ccw then changes only this session's surface (CLI or desktop app), never the other one.

Arguments: $ARGUMENTS
