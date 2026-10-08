---
description: Self-test prompt-cache warming in this session (CLI or desktop app) - one keep-alive ping a minute after this turn, verified against the transcript
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" test` and show its output. Then end your turn immediately with one line asking the user not to type for about a minute.

When the keep-alive note arrives, reply with exactly `ok` as it asks. The result is recorded automatically; if the user asks for it afterwards, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ccw.mjs" status` and report the "last self-test" line.
