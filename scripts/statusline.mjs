#!/usr/bin/env node
// Status line segment. Claude Code allows one statusLine command, so instead of
// replacing yours, this runs it (same stdin), prints its output untouched, and
// appends the cache-warm segment.
//
// Speed matters: Claude Code cancels a status line run when the next update
// arrives first, and an empty result blanks the line. So the wrapped command runs
// concurrently with our own work, without an extra shell when it doesn't need
// one, and on timer-only refreshes its last output is reused for a few seconds.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, TTL_MINUTES, computeStatus, fmtDuration, fmtTokens, loadSession, loadState, readJson, resolveSettings, writeJsonAtomic } from './lib.mjs';

const CACHE_DIR = path.join(HOME, 'statusline-cache');
const WRAPPED_REUSE_MS = 15_000;
const WRAPPED_TIMEOUT_MS = 8000;

const C = process.env.NO_COLOR
  ? { dim: '', green: '', yellow: '', red: '', reset: '' }
  : { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };

/** `"C:/x/node.exe" "C:/y/script.js" arg` → ['C:/x/node.exe', ['C:/y/script.js', 'arg']]; null if it needs a shell. */
function simpleCommand(command) {
  if (/[|&;<>()$`\\*?!{}[\]~]/.test(command.replace(/"[^"]*"/g, '""'))) return null;
  const tokens = command.match(/"[^"]*"|\S+/g);
  if (!tokens) return null;
  const [exe, ...rest] = tokens.map((t) => t.replace(/^"(.*)"$/, '$1'));
  return [exe, rest];
}

function runWrapped(command, input) {
  return new Promise((resolve) => {
    const env = { ...process.env, CCW_WRAPPED: '1' };
    const direct = simpleCommand(command);
    // Claude Code runs status line commands through Git Bash on Windows when it is installed; mirror that.
    const sh = process.platform === 'win32' && process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : null;
    let child;
    try {
      child = direct
        ? spawn(direct[0], direct[1], { env, windowsHide: true })
        : sh
          ? spawn(sh, ['-c', command], { env, windowsHide: true })
          : spawn(command, { env, windowsHide: true, shell: true });
    } catch {
      return resolve(null);
    }
    let out = '';
    const timer = setTimeout(() => child.kill(), WRAPPED_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.replace(/\s+$/, ''));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** The parts of the input the wrapped status line plausibly shows. A timer-only refresh leaves them unchanged. */
function signature(data) {
  const cw = data.context_window || {};
  return JSON.stringify([data.session_id, data.model?.id, data.model?.display_name, data.workspace?.current_dir, data.cwd, data.version, data.output_style?.name, data.vim?.mode, cw.total_input_tokens, cw.used_percentage, data.cost?.total_cost_usd]);
}

async function wrappedOutput(install, input, data) {
  const command = install?.wrapped?.command;
  if (!command || process.env.CCW_WRAPPED) return '';
  const sig = signature(data);
  const id = crypto.createHash('sha1').update(`${command}\0${data.session_id || ''}`).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${id}.json`);
  const cached = readJson(file, null);
  if (cached && cached.sig === sig && Date.now() - cached.at < WRAPPED_REUSE_MS) return cached.out;
  const out = await runWrapped(command, input);
  if (out === null || out === '') return cached?.out || ''; // keep showing the last good output rather than nothing
  try {
    writeJsonAtomic(file, { sig, at: Date.now(), out }, 0);
  } catch {
    // cache is an optimisation only
  }
  return out;
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
    const { values: settings } = resolveSettings({ session });
    st = computeStatus({ settings, session, state: loadState(session.sessionId), usage, now });
  }
  const LABEL = {
    warming: [C.green, '●', st?.nextPingAt ? `warm on, ping in ${fmtDuration(Math.max(0, st.nextPingAt - now))}` : 'warm on'],
    busy: [C.green, '●', 'warm on'],
    'no-work': [C.dim, '◌', 'warm standby'],
    off: [C.dim, '○', 'warm off'],
    'idle-cap': [C.yellow, '◌', 'warm paused (idle cap)'],
    'ping-cap': [C.yellow, '◌', 'warm paused (ping cap)'],
    expired: [C.yellow, '◌', 'warm paused (cache expired)'],
    'small-context': [C.dim, '◌', 'warm skipped (small context)'],
  };
  const [color, glyph, text] = (st && LABEL[st.status]) || [C.dim, '○', session ? 'warm off' : 'warm: waiting for first prompt'];
  const jobs = st?.work?.count || 0;
  parts.push(`${color}${glyph}${C.reset} ${text}${jobs ? ` ${C.dim}(${jobs} bg job${jobs > 1 ? 's' : ''})${C.reset}` : ''}`);

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

/** `install` is { wrapped, placement } for the settings file this status line was installed into. */
export async function main(install = {}) {
  const input = readStdin();
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {
    // still run the wrapped status line
  }
  const theirsP = wrappedOutput(install, input, data).catch(() => '');
  let segment = '';
  try {
    segment = buildSegment(data);
  } catch {
    // keep the user's own status line intact whatever happens to ours
  }
  const theirs = await theirsP;
  let out;
  if (!theirs) out = segment;
  else if (!segment) out = theirs;
  else out = theirs + (install.placement === 'newline' ? '\n' : `${C.dim} │ ${C.reset}`) + segment;
  process.stdout.write((out || 'cache-warm') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(readJson(path.join(HOME, 'statusline.json'), {})?.installs?.user || {});
