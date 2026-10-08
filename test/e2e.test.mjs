// End-to-end: the real hook, waker and CLI processes against fake transcripts in a temp CCW_HOME.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
const home = path.join(tmp, 'home');
const projects = path.join(tmp, 'projects');
const projA = path.join(tmp, 'work', 'alpha');
const projB = path.join(tmp, 'work', 'beta');
fs.mkdirSync(path.join(projA, 'sub'), { recursive: true });
fs.mkdirSync(projB, { recursive: true });

process.env.CCW_HOME = home;
process.env.CCW_PROJECTS_DIR = projects;
const lib = await import('../scripts/lib.mjs');

const baseEnv = { ...process.env, CCW_HOME: home, CCW_PROJECTS_DIR: projects, CLAUDE_PID: String(process.pid), CCW_POLL_MS: '100' };
for (const k of Object.keys(baseEnv)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') || k === 'FORCE_PROMPT_CACHING_5M') delete baseEnv[k];
delete baseEnv.CLAUDE_CODE_SESSION_ID;
delete baseEnv.CLAUDE_CODE_ENTRYPOINT; // the runner may itself be inside a Claude Code session

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sessionFile = (id) => path.join(home, 'sessions', `${id}.json`);
const stateFile = (id) => path.join(home, 'sessions', `${id}.state.json`);
const transcriptOf = (id) => path.join(projects, 'p', `${id}.jsonl`);
const MIN = 60_000;

const usageLine = (id, t, { read = 0, write = 0, msg = `m${t}` } = {}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: id,
    timestamp: new Date(t).toISOString(),
    message: {
      id: msg,
      model: 'claude-opus-5',
      usage: { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } },
    },
  }) + '\n';

/** A session whose last request was `minutesAgo` minutes ago, with a 200k-token context on a 1h cache. */
function writeTranscript(id, minutesAgo) {
  fs.mkdirSync(path.dirname(transcriptOf(id)), { recursive: true });
  fs.writeFileSync(transcriptOf(id), usageLine(id, Date.now() - minutesAgo * MIN, { read: 190_000, write: 10_000 }));
}

function hook(event, id, extra = {}, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/hook.mjs')], {
    env: { ...baseEnv, CLAUDE_CODE_ENTRYPOINT: 'cli', ...env },
    input: JSON.stringify({ hook_event_name: event, session_id: id, transcript_path: transcriptOf(id), cwd: extra.cwd || projA, ...extra }),
    encoding: 'utf8',
  });
}

const ccw = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ccw.mjs'), ...args], { env: baseEnv, encoding: 'utf8', cwd: projA });
const status = (id) => JSON.parse(ccw('status', '--json', '--all').stdout).sessions.find((s) => s.sessionId === id);

/** Pretend the session went quiet `minutes` ago: no prompt, no turn end, no request since. */
function age(id, minutes, { human = minutes } = {}) {
  const t = Date.now() - minutes * MIN;
  const h = Date.now() - human * MIN;
  lib.updateSession(id, (s) => ({ ...s, startedAt: h, lastHumanAt: h, lastWorkStopAt: h, lastPromptAt: t, lastStopAt: t, turnStartedAt: 0 }));
  // An earlier ping is a request too; drop the ones newer than the pretend quiet time.
  lib.updateState(id, (st) => ({ ...st, pingTimes: (st.pingTimes || []).filter((p) => p < t) }));
  writeTranscript(id, minutes);
}

/**
 * Run the waker as Claude Code would on Stop. `whileSleeping` runs once it has
 * claimed its slot (e.g. to age the session or to start a new turn).
 */
