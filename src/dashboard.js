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
import { readStickies, dismissSticky, createSticky, normalizeProjectPath, projectSummaries } from './store.js';
import { CATEGORIES, IMPORTANCES } from './db.js';
import { renderPage } from './dashboard-page.js';
import { renderBoardPage } from './flow/board-page.js';
import { renderGraphPage } from './flow/graph-page.js';
import { renderCommandPage } from './command-page.js';
import { buildBoard, phaseCards } from './flow/board.mjs';
import { derivePlanGraph } from './flow/derive-plans.mjs';
import { crossLink } from './flow/cross-link.mjs';
import { readPhaseDoc } from './flow/phase-doc.mjs';
import { maybeAutoSync } from './git-sync.js';

const DEFAULT_PORT = 4317;
// Ceiling on one bulk dismiss. Guards against a runaway client turning a single request
// into an unbounded write loop; well above any plausible hand-selection.
const MAX_BULK = 500;

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

// Cross-project overview: every project with active stickies (plus the launched one, even if
// it has none), each enriched with its Flow-board rollup/counts, sorted by what needs attention
// (P1s, then blockers, then work in flight). Read-only aggregation over local paths this machine
// has already stored notes for — no arbitrary path is read from the request.
function buildCommandCenter() {
  const byPath = new Map(projectSummaries().map((s) => [s.project_path, s]));
  if (PROJECT && !byPath.has(PROJECT)) {
    byPath.set(PROJECT, { project_path: PROJECT, stickies: { total: 0, p1: 0, p2: 0, p3: 0, blockers: 0 }, lastTouched: null });
  }
  const projects = [...byPath.values()].map((s) => {
    const board = buildBoard(s.project_path);
    return {
      project_path: s.project_path,
      current: s.project_path === PROJECT,
      stickies: s.stickies,
      lastTouched: s.lastTouched,
      board: board.ok ? { ok: true, source: board.source, counts: board.counts, rollup: board.rollup || null } : { ok: false },
    };
  });
  projects.sort((a, b) =>
    (b.stickies.p1 - a.stickies.p1) ||
    (b.stickies.blockers - a.stickies.blockers) ||
    ((b.board.counts?.doing || 0) - (a.board.counts?.doing || 0)) ||
    String(a.project_path).localeCompare(String(b.project_path))
  );
  const totals = projects.reduce((t, p) => {
    t.projects++; t.p1 += p.stickies.p1; t.blockers += p.stickies.blockers;
    if (p.board.rollup) { t.done += p.board.rollup.done; t.total += p.board.rollup.total; }
    return t;
  }, { projects: 0, p1: 0, blockers: 0, done: 0, total: 0 });
  totals.pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
  return { projects, totals, generatedAt: new Date().toISOString() };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  // DNS-rebinding guard. The GET read routes are intentionally ungated (they only serve local
  // data), but without a Host check a page on another site could rebind its own hostname to
  // 127.0.0.1 and read every note + project path (/api/stickies, /api/command, …). The server
  // binds loopback only, so a legitimate request's Host is always our own origin; reject anything
  // else. Mirrors the Origin allowlist used for mutations.
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

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

  // Cross-project Command Center page + its aggregated read.
  if (req.method === 'GET' && path === '/command') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderCommandPage({ project: PROJECT }));
    return;
  }
  if (req.method === 'GET' && path === '/api/command') {
    json(res, 200, buildCommandCenter());
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

  // Bulk dismiss: N stickies, ONE sync. Per-sticky dismiss syncs on every call, so clearing
  // 20 notes one by one meant 20 full git pull/commit/push cycles (~2.3s each). Hoisting the
  // sync out of the loop makes the batch cost the same as a single dismiss.
  // Ids are dismissed independently: an unknown or already-dismissed id is reported in
  // failed[] rather than sinking the whole batch.
  if (req.method === 'POST' && path === '/api/dismiss-bulk') {
    if (!mutationAllowed(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((i) => typeof i === 'string' && i) : null;
    if (!ids || !ids.length) return json(res, 400, { error: 'ids[] required' });
    if (ids.length > MAX_BULK) return json(res, 400, { error: `too many ids (max ${MAX_BULK})` });

    const results = ids.map((id) => ({ id, ...dismissSticky(id, body.reason ?? 'dashboard bulk') }));
    const dismissed = results.filter((r) => r.ok).length;
    if (dismissed) maybeAutoSync(); // once, not per id
    return json(res, 200, {
      ok: true,
      dismissed,
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error })),
    });
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
        due_at: body.due || null, // raw token ("2h"/"2026-07-20"); createSticky resolves it
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
