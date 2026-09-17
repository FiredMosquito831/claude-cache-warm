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
  fs.utimesSync(transcript, new Date(t), new Date(t));
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
