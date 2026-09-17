#!/usr/bin/env node
// Hook entry point: records session activity so the monitor knows when the
// session went idle. Must never block or fail the user's turn: always exit 0.
import {
  CONFIG_PATH,
  ensureHome,
  loadMonitorState,
  loadSession,
  logEvent,
  pruneSessions,
  readJson,
  saveConfig,
  updateSession,
} from './lib.mjs';

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

// First run only: seed config.json from the options chosen when the plugin was enabled.
// After that config.json is the live source of truth (CLI, dashboard and tray all edit it).
function seedConfigFromPluginOptions() {
  if (readJson(CONFIG_PATH)) return;
  const env = process.env;
  const patch = {};
  if (env.CLAUDE_PLUGIN_OPTION_ENABLED != null) patch.enabled = env.CLAUDE_PLUGIN_OPTION_ENABLED !== 'false';
  const interval = env.CLAUDE_PLUGIN_OPTION_INTERVAL_MINUTES;
  if (interval) patch.intervalMinutes = interval === 'auto' ? 'auto' : Number(interval);
  if (env.CLAUDE_PLUGIN_OPTION_MAX_IDLE_MINUTES) patch.maxIdleMinutes = Number(env.CLAUDE_PLUGIN_OPTION_MAX_IDLE_MINUTES);
  try {
    saveConfig(patch);
  } catch {
    saveConfig({});
  }
}

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const id = input.session_id;
  if (!id) return;
  ensureHome();
  const now = Date.now();
  const common = {
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
    claudePid: Number(process.env.CLAUDE_PID) || undefined,
  };

  switch (input.hook_event_name) {
    case 'SessionStart':
      seedConfigFromPluginOptions();
      pruneSessions(now);
      updateSession(id, { ...common, startedAt: loadSession(id)?.startedAt || now, endedAt: 0, source: input.source });
      logEvent({ type: 'session_start', sessionId: id, source: input.source, cwd: input.cwd });
      break;

    case 'UserPromptSubmit':
      updateSession(id, { ...common, lastUserActivityAt: now, endedAt: 0 });
      break;

    case 'Stop': {
      // A Stop that closes a keep-alive turn must not reset the idle clock,
      // otherwise the pings would keep their own session "active" forever.
      const session = loadSession(id) || {};
      const pingTimes = loadMonitorState(id).pingTimes || [];
      const lastPingAt = pingTimes[pingTimes.length - 1] || 0;
      const closesPing = lastPingAt > Math.max(session.lastUserActivityAt || 0, session.lastStopAt || 0);
      updateSession(id, { ...common, lastStopAt: now, ...(closesPing ? {} : { lastWorkStopAt: now }) });
      break;
    }

    case 'SessionEnd':
      updateSession(id, { ...common, endedAt: now, endReason: input.reason });
      logEvent({ type: 'session_end', sessionId: id, reason: input.reason });
      break;
  }
}

main()
  .catch((err) => logEvent({ type: 'hook_error', message: String(err?.message || err) }))
  .finally(() => process.exit(0));
