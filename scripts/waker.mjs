#!/usr/bin/env node
// The Stop hook, registered with `asyncRewake: true`.
//
// Every time a turn ends, Claude Code starts this in the background. It records
// the turn end, then sleeps until one interval after the conversation's last
// request. If by then nothing else has happened and the session should be kept
// warm, it exits with code 2: Claude Code wakes the idle session and shows our
// stderr to Claude, which answers "ok". That one small turn reads the whole
// conversation from the prompt cache and resets its TTL.
//
// Why this design:
//  - It runs the same way in the CLI, the IDE extensions and the Desktop app,
//    because it is an ordinary hook. No plugin monitor, no scheduled task.
//  - The timer restarts on every request: a new prompt supersedes the sleeping
//    waker, and the next Stop starts a fresh one. Nothing fires mid-turn.
//  - Each session has its own waker and its own settings; sessions never steer each other.

const homeArg = process.argv.find((a) => a.startsWith('--home='));
if (homeArg) process.env.CCW_HOME = homeArg.slice(7);

const lib = await import('./lib.mjs');

const POLL_MS = Number(process.env.CCW_POLL_MS) || 20_000;
// Claude Code enforces the hook `timeout` (7200 s in hooks.json) on asyncRewake hooks; leave before it.
const LIFETIME_MS = Number(process.env.CCW_WAKER_LIFETIME_MS) || 110 * 60_000;
const HEARTBEAT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const exit = (code, stderr) =>
  stderr ? process.stderr.write(stderr, () => process.exit(code)) : process.exit(code);

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const id = input.session_id;
  if (!id) return exit(0);
  const surface = lib.surfaceFromEntrypoint(process.env.CLAUDE_CODE_ENTRYPOINT);
  if (surface === 'headless') return exit(0);

  lib.ensureHome();
  lib.ensureMigrated();
  const startedAt = Date.now();

  // 1. Record the end of the turn.
  const state0 = lib.loadState(id);
  const lastPingAt = state0.pingTimes?.[state0.pingTimes.length - 1] || 0;
  const background = lib.snapshotBackground(input, startedAt);
  lib.updateSession(id, (s) => {
    // A turn that only answered our ping is not activity, or pings would keep their own session alive.
    const closesPing = lastPingAt > (s.lastStopAt || 0) && (s.lastHumanAt || 0) < lastPingAt;
    return {
      ...s,
      surface: s.surface || surface,
      entrypoint: s.entrypoint || process.env.CLAUDE_CODE_ENTRYPOINT || '',
      cwd: input.cwd || s.cwd,
      transcriptPath: input.transcript_path || s.transcriptPath,
      claudePid: Number(process.env.CLAUDE_PID) || s.claudePid,
      lastStopAt: startedAt,
      turnStartedAt: 0,
      ...(closesPing ? {} : { lastWorkStopAt: startedAt }),
      ...(background ? { background } : {}),
    };
  });

  // 2. Claim the session's timer slot. A newer prompt or Stop takes it away from us.
  const gen = `${process.pid}.${startedAt}`;
  lib.updateState(id, (s) => ({ ...s, waker: { gen, pid: process.pid, startedAt, heartbeatAt: startedAt, status: 'sleeping', nextPingAt: null } }));
  const stillMine = () => lib.loadState(id).waker?.gen === gen;
  const finish = (reason) => {
    lib.updateState(id, (s) => (s.waker?.gen === gen ? { ...s, waker: { ...s.waker, status: 'done', exitReason: reason, exitedAt: Date.now() } } : s));
    exit(0);
  };

  // 3. Sleep until the ping is due, re-checking as we go.
  let lastBeat = 0; // write a heartbeat (with nextPingAt) on the first pass
  for (;;) {
    const now = Date.now();
    if (!stillMine()) return exit(0);
    const session = lib.loadSession(id);
    if (!session || session.endedAt) return finish('session ended');
    if (session.claudePid && !lib.pidAlive(session.claudePid)) return finish('claude exited');
    if (now - startedAt > LIFETIME_MS) return finish('lifetime');

    const { values: settings } = lib.resolveSettings({ session });
    const st = lib.computeStatus({ settings, session, state: lib.loadState(id), usage: lib.readLastUsage(session.transcriptPath), now });
    if (lib.FINAL_STATUSES.has(st.status)) return finish(st.status);

    if (st.due) {
      let won = false;
      lib.updateState(id, (s) => {
        if (s.waker?.gen !== gen) return s; // superseded at the last moment
        won = true;
        return {
          ...s,
          pingTimes: [...(s.pingTimes || []), now].slice(-200),
          pingsTotal: (s.pingsTotal || 0) + 1,
          waker: { ...s.waker, status: 'pinged', exitedAt: now },
        };
      });
      if (!won) return exit(0);
      lib.logEvent({
        type: 'ping',
        sessionId: id,
        engine: 'rewake',
        surface: session.surface,
        ttl: st.ttl,
        intervalMinutes: st.intervalMinutes,
        idleMs: now - st.lastHumanAt,
        sinceRequestMs: now - st.lastRequestAt,
        work: st.work.count,
        contextTokens: st.contextTokens,
        model: st.model,
        estCostUsd: st.pingUsd,
      });
      return exit(2, lib.PING_TEXT);
    }

    if (now - lastBeat >= HEARTBEAT_MS) {
      lastBeat = now;
      lib.updateState(id, (s) => (s.waker?.gen === gen ? { ...s, waker: { ...s.waker, heartbeatAt: now, status: 'sleeping', lastStatus: st.status, nextPingAt: st.nextPingAt } } : s));
    }
    const untilDue = st.nextPingAt ? st.nextPingAt - now : POLL_MS;
    await sleep(Math.max(250, Math.min(POLL_MS, untilDue)));
  }
}

main().catch((err) => {
  lib.logEvent({ type: 'waker_error', message: String(err?.message || err) });
  exit(0);
});
