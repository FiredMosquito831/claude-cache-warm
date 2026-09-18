#!/usr/bin/env node
// Hook entry point: records session activity so the monitor knows when the
// session went idle. Must never block or fail the user's turn: always exit 0.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PATH,
  activeAgents,
  clearAgents,
  computeStatus,
  ensureHome,
  loadConfig,
  loadMonitorState,
  loadSession,
  logEvent,
  markAgent,
  monitorAlive,
  pruneSessions,
  readJson,
  readLastUsage,
  saveConfig,
  updateSession,
  writeJsonAtomic,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { refreshPluginRoot } from './statusline-install.mjs';

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

// Plugin-tab options (CLAUDE_PLUGIN_OPTION_*) and config.json are both editable, so
// neither may blindly overwrite the other. The last-applied option values are kept in
// config.json; an option that differs from that snapshot was changed in the plugin tab
// and wins. Everything else keeps whatever the CLI, dashboard or tray app set.
const OPTION_KEYS = {
  ENABLED: ['enabled', (v) => v !== 'false'],
  WARM_WHEN: ['warmWhen', (v) => v],
  INTERVAL_MINUTES: ['intervalMinutes', (v) => (v === 'auto' ? 'auto' : Number(v))],
  MAX_IDLE_MINUTES: ['maxIdleMinutes', Number],
  MIN_CONTEXT_TOKENS: ['minContextTokens', Number],
  FALLBACK_CRON: ['fallbackCron', (v) => v !== 'false'],
  DASHBOARD_PORT: ['dashboardPort', Number],
};

function syncPluginOptions() {
  const stored = readJson(CONFIG_PATH) || {};
  const seen = stored.pluginOptions || {};
  const current = {};
  const patch = {};
  for (const [envKey, [key, parse]] of Object.entries(OPTION_KEYS)) {
    const raw = process.env[`CLAUDE_PLUGIN_OPTION_${envKey}`];
    if (raw == null || raw === '') continue;
    current[key] = raw;
    if (seen[key] !== raw) patch[key] = parse(raw);
  }
  if (!Object.keys(patch).length && JSON.stringify(current) === JSON.stringify(seen)) return;
  let next;
  try {
    next = saveConfig(patch);
  } catch {
    next = saveConfig({}); // an invalid option value: keep the rest, drop the bad one
  }
  writeJsonAtomic(CONFIG_PATH, { ...next, pluginOptions: current });
}

// Plugin monitors turned out not to start for every session (a `claude --resume`
// got none). When there is no monitor, arm an in-session scheduled task instead.
// Claude Code has no hook that creates one, but a Stop hook may ask Claude to keep
// going, so once per need we ask it to call CronCreate. Costs one tool call.
function cronFallbackPrompt(id, input, now) {
  if (input.stop_hook_active) return null; // never loop
  const config = loadConfig();
  if (config.engine !== 'cron' && (!config.fallbackCron || monitorAlive(id, now))) return null;
  const session = loadSession(id);
  if (!session || session.cronArmedAt) return null;
  const st = computeStatus({ config, session, monitor: loadMonitorState(id), usage: readLastUsage(session.transcriptPath), agents: activeAgents(id, now), now });
  if (st.status !== 'warming') return null;
  // Cron steps must divide the hour evenly; recurring tasks fire with jitter, so stay under the interval.
  const step = [30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1].find((s) => s <= st.intervalMinutes) || 1;
  updateSession(id, { cronArmedAt: now });
  logEvent({ type: 'cron_armed', sessionId: id, step, intervalMinutes: st.intervalMinutes });
  const tick = `node "${ROOT.replace(/\\/g, '/')}/scripts/ccw.mjs" cron-tick ${id}`;
  return (
    `[cache-warm] This session has no keep-alive monitor, so schedule one in-session: call CronCreate with cron "*/${step} * * * *", recurring: true, and this exact prompt:\n` +
    `"[cache-warm] keep-alive: run \`${tick}\` with Bash. If it prints STOP, call CronList and CronDelete the task whose prompt starts with [cache-warm]. Otherwise reply with exactly ok. Do nothing else."\n` +
    `Then reply with one short line saying the cache keep-alive task is scheduled. Do nothing else.`
  );
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
      syncPluginOptions();
      refreshPluginRoot(); // plugin updates move the install dir; keep the status line launcher pointed at it
      pruneSessions(now);
      // No agent survives a restart. /clear, /compact and resume keep the process, and its agents, alive.
      if (input.source === 'startup') clearAgents(id);
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
      const reason = cronFallbackPrompt(id, input, now);
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
      break;
    }

    case 'SubagentStart':
      if (input.agent_id) markAgent(id, input.agent_id, { kind: 'agent', agentId: input.agent_id, type: input.agent_type || null, startedAt: now });
      break;

    case 'SubagentStop':
      if (input.agent_id) markAgent(id, input.agent_id, null);
      break;

    case 'PostToolUse':
      if (input.tool_name === 'CronDelete') updateSession(id, { cronArmedAt: 0 });
      // A shell command sent to the background keeps working after the turn ends.
      if (input.tool_input?.run_in_background === true) {
        const shellId = `shell-${input.tool_use_id || now}`;
        markAgent(id, shellId, { kind: 'shell', agentId: shellId, type: `background ${input.tool_name}`, startedAt: now });
      }
      break;

    case 'SessionEnd':
      updateSession(id, { ...common, endedAt: now, endReason: input.reason });
      if (input.reason !== 'clear') clearAgents(id);
      logEvent({ type: 'session_end', sessionId: id, reason: input.reason });
      break;
  }
}

main()
  .catch((err) => logEvent({ type: 'hook_error', message: String(err?.message || err) }))
  .finally(() => process.exit(0));
