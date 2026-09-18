// Shared core for hooks, the monitor, the CLI and the dashboard server.
// Zero dependencies on purpose: hooks run on every prompt and must start fast.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.2.0';

export const HOME = process.env.CCW_HOME || path.join(os.homedir(), '.claude-cache-warm');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const SESSIONS_DIR = path.join(HOME, 'sessions');
export const EVENTS_PATH = path.join(HOME, 'events.jsonl');

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalMinutes: 'auto',
  maxIdleMinutes: 180,
  minContextTokens: 20000,
  warmWhen: 'background-work',
  engine: 'monitor',
  fallbackCron: true,
  dashboardPort: 4777,
});

// Keep pings comfortably inside the TTL: a ping that lands late is a full re-write.
export const AUTO_INTERVAL = Object.freeze({ '1h': 50, '5m': 4 });
export const TTL_MINUTES = Object.freeze({ '1h': 60, '5m': 5 });

// USD per million tokens. `read` is the cache-hit multiplier on base input
// (0.1x, except Fable/Mythos 5.1 at 0.025x). Writes are 1.25x (5m) and 2x (1h).
// Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-09).
const PRICING = [
  [/(fable|mythos)-5-1/, { input: 10, read: 0.025 }],
  [/(fable|mythos)-5/, { input: 10, read: 0.1 }],
  [/opus-4-(1|0|\d{8})(-|$)|opus-4$/, { input: 15, read: 0.1 }], // Opus 4 / 4.1 only
  [/opus/, { input: 5, read: 0.1 }],
  [/sonnet-5/, { input: 2, read: 0.1 }],
  [/sonnet/, { input: 3, read: 0.1 }],
  [/haiku-3/, { input: 0.8, read: 0.1 }],
  [/haiku/, { input: 1, read: 0.1 }],
];
export const WRITE_MULTIPLIER = Object.freeze({ '1h': 2, '5m': 1.25 });

export function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, p] of PRICING) if (re.test(m)) return p;
  return { input: 5, read: 0.1 };
}

/** What one keep-alive ping costs vs. what a cold rebuild of the same context costs. */
export function estimateCosts(model, contextTokens, ttl) {
  const p = priceFor(model);
  const mtok = (contextTokens || 0) / 1e6;
  const pingUsd = mtok * p.input * p.read;
  const rebuildUsd = mtok * p.input * (WRITE_MULTIPLIER[ttl] || 1.25);
  return {
    pingUsd,
    rebuildUsd,
    // Warming only pays off if you come back before this many pings have been spent.
    breakEvenPings: pingUsd > 0 ? Math.floor((rebuildUsd - pingUsd) / pingUsd) : 0,
  };
}

// ---------------------------------------------------------------- fs helpers

export function ensureHome() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent));
  // Windows can briefly refuse the rename while another process has the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

export function logEvent(event) {
  try {
    ensureHome();
    fs.appendFileSync(EVENTS_PATH, JSON.stringify({ t: Date.now(), ...event }) + '\n');
  } catch {
    // Never let logging break a hook or the monitor.
  }
}

export function readEvents(sinceMs = 0) {
  let text;
  try {
    text = fs.readFileSync(EVENTS_PATH, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.t >= sinceMs) out.push(e);
    } catch {
      // Skip a torn line; the log is append-only and best-effort.
    }
  }
  return out;
}

// -------------------------------------------------------------------- config

export function validateConfigPatch(patch) {
  const out = {};
  const errors = [];
  for (const [key, value] of Object.entries(patch || {})) {
    switch (key) {
      case 'enabled':
        if (typeof value === 'boolean') out.enabled = value;
        else errors.push('enabled must be true or false');
        break;
      case 'intervalMinutes':
        if (value === 'auto') out.intervalMinutes = 'auto';
        else if (Number.isFinite(+value) && +value >= 1 && +value <= 59) out.intervalMinutes = +value;
        else errors.push('intervalMinutes must be "auto" or a number from 1 to 59');
        break;
      case 'maxIdleMinutes':
        if (Number.isFinite(+value) && +value >= 0) out.maxIdleMinutes = +value;
        else errors.push('maxIdleMinutes must be a number >= 0 (0 = never stop)');
        break;
      case 'minContextTokens':
        if (Number.isFinite(+value) && +value >= 0) out.minContextTokens = +value;
        else errors.push('minContextTokens must be a number >= 0');
        break;
      case 'warmWhen':
        if (value === 'background-work' || value === 'always') out.warmWhen = value;
        else errors.push('warmWhen must be "background-work" or "always"');
        break;
      case 'fallbackCron':
        if (typeof value === 'boolean') out.fallbackCron = value;
        else errors.push('fallbackCron must be true or false');
        break;
      case 'engine':
        if (value === 'monitor' || value === 'cron') out.engine = value;
        else errors.push('engine must be "monitor" or "cron"');
        break;
      case 'dashboardPort':
        if (Number.isInteger(+value) && +value >= 1024 && +value <= 65535) out.dashboardPort = +value;
        else errors.push('dashboardPort must be an integer from 1024 to 65535');
        break;
      default:
        errors.push(`unknown setting "${key}"`);
    }
  }
  return { patch: out, errors };
}

