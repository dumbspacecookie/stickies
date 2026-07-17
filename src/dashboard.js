#!/usr/bin/env node
// Local web dashboard for Stickies. Zero external deps (node:http only), binds to
// loopback only, and gates mutations behind a per-launch token so a drive-by website
// cannot dismiss/create your stickies via CSRF.
//
// Launch:  node src/dashboard.js [--port 4317] [--project <path>] [--open]
// Env:     STICKIES_DASHBOARD_PORT overrides the default port.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readStickies, dismissSticky, createSticky, normalizeProjectPath } from './store.js';
import { CATEGORIES, IMPORTANCES } from './db.js';
import { renderPage } from './dashboard-page.js';
import { renderBoardPage } from './flow/board-page.js';
import { renderGraphPage } from './flow/graph-page.js';
import { buildBoard, phaseCards } from './flow/board.mjs';
import { derivePlanGraph } from './flow/derive-plans.mjs';
import { crossLink } from './flow/cross-link.mjs';
import { readPhaseDoc } from './flow/phase-doc.mjs';
import { maybeAutoSync } from './git-sync.js';

const DEFAULT_PORT = 4317;

function parseArgs(argv) {
  const args = { port: Number(process.env.STICKIES_DASHBOARD_PORT) || DEFAULT_PORT, project: process.cwd(), open: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--open') args.open = true;
  }
  // Resolve to an absolute path so the board header shows the real launching folder
  // (not a bare "." when started with --project .) and so .planning reads are unambiguous.
  args.project = resolve(args.project);
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

  // Flow board page (Kanban derived from the project's GSD .planning/ROADMAP.md).
  if (req.method === 'GET' && path === '/board') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderBoardPage({ project: PROJECT }));
    return;
  }

  // Flow graph page: the plan-execution DAG (self-contained SVG, its own back-nav to
  // /board and /). Mirrors the /board route; does not touch board-page.js.
  if (req.method === 'GET' && path === '/graph') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderGraphPage({ project: PROJECT }));
    return;
  }

  // Read: the derived flow board for the current project.
  if (req.method === 'GET' && path === '/api/board') {
    json(res, 200, buildBoard(PROJECT));
    return;
  }

  // Read: the plan-execution DAG {nodes, edges}. Live derivation of the project's PLAN.md
  // frontmatter, or — in the repo-mode path with no .planning/ — the committed
  // .flow/graph.json snapshot. application/json only, loopback-only, like /api/board.
  if (req.method === 'GET' && path === '/api/plan-graph') {
    let graph = derivePlanGraph(PROJECT);
    if (!graph) {
      try { graph = JSON.parse(readFileSync(join(PROJECT || '', '.flow', 'graph.json'), 'utf8')); }
      catch { graph = { nodes: [], edges: [] }; }
    }
    json(res, 200, graph);
    return;
  }

  // Read: a single path-confined .planning/ doc as tokenized JSON (never text/html, so a
  // .md can't be served as an executable page). Read-only + loopback-only, like /api/board;
  // readPhaseDoc rejects any path that escapes the project's .planning/ dir.
  if (req.method === 'GET' && path === '/api/phase-doc') {
    json(res, 200, readPhaseDoc(PROJECT, url.searchParams.get('path') || ''));
    return;
  }

  // Read: stickies for the current project (+globals), or all projects.
  if (req.method === 'GET' && path === '/api/stickies') {
    const scopeAll = url.searchParams.get('all') === '1';
    const stickies = scopeAll
      ? readStickies({ project_path: null, include_global: true, limit: 500 })
      : readStickies({ project_path: PROJECT, include_global: true, limit: 500 });
    // Cross-link each sticky to a flow-board phase (for the card's phase chip). Phases come
    // from THIS project's board; in the all-projects view only this project's stickies can
    // chip, which is correct — the chip links to this board's /board.
    try {
      const { perSticky } = crossLink(phaseCards(PROJECT), stickies);
      for (const s of stickies) {
        const link = perSticky[s.id];
        if (link) s.phase = { id: link.id, phase: link.phase, title: link.title };
      }
    } catch { /* phase enrichment is best-effort; never fail the read over it */ }
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
        origin: 'dashboard', // typed straight into the web board
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
