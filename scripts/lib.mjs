// Shared core for the hooks, the waker, the CLI, the status line and the dashboard.
// Zero dependencies on purpose: hooks run on every prompt and must start fast.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.4.0';

export const HOME = process.env.CCW_HOME || path.join(os.homedir(), '.claude-cache-warm');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const PLUGIN_OPTIONS_PATH = path.join(HOME, 'plugin-options.json');
export const SESSIONS_DIR = path.join(HOME, 'sessions');
export const EVENTS_PATH = path.join(HOME, 'events.jsonl');

// ------------------------------------------------------------------ settings

/** Settings every scope (global, surface, project, session) may set. */
export const SCOPED_KEYS = ['enabled', 'warmWhen', 'intervalMinutes', 'maxIdleMinutes', 'minContextTokens'];
/** Settings that only make sense once per machine. */
export const GLOBAL_ONLY_KEYS = ['dashboardPort', 'statusline'];

export const DEFAULTS = Object.freeze({
  enabled: true,
  warmWhen: 'background-work',
  intervalMinutes: 'auto', // 50 on a 1-hour cache, 4 on a 5-minute cache
  maxIdleMinutes: 180,
  minContextTokens: 20000,
  dashboardPort: 4777,
  statusline: 'auto', // add the segment to every status line, creating one if there is none
});

export const SURFACES = ['cli', 'desktop', 'ide'];

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
  return { pingUsd, rebuildUsd, breakEvenPings: pingUsd > 0 ? Math.floor((rebuildUsd - pingUsd) / pingUsd) : 0 };
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

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeJsonAtomic(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent));
  // Windows briefly refuses the rename while another process has the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

/**
 * Cross-process mutex around a read-modify-write. CLI and desktop sessions, the
 * dashboard and the tray app all write the same files; without this, two
 * writers can silently drop each other's change. A lock older than 5 s is
 * treated as abandoned. If the lock can't be had within 2 s we proceed anyway:
 * a hook must never stall the session.
 */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch (err) {
      if (err.code === 'ENOENT') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        continue;
      }
      if (err.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) break;
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (held) fs.rmSync(lock, { recursive: true, force: true });
  }
}

const EVENTS_MAX_BYTES = 4 * 1024 * 1024;
const EVENTS_OLD_PATH = path.join(HOME, 'events.1.jsonl');

export function logEvent(event) {
  try {
    ensureHome();
    try {
      if (fs.statSync(EVENTS_PATH).size > EVENTS_MAX_BYTES) fs.renameSync(EVENTS_PATH, EVENTS_OLD_PATH);
    } catch {
      // no log yet, or another process rotated it first
    }
    fs.appendFileSync(EVENTS_PATH, JSON.stringify({ t: Date.now(), ...event }) + '\n');
  } catch {
    // Never let logging break a hook or the waker.
  }
}

export function readEvents(sinceMs = 0) {
  const out = [];
  for (const file of [EVENTS_OLD_PATH, EVENTS_PATH]) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.t >= sinceMs) out.push(e);
      } catch {
        // a torn line; the log is best-effort
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- validation

/**
 * Validate a settings patch. With `allowNull`, `null` means "clear this key at
 * this scope" (inherit from the scope below).
 */
export function validateSettings(patch, { allowNull = false, globalOnly = true } = {}) {
  const out = {};
  const errors = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!SCOPED_KEYS.includes(key) && !GLOBAL_ONLY_KEYS.includes(key)) {
      errors.push(`unknown setting "${key}"`);
      continue;
    }
    if (GLOBAL_ONLY_KEYS.includes(key) && !globalOnly) {
      errors.push(`"${key}" can only be set globally`);
      continue;
    }
    if (value === null || value === undefined) {
      if (allowNull) out[key] = null;
      else errors.push(`${key} needs a value`);
      continue;
    }
    switch (key) {
      case 'enabled':
        if (typeof value === 'boolean') out.enabled = value;
        else if (value === 'true' || value === 'false') out.enabled = value === 'true';
        else errors.push('enabled must be true or false');
        break;
      case 'warmWhen':
        if (value === 'background-work' || value === 'always') out.warmWhen = value;
        else errors.push('warmWhen must be "background-work" or "always"');
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
      case 'statusline':
        if (['auto', 'wrap-only', 'off'].includes(value)) out.statusline = value;
        else errors.push('statusline must be "auto", "wrap-only" or "off"');
        break;
      case 'dashboardPort':
        if (Number.isInteger(+value) && +value >= 1024 && +value <= 65535) out.dashboardPort = +value;
        else errors.push('dashboardPort must be an integer from 1024 to 65535');
        break;
    }
  }
  return { patch: out, errors };
}

