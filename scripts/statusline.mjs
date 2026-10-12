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
import { DEFAULT_STATUS_SEGMENTS, HOME, TTL_MINUTES, computeStatus, fmtDuration, fmtTokens, loadSession, loadState, readJson, resolveSettings, writeJsonAtomic } from './lib.mjs';

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

const SEP = `${C.dim} │ ${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

/** Model for the status line: Claude Code's display name, else derived from the model id (claude-opus-5-5 → Opus 5.5). */
export function modelName(data) {
  const m = data.model || {};
  if (m.display_name) return m.display_name;
  const parts = String(m.id || '').replace(/^claude-/, '').split('-');
  if (!parts[0]) return 'Claude';
  const family = parts[0][0].toUpperCase() + parts[0].slice(1);
  const version = parts.slice(1).filter((p) => /^\d{1,2}$/.test(p)).join('.');
  return version ? `${family} ${version}` : family;
}

const trimSlashes = (p) => String(p).replace(/[\\/]+$/, '');
const sameDir = (a, b) => trimSlashes(a).replace(/\\/g, '/').toLowerCase() === trimSlashes(b).replace(/\\/g, '/').toLowerCase();

/** The folder you are in; when that is below the folder Claude Code was launched from, shows "project › subfolder". */
export function folderLabel(data) {
  const cur = data.workspace?.current_dir || data.cwd;
  if (!cur) return null;
  const here = path.basename(trimSlashes(cur)) || cur;
  const launch = data.workspace?.project_dir;
  if (launch && !sameDir(launch, cur)) return `${path.basename(trimSlashes(launch)) || launch} › ${here}`;
  return here;
}

/** Git branch from .git/HEAD, walking up from `dir` (handles worktrees). Reads files only, no git process. */
export function readBranch(dir) {
  let d = dir ? String(dir) : null;
  for (let i = 0; d && i < 12; i++) {
    const dotgit = path.join(d, '.git');
    let head = null;
    try {
      if (fs.statSync(dotgit).isDirectory()) head = path.join(dotgit, 'HEAD');
      else {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (m) head = path.join(path.resolve(d, m[1].trim()), 'HEAD');
      }
    } catch {
      // no .git here
    }
    if (head) {
      try {
        const text = fs.readFileSync(head, 'utf8').trim();
        const ref = text.match(/^ref: refs\/heads\/(.+)$/);
        if (ref) return ref[1];
        if (/^[0-9a-f]{40}$/.test(text)) return text.slice(0, 7); // detached HEAD
      } catch {
        return null;
      }
      return null;
    }
    const up = path.dirname(d);
    d = up === d ? null : up;
  }
  return null;
}

const pctColor = (pct, warnAt, dangerAt) => (pct >= dangerAt ? C.red : pct >= warnAt ? C.yellow : '');
const fmtWindow = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

function modelPart(data) {
  const effort = data.effort?.level;
  return `${modelName(data)}${effort ? `${dim(` · ${effort}`)}` : ''}`;
}

function prPart(pr) {
  if (!pr?.number) return null;
  const state = pr.review_state ? String(pr.review_state).replace(/_/g, ' ') : '';
  const color = pr.review_state === 'approved' ? C.green : pr.review_state === 'changes_requested' ? C.red : C.yellow;
  return `PR #${pr.number}${state ? ` ${color}${state}${C.reset}` : ''}`;
}

function warmPart(session, st, now) {
  if (!session) return `${C.dim}○${C.reset} warm: waiting for first prompt`;
  const LABEL = {
    warming: [C.green, '●', st?.nextPingAt ? `warm on, ping in ${fmtDuration(Math.max(0, st.nextPingAt - now))}` : 'warm on'],
    busy: [C.green, '●', 'warm on'],
    'no-work': [C.dim, '◌', 'warm standby'],
    off: [C.dim, '○', 'warm off'],
    'idle-cap': [C.yellow, '◌', 'warm paused (idle cap)'],
    'ping-cap': [C.yellow, '◌', 'warm paused (ping cap)'],
    suspended: [C.red, '◌', 'warm suspended (pings missed the cache)'],
    expired: [C.yellow, '◌', 'warm paused (cache expired)'],
    'small-context': [C.dim, '◌', 'warm skipped (small context)'],
  };
  if (session.test) LABEL.warming[2] = `self-test: ping in ${st?.nextPingAt ? fmtDuration(Math.max(0, st.nextPingAt - now)) : 'a minute after this turn'}`;
  const [color, glyph, text] = (st && LABEL[st.status]) || [C.dim, '○', 'warm off'];
  const jobs = st?.work?.count || 0;
  return `${color}${glyph}${C.reset} ${text}${jobs ? ` ${C.dim}(${jobs} bg job${jobs > 1 ? 's' : ''})${C.reset}` : ''}`;
}