function runWaker(id, { background = [], crons = [], env = {}, whileSleeping, lifetimeMs = 4000, entrypoint = 'cli' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/waker.mjs')], {
      env: { ...baseEnv, CLAUDE_CODE_ENTRYPOINT: entrypoint, CCW_WAKER_LIFETIME_MS: String(lifetimeMs), ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: id, transcript_path: transcriptOf(id), cwd: projA, stop_hook_active: false, background_tasks: background, session_crons: crons }));
    if (whileSleeping) {
      const iv = setInterval(() => {
        try {
          if (readJson(stateFile(id)).waker?.status === 'sleeping') {
            clearInterval(iv);
            whileSleeping();
          }
        } catch {
          // not written yet
        }
      }, 20);
      child.on('exit', () => clearInterval(iv));
    }
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

const RUNNING_AGENT = [{ id: 'a1', type: 'subagent', status: 'running', description: 'long research', agent_type: 'Explore' }];

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('migrates a 0.2 state dir: backup, kill switch, overrides, no engine', () => {
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ enabled: true, intervalMinutes: 50, maxIdleMinutes: 70, minContextTokens: 1000, warmWhen: 'background-work', engine: 'cron', fallbackCron: false, dashboardPort: 6769, pluginOptions: { intervalMinutes: '50', maxIdleMinutes: '70', dashboardPort: '6769' } }),
  );
  const recent = Date.now() - 10 * MIN;
  fs.writeFileSync(sessionFile('old-1'), JSON.stringify({ sessionId: 'old-1', enabled: true, cronArmedAt: 123, lastUserActivityAt: recent, startedAt: recent, cwd: projA, transcriptPath: transcriptOf('old-1'), claudePid: process.pid }));
  fs.writeFileSync(path.join(home, 'sessions', 'old-1.monitor.json'), JSON.stringify({ pingTimes: [recent], pingsTotal: 7 }));
  // junk from 0.2: a headless helper run that never wrote a transcript
  fs.writeFileSync(sessionFile('junk-1'), JSON.stringify({ sessionId: 'junk-1', startedAt: Date.now() - 5 * 86400_000, claudePid: process.pid, transcriptPath: path.join(tmp, 'nope.jsonl') }));
  writeTranscript('old-1', 10);
  writeTranscript('s1', 0);
  assert.equal(hook('SessionStart', 's1', { source: 'startup' }).status, 0);

  const cfg = readJson(path.join(home, 'config.json'));
  assert.equal(cfg.schema, 2);
  assert.equal(cfg.enabled, false, 'top-level kill switch for 0.2 monitors/cron');
  assert.equal(cfg.fallbackCron, false);
  assert.equal(cfg.engine, undefined);
  assert.deepEqual(cfg.global, { enabled: true, minContextTokens: 1000, warmWhen: 'background-work' }, 'values that mirrored the plugin tab move back to the plugin tab');
  assert.ok(fs.existsSync(path.join(home, 'config.v1.backup.json')));
  assert.equal(readJson(path.join(home, 'plugin-options.json')).raw.intervalMinutes, '50');

  const old = readJson(sessionFile('old-1'));
  assert.deepEqual(old.overrides, { enabled: true });
  assert.equal(old.enabled, false, 'per-session kill switch for 0.2 monitors');
  assert.equal(old.cronArmedAt, undefined);
  assert.equal(old.lastHumanAt, recent);
  assert.equal(readJson(stateFile('old-1')).pingsTotal, 7, 'ping history carried over');
  assert.ok(!fs.existsSync(sessionFile('junk-1')), 'junk registrations are pruned even when their PID is reused');

  const s1 = readJson(sessionFile('s1'));
  assert.equal(s1.surface, 'cli');
  ccw('set', 'minContextTokens', '0'); // fake transcripts are small
});