const clean = (layer, opts) => validateSettings(layer || {}, opts).patch;

// ------------------------------------------------------------- config file
//
// config.json holds only what the user set explicitly, per scope:
//   { schema: 2, global: {...}, surfaces: { cli: {...}, desktop: {...} }, projects: { "<folder>": {...} } }
// Session overrides live in the session's own file. Plugin-tab options are a
// separate layer (plugin-options.json, written by the SessionStart hook).
//
// The top-level `enabled: false` / `fallbackCron: false` are NOT settings: they
// are a kill switch read only by processes of cache-warm 0.2 and older (its
// monitors and cron fallback), so an update can't leave old timers running.

const LEGACY_KILL_SWITCH = Object.freeze({
  enabled: false,
  fallbackCron: false,
  _note: 'Settings live under "global", "surfaces" and "projects". The top-level enabled/fallbackCron keys only switch off processes left over from cache-warm 0.2 and older.',
});

export function normProjectPath(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function normalizeConfig(raw) {
  const cfg = { schema: 2, global: clean(raw?.global), surfaces: {}, projects: {} };
  for (const s of SURFACES) {
    const layer = clean(raw?.surfaces?.[s], { globalOnly: false });
    if (Object.keys(layer).length) cfg.surfaces[s] = layer;
  }
  for (const [p, layer] of Object.entries(raw?.projects || {})) {
    const c = clean(layer, { globalOnly: false });
    if (Object.keys(c).length) cfg.projects[normProjectPath(p)] = c;
  }
  return cfg;
}

/** Turn a cache-warm 0.1/0.2 config.json into the v2 layout. Pure. */
export function migrateV1Config(raw) {
  const { engine, fallbackCron, pluginOptions, ...rest } = raw || {};
  const global = clean(rest);
  // Values that merely mirrored the plugin tab belong to the plugin tab, not to an override.
  const fromTab = clean(pluginOptions || {});
  for (const [k, v] of Object.entries(fromTab)) if (global[k] === v) delete global[k];
  return { schema: 2, global, surfaces: {}, projects: {} };
}

export function loadConfigFile() {
  const raw = readJson(CONFIG_PATH, null);
  if (!raw) return normalizeConfig({});
  return raw.schema === 2 ? normalizeConfig(raw) : migrateV1Config(raw);
}

function writeConfigFile(cfg) {
  const out = { schema: 2, global: cfg.global, surfaces: cfg.surfaces, projects: cfg.projects, ...LEGACY_KILL_SWITCH };
  writeJsonAtomic(CONFIG_PATH, out);
}

export function updateConfigFile(mutate) {
  return withLock(CONFIG_PATH, () => {
    const cfg = loadConfigFile();
    mutate(cfg);
    for (const s of Object.keys(cfg.surfaces)) if (!Object.keys(cfg.surfaces[s]).length) delete cfg.surfaces[s];
    for (const p of Object.keys(cfg.projects)) if (!Object.keys(cfg.projects[p]).length) delete cfg.projects[p];
    writeConfigFile(cfg);
    return cfg;
  });
}

// ---------------------------------------------------------------- scopes

/**
 * Scope strings: "global", "cli" | "desktop" | "ide", "project:<folder>",
 * "session:<id>". A project scope covers the folder and everything below it.
 */
export function parseScope(str) {
  const s = String(str || 'global');
  if (s === 'global') return { type: 'global', key: 'global' };
  if (SURFACES.includes(s)) return { type: 'surface', surface: s, key: s };
  if (s.startsWith('surface:') && SURFACES.includes(s.slice(8))) return { type: 'surface', surface: s.slice(8), key: s.slice(8) };
  if (s.startsWith('project:')) {
    const p = normProjectPath(s.slice(8));
    return { type: 'project', path: p, key: `project:${p}` };
  }
  if (s.startsWith('session:')) {
    sessionPath(s.slice(8)); // validates
    return { type: 'session', id: s.slice(8), key: s };
  }
  throw new Error(`unknown scope "${s}" (use global, cli, desktop, ide, project:<folder> or session:<id>)`);
}

/** Set (or with null values, clear) settings at one scope. */
export function setScoped(scopeStr, patch) {
  const scope = parseScope(scopeStr);
  const { patch: valid, errors } = validateSettings(patch, { allowNull: true, globalOnly: scope.type === 'global' });
  if (errors.length) throw new Error(errors.join('; '));
  const apply = (layer = {}) => {
    const next = { ...layer };
    for (const [k, v] of Object.entries(valid)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return next;
  };
  if (scope.type === 'session') {
    if (!loadSession(scope.id)) throw new Error(`unknown session: ${scope.id}`);
    updateSession(scope.id, (s) => ({ ...s, overrides: apply(s.overrides) }));
  } else {
    updateConfigFile((cfg) => {
      if (scope.type === 'global') cfg.global = apply(cfg.global);
      else if (scope.type === 'surface') cfg.surfaces[scope.surface] = apply(cfg.surfaces[scope.surface]);
      else {
        const existing = Object.keys(cfg.projects).find((p) => samePath(p, scope.path)) || scope.path;
        cfg.projects[existing] = apply(cfg.projects[existing]);
      }
    });
  }
  logEvent({ type: 'config', scope: scope.key, patch: valid });
  return scope;
}

/** Drop every setting at one scope, so it inherits everything again. */
export function resetScope(scopeStr) {
  const scope = parseScope(scopeStr);
  const all = Object.fromEntries([...SCOPED_KEYS, ...(scope.type === 'global' ? GLOBAL_ONLY_KEYS : [])].map((k) => [k, null]));
  return setScoped(scope.key, all);
}

/** The configured project folder that contains `cwd` (deepest wins), or null. */
export function findProject(cwd, projects) {
  if (!cwd) return null;
  const c = normProjectPath(cwd);
  let best = null;
  for (const p of Object.keys(projects || {})) {
    const inside = samePath(c, p) || samePath(c.slice(0, p.length + 1), `${p}/`);
    if (inside && (!best || p.length > best.length)) best = p;
  }
  return best;
}

// ------------------------------------------------------------ plugin tab
//
// /plugin -> cache-warm -> configure. Claude Code passes those values to hooks as
// CLAUDE_PLUGIN_OPTION_*; nothing else can see them, so the SessionStart hook
// snapshots them into plugin-options.json for the CLI and dashboard.

const DESKTOP_MODES = {
  'same-as-cli': {},
  off: { enabled: false },
  'background-work': { enabled: true, warmWhen: 'background-work' },
  always: { enabled: true, warmWhen: 'always' },
};

const PLUGIN_OPTIONS = {
  ENABLED: 'enabled',
  WARM_WHEN: 'warmWhen',
  INTERVAL_MINUTES: 'intervalMinutes',
  MAX_IDLE_MINUTES: 'maxIdleMinutes',
  MIN_CONTEXT_TOKENS: 'minContextTokens',
  DASHBOARD_PORT: 'dashboardPort',
  DESKTOP_MODE: 'desktopMode',
  STATUSLINE: 'statusline',
};

/**
 * The plugin tab as stored by Claude Code (~/.claude/settings.json, pluginConfigs),
 * in the same CLAUDE_PLUGIN_OPTION_* shape hooks receive. Lets everything pick up
 * a tab edit right away instead of at the next session start.
 */
export function pluginOptionsFromSettings() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const options = readJson(path.join(dir, 'settings.json'), null)?.pluginConfigs?.['cache-warm@claude-cache-warm']?.options;
  if (!options) return {};
  return Object.fromEntries(Object.entries(options).map(([k, v]) => [`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`, String(v)]));
}

export function pluginTabLayers() {
  const raw = readJson(PLUGIN_OPTIONS_PATH, null)?.raw || {};
  const { desktopMode, ...rest } = raw;
  return { global: clean(rest), desktop: { ...(DESKTOP_MODES[desktopMode] || {}) }, raw };
}

/**
 * Called on SessionStart. A plugin-tab value that changed since the last
 * snapshot was just edited by the user, so it wins: the override it would be
 * hidden behind is dropped. Untouched tab values never clobber CLI/dashboard edits.
 */
export function syncPluginOptions(env = process.env) {
  const raw = {};
  for (const [envKey, key] of Object.entries(PLUGIN_OPTIONS)) {
    const v = env[`CLAUDE_PLUGIN_OPTION_${envKey}`];
    if (v != null && v !== '') raw[key] = v;
  }
  if (!Object.keys(raw).length) return [];
  return withLock(PLUGIN_OPTIONS_PATH, () => {
    const prev = readJson(PLUGIN_OPTIONS_PATH, null)?.raw || {};
    const changed = Object.keys(raw).filter((k) => prev[k] !== raw[k]);
    if (!changed.length) return [];
    // Merge: hook env and settings.json may not list the same keys; a key one source omits is not a change.
    writeJsonAtomic(PLUGIN_OPTIONS_PATH, { raw: { ...prev, ...raw }, seenAt: Date.now() });
    updateConfigFile((cfg) => {
      for (const k of changed) {
        if (k === 'desktopMode') {
          if (cfg.surfaces.desktop) for (const dk of ['enabled', 'warmWhen']) delete cfg.surfaces.desktop[dk];
        } else delete cfg.global[k];
      }
    });
    logEvent({ type: 'plugin_options', changed });
    return changed;
  });
}

// --------------------------------------------------------- effective config

/**
 * Effective settings for a session, most specific scope winning:
 *   session > project folder > surface > global > plugin tab > built-in defaults
 * `sources` says where each value came from.
 */
export function resolveSettings({ surface, cwd, session } = {}, cfg = loadConfigFile(), tab = pluginTabLayers()) {
  const project = findProject(cwd || session?.cwd, cfg.projects);
  const s = surface || session?.surface;
  const layers = [
    ['default', DEFAULTS, true],
    ['plugin tab', tab.global, true],
    ['global', cfg.global, true],
    ['plugin tab (desktop)', s === 'desktop' ? tab.desktop : {}, false],
    [s ? `surface:${s}` : 'surface', s ? cfg.surfaces[s] : {}, false],
    [project ? `project:${project}` : 'project', project ? cfg.projects[project] : {}, false],
    ['session', session?.overrides || {}, false],
  ];
  const values = {};
  const sources = {};
  for (const [name, layer, global] of layers) {
    for (const k of [...SCOPED_KEYS, ...(global ? GLOBAL_ONLY_KEYS : [])]) {
      if (layer?.[k] !== undefined && layer[k] !== null) {
        values[k] = layer[k];
        sources[k] = name;
      }
    }
  }
  return { values, sources, project };
}

// ----------------------------------------------------------------- sessions
//
// Per session, two files:
//   <id>.json        identity, activity clocks, background-work snapshot, overrides
//   <id>.state.json  ping history and the current waker (the sleeping timer)

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function sessionPath(id, kind = 'session') {
  if (!SESSION_ID_RE.test(String(id))) throw new Error(`invalid session id: ${id}`);
  const suffix = { session: '.json', state: '.state.json', monitor: '.monitor.json' }[kind];
  return path.join(SESSIONS_DIR, `${id}${suffix}`);
}

/** Map CLAUDE_CODE_ENTRYPOINT to where the session runs. "headless" sessions are never warmed. */
export function surfaceFromEntrypoint(ep) {
  const e = String(ep || '').toLowerCase();
  if (e.startsWith('sdk')) return 'headless'; // claude -p, Agent SDK
  if (e.includes('desktop')) return 'desktop';
  if (/vscode|jetbrains|cursor|windsurf|ide/.test(e)) return 'ide';
  return 'cli';
}

export function loadSession(id) {
  return readJson(sessionPath(id), null);
}

/** Read-modify-write a session file under its lock. `patch` is an object or a function. */
export function updateSession(id, patch) {
  const file = sessionPath(id);
  return withLock(file, () => {
    const current = readJson(file, null) || { sessionId: id, startedAt: Date.now(), overrides: {} };
    const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
    // `enabled: false` here is the 0.2 kill switch (see LEGACY_KILL_SWITCH); 0.3 uses overrides.enabled.
    const out = { ...next, schema: 2, enabled: false };
    writeJsonAtomic(file, out);
    return out;
  });
}

export function loadState(id) {
  return readJson(sessionPath(id, 'state'), null) || { pingTimes: [], pingsTotal: 0, waker: null };
}

export function updateState(id, mutate) {
  const file = sessionPath(id, 'state');
  return withLock(file, () => {
    const current = readJson(file, null) || { pingTimes: [], pingsTotal: 0, waker: null };
    const next = mutate(current) || current;
    writeJsonAtomic(file, next);
    return next;
  });
}

/** Make any sleeping waker of this session stand down. */
export function supersedeWaker(id, reason) {
  updateState(id, (s) => ({ ...s, waker: s.waker ? { ...s.waker, gen: `superseded:${reason}:${Date.now()}`, status: 'superseded' } : null }));
}

export function listSessions() {
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n))
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

