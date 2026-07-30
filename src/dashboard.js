#!/usr/bin/env node
// Local web dashboard for Stickies. Zero external deps (node:http only), binds to
// loopback only, and gates mutations behind a per-launch token so a drive-by website
// cannot dismiss/create your stickies via CSRF.
//
// Launch:  node src/dashboard.js [--port <n>] [--project <path>] [--open]
// Env:     STICKIES_DASHBOARD_PORT overrides the default port.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pidFilePath } from './dashboard-autostart.js';
import { ensureAuthKey, authKind, cookieHeader, authorizedUrl, authEnabled, authKeyPath, keyMatches, mintTicket, KEY_PARAM } from './dashboard-auth.js';
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
import { resolveProject, knownProjects } from './project-scope.js';
import { DEFAULT_PORT } from './dashboard-port.js';

// Optional, dev-only. Present in the development tree, absent from the published package — and
// this file has to work unchanged in both, because it is ported wholesale and any divergence
// becomes a hand-merge on every release. A failed import here is the normal case, not an error:
// it means this build simply does not have the feature, and the two routes that use it are never
// registered. Resolved once at startup so no request pays for the attempt.
let APPRENTICE = null;
try {
  APPRENTICE = await import('./apprentice-page.js').then(async (page) => ({
    ...page,
    ...(await import('./apprentice.js')),
  }));
} catch {
  /* not this build */
}

// Navigation contributed by whatever optional modules this build actually has. Empty in the
// published package, so the shared renderers stay byte-identical between the trees.
const EXTRA_NAV = APPRENTICE ? [{ href: '/apprentice', label: '🧭 Apprentice' }] : [];

// Board writeback edits a project's .planning/ROADMAP.md, so it is opt-in: a dashboard should
// not gain the power to rewrite planning documents just by being open. The board page asks this
// too, and hides its drag affordances when it is off, so the feature is never a dead gesture.
function writebackEnabled() {
  return process.env.STICKIES_BOARD_WRITEBACK === '1';
}
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
// Proof of ownership for `--stop`, written into the pidfile and echoed on /api/health. Not a
// second mutation gate: it authenticates the SERVER to the CLI, never the other way round.
const OWNER_NONCE = randomBytes(16).toString('hex');
// Gates READS (see dashboard-auth.js). Persisted in STICKIES_HOME rather than regenerated per
// launch, so an already-authorized browser survives the restart this server now takes on every
// reboot. Deliberately NOT the owner nonce above: that one is published on /api/health to prove
// this process owns the port, and a secret that gates reads must never be published anywhere.
const AUTH_KEY = ensureAuthKey();
// No key and no way to make one (an unwritable STICKIES_HOME, a directory where the file should
// be) means every request would 401 — a dashboard that starts, looks healthy, and cannot be
// opened by anyone, ever, with nothing on screen to say why. Refuse to start instead, so
// `--detach` and the autostart hook report a failure a human can act on.
if (authEnabled() && !AUTH_KEY) {
  process.stderr.write(
    `stickies dashboard: cannot read or create ${authKeyPath()}, which is what authorizes reads.\n` +
    'Fix the permissions on that directory, or set STICKIES_DASHBOARD_AUTH=0 to serve reads openly.\n'
  );
  process.exit(1);
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

// Every legitimate body here is a small JSON object: a note (≤500 chars) or a bulk dismiss
// (≤500 ids). Buffering without a ceiling meant a 40MB POST was assembled in memory in full
// before the content-length check rejected it. Reachable only with the token, but a cap costs
// nothing and removes the question.
const MAX_BODY_BYTES = 256 * 1024;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);       // the caller answers 400; nothing further is accumulated
        req.destroy();
        return;
      }
      b += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); }
    });
    req.on('error', () => { if (!aborted) { aborted = true; resolve(null); } });
  });
}

// Reject cross-site mutation attempts: require our launch token AND a same-origin/no Origin.
function mutationAllowed(req) {
  const given = req.headers['x-stickies-token'];
  // Constant-time so the comparison cannot be turned into an oracle. At 128 bits guessing is
  // hopeless anyway, but timingSafeEqual behind a length check is one line.
  //
  // The length check must be in BYTES, not JS string length: `'é'.repeat(32)` is 32 code units
  // and 64 bytes, so a code-unit comparison let it through to timingSafeEqual, which throws
  // RangeError on unequal buffers — inside an async handler, i.e. an unhandled rejection that
  // took the whole server down. One header, no token, dashboard dead.
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  return true;
}

