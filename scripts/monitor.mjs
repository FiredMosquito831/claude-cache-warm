#!/usr/bin/env node
// Plugin monitor: one long-lived process per interactive Claude Code session.
// Claude Code delivers every stdout line to the model as a notification, which
// wakes an idle session. So stdout carries ONLY ping lines; everything else
// goes to events.jsonl.
import {
  PING_TEXT,
  activeAgents,
  computeStatus,
  ensureHome,
  listSessions,
  loadConfig,
  loadMonitorState,
  loadSession,
  logEvent,
  pidAlive,
  readLastUsage,
  saveMonitorState,
} from './lib.mjs';

const TICK_MS = Number(process.env.CCW_TICK_MS) || 5000;
const MIN_PING_GAP_MS = 60_000; // hard floor, whatever the config says
const KEEP_PING_TIMES = 200;
const claudePid = Number(process.env.CLAUDE_PID) || 0;

// /clear and /resume swap the session id inside the same Claude process, so the
// env var we were started with goes stale. Hooks record the owning PID; trust that first.
function currentSession() {
  const live = listSessions().filter((s) => !s.endedAt);
  const newest = (list) => list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (claudePid) {
    const mine = newest(live.filter((s) => s.claudePid === claudePid));
    if (mine) return mine;
  }
  const envId = process.env.CLAUDE_CODE_SESSION_ID;
  if (envId) {
    const s = loadSession(envId);
    if (s && !s.endedAt) return s;
  }
  if (claudePid) return null; // hooks haven't registered this process yet
  return newest(live.filter((s) => s.cwd && samePath(s.cwd, process.cwd()))) || null;
}

function samePath(a, b) {
  const norm = (p) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

let lastSkipReason = null;

function tick() {
  if (claudePid && !pidAlive(claudePid)) process.exit(0);

  const session = currentSession();
  if (!session) return;
  const id = session.sessionId;
  const now = Date.now();
  const config = loadConfig();
  const monitor = loadMonitorState(id);
  const usage = readLastUsage(session.transcriptPath);
  const st = computeStatus({ config, session, monitor, usage, agents: activeAgents(id, now), now });

  monitor.monitorPid = process.pid;
  monitor.heartbeatAt = now;

  if (st.status !== lastSkipReason && st.status !== 'warming') {
    logEvent({ type: 'skip', sessionId: id, reason: st.status });
  }
  lastSkipReason = st.status;

  if (st.due && config.engine === 'monitor' && now - st.lastPingAt >= MIN_PING_GAP_MS) {
    monitor.pingTimes = [...(monitor.pingTimes || []), now].slice(-KEEP_PING_TIMES);
    monitor.pingsTotal = (monitor.pingsTotal || 0) + 1;
    saveMonitorState(id, monitor); // persist before emitting so a crash can't cause a ping storm
    logEvent({
      type: 'ping',
      sessionId: id,
      engine: 'monitor',
      ttl: st.ttl,
      intervalMinutes: st.intervalMinutes,
      reason: st.reason,
      agentsRunning: st.agentsRunning,
      idleMs: now - st.lastHumanAt,
      contextTokens: st.contextTokens,
      model: st.model,
      estCostUsd: st.pingUsd,
    });
    process.stdout.write(PING_TEXT + '\n');
    return;
  }
  saveMonitorState(id, monitor);
}

ensureHome();
logEvent({ type: 'monitor_start', pid: process.pid, claudePid, sessionId: process.env.CLAUDE_CODE_SESSION_ID || null });
setInterval(() => {
  try {
    tick();
  } catch (err) {
    logEvent({ type: 'monitor_error', message: String(err?.message || err) });
  }
}, TICK_MS);