function removeSessionFiles(id) {
  for (const kind of ['session', 'state', 'monitor']) fs.rmSync(sessionPath(id, kind), { force: true });
  fs.rmSync(path.join(SESSIONS_DIR, `${id}.agents`), { recursive: true, force: true });
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Last sign of life: hook activity or the transcript growing. */
export function lastSeen(s) {
  return Math.max(s.endedAt || 0, s.lastHumanAt || s.lastUserActivityAt || 0, s.lastPromptAt || 0, s.lastStopAt || 0, s.startedAt || 0, mtimeMs(s.transcriptPath));
}

/**
 * Drop state of sessions that are over, and of junk registrations (headless
 * helper runs that never wrote a transcript). PIDs get reused on Windows, so a
 * "live" PID alone doesn't keep a session that has been silent for days.
 */
export function pruneSessions(now = Date.now()) {
  for (const s of listSessions()) {
    const seen = lastSeen(s);
    const dead = !!s.endedAt || (s.claudePid ? !pidAlive(s.claudePid) : true);
    const noTranscript = !s.transcriptPath || !fs.existsSync(s.transcriptPath);
    const junk = s.surface === 'headless' || (noTranscript && now - seen > 3600_000);
    if (junk || now - seen > 3 * 86400_000 || (dead && now - seen > 86400_000)) removeSessionFiles(s.sessionId);
  }
}

// ---------------------------------------------------------------- migration

/**
 * One-time upgrade from cache-warm 0.1/0.2. Keeps a backup, moves per-session
 * switches into overrides, removes the cron/monitor bookkeeping and switches off
 * any 0.2 monitor or cron task still running in an open session.
 */
export function ensureMigrated() {
  const raw = readJson(CONFIG_PATH, null);
  if (raw?.schema === 2) return false;
  return withLock(CONFIG_PATH, () => {
    const again = readJson(CONFIG_PATH, null);
    if (again?.schema === 2) return false;
    ensureHome();
    if (again) {
      const backup = path.join(HOME, 'config.v1.backup.json');
      if (!fs.existsSync(backup)) fs.copyFileSync(CONFIG_PATH, backup);
      if (again.pluginOptions && !fs.existsSync(PLUGIN_OPTIONS_PATH)) writeJsonAtomic(PLUGIN_OPTIONS_PATH, { raw: again.pluginOptions, seenAt: Date.now() });
    }
    writeConfigFile(again ? migrateV1Config(again) : normalizeConfig({}));
    for (const s of listSessions()) {
      if (s.schema === 2) continue;
      const overrides = { ...(s.overrides || {}) };
      if (typeof s.enabled === 'boolean') overrides.enabled = s.enabled;
      const { cronArmedAt, lastUserActivityAt, ...rest } = s;
      writeJsonAtomic(sessionPath(s.sessionId), {
        ...rest,
        lastHumanAt: lastUserActivityAt || rest.lastHumanAt || 0,
        overrides: clean(overrides, { globalOnly: false }),
        schema: 2,
        enabled: false,
      });
      fs.rmSync(path.join(SESSIONS_DIR, `${s.sessionId}.agents`), { recursive: true, force: true });
      // Keep the ping history (0.2 kept it next to the monitor's heartbeat).
      const mon = readJson(sessionPath(s.sessionId, 'monitor'), null);
      if (mon?.pingTimes?.length && !fs.existsSync(sessionPath(s.sessionId, 'state'))) {
        writeJsonAtomic(sessionPath(s.sessionId, 'state'), { pingTimes: mon.pingTimes, pingsTotal: mon.pingsTotal || mon.pingTimes.length, waker: null });
      }
    }
    pruneSessions();
    logEvent({ type: 'migrated', from: again ? 'v1' : 'none' });
    return true;
  });
}

// ------------------------------------------------------- background work

const DONE = new Set(['completed', 'complete', 'failed', 'killed', 'cancelled', 'canceled', 'stopped', 'done', 'error']);

/**
 * What the session is waiting on, from Claude Code's own registry (the Stop
 * hook's `background_tasks` and `session_crons`). Monitors are watchers that
 * can run forever, so they don't count; neither do cache-warm's own leftovers.
 */
export function pendingWork(session) {
  const bg = session?.background;
  if (!bg) return { known: false, tasks: [], crons: [], count: 0 };
  const tasks = (bg.tasks || []).filter(
    (t) => !DONE.has(String(t.status || '').toLowerCase()) && t.type !== 'monitor' && !/keep-alive timer|cache-warm/i.test(t.description || ''),
  );
  const crons = (bg.crons || []).filter((c) => !String(c.prompt || '').startsWith('[cache-warm]'));
  return { known: true, tasks, crons, count: tasks.length + crons.length };
}

/** Compact snapshot of a Stop hook's background_tasks/session_crons. */
export function snapshotBackground(input, now = Date.now()) {
  if (!Array.isArray(input?.background_tasks) && !Array.isArray(input?.session_crons)) return null;
  return {
    at: now,
    tasks: (input.background_tasks || []).map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      description: String(t.description || t.command || t.agent_type || t.name || '').slice(0, 120),
    })),
    crons: (input.session_crons || []).map((c) => ({ id: c.id, schedule: c.schedule, recurring: c.recurring, prompt: String(c.prompt || '').slice(0, 120) })),
  };
}