// The project a request is about: ?project=<path> when present (validated against the
// allowlist in project-scope.js), else the project this server was launched from.
//
// PROJECT is only the DEFAULT now, not a life sentence — one dashboard serves every terminal,
// each asking for its own folder. An unrecognized path is refused rather than silently
// downgraded to PROJECT, so a page can never show one folder's plans under another's name.
// Returns null after having already answered the request.
function scopeOf(url, res, { html = false } = {}) {
  const r = resolveProject(url.searchParams.get('project'), PROJECT);
  if (r.ok) return r.project;
  const msg = `Unknown project: ${r.requested}\n\nThe dashboard only serves projects this machine has registered — ones with saved stickies, or ones a recent Claude session ran in.`;
  if (html) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(msg);
  } else {
    json(res, 403, { error: 'unknown project', requested: r.requested });
  }
  return null;
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

// A throw anywhere in the async handler below is an unhandled promise rejection, and Node's
// default for that is to kill the process — so one malformed request could end a dashboard that
// other terminals are relying on. (It already did: a multi-byte token header reached
// timingSafeEqual and threw RangeError.) The specific bug is fixed, but the class shouldn't be
// able to recur: answer 500 and stay up.
const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    try {
      process.stderr.write(`stickies dashboard: request failed: ${err?.stack || err}\n`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    } catch { /* the socket is already gone; staying alive is the point */ }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  // DNS-rebinding guard, and the outermost check: it runs before the read gate below, so a
  // rebound request is refused without even consulting a cookie. Without a Host check a page on
  // another site could rebind its own hostname to 127.0.0.1 and, carrying any cookie the browser
  // holds for that host, read every note + project path (/api/stickies, /api/command, …). The server
  // binds loopback only, so a legitimate request's Host is always our own origin; reject anything
  // else. Mirrors the Origin allowlist used for mutations.
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  // Stop, on request from something that can read the pidfile.
  //
  // This replaces `--stop` signalling a pid. Sending SIGTERM meant trusting that the pid we had
  // still belongs to the process we think it does — and after a dashboard is SIGKILLed its
  // pidfile survives, so the OS is free to hand that number to something entirely unrelated
  // before anyone runs `--stop`. Asking the process itself to exit removes that whole class:
  // the only thing that can act on this request is the process holding the nonce, which is the
  // dashboard that wrote it.
  //
  // Above the read gate because the CLI has the pidfile, not necessarily a browser cookie, and
  // the nonce is the stronger proof of the two for this purpose. A custom header rather than a
  // form field, so a cross-origin page cannot reach it without a CORS preflight it will not get.
  if (req.method === 'POST' && path === '/api/stop') {
    const offered = req.headers['x-stickies-owner'];
    if (!keyMatches(typeof offered === 'string' ? offered : '', OWNER_NONCE)) {
      json(res, 403, { error: 'not the owner of this dashboard' });
      return;
    }
    json(res, 200, { ok: true, stopping: true, pid: process.pid });
    // Let the response flush before going. The exit handler removes the pidfile, so nothing is
    // left vouching for a pid the OS may reuse.
    setTimeout(() => process.exit(0), 50).unref?.();
    return;
  }

  // Read gate. Everything below this point serves the user's notes, project paths and planning
  // documents, so it requires proof of being the user: a cookie, the key header, or a fresh
  // `?k=` link. /api/health is deliberately ABOVE it — autostart, `--stop` and doctor all probe
  // liveness before any cookie can exist, and it discloses only what is needed to identify the
  // process. See src/dashboard-auth.js for what this does and does not buy.
  if (path !== '/api/health') {
    const kind = authKind(req, url, AUTH_KEY, port);
    if (kind === null) {
      // Never mention whether a key file exists or what it looks like; just say how to get in.
      const wants = req.headers.accept || '';
      if (wants.includes('text/html')) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(
          'Not authorized.\n\n' +
          'The Stickies dashboard serves your notes and planning documents, so it only answers a\n' +
          'browser you have authorized. Get an authorized link with:\n\n' +
          '    stickies dashboard --link\n\n' +
          'or Ctrl+click the Stickies segment in your Claude Code statusline, which carries one.\n'
        );
      } else {
        json(res, 401, { error: 'not authorized', hint: 'run `stickies dashboard --link` for an authorized URL' });
      }
      return;
    }
    // A link carrying the key is redeemed ONCE for a cookie, then bounced to the same URL
    // without it, so the secret does not sit in the address bar, get copied into a bug report,
    // or ride along in a Referer to anywhere the page later links.
    if (kind === 'query') {
      url.searchParams.delete(KEY_PARAM);
      const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '');
      res.writeHead(302, {
        location: clean,
        'set-cookie': cookieHeader(AUTH_KEY, port),
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
  }

  // Liveness + identity. Lets `stickies dashboard --detach` and the SessionStart autostart
  // tell "our dashboard is already up" apart from "some other program owns this port", instead
  // of spawning a child that dies on EADDRINUSE and reporting success anyway.
  if (req.method === 'GET' && path === '/api/health') {
    // Identity only. The ownership nonce is deliberately NOT here: this route is unauthenticated
    // (autostart and doctor must reach it before any credential exists), so anything published
    // here can be scraped by any local process and replayed later. `--stop` now proves ownership
    // in the other direction — it presents the nonce to /api/stop — so the server never has to
    // hand it out. pid stays: it is public in the process table anyway, and it is what lets a
    // human end this instance by hand.
    json(res, 200, { ok: true, app: 'stickies', project: PROJECT, port, pid: process.pid });
    return;
  }

  // Page
  if (req.method === 'GET' && path === '/') {
    const scope = scopeOf(url, res, { html: true });
    if (scope === null) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPage({ token: TOKEN, project: scope, categories: CATEGORIES, importances: IMPORTANCES, extraNav: EXTRA_NAV }));
    return;
  }

  // Flow board page (Kanban derived from the project's GSD .planning/ROADMAP.md).
  if (req.method === 'GET' && path === '/board') {
    const scope = scopeOf(url, res, { html: true });
    if (scope === null) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    // The board only needs a mutation token when writeback is on — no point handing a page
    // credentials for a capability it isn't allowed to use.
    res.end(renderBoardPage({ project: scope, writeback: writebackEnabled(), token: writebackEnabled() ? TOKEN : null, extraNav: EXTRA_NAV }));
    return;
  }

  // Flow graph page: the plan-execution DAG (self-contained SVG, its own back-nav to
  // /board and /). Mirrors the /board route; does not touch board-page.js.
  if (req.method === 'GET' && path === '/graph') {
    const scope = scopeOf(url, res, { html: true });
    if (scope === null) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderGraphPage({ project: scope }));
    return;
  }

  // Apprentice, if this build has it. See the optional import near the top of the file: in a tree
  // without src/apprentice-page.js these two routes simply do not exist, and everything else here
  // is identical — which is what keeps this file portable between the dev and public trees.
  if (APPRENTICE && req.method === 'GET' && path === '/apprentice') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(APPRENTICE.renderApprenticePage({ weeks: Number(url.searchParams.get('weeks')) || 2 }));
    return;
  }
  if (APPRENTICE && req.method === 'GET' && path === '/api/apprentice') {
    const weeks = Number(url.searchParams.get('weeks'));
    // Clamped rather than trusted: this value reaches a date subtraction, and a NaN or a wild
    // number would silently produce a window that is empty or the whole history.
    const w = Number.isInteger(weeks) && weeks > 0 && weeks <= 520 ? weeks : 2;
    json(res, 200, APPRENTICE.analyze(APPRENTICE.loadRows(), { weeks: w }));
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

  // The projects this dashboard may be pointed at, for the header switcher. Paths are ones
  // already registered on this machine (see project-scope.js) — the same set the /command
  // page has always aggregated, so this discloses nothing new.
  if (req.method === 'GET' && path === '/api/projects') {
    const projects = [...knownProjects(PROJECT)]
      .map((p) => ({
        project_path: p,
        current: p === PROJECT,
        hasBoard: existsSync(join(p, '.planning', 'ROADMAP.md')) || existsSync(join(p, '.flow', 'board.json')),
      }))
      .sort((a, b) => String(a.project_path).localeCompare(String(b.project_path)));
    json(res, 200, { launchProject: PROJECT, projects });
    return;
  }

  // Read: the derived flow board for the requested (or launch) project.
  if (req.method === 'GET' && path === '/api/board') {
    const scope = scopeOf(url, res);
    if (scope === null) return;
    json(res, 200, { ...buildBoard(scope), project: scope });
    return;
  }

  // Read: the plan-execution DAG {nodes, edges}. Live derivation of the project's PLAN.md
  // frontmatter, or — in the repo-mode path with no .planning/ — the committed
  // .flow/graph.json snapshot. application/json only, loopback-only, like /api/board.
  if (req.method === 'GET' && path === '/api/plan-graph') {
    const scope = scopeOf(url, res);
    if (scope === null) return;
    let graph = derivePlanGraph(scope);
    if (!graph) {
      try { graph = JSON.parse(readFileSync(join(scope || '', '.flow', 'graph.json'), 'utf8')); }
      catch { graph = { nodes: [], edges: [] }; }
    }
    json(res, 200, graph);
    return;
  }

  // Read: a single path-confined .planning/ doc as tokenized JSON (never text/html, so a
  // .md can't be served as an executable page). Read-only + loopback-only, like /api/board;
  // readPhaseDoc rejects any path that escapes the project's .planning/ dir.
  if (req.method === 'GET' && path === '/api/phase-doc') {
    const scope = scopeOf(url, res);
    if (scope === null) return;
    json(res, 200, readPhaseDoc(scope, url.searchParams.get('path') || ''));
    return;
  }

  // Read: stickies for the requested project (+globals), or all projects.
  if (req.method === 'GET' && path === '/api/stickies') {
    const scope = scopeOf(url, res);
    if (scope === null) return;
    const scopeAll = url.searchParams.get('all') === '1';
    const stickies = scopeAll
      ? readStickies({ project_path: null, include_global: true, limit: 500 })
      : readStickies({ project_path: scope, include_global: true, limit: 500 });
    // Cross-link each sticky to a flow-board phase (for the card's phase chip). Phases come
    // from the SCOPED project's board; in the all-projects view only that project's stickies
    // can chip, which is correct — the chip links to that same board.
    try {
      const { perSticky } = crossLink(phaseCards(scope), stickies);
      for (const s of stickies) {
        const link = perSticky[s.id];
        if (link) s.phase = { id: link.id, phase: link.phase, title: link.title };
      }
    } catch { /* phase enrichment is best-effort; never fail the read over it */ }
    json(res, 200, { project: scope, scopeAll, count: stickies.length, stickies });
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

  // Board writeback: move a phase between columns by editing its ROADMAP.md Status line.
  // The only route that writes to a planning document, so it carries every gate at once:
  // token + same-origin (mutationAllowed), the project allowlist (scopeOf), and writeback's own
  // refusal to make a change the board would then ignore. Off unless explicitly enabled.
  if (req.method === 'POST' && path === '/api/board/status') {
    if (!mutationAllowed(req)) return json(res, 403, { error: 'forbidden' });
    if (!writebackEnabled()) {
      return json(res, 403, {
        error: 'writeback disabled',
        detail: 'Set STICKIES_BOARD_WRITEBACK=1 to let the board edit .planning/ROADMAP.md.',
      });
    }
    const scope = scopeOf(url, res);
    if (scope === null) return;
    const body = await readBody(req);
    if (!body || !body.phase || !body.column) return json(res, 400, { error: 'phase and column required' });
    const { setPhaseStatus } = await import('./flow/writeback.mjs');
    const result = setPhaseStatus(scope, String(body.phase), String(body.column));
    return json(res, result.ok ? 200 : 409, result);
  }

  if (req.method === 'POST' && path === '/api/create') {
    if (!mutationAllowed(req)) return json(res, 403, { error: 'forbidden' });
    // A note must land in the project whose page you typed it on, not the one that happened to
    // launch the server — otherwise the switcher would silently misfile every note.
    const scope = scopeOf(url, res);
    if (scope === null) return;
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad json' });
    try {
      const sticky = createSticky({
        content: body.content,
        category: body.category,
        importance: body.importance || 'P2',
        tags: Array.isArray(body.tags) ? body.tags : [],
        due_at: body.due || null, // raw token ("2h"/"2026-07-20"); createSticky resolves it
        project_path: body.global ? null : scope,
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
}

// Without this handler an EADDRINUSE reached the process as an unhandled 'error' event and
// dumped a raw node stack trace — or, under `--detach`, killed the child silently while the
// CLI had already printed "started in background". Either way the port kept serving the FIRST
// project and you were never told. Explain it instead, and name who already owns the port.
server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    let owner = '';
    try {
      const { probeHealth } = await import('./dashboard-autostart.js');
      const health = await probeHealth(port, 700);
      if (health && health !== 'foreign') owner = ` It is already a Stickies dashboard, serving: ${health.project || '(global view)'}.`;
      else if (health === 'foreign') owner = ' Something other than Stickies is listening there.';
    } catch { /* identifying the owner is a nicety, not a requirement */ }
    process.stderr.write(
      `stickies dashboard: port ${port} is already in use.${owner}\n` +
      `One dashboard serves every project — open http://127.0.0.1:${port}/board?project=<path>, ` +
      `or start a second instance on another port with --port <n>.\n`
    );
    process.exit(1);
  }
  process.stderr.write(`stickies dashboard: ${err?.message || err}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  // Proof of ownership for `stickies dashboard --stop`. Without it, --stop takes the pid to
  // kill from the /api/health BODY — i.e. whoever holds the port picks the victim, and another
  // program holding a port is a normal thing (the old default, 4317, was OpenTelemetry's). Only a process that could write here can nominate itself.
  //
  // The pid alone was not proof of anything: a pid is public (it is in the process table), so a
  // squatter can restate the recorded one and have --stop kill it. The nonce is the part an
  // impostor cannot supply — random per listen, written owner-only, and echoed on /api/health.
  //
  // Written 'wx' onto a path we just removed, rather than 'w'. 'w' follows a symlink at the final
  // component, so anything able to plant `~/.stickies/dashboard-<port>.pid` as a link could have
  // this process truncate a file of its choosing. Holding the port means any file already there
  // is stale, so removing it first is safe — and if the create then loses a race we simply have
  // no pidfile, which makes --stop stricter rather than looser.
  try {
    const pidFile = pidFilePath(port); // one definition, shared with the reader in --stop
    mkdirSync(dirname(pidFile), { recursive: true });
    rmSync(pidFile, { force: true });
    const fd = openSync(pidFile, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: OWNER_NONCE })); }
    finally { closeSync(fd); }
    const cleanup = () => { try { rmSync(pidFile, { force: true }); } catch { /* nothing to do */ } };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
  } catch { /* a dashboard that cannot write a pidfile still serves; --stop just gets stricter */ }
  const target = PROJECT || '(global view)';
  // The printed URL carries the key: a bare one now answers 401, and a startup banner that hands
  // you a link you cannot open is worse than no banner.
  process.stdout.write(`Stickies dashboard → ${authorizedUrl(port, '/')}   (default project: ${target})\n`);
  process.stdout.write('Serves any registered project: /board?project=<path> — or use the header switcher.\n');
  process.stdout.write(
    authEnabled()
      ? 'Loopback only; reads need this link (it sets a cookie), mutations the in-page token. Ctrl-C to stop.\n'
      : 'Loopback only; READS ARE UNAUTHENTICATED (STICKIES_DASHBOARD_AUTH=0). Ctrl-C to stop.\n'
  );
  if (open) {
    // A ticket, never the key: this URL becomes a process command line, which other accounts can
    // read and audit logging records. See mintTicket() — one use, sixty seconds.
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const url = authEnabled() ? authorizedUrl(port, '/', mintTicket()) : `http://127.0.0.1:${port}/`;
    import('node:child_process').then(({ exec }) => exec(`${cmd} "${url}"`));
  }
});
