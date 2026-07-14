#!/usr/bin/env node
// Local web dashboard for Stickies. Zero external deps (node:http only), binds to
// loopback only, and gates mutations behind a per-launch token so a drive-by website
// cannot dismiss/create your stickies via CSRF.
//
// Launch:  node src/dashboard.js [--port 4317] [--project <path>] [--open]
// Env:     STICKIES_DASHBOARD_PORT overrides the default port.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readStickies, dismissSticky, createSticky, normalizeProjectPath } from './store.js';
import { CATEGORIES, IMPORTANCES } from './db.js';
import { renderPage } from './dashboard-page.js';
import { maybeAutoSync } from './git-sync.js';

const DEFAULT_PORT = 4317;

function parseArgs(argv) {
  const args = { port: Number(process.env.STICKIES_DASHBOARD_PORT) || DEFAULT_PORT, project: process.cwd(), open: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--open') args.open = true;
  }
  return args;
}

const { port, project, open } = parseArgs(process.argv.slice(2));
const PROJECT = normalizeProjectPath(project);
const TOKEN = randomBytes(16).toString('hex'); // gates mutations

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); }
    });
  });
}

// Reject cross-site mutation attempts: require our launch token AND a same-origin/no Origin.
function mutationAllowed(req) {
  if (req.headers['x-stickies-token'] !== TOKEN) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  // Page
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPage({ token: TOKEN, project: PROJECT, categories: CATEGORIES, importances: IMPORTANCES }));
    return;
  }

  // Read: stickies for the current project (+globals), or all projects.
  if (req.method === 'GET' && path === '/api/stickies') {
    const scopeAll = url.searchParams.get('all') === '1';
    const stickies = scopeAll
      ? readStickies({ project_path: null, include_global: true, limit: 500 })
      : readStickies({ project_path: PROJECT, include_global: true, limit: 500 });
    json(res, 200, { project: PROJECT, scopeAll, count: stickies.length, stickies });
    return;
  }

  // Mutations (token-gated)
  if (req.method === 'POST' && path === '/api/dismiss') {
    if (!mutationAllowed(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    if (!body || !body.id) return json(res, 400, { error: 'id required' });
    const result = dismissSticky(body.id, body.reason ?? null);
    if (result.ok) maybeAutoSync();
    return json(res, result.ok ? 200 : 404, result);
  }

  if (req.method === 'POST' && path === '/api/create') {
    if (!mutationAllowed(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad json' });
    try {
      const sticky = createSticky({
        content: body.content,
        category: body.category,
        importance: body.importance || 'P2',
        tags: Array.isArray(body.tags) ? body.tags : [],
        project_path: body.global ? null : PROJECT,
        source: 'manual',
      });
      maybeAutoSync();
      return json(res, 200, { ok: true, sticky });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  const target = PROJECT || '(global view)';
  process.stdout.write(`Stickies dashboard → http://127.0.0.1:${port}/   (project: ${target})\n`);
  process.stdout.write('Loopback only; mutations require the in-page token. Ctrl-C to stop.\n');
  if (open) {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    import('node:child_process').then(({ exec }) => exec(`${cmd} http://127.0.0.1:${port}/`));
  }
});