// ------------------------------------------------------------- transcripts

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
        contextTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
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

export function resolveIntervalMinutes(settings, ttl) {
  return settings.intervalMinutes === 'auto' ? AUTO_INTERVAL[ttl] || 4 : settings.intervalMinutes;
}

// ------------------------------------------------------------------- status

const MAX_PINGS_PER_IDLE = 24;

/**
 * Single source of truth for "should this session be pinged, and when".
 * The waker acts on it; the CLI, status line and dashboard only display it.
 */
export function computeStatus({ settings, session, state, usage, now = Date.now(), env = process.env }) {
  const ttl = resolveTtl(usage, env);
  const intervalMinutes = resolveIntervalMinutes(settings, ttl);
  const pingTimes = state?.pingTimes || [];
  const lastPingAt = pingTimes.length ? pingTimes[pingTimes.length - 1] : 0;

  // Activity: a prompt you typed, or a turn that did real work. Keep-alive turns don't count.
  const lastHumanAt = Math.max(session.lastHumanAt || 0, session.lastWorkStopAt || 0, session.startedAt || 0);
  // Any request of the main conversation refreshes its cache, pings included.
  const lastRequestAt = Math.max(session.lastPromptAt || 0, session.lastStopAt || 0, lastPingAt, usage?.timestamp || 0);
  const work = pendingWork(session);
  const pingsSinceActivity = pingTimes.filter((t) => t > lastHumanAt).length;
  const pingCap = settings.maxIdleMinutes > 0 ? Math.min(MAX_PINGS_PER_IDLE, Math.ceil(settings.maxIdleMinutes / intervalMinutes) + 1) : MAX_PINGS_PER_IDLE;
  const turnActive = (session.turnStartedAt || 0) > (session.lastStopAt || 0) && now - session.turnStartedAt < 6 * 3600_000;

  const base = {
    ttl,
    intervalMinutes,
    lastHumanAt,
    lastRequestAt,
    lastPingAt,
    pingsSinceActivity,
    pingsTotal: state?.pingsTotal || 0,
    pingCap,
    work,
    model: usage?.model || null,
    contextTokens: usage?.contextTokens || 0,
    nextPingAt: null,
    warning: intervalMinutes >= TTL_MINUTES[ttl] ? `interval ${intervalMinutes}m is not shorter than the ${ttl} cache TTL` : null,
    ...estimateCosts(usage?.model, usage?.contextTokens, ttl),
  };

  let status;
  if (session.endedAt) status = 'ended';
  else if (!settings.enabled) status = 'off';
  else if (turnActive) status = 'busy'; // the conversation is refreshing its own cache
  else if (settings.warmWhen === 'background-work' && work.count === 0) status = 'no-work';
  else if (base.contextTokens < settings.minContextTokens) status = 'small-context';
  else if (settings.maxIdleMinutes > 0 && now - lastHumanAt > settings.maxIdleMinutes * 60_000) status = 'idle-cap';
  else if (pingsSinceActivity >= pingCap) status = 'ping-cap';
  else if (state?.suspended && state.suspended.at >= lastHumanAt) status = 'suspended'; // pings were missing the cache
  else if (now - lastRequestAt > TTL_MINUTES[ttl] * 60_000) status = 'expired'; // a ping now would be the expensive rewrite
  else status = 'warming';

  if (status === 'warming') base.nextPingAt = lastRequestAt + intervalMinutes * 60_000;
  return { status, due: status === 'warming' && now >= base.nextPingAt, ...base };
}