export function loadConfig() {
  const stored = readJson(CONFIG_PATH, {}) || {};
  // Re-validate on load so a hand-edited file can't feed the monitor garbage.
  const { patch } = validateConfigPatch(stored);
  return { ...DEFAULT_CONFIG, ...patch };
}

export function saveConfig(patch) {
  const { patch: clean, errors } = validateConfigPatch(patch);
  if (errors.length) throw new Error(errors.join('; '));
  const stored = readJson(CONFIG_PATH, {}) || {};
  // pluginOptions is the hook's snapshot of the plugin-tab values, not a setting; carry it along.
  const next = { ...loadConfig(), ...clean, ...(stored.pluginOptions ? { pluginOptions: stored.pluginOptions } : {}) };
  writeJsonAtomic(CONFIG_PATH, next);
  logEvent({ type: 'config', patch: clean });
  return next;
}

// ------------------------------------------------------------------ sessions
// Two files per session so writers never collide:
//   <id>.json          owned by hooks + CLI   (activity, per-session toggle)
//   <id>.monitor.json  owned by the monitor   (heartbeat, ping history)

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function sessionPath(id, kind = 'session') {
  if (!SESSION_ID_RE.test(String(id))) throw new Error(`invalid session id: ${id}`);
  return path.join(SESSIONS_DIR, kind === 'monitor' ? `${id}.monitor.json` : `${id}.json`);
}

export function loadSession(id) {
  return readJson(sessionPath(id), null);
}

export function updateSession(id, patch) {
  const current = loadSession(id) || { sessionId: id, startedAt: Date.now(), enabled: null };
  const next = { ...current, ...patch };
  writeJsonAtomic(sessionPath(id), next);
  return next;
}

// Per-session overrides. `null` clears one, i.e. "follow the global setting again".
const SESSION_OVERRIDE_KEYS = ['intervalMinutes', 'maxIdleMinutes', 'warmWhen'];

export function setSessionOverrides(id, patch) {
  const session = loadSession(id);
  if (!session) throw new Error(`unknown session: ${id}`);
  const next = { enabled: session.enabled ?? null, overrides: { ...(session.overrides || {}) } };
  const toValidate = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'enabled') {
      if (![true, false, null].includes(value)) throw new Error('enabled must be true, false or null');
      next.enabled = value;
    } else if (!SESSION_OVERRIDE_KEYS.includes(key)) throw new Error(`"${key}" cannot be set per session`);
    else if (value === null) delete next.overrides[key];
    else toValidate[key] = value;
  }
  const { patch: clean, errors } = validateConfigPatch(toValidate);
  if (errors.length) throw new Error(errors.join('; '));
  Object.assign(next.overrides, clean);
  logEvent({ type: 'config', sessionId: id, patch });
  return updateSession(id, next);
}

// Background work (running subagents, background shell commands): one marker file
// each, so concurrent hooks never race on a shared file.
// Subagents are removed on SubagentStop. Claude Code has no hook for a background
// shell finishing, so those markers simply age out.
const STALE_MS = { agent: 12 * 3600_000, shell: 2 * 3600_000 };

function agentsDir(id) {
  sessionPath(id); // validates the id
  return path.join(SESSIONS_DIR, `${id}.agents`);
}

export function markAgent(id, agentId, info) {
  const file = path.join(agentsDir(id), `${String(agentId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}.json`);
  if (info) writeJsonAtomic(file, info);
  else fs.rmSync(file, { force: true });
}

export function clearAgents(id) {
  fs.rmSync(agentsDir(id), { recursive: true, force: true });
}

export function activeAgents(id, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(agentsDir(id));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(agentsDir(id), n)))
    .filter((a) => a && now - (a.startedAt || 0) < (STALE_MS[a.kind] || STALE_MS.agent));
}

