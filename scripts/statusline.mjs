#!/usr/bin/env node
// Status line segment. Claude Code allows one statusLine command, so instead of
// replacing yours, this runs it (same stdin), prints its output untouched, and
// appends the cache-warm segment. Must never throw: a broken status line is blank.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, TTL_MINUTES, activeAgents, computeStatus, fmtDuration, fmtTokens, loadConfig, loadMonitorState, loadSession, readJson } from './lib.mjs';

export const STATUSLINE_STATE = path.join(HOME, 'statusline.json');

const C = process.env.NO_COLOR
  ? { dim: '', green: '', yellow: '', red: '', reset: '' }
  : { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };

/** Run the status line command that was configured before ours, with the same input. */
function runWrapped(command, input) {
  if (!command) return '';
  // Claude Code runs status line commands through a POSIX shell where it has one (Git Bash
  // on Windows), so do the same: a command written for bash would not survive cmd.exe.
  const sh = process.platform === 'win32' && process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : null;
  const opts = { input, encoding: 'utf8', timeout: 4000, windowsHide: true, env: { ...process.env, CCW_WRAPPED: '1' } };
  const r = sh ? spawnSync(sh, ['-c', command], opts) : spawnSync(command, { ...opts, shell: true });
  return (r.stdout || '').replace(/\s+$/, '');
}

export function buildSegment(data, now = Date.now()) {
  const cw = data.context_window || {};
  const pc = data.prompt_cache || null;
  const parts = [];

  // 1. Is warming on for this session, and what is it waiting for?
  const session = data.session_id ? loadSession(data.session_id) : null;
  let st = null;
  if (session) {
    const ttl = pc?.ttl || null;
    const usage = {
      model: data.model?.id,
      contextTokens: cw.total_input_tokens || 0,
      ttl,
      // expires_at is exactly one TTL after the last request that touched the cache
      timestamp: pc?.expires_at && ttl ? pc.expires_at * 1000 - TTL_MINUTES[ttl] * 60_000 : 0,
    };
    st = computeStatus({ config: loadConfig(), session, monitor: loadMonitorState(session.sessionId), usage, agents: activeAgents(session.sessionId, now), now });
  }
  const LABEL = {
    warming: [C.green, '●', st?.nextPingAt ? `warm on, ping in ${fmtDuration(Math.max(0, st.nextPingAt - now))}` : 'warm on'],
    'no-work': [C.dim, '◌', 'warm standby'],
    off: [C.dim, '○', 'warm off'],
    'idle-cap': [C.yellow, '◌', 'warm paused (idle cap)'],
    expired: [C.yellow, '◌', 'warm paused (cache expired)'],
    'small-context': [C.dim, '◌', 'warm skipped (small context)'],
  };
  const [color, glyph, text] = (st && LABEL[st.status]) || [C.dim, '○', session ? 'warm off' : 'warm: session not registered yet'];
  parts.push(`${color}${glyph}${C.reset} ${text}${st?.agentsRunning ? ` ${C.dim}(${st.agentsRunning} bg job${st.agentsRunning > 1 ? 's' : ''})${C.reset}` : ''}`);

  // 2. Current tokens, and how many of them came from the cache on the last request.
  if (cw.total_input_tokens) {
    const cached = cw.current_usage?.cache_read_input_tokens;
    const pct = cached != null ? ` ${C.dim}(${Math.round((cached / cw.total_input_tokens) * 100)}%)${C.reset}` : '';
    parts.push(`ctx ${fmtTokens(cw.total_input_tokens)}${cached != null ? `, cached ${fmtTokens(cached)}${pct}` : ''}`);
  }

  // 3. How long until the cache goes cold.
  if (pc) {
    const left = pc.expires_at ? pc.expires_at * 1000 - now : 0;
    if (pc.warm && left > 0) {
      const tight = left < 5 * 60_000 && pc.ttl === '1h';
      parts.push(`${tight ? C.yellow : ''}${pc.ttl} cache, ${fmtDuration(left)} left${tight ? C.reset : ''}`);
    } else if (pc.caching_observed) {
      parts.push(`${C.red}cache cold${C.reset}`);
    }
  }
  return parts.join(`${C.dim} · ${C.reset}`);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function main() {
  const input = readStdin();
  const state = readJson(STATUSLINE_STATE, {}) || {};
  // CCW_WRAPPED guards against wrapping ourselves if settings ever end up pointing in a loop.
  const theirs = process.env.CCW_WRAPPED ? '' : runWrapped(state.wrapped?.command, input);
  let segment = '';
  try {
    segment = buildSegment(JSON.parse(input || '{}'));
  } catch {
    // keep the user's own status line intact whatever happens to ours
  }
  if (!theirs) return process.stdout.write(segment + '\n');
  if (!segment) return process.stdout.write(theirs + '\n');
  const sep = state.placement === 'newline' ? '\n' : `${C.dim} │ ${C.reset}`;
  process.stdout.write(theirs + sep + segment + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