test('headless runs (claude -p, Agent SDK) are never registered', () => {
  hook('SessionStart', 'headless-1', { source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  hook('UserPromptSubmit', 'headless-1', { prompt: 'hi' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.ok(!fs.existsSync(sessionFile('headless-1')));
});

test('scopes: session > project > surface > global > plugin tab > default', () => {
  writeTranscript('desk-1', 0);
  writeTranscript('cli-1', 0);
  hook('SessionStart', 'desk-1', { source: 'startup', cwd: path.join(projA, 'sub') }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p' });
  hook('SessionStart', 'cli-1', { source: 'startup', cwd: projB });
  assert.equal(readJson(sessionFile('desk-1')).surface, 'desktop');

  assert.equal(status('desk-1').settings.intervalMinutes, 50, 'plugin tab value');
  assert.equal(status('desk-1').sources.intervalMinutes, 'plugin tab');

  assert.equal(ccw('interval', '40').status, 0); // global
  assert.equal(ccw('interval', '30', '--desktop').status, 0);
  assert.equal(ccw('interval', '20', `--project=${projA}`).status, 0);
  assert.equal(status('cli-1').settings.intervalMinutes, 40, 'CLI session in another folder: global');
  assert.equal(status('desk-1').settings.intervalMinutes, 20, 'project wins over surface, and covers subfolders');
  assert.match(status('desk-1').sources.intervalMinutes, /^project:/);

  assert.equal(ccw('interval', '10', '--session=desk').status, 0);
  assert.equal(status('desk-1').settings.intervalMinutes, 10);
  assert.equal(status('cli-1').settings.intervalMinutes, 40, 'a session override never leaks');

  assert.equal(ccw('reset', '--session=desk').status, 0);
  assert.equal(ccw('reset', `--project=${projA}`).status, 0);
  assert.equal(status('desk-1').settings.intervalMinutes, 30, 'back to the desktop surface');
  assert.equal(status('cli-1').settings.intervalMinutes, 40, 'desktop settings never touch CLI sessions');

  assert.notEqual(ccw('set', 'dashboardPort', '5000', '--desktop').status, 0, 'dashboardPort is global only');
  assert.notEqual(ccw('interval', '90').status, 0);
  assert.notEqual(ccw('when', 'sometimes').status, 0);
  ccw('reset', '--desktop');
  ccw('unset', 'intervalMinutes');
  assert.equal(status('cli-1').sources.intervalMinutes, 'plugin tab');
});

test('plugin-tab edits win once, then CLI/dashboard edits are not clobbered', () => {
  const start = (opts) => hook('SessionStart', 'cli-1', { source: 'clear', cwd: projB }, Object.fromEntries(Object.entries(opts).map(([k, v]) => [`CLAUDE_PLUGIN_OPTION_${k}`, v])));
  start({ INTERVAL_MINUTES: '50', MAX_IDLE_MINUTES: '70', DASHBOARD_PORT: '6769' }); // same as snapshot: nothing changes
  ccw('interval', '25');
  start({ INTERVAL_MINUTES: '50', MAX_IDLE_MINUTES: '70', DASHBOARD_PORT: '6769' });
  assert.equal(status('cli-1').settings.intervalMinutes, 25, 'unchanged tab must not undo the global edit');
  start({ INTERVAL_MINUTES: '45', MAX_IDLE_MINUTES: '70', DASHBOARD_PORT: '6769' });
  assert.equal(status('cli-1').settings.intervalMinutes, 45, 'the tab was edited: it wins');
  assert.equal(status('cli-1').sources.intervalMinutes, 'plugin tab');

  start({ INTERVAL_MINUTES: '50', MAX_IDLE_MINUTES: '70', DASHBOARD_PORT: '6769', DESKTOP_MODE: 'off' });
  assert.equal(status('desk-1').settings.enabled, false, 'plugin tab: desktop off');
  assert.equal(status('cli-1').settings.enabled, true, 'CLI unaffected');
  start({ INTERVAL_MINUTES: '50', MAX_IDLE_MINUTES: '70', DASHBOARD_PORT: '6769', DESKTOP_MODE: 'same-as-cli' });
  assert.equal(status('desk-1').settings.enabled, true);
});

test('only a person typing resets the idle clock; old cron tasks are told to delete themselves', () => {
  hook('UserPromptSubmit', 'cli-1', { prompt: 'hello', cwd: projB });
  const human = readJson(sessionFile('cli-1')).lastHumanAt;
  assert.ok(Date.now() - human < 5000);

  for (const prompt of ['<task-notification><task-id>x</task-id></task-notification>', '[cache-warm] Keep-alive ping to refresh the prompt cache.', '']) {
    hook('UserPromptSubmit', 'cli-1', { prompt, cwd: projB });
    assert.equal(readJson(sessionFile('cli-1')).lastHumanAt, human, `not human: ${JSON.stringify(prompt.slice(0, 20))}`);
  }

  const legacy = hook('UserPromptSubmit', 'cli-1', { cwd: projB, prompt: '[cache-warm] keep-alive: run `node "C:/x/scripts/ccw.mjs" cron-tick cli-1` with Bash. If it prints STOP, call CronList and CronDelete...' });
  const out = JSON.parse(legacy.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /CronDelete every task whose prompt starts with "\[cache-warm\]"/);
  assert.equal(readJson(sessionFile('cli-1')).lastHumanAt, human);
  assert.match(ccw('cron-tick', 'cli-1').stdout, /^STOP/);
});

test('waker: nothing pending in the background means no ping (default policy)', async () => {
  age('cli-1', 51);
  const r = await runWaker('cli-1', { whileSleeping: () => age('cli-1', 51), lifetimeMs: 1200 });
  assert.equal(r.code, 0);
  assert.equal(status('cli-1').status, 'no-work');
});

test('waker: pings once the conversation has been silent for a full interval, while work is pending', async () => {
  ccw('interval', 'auto'); // 50 min on a 1h cache
  writeTranscript('cli-1', 0);
  // Waker starts at a fresh turn end: not due yet. Then pretend 51 minutes passed.
  const r = await runWaker('cli-1', { background: RUNNING_AGENT, whileSleeping: () => age('cli-1', 51, { human: 60 }) });
  assert.equal(r.code, 2, 'exit 2 wakes Claude');
  assert.match(r.stderr, /^\[cache-warm\] Keep-alive ping/);
  const st = readJson(stateFile('cli-1'));
  assert.equal(st.pingsTotal, 1);
  assert.equal(st.waker.status, 'pinged');
  const ev = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.type === 'ping');
  assert.equal(ev.at(-1).engine, 'rewake');
  assert.equal(ev.at(-1).work, 1);
});

test("waker: the ping's own turn end is not activity", async () => {
  const humanBefore = readJson(sessionFile('cli-1')).lastWorkStopAt;
  // Claude answered "ok": that Stop starts a new waker; supersede it right away.
  const r = await runWaker('cli-1', { background: RUNNING_AGENT, whileSleeping: () => hook('UserPromptSubmit', 'cli-1', { prompt: 'next thing', cwd: projB }) });
  assert.equal(r.code, 0);
  const s = readJson(sessionFile('cli-1'));
  assert.equal(s.lastWorkStopAt, humanBefore, 'closing a ping must not reset the idle clock');
});

test('waker: a new prompt makes the sleeping timer stand down (timer restarts on every request)', async () => {
  writeTranscript('cli-1', 0);
  let superseded = false;
  const r = await runWaker('cli-1', {
    background: RUNNING_AGENT,
    whileSleeping: () => {
      hook('UserPromptSubmit', 'cli-1', { prompt: 'still here', cwd: projB });
      superseded = true;
      age('cli-1', 51); // even if it now looked due, the timer is no longer this waker's
    },
  });
  assert.ok(superseded);
  assert.equal(r.code, 0);
  assert.equal(readJson(stateFile('cli-1')).pingsTotal, 1, 'no extra ping');
});

test('waker: idle cap, ping cap and an already-expired cache all end the timer without pinging', async () => {
  ccw('set', 'maxIdleMinutes', '70');
  let r = await runWaker('cli-1', { background: RUNNING_AGENT, whileSleeping: () => age('cli-1', 51, { human: 80 }) });
  assert.equal(r.code, 0);
  assert.equal(readJson(stateFile('cli-1')).waker.exitReason, 'idle-cap');

  r = await runWaker('cli-1', { background: RUNNING_AGENT, whileSleeping: () => age('cli-1', 75, { human: 75 }) });
  assert.equal(r.code, 0);
  assert.match(readJson(stateFile('cli-1')).waker.exitReason, /idle-cap|expired/);

  ccw('set', 'maxIdleMinutes', '0');
  r = await runWaker('cli-1', { background: RUNNING_AGENT, whileSleeping: () => age('cli-1', 75, { human: 75 }) });
  assert.equal(r.code, 0);
  assert.equal(readJson(stateFile('cli-1')).waker.exitReason, 'expired', 'a ping now would be the expensive rewrite');

  // ping cap: with a 10-minute idle cap and interval 4, at most ceil(10/4)+1 = 4 pings per idle stretch
  ccw('set', 'maxIdleMinutes', '10');
  ccw('interval', '4', '--session=cli-1');
  r = await runWaker('cli-1', {
    background: RUNNING_AGENT,
    whileSleeping: () => {
      age('cli-1', 5, { human: 6 });
      const now = Date.now();
      lib.updateState('cli-1', (st) => ({ ...st, pingTimes: [now - 4 * MIN, now - 3 * MIN, now - 2 * MIN, now - 1000] }));
    },
  });
  assert.equal(r.code, 0);
  assert.equal(readJson(stateFile('cli-1')).waker.exitReason, 'ping-cap');
  ccw('reset', '--session=cli-1');
  ccw('set', 'maxIdleMinutes', '0');
});

test('sessions are isolated: a desktop-only setting warms the desktop session and leaves CLI alone', async () => {
  ccw('when', 'always', '--desktop');
  ccw('off', '--cli');
  const [desk, cli] = await Promise.all([
    runWaker('desk-1', { entrypoint: 'claude-desktop-3p', whileSleeping: () => age('desk-1', 51) }),
    runWaker('cli-1', { lifetimeMs: 1500, whileSleeping: () => age('cli-1', 51) }),
  ]);
  assert.equal(desk.code, 2, 'desktop: always, so it pings without background work');
  assert.equal(cli.code, 0, 'CLI: off');
  assert.equal(status('cli-1').status, 'off');
  ccw('reset', '--desktop');
  ccw('reset', '--cli');
});

test('inside a session, an unscoped change stays on that surface; --global is explicit', () => {
  const inDesktop = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ccw.mjs'), ...a], { env: { ...baseEnv, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p' }, encoding: 'utf8', cwd: projA });
  const r = inDesktop('off');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /desktop sessions; only desktop sessions, use --global for all/);
  assert.equal(status('desk-1').settings.enabled, false);
  assert.equal(status('cli-1').settings.enabled, true, 'a desktop session must not switch off CLI sessions');
  assert.equal(readJson(path.join(home, 'config.json')).global.enabled ?? true, true);
  inDesktop('reset');
  assert.equal(status('desk-1').settings.enabled, true);
  assert.equal(inDesktop('off', '--global').status, 0);
  assert.equal(status('cli-1').settings.enabled, false, '--global reaches every surface');
  ccw('unset', 'enabled');
  assert.equal(status('cli-1').settings.enabled, true);
});

