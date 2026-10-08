#!/usr/bin/env node
// ccw: command-line control for claude-cache-warm.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_INTERVAL,
  DEFAULTS,
  GLOBAL_ONLY_KEYS,
  HOME,
  SCOPED_KEYS,
  SURFACES,
  VERSION,
  ensureMigrated,
  fmtDuration,
  fmtTokens,
  listSessions,
  loadConfigFile,
  loadSession,
  normProjectPath,
  pluginTabLayers,
  readEvents,
  resetScope,
  resolveSettings,
  sessionViews,
  setScoped,
} from './lib.mjs';
import { DEFAULT_REFRESH_SECONDS, installStatusline, statuslineStatus, uninstallStatusline } from './statusline-install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'status', ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const thisSession = process.env.CLAUDE_CODE_SESSION_ID || null;

const HELP = `ccw ${VERSION} - keep Claude Code's prompt cache warm while a session waits

  ccw status [--all] [--json]       live sessions, what each is waiting for, next ping
  ccw config [scope]                effective settings and which scope each one comes from

  ccw on | off [scope]              switch warming on or off
  ccw when <background-work|always> [scope]
                                    background-work (default): only while a subagent, background
                                    task or scheduled task is pending. always: any idle session
  ccw interval <minutes|auto> [scope]
                                    auto = ${AUTO_INTERVAL['1h']} min on a 1-hour cache, ${AUTO_INTERVAL['5m']} min on a 5-minute cache
  ccw set <key> <value> [scope]     ${[...SCOPED_KEYS, ...GLOBAL_ONLY_KEYS].join(' | ')}
  ccw unset <key> [scope]           drop one setting at that scope (inherit it again)
  ccw reset [scope]                 drop every setting at that scope
  ccw scopes                        list every scope that has settings

  scope (default: global)
    --cli | --desktop | --ide       sessions on that surface
    --project[=<folder>]            sessions in that folder or below (default folder: current directory)
    --session[=<id-prefix>]         one session (default: the session this shell belongs to)
  Most specific wins: session > project > surface > global > plugin tab > defaults.

  ccw dashboard [--no-open]         web dashboard: sessions, per-scope settings, analytics
  ccw statusline [install|uninstall] [--newline] [--refresh=<s>] [--file=<settings.json>]
                                    add the cache segment to your status line (wraps, never replaces).
                                    Default: user settings, so every folder gets it; refresh every 5 s
  ccw events [n]                    last n log events (default 20)
  ccw doctor                        health checks

State: ${HOME}`;

// ------------------------------------------------------------------- scopes

function sessionByPrefix(prefix) {
  const matches = listSessions().filter((s) => s.sessionId.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `"${prefix}" matches ${matches.length} sessions` : `no session starts with "${prefix}"`);
  return matches[0].sessionId;
}

/** The scope named by the flags, as a scope string for lib.setScoped. */
function scopeFromFlags() {
  const found = [];
  for (const a of args) {
    if (a === '--session' || a.startsWith('--session=')) {
      const prefix = a.split('=')[1];
      if (prefix) found.push(`session:${sessionByPrefix(prefix)}`);
      else if (thisSession && loadSession(thisSession)) found.push(`session:${thisSession}`);
      else throw new Error('no registered Claude Code session in this shell; use --session=<id-prefix>');
    } else if (a === '--project' || a.startsWith('--project=')) {
      found.push(`project:${normProjectPath(a.includes('=') ? a.slice(a.indexOf('=') + 1) : process.cwd())}`);
    } else if (a.startsWith('--surface=')) {
      found.push(a.slice(10));
    } else if (SURFACES.includes(a.slice(2))) {
      found.push(a.slice(2));
    }
  }
  if (found.length > 1) throw new Error('pick one scope');
  return found[0] || 'global';
}

const describeScope = (s) => (s === 'global' ? 'global' : s.startsWith('session:') ? `session ${s.slice(8, 16)}` : s.startsWith('project:') ? `project ${s.slice(8)}` : `${s} sessions`);

function parseValue(key, raw) {
  if (raw === 'inherit' || raw === 'unset') return null;
  if (key === 'enabled') return raw === 'true' || raw === 'on';
  if (key === 'intervalMinutes' && raw === 'auto') return 'auto';
  if (key === 'warmWhen') return raw;
  return Number(raw);
}

function set(patch) {
  const scope = scopeFromFlags();
  setScoped(scope, patch);
  return describeScope(scope);
}

// ------------------------------------------------------------------- status

const STATUS_HINT = {
  warming: 'warming',
  busy: 'turn in progress',
  off: 'warming off',
  'no-work': 'standing by: nothing running in the background',
  'small-context': 'context too small to be worth warming',
  'idle-cap': 'idle cap reached, pings stopped',
  'ping-cap': 'ping cap reached, pings stopped',
  expired: 'cache already expired, not re-writing it',
  ended: 'session ended',
};

function fmtValue(k, v) {
  if (k === 'intervalMinutes') return v === 'auto' ? `auto (${AUTO_INTERVAL['1h']}m on 1h cache)` : `${v}m`;
  if (k === 'maxIdleMinutes') return v ? `${v}m` : 'never';
  return String(v);
}

