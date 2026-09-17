// Cache analytics, derived from Claude Code's own transcripts (the usage block
// the API returns on every response) plus our ping log. Read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, TTL_MINUTES, WRITE_MULTIPLIER, priceFor, readEvents, readJson, writeJsonAtomic } from '../scripts/lib.mjs';

const PROJECTS_DIR = process.env.CCW_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const DAY = 24 * 3600_000;

// A gap only counts as a cold rebuild if the request re-wrote a meaningful context.
const REBUILD_MIN_TOKENS = 10_000;

export const GAP_BUCKETS = [
  { label: '< 5 min', max: 5 },
  { label: '5-15 min', max: 15 },
  { label: '15-60 min', max: 60 },
  { label: '1-3 h', max: 180 },
  { label: '3-8 h', max: 480 },
  { label: '> 8 h', max: Infinity },
];

// Transcripts are append-only, so remember how far each one was parsed and only
// read the new bytes next time. Persisted, because a cold scan of a busy week is ~1 min.
const CACHE_FILE = path.join(HOME, 'analytics-cache.json');
const CACHE_VERSION = 1;
let fileCache = null; // path -> { offset, mtimeMs, requests, recentKeys }
let cacheDirty = false;

function loadCache() {
  if (fileCache) return fileCache;
  const stored = readJson(CACHE_FILE);
  fileCache = new Map(stored?.version === CACHE_VERSION ? Object.entries(stored.files) : []);
  return fileCache;
}

function persistCache(liveFiles) {
  for (const key of fileCache.keys()) if (!liveFiles.has(key)) cacheDirty = fileCache.delete(key) || cacheDirty;
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    writeJsonAtomic(CACHE_FILE, { version: CACHE_VERSION, files: Object.fromEntries(fileCache) }, 0);
  } catch {
    // cache is an optimisation only
  }
}

function recentTranscripts(sinceMs) {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of projects) {
    if (!dir.isDirectory()) continue;
    const full = path.join(PROJECTS_DIR, dir.name);
    let names;
    try {
      names = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= sinceMs) out.push({ file, mtimeMs: st.mtimeMs, size: st.size, project: dir.name });
      } catch {
        // deleted between readdir and stat
      }
    }
  }
  return out;
}

/** Parse API responses of the main conversation from `offset` to the end of the file. */
async function parseTranscript(file, offset, recentKeys) {
  // One API response is written as several lines (one per content block) repeating the same usage.
  const seen = new Set(recentKeys);
  const requests = [];
  let consumed = offset;
  const stream = fs.createReadStream(file, { start: offset });
  let tail = Buffer.alloc(0);
  const handle = (buf) => {
    if (!buf.includes('"usage"')) return;
    const line = buf.toString('utf8');
    if (!line.includes('"assistant"')) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const msg = rec.message;
    const u = msg?.usage;
    if (rec.type !== 'assistant' || rec.isSidechain || !u) return;
    const key = msg.id || rec.requestId || rec.uuid;
    if (seen.has(key)) return;
    seen.add(key);
    const t = Date.parse(rec.timestamp);
    if (!t) return;
    const c = u.cache_creation || {};
    requests.push({
      t,
      key,
      sessionId: rec.sessionId,
      cwd: rec.cwd,
      model: msg.model,
      input: u.input_tokens || 0,
      read: u.cache_read_input_tokens || 0,
      write: u.cache_creation_input_tokens || 0,
      ttl: c.ephemeral_1h_input_tokens > 0 ? '1h' : c.ephemeral_5m_input_tokens > 0 ? '5m' : null,
    });
  };
  for await (const chunk of stream) {
    let buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(10)) !== -1) {
      handle(buf.subarray(0, nl));
      consumed += nl + 1;
      buf = buf.subarray(nl + 1);
    }
    tail = buf; // a half-written last line is re-read next time
  }
  return { requests, offset: consumed };
}

