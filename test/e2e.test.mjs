// End-to-end: real hook + monitor processes against a fake transcript, in a temp CCW_HOME.
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
const transcript = path.join(tmp, 'projects', 'demo', 'sess-1.jsonl');
const env = {
  ...process.env,
  CCW_HOME: home,
  CCW_PROJECTS_DIR: path.join(tmp, 'projects'),
  CLAUDE_PID: String(process.pid),
  CLAUDE_CODE_SESSION_ID: 'sess-1',
  CCW_TICK_MS: '100',
};
delete env.FORCE_PROMPT_CACHING_5M;

const usageLine = (t, { read = 0, write = 0, id, ttl = '1h' }) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: 'sess-1',
    cwd: tmp,
    timestamp: new Date(t).toISOString(),
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? write : 0, ephemeral_5m_input_tokens: ttl === '5m' ? write : 0 },
      },
    },
  }) + '\n';

const hook = (event, extra = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts/hook.mjs')], {
    env,
    input: JSON.stringify({ hook_event_name: event, session_id: 'sess-1', transcript_path: transcript, cwd: tmp, ...extra }),
  });
const ccw = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/ccw.mjs'), ...args], { env, encoding: 'utf8' });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sessionFile = path.join(home, 'sessions', 'sess-1.json');

// Pretend the human walked away `idleMin` minutes ago.
function setIdle(idleMin) {
  const t = Date.now() - idleMin * 60_000;
  fs.writeFileSync(sessionFile, JSON.stringify({ ...readJson(sessionFile), startedAt: t, lastUserActivityAt: t, lastStopAt: t, lastWorkStopAt: t }));
  // The last main-conversation response is what dates the cache, not the file's mtime.
  fs.writeFileSync(transcript, usageLine(t, { write: 80_000, id: 'm1' }));
  fs.rmSync(path.join(home, 'sessions', 'sess-1.monitor.json'), { force: true });
}

async function runMonitor(ms) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/monitor.mjs')], { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, ms));
  child.kill();
  return out.split('\n').filter(Boolean);
}

test.before(() => {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(transcript, usageLine(now, { write: 80_000, id: 'm1' }) + usageLine(now, { write: 80_000, id: 'm1' }));
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('hooks register the session and seed config', () => {
  assert.equal(hook('SessionStart', { source: 'startup' }).status, 0);
  assert.equal(JSON.parse(ccw('status', '--json').stdout).config.warmWhen, 'background-work', 'default policy');
  ccw('when', 'always'); // the next tests exercise the timer itself; the default policy has its own test
  hook('UserPromptSubmit');
  hook('Stop');
  const s = readJson(sessionFile);
  assert.equal(s.claudePid, process.pid);
  assert.ok(s.lastUserActivityAt && s.lastWorkStopAt);
  assert.equal(readJson(path.join(home, 'config.json')).intervalMinutes, 'auto');
});

test('hook never fails the turn, even on garbage input', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/hook.mjs')], { env, input: 'not json' });
  assert.equal(r.status, 0);
});

test('an active session is not pinged', async () => {
  assert.deepEqual(await runMonitor(600), []);
  const st = JSON.parse(ccw('status', '--json').stdout).sessions[0];
  assert.equal(st.status, 'warming');
  assert.equal(st.ttl, '1h');
  assert.equal(st.intervalMinutes, 50);
  assert.equal(st.contextTokens, 80_003);
});

test('an idle session gets exactly one ping, and that ping does not reset the idle clock', async () => {
  setIdle(51);
  const lines = await runMonitor(800);
  assert.equal(lines.length, 1, 'one ping, then wait a full interval');
  assert.match(lines[0], /^\[cache-warm\]/);
  hook('Stop'); // the keep-alive turn finishing
  assert.ok(Date.now() - readJson(sessionFile).lastWorkStopAt > 50 * 60_000, 'ping Stop must not count as human activity');
  assert.match(fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8'), /"type":"ping"/);
});

test('off switch, idle cap, expired cache and per-session pause all stop pings', async () => {
  setIdle(51);
  ccw('off');
  assert.deepEqual(await runMonitor(500), []);
  ccw('on');

  setIdle(55);
  ccw('set', 'maxIdleMinutes', '30');
  assert.deepEqual(await runMonitor(500), []);
  ccw('set', 'maxIdleMinutes', '0');

  setIdle(75); // past the 1h TTL: a ping would be a full-price rewrite
  assert.deepEqual(await runMonitor(500), []);
  assert.equal(JSON.parse(ccw('status', '--json').stdout).sessions[0].status, 'expired');

  setIdle(51);
  assert.equal(ccw('off', '--session').status, 0);
  assert.deepEqual(await runMonitor(500), []);
  ccw('follow');
  assert.equal((await runMonitor(800)).length, 1);
});

test('default policy: an idle session is warmed only while background work is running', async () => {
  const status = () => JSON.parse(ccw('status', '--json').stdout).sessions[0];
  const agentsDir = path.join(home, 'sessions', 'sess-1.agents');
  ccw('when', 'background-work');
  setIdle(51);
  assert.equal(status().status, 'no-work');
  assert.deepEqual(await runMonitor(500), [], 'idle but nothing running: no ping');

  hook('SubagentStart', { agent_id: 'agent-1', agent_type: 'Explore' });
  hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'npm run build', run_in_background: true } });
  hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu2', tool_input: { command: 'ls' } });
  assert.equal(status().agentsRunning, 2, 'subagent + background shell; a foreground command is not work');
  assert.equal(status().status, 'warming');
  assert.equal((await runMonitor(800)).length, 1);

  setIdle(51);
  ccw('off', '--session');
  assert.deepEqual(await runMonitor(500), [], 'per-session pause wins');
  ccw('follow');

  hook('SubagentStop', { agent_id: 'agent-1' });
  assert.equal(status().agentsRunning, 1);
  fs.rmSync(agentsDir, { recursive: true });
  assert.equal(status().status, 'no-work');
  assert.deepEqual(await runMonitor(500), [], 'work finished: stand by again');

  // one session can opt in to always-warm without touching the global default
  assert.equal(ccw('when', 'always', '--session').status, 0);
  assert.equal((await runMonitor(800)).length, 1);
  ccw('follow');
  ccw('when', 'always');
});