function printStatus() {
  const now = Date.now();
  const views = sessionViews(now, thisSession);
  if (flags.has('--json')) return console.log(JSON.stringify({ config: loadConfigFile(), pluginTab: pluginTabLayers().raw, sessions: views, now }, null, 2));
  const g = resolveSettings({});
  console.log(
    `global: ${g.values.enabled ? 'ON' : 'OFF'} | warm ${g.values.warmWhen === 'always' ? 'any idle session' : 'while background work runs'} | interval ${fmtValue('intervalMinutes', g.values.intervalMinutes)} | stop after ${fmtValue('maxIdleMinutes', g.values.maxIdleMinutes)} idle`,
  );
  const shown = views.filter((v) => flags.has('--all') || v.status !== 'ended');
  if (!shown.length) return console.log('no live sessions registered yet (a session registers on its first prompt)');
  for (const v of shown) {
    const next = v.nextPingAt ? `next ping in ${fmtDuration(v.nextPingAt - now)}` : STATUS_HINT[v.status] || v.status;
    console.log(
      [
        `${v.isThisSession ? '*' : ' '} ${v.sessionId.slice(0, 8)}`,
        v.surface.padEnd(7),
        v.status.padEnd(13),
        `${fmtTokens(v.contextTokens)} ctx`.padEnd(11),
        `ttl ${v.ttl}`,
        `every ${v.intervalMinutes}m`,
        `idle ${fmtDuration(now - v.lastHumanAt)}`.padEnd(14),
        `${v.pingsSinceActivity} pings`,
        v.work.count ? `${v.work.count} bg job${v.work.count > 1 ? 's' : ''}` : '',
        `~$${v.pingUsd.toFixed(4)}/ping`,
        next,
      ]
        .filter(Boolean)
        .join('  '),
    );
    const scoped = Object.entries(v.sources).filter(([, src]) => !['default', 'plugin tab', 'global'].includes(src));
    if (scoped.length) console.log(`    scoped: ${scoped.map(([k, src]) => `${k}=${v.settings[k]} (${src})`).join(', ')}`);
    if (v.warning) console.log(`    warning: ${v.warning}`);
    console.log(`    ${v.cwd || ''}`);
  }
}

function printConfig() {
  const scope = scopeFromFlags();
  let ctx = {};
  if (scope.startsWith('session:')) ctx = { session: loadSession(scope.slice(8)) };
  else if (scope.startsWith('project:')) ctx = { cwd: scope.slice(8) };
  else if (SURFACES.includes(scope)) ctx = { surface: scope };
  else if (thisSession && loadSession(thisSession) && !flags.has('--global')) ctx = { session: loadSession(thisSession) };
  const { values, sources, project } = resolveSettings(ctx);
  const label = ctx.session ? `session ${ctx.session.sessionId.slice(0, 8)} (${ctx.session.surface || 'cli'}${project ? `, project ${project}` : ''})` : describeScope(scope);
  console.log(`effective settings for ${label}:`);
  for (const k of [...SCOPED_KEYS, ...GLOBAL_ONLY_KEYS]) console.log(`  ${k.padEnd(17)} ${fmtValue(k, values[k]).padEnd(26)} from ${sources[k]}`);
}

function printScopes() {
  const cfg = loadConfigFile();
  const tab = pluginTabLayers();
  const show = (name, layer) => Object.keys(layer || {}).length && console.log(`${name.padEnd(40)} ${JSON.stringify(layer)}`);
  show('defaults', DEFAULTS);
  show('plugin tab', tab.global);
  show('plugin tab (desktop)', tab.desktop);
  show('global', cfg.global);
  for (const s of SURFACES) show(s, cfg.surfaces[s]);
  for (const [p, layer] of Object.entries(cfg.projects)) show(`project ${p}`, layer);
  for (const s of listSessions()) if (Object.keys(s.overrides || {}).length) show(`session ${s.sessionId.slice(0, 8)} (${s.surface || 'cli'})`, s.overrides);
}