test('the config file survives concurrent writers (no lost updates)', async () => {
  const runs = Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'scripts/ccw.mjs'), 'interval', String(10 + i), `--project=${path.join(tmp, 'p' + i)}`], { env: baseEnv });
      c.on('exit', resolve);
    }),
  );
  await Promise.all(runs);
  const cfg = readJson(path.join(home, 'config.json'));
  assert.equal(Object.keys(cfg.projects).length, 8, JSON.stringify(Object.keys(cfg.projects)));
  for (let i = 0; i < 8; i++) ccw('reset', `--project=${path.join(tmp, 'p' + i)}`);
});

test('status line: wraps without replacing, refreshes every 5 s, several installs, clean uninstall', () => {
  const userCfg = path.join(tmp, 'claude-config');
  fs.mkdirSync(userCfg, { recursive: true });
  const user = path.join(userCfg, 'settings.json');
  const local = path.join(projA, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const userOriginal = { model: 'x', statusLine: { type: 'command', command: 'echo USERLINE', padding: 1 } };
  const localOriginal = { statusLine: { type: 'command', command: 'echo LOCALLINE' } };
  fs.writeFileSync(user, JSON.stringify(userOriginal));
  fs.writeFileSync(local, JSON.stringify(localOriginal));
  const env = { ...baseEnv, CLAUDE_CONFIG_DIR: userCfg };
  const sl = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ccw.mjs'), 'statusline', ...a], { env, encoding: 'utf8', cwd: projA });

  const r = sl('install');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /settings\.local\.json has its own statusLine/, 'warns about the folder-level line that would hide it');
  assert.equal(sl('install').status, 0, 'installing twice must not wrap itself');
  assert.equal(sl('install', `--file=${local}`).status, 0);
  const installed = readJson(user);
  assert.equal(installed.statusLine.refreshInterval, 5);
  assert.equal(installed.statusLine.padding, 1);
  assert.equal(installed.model, 'x');

  const input = JSON.stringify({
    session_id: 'cli-1',
    model: { id: 'claude-opus-5' },
    context_window: { total_input_tokens: 200_000, current_usage: { cache_read_input_tokens: 190_000 } },
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: Math.floor(Date.now() / 1000) + 1800 },
  });
  const runCmd = (file) => {
    const cmd = readJson(file).statusLine.command;
    const args = cmd.match(/"[^"]*"|\S+/g).map((t) => t.replace(/^"(.*)"$/, '$1'));
    return spawnSync(args[0], args.slice(1), { env: { ...env, NO_COLOR: '1' }, input, encoding: 'utf8' }).stdout;
  };
  const u = runCmd(user);
  assert.match(u, /^USERLINE │ /, 'their output first, untouched');
  assert.match(u, /ctx 200\.0k, cached 190\.0k \(95%\)/);
  assert.match(u, /1h cache, (29|30)m \d\ds left/);
  assert.match(runCmd(local), /^LOCALLINE │ /, 'each install wraps its own command');

  const state = path.join(home, 'statusline.json');
  fs.writeFileSync(state, JSON.stringify({ ...readJson(state), pluginRoot: path.join(tmp, 'gone') }));
  assert.equal(runCmd(user).trim(), 'USERLINE', 'a missing plugin degrades to the user status line');

  assert.equal(sl('uninstall').status, 0);
  assert.deepEqual(readJson(user), userOriginal);
  assert.deepEqual(readJson(local), localOriginal);
  assert.ok(!fs.existsSync(path.join(home, 'statusline-launcher.mjs')));
});

test('analytics dedupes repeated usage lines, finds a cold rebuild, and parses incrementally', async () => {
  const t0 = Date.now() - 5 * 3600_000;
  const file = transcriptOf('an-1');
  fs.writeFileSync(
    file,
    usageLine('an-1', t0, { write: 100_000, msg: 'a' }) +
      usageLine('an-1', t0, { write: 100_000, msg: 'a' }) +
      usageLine('an-1', t0 + MIN, { read: 100_000, write: 500, msg: 'b' }) +
      usageLine('an-1', t0 + 91 * MIN, { read: 0, write: 101_000, msg: 'c' }),
  );
  const { computeAnalytics } = await import('../dashboard/analytics.mjs');
  const a = await computeAnalytics({ days: 1 });
  const mine = a.rebuilds.filter((r) => r.sessionId === 'an-1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].tokens, 101_000);
  const before = a.totals.requests;
  fs.appendFileSync(file, usageLine('an-1', Date.now(), { read: 101_000, write: 200, msg: 'd' }));
  assert.equal((await computeAnalytics({ days: 1 })).totals.requests, before + 1);
});