test('per-session overrides beat the global settings and can be cleared', async () => {
  setIdle(20);
  assert.deepEqual(await runMonitor(500), [], '20 min idle < 50 min auto interval');
  assert.equal(ccw('interval', '15', '--session=sess').status, 0);
  const st = JSON.parse(ccw('status', '--json').stdout).sessions[0];
  assert.equal(st.intervalMinutes, 15);
  assert.deepEqual(st.overrides, { intervalMinutes: 15 });
  assert.equal((await runMonitor(800)).length, 1);

  assert.notEqual(ccw('set', 'engine', 'cron', '--session').status, 0, 'engine is global only');
  ccw('follow');
  assert.deepEqual(JSON.parse(ccw('status', '--json').stdout).sessions[0].overrides, {});
  assert.equal(readJson(path.join(home, 'config.json')).intervalMinutes, 'auto', 'global untouched');
});

test('config validation rejects nonsense', () => {
  assert.notEqual(ccw('interval', '90').status, 0);
  assert.notEqual(ccw('set', 'engine', 'magic').status, 0);
  assert.equal(ccw('interval', '30').status, 0);
  assert.equal(readJson(path.join(home, 'config.json')).intervalMinutes, 30);
});

test('analytics dedupes repeated usage lines, finds a cold rebuild, and parses incrementally', async () => {
  const t0 = Date.now() - 5 * 3600_000;
  fs.writeFileSync(
    transcript,
    usageLine(t0, { write: 100_000, id: 'a' }) +
      usageLine(t0, { write: 100_000, id: 'a' }) +
      usageLine(t0 + 60_000, { read: 100_000, write: 500, id: 'b' }) +
      usageLine(t0 + 91 * 60_000, { read: 0, write: 101_000, id: 'c' }),
  );
  process.env.CCW_HOME = home;
  process.env.CCW_PROJECTS_DIR = path.join(tmp, 'projects');
  const { computeAnalytics } = await import('../dashboard/analytics.mjs');
  const a = await computeAnalytics({ days: 1 });
  assert.equal(a.totals.requests, 3);
  assert.equal(a.rebuilds.length, 1);
  assert.equal(a.rebuilds[0].tokens, 101_000);
  assert.ok(a.rebuilds[0].warmUsd < a.rebuilds[0].usd);

  fs.appendFileSync(transcript, usageLine(Date.now(), { read: 101_000, write: 200, id: 'd' }));
  assert.equal((await computeAnalytics({ days: 1 })).totals.requests, 4);
});

test('status line wraps an existing one, appends the segment, and uninstalls cleanly', () => {
  const settings = path.join(tmp, 'settings.json');
  const original = { model: 'x', statusLine: { type: 'command', command: 'echo THEIRS', padding: 1 } };
  fs.writeFileSync(settings, JSON.stringify(original));

  assert.equal(ccw('statusline', 'install', `--file=${settings}`).status, 0);
  assert.equal(ccw('statusline', 'install', `--file=${settings}`).status, 0, 'installing twice must not wrap itself');
  const installed = readJson(settings);
  assert.match(installed.statusLine.command, /statusline-launcher\.mjs/);
  assert.equal(installed.statusLine.padding, 1);
  assert.equal(installed.model, 'x');

  const input = JSON.stringify({
    session_id: 'sess-1',
    model: { id: 'claude-opus-5' },
    context_window: { total_input_tokens: 200_000, current_usage: { cache_read_input_tokens: 190_000 } },
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: Math.floor(Date.now() / 1000) + 1800 },
  });
  const run = () => spawnSync(process.execPath, [path.join(home, 'statusline-launcher.mjs')], { env: { ...env, NO_COLOR: '1' }, input, encoding: 'utf8' }).stdout;
  const line = run();
  assert.match(line, /^THEIRS │ /, 'their output first, untouched');
  assert.match(line, /ctx 200\.0k, cached 190\.0k \(95%\)/);
  assert.match(line, /1h cache, (29|30)m \d\ds left/);
  assert.match(line, /warm (on|standby|off|paused)/);

  // a missing plugin must degrade to the user's own status line, not to a blank one
  const state = path.join(home, 'statusline.json');
  fs.writeFileSync(state, JSON.stringify({ ...readJson(state), pluginRoot: path.join(tmp, 'gone') }));
  assert.equal(run().trim(), 'THEIRS');

  assert.equal(ccw('statusline', 'uninstall').status, 0);
  assert.deepEqual(readJson(settings), original);
  assert.ok(!fs.existsSync(path.join(home, 'statusline-launcher.mjs')));
});