async function requestsFor(entry) {
  const cache = loadCache();
  let hit = cache.get(entry.file);
  if (hit && hit.offset > entry.size) hit = null; // file was rewritten, start over
  if (hit && hit.mtimeMs === entry.mtimeMs) return hit.requests;
  const parsed = await parseTranscript(entry.file, hit?.offset || 0, hit?.recentKeys || []);
  const requests = (hit?.requests || []).concat(parsed.requests).sort((a, b) => a.t - b.t);
  cacheDirty = true;
  cache.set(entry.file, { offset: parsed.offset, mtimeMs: entry.mtimeMs, requests, recentKeys: requests.slice(-20).map((r) => r.key) });
  return requests;
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function computeAnalytics({ days = 7, intervalFor = (ttl) => (ttl === '1h' ? 50 : 4), maxIdleMinutes = 180, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const daily = new Map();
  for (let t = since + DAY; t <= now + 1; t += DAY) daily.set(dayKey(t), { day: dayKey(t), read: 0, write: 0, input: 0, requests: 0, rebuilds: 0 });
  const gaps = GAP_BUCKETS.map((b) => ({ label: b.label, count: 0, rebuilds: 0 }));
  const rebuilds = [];
  const totals = { read: 0, write: 0, input: 0, requests: 0, sessions: 0, rebuildTokens: 0, rebuildUsd: 0, avoidableUsd: 0 };
  const bySession = new Map();

  const transcripts = recentTranscripts(since);
  for (const entry of transcripts) {
    const requests = await requestsFor(entry);
    let prev = null;
    let ttl = '5m';
    let counted = false;
    for (const r of requests) {
      if (r.ttl) ttl = r.ttl;
      if (r.t >= since) {
        if (!counted) (counted = true), totals.sessions++;
        const d = daily.get(dayKey(r.t));
        if (d) (d.read += r.read), (d.write += r.write), (d.input += r.input), d.requests++;
        totals.read += r.read;
        totals.write += r.write;
        totals.input += r.input;
        totals.requests++;
        if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
        bySession.get(r.sessionId).push(r);

        if (prev) {
          const gapMin = (r.t - prev.t) / 60_000;
          const bucket = gaps[GAP_BUCKETS.findIndex((b) => gapMin < b.max)];
          bucket.count++;
          // Cold rebuild: came back after the TTL and re-wrote (rather than read) the old context.
          const prevContext = prev.read + prev.write + prev.input;
          const cold = gapMin > TTL_MINUTES[ttl] && r.write >= REBUILD_MIN_TOKENS && r.read < prevContext * 0.5;
          if (cold) {
            const price = priceFor(r.model);
            const usd = (r.write / 1e6) * price.input * WRITE_MULTIPLIER[ttl];
            // What warming through that gap would have cost instead: pings, plus the read on return.
            const pings = Math.ceil(gapMin / intervalFor(ttl));
            const warmUsd = (pings + 1) * (prevContext / 1e6) * price.input * price.read;
            bucket.rebuilds++;
            if (d) d.rebuilds++;
            totals.rebuildTokens += r.write;
            totals.rebuildUsd += usd;
            // Past the idle cap the plugin would have stopped pinging, so that rebuild was never avoidable.
            const avoidable = !maxIdleMinutes || gapMin <= maxIdleMinutes;
            if (avoidable) totals.avoidableUsd += Math.max(0, usd - warmUsd);
            rebuilds.push({ t: r.t, sessionId: r.sessionId, cwd: r.cwd, model: r.model, ttl, gapMin, tokens: r.write, usd, warmUsd, pings, avoidable });
          }
        }
      }
      prev = r;
    }
  }

  persistCache(new Set(transcripts.map((e) => e.file)));

  // Did each ping really land on a warm cache? Look at the first response after it.
  const pingEvents = readEvents(since).filter((e) => e.type === 'ping');
  const pings = { sent: pingEvents.length, verified: 0, hits: 0, estCostUsd: 0, readTokens: 0 };
  for (const e of pingEvents) {
    pings.estCostUsd += e.estCostUsd || 0;
    const next = (bySession.get(e.sessionId) || []).find((r) => r.t >= e.t && r.t - e.t < 5 * 60_000);
    if (!next) continue;
    pings.verified++;
    pings.readTokens += next.read;
    if (next.read > next.write) pings.hits++;
  }

  const denom = totals.read + totals.write + totals.input;
  return {
    days,
    since,
    now,
    totals: { ...totals, hitRatio: denom ? totals.read / denom : 0 },
    daily: [...daily.values()],
    gaps,
    rebuilds: rebuilds.sort((a, b) => b.t - a.t).slice(0, 50),
    pings,
  };
}