/** Statuses after which a waker has nothing left to wait for. */
export const FINAL_STATUSES = new Set(['ended', 'expired', 'idle-cap', 'ping-cap', 'suspended']);

/**
 * Did a ping's turn read the conversation from the cache? A hit reads (nearly)
 * everything; a miss had to write it again, i.e. the ping cost a full rebuild.
 */
export function judgePing(usage) {
  const total = (usage?.cacheRead || 0) + (usage?.cacheCreation || 0);
  if (!total) return null;
  return usage.cacheCreation <= total * 0.2 ? 'hit' : 'miss';
}

/** A ping that misses twice in a row stops warming that session until someone is active again. */
export const MISSES_BEFORE_SUSPEND = 2;

/**
 * Called by every waker pass: judge the last ping once its turn shows up in the
 * transcript, end a self-test, suspend a session whose pings keep missing.
 */
export function verifyLastPing(id, session, now = Date.now()) {
  const state = loadState(id);
  const ping = state.lastPing;
  if (!ping || ping.result) return null;
  const usage = readLastUsage(session.transcriptPath);
  if (!usage || usage.timestamp < ping.at - 1000) {
    // give up after 10 minutes: the turn never reached the transcript
    if (now - ping.at > 600_000) updateState(id, (s) => ({ ...s, lastPing: { ...s.lastPing, result: 'unknown' } }));
    return null;
  }
  const result = judgePing(usage) || 'unknown';
  let suspended = false;
  updateState(id, (s) => {
    const misses = result === 'miss' ? (s.consecutiveMisses || 0) + 1 : 0;
    suspended = misses >= MISSES_BEFORE_SUSPEND;
    return {
      ...s,
      lastPing: { ...s.lastPing, result, read: usage.cacheRead, write: usage.cacheCreation },
      consecutiveMisses: misses,
      ...(suspended ? { suspended: { at: now, reason: `${misses} pings in a row missed the cache` } } : {}),
    };
  });
  logEvent({ type: 'ping_result', sessionId: id, surface: session.surface, result, read: usage.cacheRead, write: usage.cacheCreation, ...(suspended ? { suspended: true } : {}) });
  if (session.test) endSelfTest(id, result);
  return result;
}