function contextPart(cw) {
  if (!cw.total_input_tokens) return null;
  const cached = cw.current_usage?.cache_read_input_tokens;
  const pct = cached != null ? ` ${C.dim}(${Math.round((cached / cw.total_input_tokens) * 100)}%)${C.reset}` : '';
  return `ctx ${fmtTokens(cw.total_input_tokens)}${cached != null ? `, cached ${fmtTokens(cached)}${pct}` : ''}`;
}

function cachePart(pc, now) {
  if (!pc) return null;
  const left = pc.expires_at ? pc.expires_at * 1000 - now : 0;
  if (pc.warm && left > 0) {
    const tight = left < 5 * 60_000 && pc.ttl === '1h';
    return `${tight ? C.yellow : ''}${pc.ttl} cache, ${fmtDuration(left)} left${tight ? C.reset : ''}`;
  }
  return pc.caching_observed ? `${C.red}cache cold${C.reset}` : null;
}

function fillPart(cw) {
  const size = cw.context_window_size;
  const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : size && cw.total_input_tokens ? (cw.total_input_tokens / size) * 100 : null;
  if (pct == null) return null;
  return `${pctColor(pct, 70, 90)}${Math.round(pct)}% of ${size ? fmtWindow(size) : 'window'}${C.reset}`;
}

/** 5-hour and 7-day subscription limits (only present for claude.ai subscribers, after the first response). */
function limitsPart(rl, now) {
  const bits = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = rl?.[key];
    if (typeof w?.used_percentage !== 'number') continue;
    const left = key === 'five_hour' && w.resets_at ? w.resets_at * 1000 - now : 0;
    bits.push(`${pctColor(w.used_percentage, 80, 95)}${label} ${Math.round(w.used_percentage)}%${C.reset}${left > 0 ? dim(` (${fmtDuration(left)})`) : ''}`);
  }
  return bits.length ? bits.join(dim(' · ')) : null;
}

const costPart = (cost) => (typeof cost?.total_cost_usd === 'number' && cost.total_cost_usd > 0 ? `~$${cost.total_cost_usd.toFixed(2)} est.` : null);

/**
 * The segment: the parts named by the `statuslineSegments` setting, in that order.
 * A part with no data (no open PR, no limit data yet, no git repo) is left out.
 */
export function buildSegment(data, now = Date.now()) {
  const cw = data.context_window || {};
  const session = data.session_id ? loadSession(data.session_id) : null;
  const resolved = resolveSettings(session ? { session } : {});
  const wanted = Array.isArray(resolved.values.statuslineSegments) ? resolved.values.statuslineSegments : DEFAULT_STATUS_SEGMENTS;
  let st = null;
  if (session) {
    const pc = data.prompt_cache || null;
    const ttl = pc?.ttl || null;
    const usage = {
      model: data.model?.id,
      contextTokens: cw.total_input_tokens || 0,
      ttl,
      // expires_at is exactly one TTL after the last request that touched the cache
      timestamp: pc?.expires_at && ttl ? pc.expires_at * 1000 - TTL_MINUTES[ttl] * 60_000 : 0,
    };
    st = computeStatus({ settings: resolved.values, session, state: loadState(session.sessionId), usage, now });
  }
  const parts = {
    model: () => modelPart(data),
    folder: () => folderLabel(data),
    branch: () => {
      const b = readBranch(data.workspace?.current_dir || data.cwd);
      return b ? `⎇ ${b}` : null;
    },
    pr: () => prPart(data.pr),
    warm: () => warmPart(session, st, now),
    context: () => contextPart(cw),
    cache: () => cachePart(data.prompt_cache, now),
    fill: () => fillPart(cw),
    limits: () => limitsPart(data.rate_limits, now),
    cost: () => costPart(data.cost),
  };
  const out = [];
  for (const name of wanted) {
    const text = parts[name]?.();
    if (text) out.push(text);
  }
  return out.join(SEP);
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
