// Serveur local, sans aucune dependance npm.
//   npm start        -> http://localhost:5190
// Ecoute aussi sur le reseau local pour un acces depuis le telephone.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';

import { routes } from './src/api.js';
import { currentUser, hasAccounts, login, logoutCookie, signup } from './src/auth.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5190;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

/* ------------------------------- Routage ---------------------------------- */

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, pattern] = key.split(' ');
  const names = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  return { method, regex, names, handler };
});

function matchRoute(method, pathname) {
  for (const route of compiled) {
    if (route.method !== method) continue;
    const m = pathname.match(route.regex);
    if (!m) continue;
    const params = {};
    route.names.forEach((name, i) => { params[name] = m[i + 1]; });
    return { handler: route.handler, params };
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Screenshots travel as base64 data URLs, so this has to fit a few of them.
    if (size > 25_000_000) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON.');
  }
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/* ---------------------------- Fichiers statiques --------------------------- */

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));

  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // no-store, not no-cache: without it the browser keeps running the old
      // app.js after an update and the change looks like it did not apply.
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    // Application monopage : tout chemin inconnu retombe sur index.html
    try {
      const body = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}

/* -------------------------------- Serveur --------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  /* -------------------------------- Accounts ------------------------------ */

  if ((pathname === '/api/signup' || pathname === '/api/login') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const action = pathname === '/api/signup' ? signup : login;
      const result = action(req, body?.email, body?.password);
      if (!result.ok) return sendJson(res, 401, { error: result.error });
      res.setHeader('Set-Cookie', result.cookie);
      return sendJson(res, 200, { ok: true, user: result.user });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/logout') {
    res.setHeader('Set-Cookie', logoutCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/session') {
    return sendJson(res, 200, { user: currentUser(req), has_accounts: hasAccounts() });
  }

  const user = currentUser(req);

  if (!user) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Not signed in.' });
    if (pathname !== '/login.html' && pathname !== '/style.css') {
      return serveStatic(res, '/login.html');
    }
  }

  /* -------------------------------- Routing ------------------------------- */

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    return serveStatic(res, pathname);
  }

  const match = matchRoute(req.method, pathname);
  if (!match) return sendJson(res, 404, { error: 'Unknown route.' });

  try {
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    // Every handler receives the owner. Nothing downstream can query without it.
    const result = await match.handler({
      params: match.params, body, query: url.searchParams, userId: user.id, user
    });
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error(`[${req.method} ${pathname}]`, err);
    sendJson(res, 500, { error: err.message || 'Internal error.' });
  }
});

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/* Node drops an idle keep-alive connection after 5 seconds by default. Railway's
   edge proxy holds those connections open for much longer and reuses them, so it
   regularly sends a request down a socket Node is closing at that exact moment.
   The request dies in flight and the browser reports it as "Failed to fetch" —
   which is why curl, opening a fresh connection every time, never reproduces it.
   The server must outlive the proxy's idle window, not the other way round. */
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;   // must stay above keepAliveTimeout

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  chatmate — reply assistant');
  console.log('  ---------------------------------');
  console.log(`  On this computer : http://localhost:${PORT}`);
  for (const ip of localAddresses()) {
    console.log(`  From her phone   : http://${ip}:${PORT}   (same wifi)`);
  }
  console.log(`\n  No connection to Fansly. Data lives in ${process.env.CHATMATE_DATA_DIR || 'data/'}\n`);
});