/** True when this session's monitor process has heart-beaten recently. */
export function monitorAlive(id, now = Date.now()) {
  return now - (loadMonitorState(id).heartbeatAt || 0) < 30_000;
}

export function loadMonitorState(id) {
  return readJson(sessionPath(id, 'monitor'), null) || { pingTimes: [] };
}

export function saveMonitorState(id, state) {
  writeJsonAtomic(sessionPath(id, 'monitor'), state);
}

export function listSessions() {
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.monitor.json') && !n.includes('.tmp'))
    .map((n) => readJson(path.join(SESSIONS_DIR, n)))
    .filter((s) => s && s.sessionId);
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Drop state for sessions that ended (or whose Claude process died) over a week ago. */
export function pruneSessions(now = Date.now()) {
  const WEEK = 7 * 24 * 3600 * 1000;
  for (const s of listSessions()) {
    const last = Math.max(s.endedAt || 0, s.lastUserActivityAt || 0, s.lastStopAt || 0, s.startedAt || 0);
    const dead = s.endedAt || !pidAlive(s.claudePid);
    if (dead && now - last > WEEK) {
      fs.rmSync(sessionPath(s.sessionId), { force: true });
      fs.rmSync(sessionPath(s.sessionId, 'monitor'), { force: true });
      clearAgents(s.sessionId);
    }
  }
}

// --------------------------------------------------------------- transcripts

/**
 * Read the tail of a transcript and return the latest main-conversation usage:
 * how big the context is, which model, and which cache TTL Claude Code is writing.
 */
export function readLastUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    // Tool results can make single lines huge, so widen the window until a usage line shows up.
    for (const window of [256 * 1024, 4 * 1024 * 1024, size]) {
      const len = Math.min(size, window);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // first line is probably cut in half
      const found = scanUsage(lines);
      if (found || len === size) return found;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function scanUsage(lines) {
  let latest = null;
  let ttl = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const u = rec?.message?.usage;
    if (!u || rec.isSidechain || rec.type !== 'assistant') continue;
    if (!latest) {
      latest = {
        model: rec.message.model,
        timestamp: Date.parse(rec.timestamp) || 0,
        contextTokens:
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreation: u.cache_creation_input_tokens || 0,
      };
    }
    const c = u.cache_creation || {};
    if (c.ephemeral_1h_input_tokens > 0) ttl = '1h';
    else if (c.ephemeral_5m_input_tokens > 0) ttl = '5m';
    if (ttl) break;
  }
  return latest ? { ...latest, ttl } : null;
}

/** TTL the session is really using: what the transcript shows, else what the env asks for. */
export function resolveTtl(usage, env = process.env) {
  if (env.FORCE_PROMPT_CACHING_5M === '1') return '5m';
  if (usage?.ttl) return usage.ttl;
  if (env.CLAUDE_CODE_PROMPT_CACHE_TTL === '1h' || env.ENABLE_PROMPT_CACHING_1H === '1') return '1h';
  return '5m';
}

export function resolveIntervalMinutes(config, ttl) {
  return config.intervalMinutes === 'auto' ? AUTO_INTERVAL[ttl] || 4 : config.intervalMinutes;
}

// -------------------------------------------------------------------- status

/**
 * Single source of truth for "should this session be pinged, and when".
 * The monitor acts on it; the CLI and dashboard only display it.
 */
export function computeStatus({ config: globalConfig, session, monitor, usage, agents = [], now = Date.now(), env = process.env }) {
  const overrides = session.overrides || {};
  const config = { ...globalConfig, ...overrides };
  const ttl = resolveTtl(usage, env);
  const intervalMinutes = resolveIntervalMinutes(config, ttl);
  const intervalMs = intervalMinutes * 60_000;
  const pingTimes = monitor?.pingTimes || [];
  const lastPingAt = pingTimes.length ? pingTimes[pingTimes.length - 1] : 0;

  // When the human (or real work) last touched the session. Pings don't count;
  // launching background work does.
  const lastHumanAt = Math.max(session.lastUserActivityAt || 0, session.lastWorkStopAt || 0, session.startedAt || 0, ...agents.map((a) => a.startedAt || 0));
  // When the main conversation's cache was last refreshed by anything, pings included.
  // Deliberately not the transcript's mtime: subagent and tool output can touch the file
  // without the main conversation sending a request.
  // Launching an agent or resuming a session is not a request, so lastHumanAt stays out of it.
  const lastRequestAt = Math.max(session.lastUserActivityAt || 0, session.lastStopAt || 0, lastPingAt, usage?.timestamp || 0);

  const base = {
    ttl,
    intervalMinutes,
    lastHumanAt,
    lastRequestAt,
    lastPingAt,
    pingsSinceUser: pingTimes.filter((t) => t > (session.lastUserActivityAt || 0)).length,
    pingsTotal: monitor?.pingsTotal || 0,
    model: usage?.model || null,
    contextTokens: usage?.contextTokens || 0,
    nextPingAt: null,
    overrides,
    warmWhen: config.warmWhen,
    agentsRunning: agents.length,
    agentTypes: [...new Set(agents.map((a) => a.type).filter(Boolean))],
    warning: intervalMinutes >= TTL_MINUTES[ttl] ? `interval ${intervalMinutes}m is not shorter than the ${ttl} cache TTL` : null,
    ...estimateCosts(usage?.model, usage?.contextTokens, ttl),
  };

  // Default policy: only warm a session that is waiting on background work. Its result
  // lands in this conversation, so you are certainly coming back, and meanwhile the main
  // conversation sends nothing that would refresh its own cache.
  const enabled = session.enabled ?? config.enabled;
  base.reason = agents.length ? 'background-work' : 'idle';
  let status;
  if (session.endedAt) status = 'ended';
  else if (!enabled) status = 'off';
  else if (config.warmWhen === 'background-work' && !agents.length) status = 'no-work';
  else if (base.contextTokens < config.minContextTokens) status = 'small-context';
  else if (config.maxIdleMinutes > 0 && now - lastHumanAt > config.maxIdleMinutes * 60_000) status = 'idle-cap';
  else if (now - lastRequestAt > TTL_MINUTES[ttl] * 60_000) status = 'expired'; // cache already gone; a ping would be a full-price rewrite
  else status = 'warming';

  if (status === 'warming') base.nextPingAt = lastRequestAt + intervalMs;
  return { status, due: status === 'warming' && now >= base.nextPingAt, ...base };
}

/** Every registered session with its computed status, most recently active first. */
export function sessionViews(now = Date.now(), thisSession = null) {
  const config = loadConfig();
  return listSessions()
    .map((session) => {
      const monitor = loadMonitorState(session.sessionId);
      const usage = readLastUsage(session.transcriptPath);
      const agents = activeAgents(session.sessionId, now);
      const st = computeStatus({ config, session, monitor, usage, agents, now });
      // A crashed Claude never fires SessionEnd, so check the process too.
      const gone = !session.endedAt && session.claudePid && !pidAlive(session.claudePid);
      return {
        ...session,
        ...st,
        status: gone ? 'ended' : st.status,
        nextPingAt: gone ? null : st.nextPingAt,
        monitorAlive: now - (monitor.heartbeatAt || 0) < 30_000,
        isThisSession: session.sessionId === thisSession,
      };
    })
    .sort((a, b) => b.lastRequestAt - a.lastRequestAt);
}

/**
 * Cron-engine turn: the scheduled prompt runs this. The turn itself is the ping,
 * so all this decides is whether the task should keep existing.
 */
export function cronTick(id, now = Date.now()) {
  const session = loadSession(id);
  if (!session) return { keep: false, reason: 'session not registered' };
  const monitor = loadMonitorState(id);
  const st = computeStatus({ config: loadConfig(), session, monitor, usage: readLastUsage(session.transcriptPath), agents: activeAgents(id, now), now });
  monitor.pingTimes = [...(monitor.pingTimes || []), now].slice(-200);
  monitor.pingsTotal = (monitor.pingsTotal || 0) + 1;
  saveMonitorState(id, monitor);
  logEvent({ type: 'ping', sessionId: id, engine: 'cron', ttl: st.ttl, status: st.status, contextTokens: st.contextTokens, model: st.model, estCostUsd: st.pingUsd });
  // Keep the task while there is something to warm and no monitor has taken over.
  const keep = st.status === 'warming' && (loadConfig().engine === 'cron' || !monitorAlive(id, now));
  if (!keep) updateSession(id, { cronArmedAt: 0 });
  return { keep, reason: st.status };
}

export const PING_TEXT =
  '[cache-warm] Keep-alive ping to refresh the prompt cache. Reply with exactly "ok" and nothing else. Do not call tools, do not think, do not comment on this message.';

// --------------------------------------------------------------------- misc

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
