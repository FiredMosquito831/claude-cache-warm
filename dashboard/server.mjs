#!/usr/bin/env node
// Local dashboard + control API. Zero dependencies; binds to loopback only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, loadConfig, loadSession, logEvent, resolveIntervalMinutes, saveConfig, sessionViews, updateSession } from '../scripts/lib.mjs';
import { computeAnalytics } from './analytics.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.CCW_PORT) || loadConfig().dashboardPort;
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
      return send(res, 200, { config: loadConfig(), sessions: sessionViews(now), now, version: VERSION });
    }

    if (req.method === 'GET' && url.pathname === '/api/analytics') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const config = loadConfig();
      const key = `${days}`;
      if (!analyticsInFlight || analyticsInFlight.key !== key) {
        const promise = computeAnalytics({ days, maxIdleMinutes: config.maxIdleMinutes, intervalFor: (ttl) => resolveIntervalMinutes(config, ttl) }).finally(() => {
          if (analyticsInFlight?.promise === promise) analyticsInFlight = null;
        });
        analyticsInFlight = { key, promise };
      }
      return send(res, 200, await analyticsInFlight.promise);
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      if (!writeAllowed(req)) return send(res, 403, { error: 'forbidden' });
      try {
        return send(res, 200, saveConfig(await readBody(req)));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    const m = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/);
    if (req.method === 'POST' && m) {
      if (!writeAllowed(req)) return send(res, 403, { error: 'forbidden' });
      const { enabled } = await readBody(req).catch(() => ({}));
      if (![true, false, null].includes(enabled)) return send(res, 400, { error: 'enabled must be true, false or null' });
      if (!loadSession(m[1])) return send(res, 404, { error: 'unknown session' });
      updateSession(m[1], { enabled });
      logEvent({ type: 'config', sessionId: m[1], patch: { enabled } });
      return send(res, 200, { ok: true });
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
