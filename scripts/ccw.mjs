#!/usr/bin/env node
// ccw: command-line control for claude-cache-warm.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_INTERVAL,
  HOME,
  PING_TEXT,
  VERSION,
  computeStatus,
  fmtDuration,
  fmtTokens,
  loadConfig,
  loadSession,
  readEvents,
  readLastUsage,
  saveConfig,
  sessionViews,
  setSessionOverrides,
} from './lib.mjs';
import { installStatusline, statuslineStatus, uninstallStatusline } from './statusline-install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'status', ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const thisSession = process.env.CLAUDE_CODE_SESSION_ID || null;

const HELP = `ccw ${VERSION} - keep Claude Code's prompt cache warm while a session sits idle

  ccw status [--json] [--all]     show config and live sessions
  ccw on  [--session]             enable warming (globally, or only for this session)
  ccw off [--session]             disable warming
  ccw when <background-work|always>
                                  background-work (default): warm only while a subagent or background
                                  task is running. always: warm any idle session.
  ccw interval <minutes|auto>     ping interval (auto = ${AUTO_INTERVAL['1h']}m on a 1h cache, ${AUTO_INTERVAL['5m']}m on a 5m cache)
  ccw set <key> <value>           maxIdleMinutes | minContextTokens | engine | dashboardPort
  ccw follow                      drop every per-session override, follow the global settings again

  --session[=<id-prefix>]         apply on/off, when, interval and "set maxIdleMinutes" to one session only
                                  (default: the session this shell belongs to)
  ccw dashboard [--no-open]       start the web dashboard
  ccw statusline install          add a cache segment to the Claude Code status line. An existing status
      [--newline] [--file=<path>] line is kept and wrapped, not replaced (--newline: own row instead of appending)
  ccw statusline uninstall        put the previous status line back exactly as it was
  ccw statusline                  show what is installed
  ccw events [n]                  last n log events (default 20)
  ccw cron                        print the cron schedule + prompt for the CronCreate fallback
  ccw doctor                      check that hooks and the monitor are actually running

State lives in ${HOME}`;

function printStatus() {
  const now = Date.now();
  const config = loadConfig();
  const views = sessionViews(now, thisSession);
  if (flags.has('--json')) return console.log(JSON.stringify({ config, sessions: views, now }, null, 2));

  const interval = config.intervalMinutes === 'auto' ? 'auto' : `${config.intervalMinutes}m`;
  console.log(
    `cache-warm: ${config.enabled ? 'ON' : 'OFF'} | warm ${config.warmWhen === 'always' ? 'any idle session' : 'only while background work runs'} | interval ${interval} | stop after ${config.maxIdleMinutes || 'never'}${config.maxIdleMinutes ? 'm' : ''} idle | engine ${config.engine}`,
  );
  const shown = views.filter((v) => flags.has('--all') || v.status !== 'ended');
  if (!shown.length) return console.log('no live sessions registered yet (hooks register a session on its first prompt)');
  for (const v of shown) {
    const next = v.nextPingAt ? `next ping in ${fmtDuration(v.nextPingAt - now)}` : STATUS_HINT[v.status] || v.status;
    console.log(
      [
        `${v.isThisSession ? '*' : ' '} ${v.sessionId.slice(0, 8)}`,
        v.status.padEnd(13),
        `${fmtTokens(v.contextTokens)} ctx`.padEnd(11),
        `ttl ${v.ttl}`,
        `every ${v.intervalMinutes}m`,
        `idle ${fmtDuration(now - v.lastHumanAt)}`.padEnd(14),
        `${v.pingsSinceUser} pings`,
        v.agentsRunning ? `${v.agentsRunning} background job${v.agentsRunning > 1 ? 's' : ''}` : '',
        `~$${v.pingUsd.toFixed(4)}/ping`,
        next,
        v.monitorAlive || v.status === 'ended' ? '' : '[no monitor]',
      ].join('  '),
    );
    if (v.warning) console.log(`    warning: ${v.warning}`);
    const ov = Object.entries({ ...(v.overrides || {}), ...(v.enabled == null ? {} : { enabled: v.enabled }) });
    if (ov.length) console.log(`    session overrides: ${ov.map(([k, val]) => `${k}=${val}`).join(', ')}`);
    console.log(`    ${v.cwd || ''}`);
  }
}

const STATUS_HINT = {
  off: 'warming off',
  'no-work': 'standing by: no subagent or background task running',
  'small-context': 'context too small to be worth warming',
  'idle-cap': 'idle too long, pings stopped',
  expired: 'cache already expired, not re-writing it',
  ended: 'session ended',
};

// --session (this shell's session) or --session=<id prefix>; null when the flag is absent.
function targetSession() {
  const flag = args.find((a) => a === '--session' || a.startsWith('--session='));
  if (!flag) return null;
  const prefix = flag.split('=')[1];
  if (!prefix) {
    if (!thisSession || !loadSession(thisSession)) throw new Error('no registered Claude Code session in this shell; use --session=<id-prefix>');
    return thisSession;
  }
  const matches = sessionViews().filter((v) => v.sessionId.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `"${prefix}" matches ${matches.length} sessions` : `no session starts with "${prefix}"`);
  return matches[0].sessionId;
}

// Apply a settings patch to one session (as an override) or globally.
function apply(patch) {
  const id = targetSession();
  if (!id) return { scope: 'all sessions', result: saveConfig(patch) };
  return { scope: `session ${id.slice(0, 8)}`, result: setSessionOverrides(id, patch) };
}