// ---------------------------------------------------------------- self-test

const TEST_OVERRIDES = { enabled: true, warmWhen: 'always', intervalMinutes: 1, minContextTokens: 0, maxIdleMinutes: 0 };
const TEST_MAX_MS = 15 * 60_000;

/** Ping this session once, a minute after its next turn ends, then put its settings back. */
export function startSelfTest(id, now = Date.now()) {
  const s = loadSession(id);
  if (!s) throw new Error('this session is not registered yet; send one prompt first');
  updateSession(id, (cur) => ({
    ...cur,
    test: { startedAt: now, restore: cur.test ? cur.test.restore : cur.overrides || {} },
    overrides: { ...(cur.test ? cur.test.restore : cur.overrides || {}), ...TEST_OVERRIDES },
    testResult: null,
  }));
  updateState(id, (st) => ({ ...st, suspended: null, consecutiveMisses: 0 }));
  logEvent({ type: 'self_test_start', sessionId: id, surface: s.surface });
}

export function endSelfTest(id, result, now = Date.now()) {
  updateSession(id, (cur) => (cur.test ? { ...cur, overrides: cur.test.restore || {}, test: null, testResult: { at: now, result, surface: cur.surface } } : cur));
  logEvent({ type: 'self_test_end', sessionId: id, result });
}

