---
description: Add (or remove) the cache-warm segment in the Claude Code status line - warm on/off, context tokens, cached tokens, time until the cache expires
argument-hint: "[install | uninstall | newline]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Manage the status line segment with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" statusline <sub-command>`:

- no argument or `install`: run `statusline install`
- `newline`: run `statusline install --newline` (segment on its own row)
- `uninstall` / `remove`: run `statusline uninstall`

Show the command output verbatim. After an install, add one line: the existing status line (if any) still runs first and the segment is appended to it; it shows up after the next turn, and `/cache-warm:statusline uninstall` restores the previous setup exactly.

Arguments: $ARGUMENTS