function toggle(enabled) {
  const id = targetSession();
  if (id) {
    setSessionOverrides(id, { enabled });
    return console.log(`cache-warm ${enabled ? 'ON' : 'OFF'} for session ${id.slice(0, 8)}`);
  }
  saveConfig({ enabled });
  console.log(`cache-warm ${enabled ? 'ON' : 'OFF'} (all sessions; applies within 5s, no restart needed)`);
}

function cronInfo() {
  const config = loadConfig();
  const usage = thisSession ? readLastUsage(loadSession(thisSession)?.transcriptPath) : null;
  const st = computeStatus({ config, session: loadSession(thisSession) || {}, monitor: null, usage });
  // Cron steps must divide the hour evenly, and recurring tasks fire with jitter,
  // so pick the largest clean step at or below the wanted interval.
  const step = [30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1].find((s) => s <= st.intervalMinutes) || 1;
  console.log(JSON.stringify({ cron: `*/${step} * * * *`, recurring: true, prompt: PING_TEXT, ttl: st.ttl }, null, 2));
}

function doctor() {
  const now = Date.now();
  const events = readEvents(now - 24 * 3600_000);
  const views = sessionViews(now, thisSession).filter((v) => v.status !== 'ended');
  const ok = (cond, msg) => console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  ok(true, `state dir ${HOME}`);
  ok(views.length > 0, `${views.length} live session(s) registered by hooks`);
  ok(views.some((v) => v.monitorAlive), 'a monitor process is heart-beating (needs an interactive CLI session; monitors are experimental)');
  ok(events.some((e) => e.type === 'ping'), `${events.filter((e) => e.type === 'ping').length} ping(s) sent in the last 24h`);
  if (thisSession) ok(!!loadSession(thisSession), `this session (${thisSession.slice(0, 8)}) is registered`);
  if (!views.some((v) => v.monitorAlive)) {
    console.log('\nNo monitor? Use the cron fallback inside the session: /cache-warm:config engine cron');
  }
}

function dashboard() {
  const server = path.join(ROOT, 'dashboard', 'server.mjs');
  const child = spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const url = `http://127.0.0.1:${loadConfig().dashboardPort}/`;
  console.log(`dashboard: ${url}`);
  if (!flags.has('--no-open')) {
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    setTimeout(() => spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(), 600);
  }
}

function fail(msg) {
  console.error(`ccw: ${msg}`);
  process.exitCode = 1;
}

try {
  switch (cmd) {
    case 'status':
      printStatus();
      break;
    case 'on':
      toggle(true);
      break;
    case 'off':
      toggle(false);
      break;
    case 'follow':
      {
        const id = targetSession() || thisSession;
        if (!id) fail('no Claude Code session in this shell; use --session=<id-prefix>');
        else setSessionOverrides(id, { enabled: null, intervalMinutes: null, maxIdleMinutes: null, warmWhen: null }), console.log(`session ${id.slice(0, 8)} follows the global settings again`);
      }
      break;
    case 'when':
      if (!positional[0]) fail('usage: ccw when <background-work|always>');
      else console.log(`warm when: ${positional[0]} (${apply({ warmWhen: positional[0] }).scope})`);
      break;
    case 'interval':
      if (!positional[0]) fail('usage: ccw interval <minutes|auto>');
      else {
        const { scope } = apply({ intervalMinutes: positional[0] === 'auto' ? 'auto' : Number(positional[0]) });
        console.log(`interval ${positional[0]} (${scope})`);
      }
      break;
    case 'set': {
      const [key, raw] = positional;
      if (!key || raw == null) fail('usage: ccw set <key> <value>');
      else {
        const value = raw === 'true' ? true : raw === 'false' ? false : raw === 'auto' || Number.isNaN(Number(raw)) ? raw : Number(raw);
        const { scope } = apply({ [key]: value });
        console.log(`${key} = ${value} (${scope})`);
      }
      break;
    }
    case 'dashboard':
      dashboard();
      break;
    case 'statusline': {
      const fileFlag = args.find((a) => a.startsWith('--file='));
      if (positional[0] === 'install') {
        const r = installStatusline({ file: fileFlag?.slice(7), placement: flags.has('--newline') ? 'newline' : flags.has('--append') ? 'append' : undefined });
        console.log(`status line installed in ${r.settingsFile}`);
        console.log(r.wrapped ? `your existing status line is kept and runs first: ${r.wrapped}` : 'no previous status line was configured');
        if (!r.alreadyInstalled) console.log(`backup: ${r.settingsFile}.ccw-backup   (undo: ccw statusline uninstall)`);
      } else if (positional[0] === 'uninstall') {
        const r = uninstallStatusline();
        console.log(`removed from ${r.settingsFile}; ${r.restored ? `restored: ${r.restored}` : 'no status line configured now'}`);
      } else {
        const s = statuslineStatus();
        console.log(s.installed ? `installed in ${s.settingsFile} (${s.placement})` : 'not installed (ccw statusline install)');
        console.log(s.installed ? `wraps: ${s.wrapped || 'nothing'}` : `current status line: ${s.currentCommand || 'none'}`);
      }
      break;
    }
    case 'events':
      for (const e of readEvents().slice(-(Number(positional[0]) || 20))) {
        const { t, type, ...rest } = e;
        console.log(`${new Date(t).toLocaleString()}  ${type.padEnd(14)} ${JSON.stringify(rest)}`);
      }
      break;
    case 'cron':
      cronInfo();
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
