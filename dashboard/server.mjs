#!/usr/bin/env node
// Local dashboard + control API. Zero dependencies; binds to loopback only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  GLOBAL_ONLY_KEYS,
  SCOPED_KEYS,
  SURFACES,
  VERSION,
  ensureMigrated,
  listSessions,
  loadConfigFile,
  loadSession,
  pluginTabLayers,
  resetScope,
  resolveIntervalMinutes,
  resolveSettings,
  sessionViews,
  pluginOptionsFromSettings,
  setScoped,
  syncPluginOptions,
} from '../scripts/lib.mjs';
import { ensureStatusline } from '../scripts/statusline-install.mjs';
import { computeAnalytics } from './analytics.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
ensureMigrated();
const port = Number(process.env.CCW_PORT) || resolveSettings({}).values.dashboardPort;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Any web page can fire requests at localhost. Reads are harmless, but writes flip
// settings, so require a loopback Host, a same-origin Origin and a JSON body
// (a cross-site form can't send application/json without a preflight we never grant).
function writeAllowed(req) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) return false;
  return (req.headers['content-type'] || '').startsWith('application/json');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

let analyticsInFlight = null; // transcript scans are heavy; share one between concurrent callers

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (!['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0])) return send(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: VERSION });

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const now = Date.now();
      syncPluginOptions(pluginOptionsFromSettings());
      const config = loadConfigFile();
      const tab = pluginTabLayers();
      // Every scope's own settings plus what it inherits, so the UI can show both.
      const scopes = [
        { scope: 'global', label: 'Global', own: config.global, ...resolveSettings({}, config, tab) },
        ...SURFACES.map((s) => ({ scope: s, label: { cli: 'CLI', desktop: 'Desktop app', ide: 'IDE' }[s], own: config.surfaces[s] || {}, ...resolveSettings({ surface: s }, config, tab) })),
        ...Object.keys(config.projects).map((p) => ({ scope: `project:${p}`, label: p, own: config.projects[p], ...resolveSettings({ cwd: p }, config, tab) })),
      ];
      const folders = [...new Set(listSessions().map((s) => s.cwd).filter(Boolean))];
      return send(res, 200, { now, version: VERSION, defaults: DEFAULTS, keys: { scoped: SCOPED_KEYS, globalOnly: GLOBAL_ONLY_KEYS }, pluginTab: tab.raw, scopes, folders, sessions: sessionViews(now) });
    }

    if (req.method === 'GET' && url.pathname === '/api/analytics') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const { values } = resolveSettings({});
      const key = `${days}`;
      if (!analyticsInFlight || analyticsInFlight.key !== key) {
        const promise = computeAnalytics({ days, maxIdleMinutes: values.maxIdleMinutes, intervalFor: (ttl) => resolveIntervalMinutes(values, ttl) }).finally(() => {
          if (analyticsInFlight?.promise === promise) analyticsInFlight = null;
        });
        analyticsInFlight = { key, promise };
      }
      return send(res, 200, await analyticsInFlight.promise);
    }

    // { scope: "global" | "cli" | "desktop" | "ide" | "project:<folder>" | "session:<id>", patch: {...} }
    // A null value clears that setting at that scope; { reset: true } clears the whole scope.
    if (req.method === 'POST' && url.pathname === '/api/scope') {
      if (!writeAllowed(req)) return send(res, 403, { error: 'forbidden' });
      try {
        const body = await readBody(req);
        if (String(body.scope || '').startsWith('session:') && !loadSession(body.scope.slice(8))) return send(res, 404, { error: 'unknown session' });
        if (body.reset) resetScope(body.scope);
        else setScoped(body.scope, body.patch || {});
        if (body.scope === 'global' && (body.reset || (body.patch && 'statusline' in body.patch))) ensureStatusline({ mode: resolveSettings({}).values.statusline });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    // 0.2 API, kept for the tray app and scripts: global patch / session patch.
    if (req.method === 'POST' && url.pathname === '/api/config') {
      if (!writeAllowed(req)) return send(res, 403, { error: 'forbidden' });
      try {
        setScoped('global', await readBody(req));
        return send(res, 200, resolveSettings({}).values);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    const m = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/);
    if (req.method === 'POST' && m) {
      if (!writeAllowed(req)) return send(res, 403, { error: 'forbidden' });
      if (!loadSession(m[1])) return send(res, 404, { error: 'unknown session' });
      try {
        setScoped(`session:${m[1]}`, await readBody(req));
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: String(err?.message || err) });
  }
});

server.on('error', (err) => {
  // Already running (second `ccw dashboard`, or the tray app started it): nothing to do.
  if (err.code === 'EADDRINUSE') process.exit(0);
  throw err;
});
server.listen(port, '127.0.0.1', () => console.log(`claude-cache-warm dashboard: http://127.0.0.1:${port}/`));
