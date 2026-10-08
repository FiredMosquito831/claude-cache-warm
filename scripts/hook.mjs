#!/usr/bin/env node
// SessionStart / UserPromptSubmit / SessionEnd hook. Records who did what and
// when, so the waker (the Stop hook) knows how long the session has been idle.
// It must never block or fail a turn: always exit 0.

// `--home=<dir>` points a hook at another state directory (tests, live checks).
const homeArg = process.argv.find((a) => a.startsWith('--home='));
if (homeArg) process.env.CCW_HOME = homeArg.slice(7);

const lib = await import('./lib.mjs');
const { ensureStatusline, refreshStatuslineLauncher } = await import('./statusline-install.mjs');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

// Pruning walks every session file; once an hour is plenty.
function pruneOccasionally(now) {
  const stamp = `${lib.SESSIONS_DIR}/.pruned`;
  if (now - (lib.readJson(stamp, 0) || 0) < 3600_000) return;
  lib.writeJsonAtomic(stamp, now);
  lib.pruneSessions(now);
}

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const id = input.session_id;
  if (!id) return;
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || '';
  const surface = lib.surfaceFromEntrypoint(entrypoint);
  // claude -p and the Agent SDK are scripts, not people: never register them, never warm them.
  if (surface === 'headless') return;

  lib.ensureHome();
  lib.ensureMigrated();
  const now = Date.now();
  const identity = {
    surface,
    entrypoint,
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
    claudePid: Number(process.env.CLAUDE_PID) || undefined,
  };

  switch (input.hook_event_name) {
    case 'SessionStart': {
      lib.syncPluginOptions(process.env);
      refreshStatuslineLauncher();
      ensureStatusline({ mode: lib.resolveSettings({}).values.statusline, cwd: input.cwd });
      pruneOccasionally(now);
      // A new process (startup/resume/fork) has no background work yet; /clear and /compact keep the process.
      const freshProcess = input.source === 'startup' || input.source === 'resume' || input.source === 'fork';
      lib.updateSession(id, (s) => ({
        ...s,
        ...identity,
        startedAt: s.startedAt && !freshProcess ? s.startedAt : now,
        source: input.source,
        endedAt: 0,
        turnStartedAt: 0,
        ...(freshProcess ? { background: null } : {}),
      }));
      lib.supersedeWaker(id, 'session-start');
      lib.logEvent({ type: 'session_start', sessionId: id, source: input.source, surface, cwd: input.cwd });
      break;
    }

    case 'ConfigChange':
      // A settings file changed: pick up plugin-tab edits now, not at the next session start.
      if (lib.syncPluginOptions(lib.pluginOptionsFromSettings()).includes('statusline')) {
        ensureStatusline({ mode: lib.resolveSettings({}).values.statusline, cwd: input.cwd });
      }
      break;

    case 'UserPromptSubmit': {
      const kind = lib.classifyPrompt(input.prompt);
      lib.expireSelfTest(lib.loadSession(id), now);
      // A turn is starting: whatever timer was sleeping stands down. The next Stop starts a fresh one.
      lib.supersedeWaker(id, 'turn');
      lib.updateSession(id, (s) => ({
        ...s,
        ...identity,
        endedAt: 0,
        lastPromptAt: now,
        turnStartedAt: now,
        lastPromptKind: kind,
        // Only a person typing resets the idle clock. Scheduled tasks, background
        // reports and keep-alive pings arrive here too and must not.
        ...(kind === 'human' ? { lastHumanAt: now } : {}),
      }));
      if (kind === 'legacy-cron') {
        lib.logEvent({ type: 'legacy_cron_cleanup', sessionId: id });
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lib.LEGACY_CRON_CLEANUP } }) + '\n');
      }
      break;
    }

    case 'SessionEnd':
      lib.updateSession(id, (s) => ({ ...s, endedAt: now, endReason: input.reason, turnStartedAt: 0 }));
      lib.supersedeWaker(id, 'session-end');
      lib.logEvent({ type: 'session_end', sessionId: id, reason: input.reason });
      break;
  }
}

main()
  .catch((err) => lib.logEvent({ type: 'hook_error', message: String(err?.message || err) }))
  .finally(() => process.exit(0));