/** A self-test that never got its ping (session closed, wake failed) must not leave 1-minute pings behind. */
export function expireSelfTest(session, now = Date.now()) {
  if (session?.test && now - session.test.startedAt > TEST_MAX_MS) endSelfTest(session.sessionId, 'no ping within 15 minutes', now);
}

export const WAKER_STALE_MS = 3 * 60_000;

/** Every registered session with its effective settings and status, most recently active first. */
export function sessionViews(now = Date.now(), thisSession = null) {
  const cfg = loadConfigFile();
  const tab = pluginTabLayers();
  return listSessions()
    .filter((s) => s.surface !== 'headless')
    .map((session) => {
      const state = loadState(session.sessionId);
      const { values: settings, sources, project } = resolveSettings({ session }, cfg, tab);
      const usage = readLastUsage(session.transcriptPath);
      const st = computeStatus({ settings, session, state, usage, now });
      // A crashed Claude never fires SessionEnd, so check the process too; PIDs get
      // reused, so a session silent for a day counts as gone whatever its PID says.
      const seen = lastSeen(session);
      const gone = !session.endedAt && ((session.claudePid && !pidAlive(session.claudePid)) || now - seen > 86400_000);
      const w = state.waker;
      const wakerAlive = !!w && w.status === 'sleeping' && now - (w.heartbeatAt || 0) < WAKER_STALE_MS && pidAlive(w.pid);
      return {
        ...session,
        ...st,
        surface: session.surface || 'cli',
        settings,
        sources,
        project,
        status: gone ? 'ended' : st.status,
        nextPingAt: gone ? null : st.nextPingAt,
        waker: w ? { status: w.status, alive: wakerAlive, heartbeatAt: w.heartbeatAt, exitReason: w.exitReason || null } : null,
        lastSeen: seen,
        isThisSession: session.sessionId === thisSession,
      };
    })
    .sort((a, b) => b.lastRequestAt - a.lastRequestAt);
}