function doctor() {
  const now = Date.now();
  const events = readEvents(now - 24 * 3600_000);
  const views = sessionViews(now, thisSession).filter((v) => v.status !== 'ended');
  const ok = (cond, msg) => console.log(`${cond === null ? 'info' : cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  ok(loadConfigFile().schema === 2, `state dir ${HOME} (config schema 2)`);
  ok(views.length > 0, `${views.length} live session(s) registered`);
  const waiting = views.filter((v) => v.status === 'warming');
  ok(waiting.every((v) => v.waker?.alive), `${waiting.filter((v) => v.waker?.alive).length}/${waiting.length} warming session(s) have a live waker`);
  ok(views.some((v) => v.work.known) || !views.length, 'Claude Code reports background tasks to the Stop hook (needs a recent Claude Code)');
  const pings = events.filter((e) => e.type === 'ping');
  ok(null, `${pings.length} ping(s) in the last 24h (${pings.filter((e) => e.engine === 'rewake').length} from 0.3 wakers)`);
  const legacy = events.filter((e) => e.type === 'legacy_cron_cleanup').length;
  if (legacy) ok(null, `${legacy} leftover 0.2 cron task(s) asked to delete themselves`);
  if (thisSession) ok(!!loadSession(thisSession), `this session (${thisSession.slice(0, 8)}) is registered`);
}

function dashboard() {
  const server = path.join(ROOT, 'dashboard', 'server.mjs');
  const child = spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const url = `http://127.0.0.1:${resolveSettings({}).values.dashboardPort}/`;
  console.log(`dashboard: ${url}`);
  if (!flags.has('--no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    setTimeout(() => spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(), 600);
  }
}

function fail(msg) {
  console.error(`ccw: ${msg}`);
  process.exitCode = 1;
}

try {
  // Settings commands work on the 0.3 layout; status line, events and help don't need it.
  if (!['statusline', 'events', 'help', '--help', '-h', 'cron-tick'].includes(cmd)) ensureMigrated();
  switch (cmd) {
    case 'status':
      printStatus();
      break;
    case 'config':
      printConfig();
      break;
    case 'scopes':
      printScopes();
      break;
    case 'on':
    case 'off':
      console.log(`cache-warm ${cmd.toUpperCase()} (${set({ enabled: cmd === 'on' })})`);
      break;
    case 'when':
      if (!positional[0]) fail('usage: ccw when <background-work|always|inherit> [scope]');
      else console.log(`warm when ${positional[0]} (${set({ warmWhen: parseValue('warmWhen', positional[0]) })})`);
      break;
    case 'interval':
      if (!positional[0]) fail('usage: ccw interval <minutes|auto|inherit> [scope]');
      else console.log(`interval ${positional[0]} (${set({ intervalMinutes: parseValue('intervalMinutes', positional[0]) })})`);
      break;
    case 'set': {
      const [key, raw] = positional;
      if (!key || raw == null) fail('usage: ccw set <key> <value|inherit> [scope]');
      else console.log(`${key} = ${raw} (${set({ [key]: parseValue(key, raw) })})`);
      break;
    }
    case 'unset':
      if (!positional[0]) fail('usage: ccw unset <key> [scope]');
      else console.log(`${positional[0]} now inherited (${set({ [positional[0]]: null })})`);
      break;
    case 'reset':
    case 'follow': {
      // `follow` (0.2) meant "this session follows global again".
      const scope = cmd === 'follow' && !args.length && thisSession ? `session:${thisSession}` : scopeFromFlags();
      resetScope(scope);
      console.log(`cleared every setting at ${describeScope(scope)}; it inherits again`);
      break;
    }
    case 'dashboard':
      dashboard();
      break;
    case 'statusline': {
      const fileFlag = args.find((a) => a.startsWith('--file='));
      const refreshFlag = args.find((a) => a.startsWith('--refresh='));
      if (positional[0] === 'install') {
        const r = installStatusline({
          file: fileFlag?.slice(7),
          placement: flags.has('--newline') ? 'newline' : flags.has('--append') ? 'append' : undefined,
          refreshSeconds: refreshFlag ? Math.max(1, Number(refreshFlag.slice(10)) || DEFAULT_REFRESH_SECONDS) : DEFAULT_REFRESH_SECONDS,
        });
        console.log(`status line installed in ${r.settingsFile}`);
        console.log(r.wrapped ? `your existing status line is kept and runs first: ${r.wrapped}` : 'no previous status line was configured there');
        if (!r.alreadyInstalled) console.log(`backup: ${r.settingsFile}.ccw-backup   (undo: ccw statusline uninstall)`);
        for (const f of r.shadowedBy) console.log(`note: ${f} has its own statusLine, which wins in that folder; add the segment there too with --file="${f}"`);
      } else if (positional[0] === 'uninstall') {
        for (const r of uninstallStatusline({ file: fileFlag?.slice(7) })) console.log(`removed from ${r.settingsFile}; ${r.restored ? `restored: ${r.restored}` : 'no status line configured there now'}`);
      } else {
        const s = statuslineStatus();
        if (!s.installs.length) console.log('not installed (ccw statusline install)');
        for (const i of s.installs) console.log(`${i.active ? 'installed' : 'REMOVED BY SOMETHING ELSE'} in ${i.settingsFile} (${i.placement}); wraps: ${i.wrapped || 'nothing'}`);
        console.log(`in this folder Claude Code uses: ${s.inEffect || 'no status line'}${s.inEffect ? (s.inEffectIsOurs ? ' (includes the cache segment)' : ' (WITHOUT the cache segment)') : ''}`);
      }
      break;
    }
    case 'events':
      for (const e of readEvents().slice(-(Number(positional[0]) || 20))) {
        const { t, type, ...rest } = e;
        console.log(`${new Date(t).toLocaleString()}  ${type.padEnd(18)} ${JSON.stringify(rest)}`);
      }
      break;
    case 'cron-tick':
      // Scheduled tasks created by 0.2 run this. Warming no longer uses them.
      console.log('STOP (cache-warm 0.3 no longer uses scheduled tasks; delete this one)');
      break;
    case 'doctor':
      doctor();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
} catch (err) {
  fail(err.message);
}
