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
  logEvent,
  readEvents,
  readLastUsage,
  saveConfig,
  sessionViews,
  updateSession,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'status', ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const thisSession = process.env.CLAUDE_CODE_SESSION_ID || null;

const HELP = `ccw ${VERSION} - keep Claude Code's prompt cache warm while a session sits idle

  ccw status [--json] [--all]     show config and live sessions
  ccw on  [--session]             enable warming (globally, or only for this session)
  ccw off [--session]             disable warming
  ccw follow                      make this session follow the global switch again
  ccw interval <minutes|auto>     ping interval (auto = ${AUTO_INTERVAL['1h']}m on a 1h cache, ${AUTO_INTERVAL['5m']}m on a 5m cache)
  ccw set <key> <value>           maxIdleMinutes | minContextTokens | engine | dashboardPort
  ccw dashboard [--no-open]       start the web dashboard
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
    `cache-warm: ${config.enabled ? 'ON' : 'OFF'} | interval ${interval} | stop after ${config.maxIdleMinutes || 'never'}${config.maxIdleMinutes ? 'm' : ''} idle | engine ${config.engine}`,
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
        `~$${v.pingUsd.toFixed(4)}/ping`,
        next,
        v.monitorAlive || v.status === 'ended' ? '' : '[no monitor]',
      ].join('  '),
    );
    if (v.warning) console.log(`    warning: ${v.warning}`);
    console.log(`    ${v.cwd || ''}`);
  }
}

const STATUS_HINT = {
  off: 'warming off',
  'small-context': 'context too small to be worth warming',
  'idle-cap': 'idle too long, pings stopped',
  expired: 'cache already expired, not re-writing it',
  ended: 'session ended',
};

function toggle(enabled) {
  if (flags.has('--session')) {
    if (!thisSession || !loadSession(thisSession)) return fail('no registered Claude Code session in this shell');
    updateSession(thisSession, { enabled });
    logEvent({ type: 'config', sessionId: thisSession, patch: { enabled } });
    return console.log(`cache-warm ${enabled ? 'ON' : 'OFF'} for session ${thisSession.slice(0, 8)}`);
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
      if (!thisSession) fail('no Claude Code session in this shell');
      else updateSession(thisSession, { enabled: null }), console.log('this session follows the global switch again');
      break;
    case 'interval':
      if (!positional[0]) fail('usage: ccw interval <minutes|auto>');
      else console.log(`interval: ${saveConfig({ intervalMinutes: positional[0] === 'auto' ? 'auto' : Number(positional[0]) }).intervalMinutes}`);
      break;
    case 'set': {
      const [key, raw] = positional;
      if (!key || raw == null) fail('usage: ccw set <key> <value>');
      else {
        const value = raw === 'true' ? true : raw === 'false' ? false : raw === 'auto' || Number.isNaN(Number(raw)) ? raw : Number(raw);
        console.log(JSON.stringify(saveConfig({ [key]: value }), null, 2));
      }
      break;
    }
    case 'dashboard':
      dashboard();
      break;
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