// ----------------------------------------------------------------- prompts

export const PING_TEXT =
  '[cache-warm] Keep-alive ping to refresh the prompt cache. Reply with exactly "ok" and nothing else. Do not call tools, do not think, do not comment on this message.';

/** Sent when a scheduled task left behind by cache-warm 0.2 fires. */
export const LEGACY_CRON_CLEANUP =
  '[cache-warm] This scheduled keep-alive task was created by an older cache-warm version and is obsolete: warming now runs from hooks and needs no scheduled task. Do NOT run the command in that prompt. Call CronList, then CronDelete every task whose prompt starts with "[cache-warm]". Then reply with exactly: removed old cache-warm task';

/**
 * Who started this turn. UserPromptSubmit also fires for scheduled tasks,
 * background-task reports and other sessions' messages; only a person typing
 * counts as activity for the idle clock.
 */
export function classifyPrompt(prompt) {
  const p = String(prompt || '').trimStart();
  if (!p) return 'machine';
  if (/^\[cache-warm\] keep-alive: run .*cron-tick/s.test(p)) return 'legacy-cron';
  if (p.startsWith('[cache-warm]')) return 'ping';
  if (/^<(task-notification|teammate-message|cross-session|channel|system-reminder)\b/.test(p)) return 'machine';
  return 'human';
}

// -------------------------------------------------------------------- misc

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
