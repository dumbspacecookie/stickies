// Boots the real dashboard server and exercises the API + CSRF gate.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(tmpdir(), 'stickies_dash_test.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
// Isolate from the developer's real sync config. An inherited STICKIES_AUTO_SYNC +
// STICKIES_SYNC_REPO makes a dismiss trigger maybeAutoSync(), which pulls the real note
// repo into this temp DB — so read counts jump around (the long-standing "count grows
// each run" flake). Blanking the sync vars keeps the test hermetic.
const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '' };
const env = { ...process.env, STICKIES_DB: db, ...NO_SYNC };
const PROJECT = join(tmpdir(), 'dash_proj');
const PORT = 4399;
const base = `http://127.0.0.1:${PORT}`;

// Seed two stickies (one project, one global) via the store.
process.env.STICKIES_DB = db;
Object.assign(process.env, NO_SYNC);
const { createSticky } = await import('../src/store.js');
const target = createSticky({ content: 'dashboard target sticky', category: 'todo', importance: 'P1', project_path: PROJECT });
createSticky({ content: 'a global note', category: 'preference', importance: 'P3', project_path: null });

// Launch the dashboard.
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dashboard.js', '--port', String(PORT), '--project', PROJECT], { env });
srv.stderr.on('data', (d) => process.stdout.write('  srv: ' + d));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/stickies'); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

let fail = 0;
const check = (cond, msg) => console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`) || (cond ? 0 : fail++);

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // Page renders + embeds a token.
  const page = await (await fetch(base + '/')).text();
  check(page.includes('<title>Stickies</title>'), 'page renders');
  const token = (page.match(/const TOKEN = "([0-9a-f]+)"/) || [])[1];
  check(!!token, 'page embeds a launch token');

  // Read API: project scope shows project + global.
  const proj = await (await fetch(base + '/api/stickies?all=0')).json();
  check(proj.count === 2, `project scope returns project+global (got ${proj.count})`);

  // CSRF: dismiss WITHOUT token -> 403.
  const noTok = await fetch(base + '/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: target.id }) });
  check(noTok.status === 403, `dismiss without token blocked (got ${noTok.status})`);

  // CSRF: cross-origin Origin WITH token -> 403.
  const badOrigin = await fetch(base + '/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token, origin: 'http://evil.example' }, body: JSON.stringify({ id: target.id }) });
  check(badOrigin.status === 403, `cross-origin mutation blocked (got ${badOrigin.status})`);

  // Legit dismiss WITH token -> 200.
  const okDismiss = await fetch(base + '/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token }, body: JSON.stringify({ id: target.id }) });
  check(okDismiss.status === 200, `dismiss with token succeeds (got ${okDismiss.status})`);

  const after = await (await fetch(base + '/api/stickies?all=0')).json();
  check(after.count === 1, `dismissed sticky removed from read (got ${after.count})`);

  // --- Bulk dismiss -------------------------------------------------------------------
  // Same CSRF gate as /api/dismiss, and a batch must survive a bad id: the whole point is
  // clearing many notes at once, so one stale id can't be allowed to sink the request.
  const b1 = createSticky({ content: 'bulk one', category: 'todo', importance: 'P3', project_path: PROJECT });
  const b2 = createSticky({ content: 'bulk two', category: 'todo', importance: 'P3', project_path: PROJECT });
  const b3 = createSticky({ content: 'bulk global', category: 'context', importance: 'P3', project_path: null });

  const bulkNoTok = await fetch(base + '/api/dismiss-bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [b1.id] }) });
  check(bulkNoTok.status === 403, `bulk without token blocked (got ${bulkNoTok.status})`);

  const bulkBadOrigin = await fetch(base + '/api/dismiss-bulk', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token, origin: 'http://evil.example' }, body: JSON.stringify({ ids: [b1.id] }) });
  check(bulkBadOrigin.status === 403, `bulk cross-origin blocked (got ${bulkBadOrigin.status})`);

  const bulkEmpty = await fetch(base + '/api/dismiss-bulk', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token }, body: JSON.stringify({ ids: [] }) });
  check(bulkEmpty.status === 400, `bulk with empty ids rejected (got ${bulkEmpty.status})`);

  const bulkTooMany = await fetch(base + '/api/dismiss-bulk', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token }, body: JSON.stringify({ ids: Array.from({ length: 501 }, (_, i) => 'id-' + i) }) });
  check(bulkTooMany.status === 400, `bulk over MAX_BULK rejected (got ${bulkTooMany.status})`);

  // Mixed batch: two project notes + one global + one bogus id, in a single request.
  const bulkRes = await fetch(base + '/api/dismiss-bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ ids: [b1.id, b2.id, b3.id, 'no-such-id'], reason: 'test bulk' }),
  });
  const bulkOut = await bulkRes.json();
  check(bulkRes.status === 200, `bulk with token succeeds (got ${bulkRes.status})`);
  check(bulkOut.dismissed === 3, `bulk dismissed the 3 real ids (got ${bulkOut.dismissed})`);
  check(bulkOut.failed?.length === 1 && bulkOut.failed[0].id === 'no-such-id', 'bogus id isolated in failed[], batch survives');

  const afterBulk = await (await fetch(base + '/api/stickies?all=0')).json();
  check(afterBulk.count === 1, `bulk cleared project+global notes together (got ${afterBulk.count})`);

  // Re-dismissing an already-dismissed id reports failure rather than double-counting.
  const bulkRepeat = await (await fetch(base + '/api/dismiss-bulk', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token }, body: JSON.stringify({ ids: [b1.id] }) })).json();
  check(bulkRepeat.dismissed === 0 && bulkRepeat.failed.length === 1, 'already-dismissed id is not re-counted');

  // --- Due dates via the dashboard create path ----------------------------------------
  const dueCreate = await fetch(base + '/api/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'ship with a deadline', category: 'todo', importance: 'P1', due: '2h' }),
  });
  const dueOut = await dueCreate.json();
  check(dueOut.ok && dueOut.sticky?.due_at && new Date(dueOut.sticky.due_at) > new Date(), 'create resolves a due token to a future instant');
  const badDueOut = await (await fetch(base + '/api/create', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'no real deadline', category: 'todo', due: 'whenever' }),
  })).json();
  check(badDueOut.ok && badDueOut.sticky?.due_at === null, 'unparseable due is dropped, note still created');
  // The form and card path must be present in the page.
  const dpage = await (await fetch(base + '/')).text();
  check(dpage.includes('id="due"'), 'add form exposes a due input');
  check(dpage.includes('dueChip'), 'card renderer has due-chip logic');

  // Theme: the page must ship the toggle, both theme token blocks, and the boot script.
  check(dpage.includes('id="themeToggle"'), 'page has a light/dark toggle');
  check(dpage.includes('data-theme="light"') && dpage.includes('data-theme="dark"'), 'page defines both theme token blocks');
  check(dpage.includes('prefers-color-scheme: light'), 'page respects OS light preference');

  // Deep-link: a #note-<id> in the URL scrolls to + pulses that exact card.
  check(dpage.includes('focusFromHash'), 'page has the #note deep-link handler');
  check(dpage.includes('hashchange'), 'page re-focuses on hashchange');
  check(dpage.includes('stickyFlash'), 'page has the deep-link flash animation');
  check(dpage.includes("c.id = 'note-' + s.id"), 'cards carry a stable #note-<id> anchor');

  // Search + [[wikilinks]].
  check(dpage.includes('id="search"'), 'header has a search box');
  check(dpage.includes('matchesQuery'), 'page has the search filter');
  check(dpage.includes('renderBody') && dpage.includes('resolveNote'), 'page linkifies [[wikilinks]] in note bodies');

  // DNS-rebinding guard: a request with a foreign Host header is rejected (403) even on a read
  // route; the correct loopback Host still works. (fetch forbids setting Host, so use raw http.)
  const rawGet = (headers) => new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/stickies', method: 'GET', headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.end();
  });
  check((await rawGet({ host: 'evil.example:' + PORT })) === 403, 'foreign Host header rejected (DNS-rebinding guard)');
  check((await rawGet({ host: '127.0.0.1:' + PORT })) === 200, 'correct loopback Host allowed');

  // Command Center: cross-project aggregation + its page.
  const cmd = await (await fetch(base + '/api/command')).json();
  check(Array.isArray(cmd.projects) && cmd.totals && typeof cmd.totals.pct === 'number', '/api/command returns {projects, totals}');
  const here = cmd.projects.find((p) => p.current);
  // The API returns the normalized project_path (forward slashes); PROJECT here is the raw
  // join() output, so match on the folder rather than an exact string.
  check(!!here && here.project_path.endsWith('dash_proj'), 'command center includes the launched project, flagged current');
  check(cmd.projects.every((p) => p.stickies && typeof p.stickies.p1 === 'number' && p.board), 'each project carries sticky counts + a board summary');
  const cpage = await (await fetch(base + '/command')).text();
  check(cpage.includes('Command Center'), '/command page renders');
  for (const [i, src] of [...cpage.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).entries()) {
    let ok = true, err = '';
    try { new Function(src); } catch (e) { ok = false; err = e.message; }
    check(ok, `command page inline script #${i} parses${ok ? '' : ' — ' + err}`);
  }

  // The page's browser JS must actually PARSE. The API can be perfectly healthy while a
  // syntax error in the inline script leaves the UI stuck on "Loading…" forever — the page
  // is emitted from a template literal, so an escape that collapses on the way out (e.g. a
  // backslash inside a regex literal) is a real and silent way to ship a dead dashboard.
  const html = await (await fetch(base + '/')).text();
  const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check(blocks.length > 0, `page serves an inline script (got ${blocks.length})`);
  for (const [i, src] of blocks.entries()) {
    let parsed = true;
    let err = '';
    try {
      new Function(src); // parse-only: never executed
    } catch (e) {
      parsed = false;
      err = e.message;
    }
    check(parsed, `inline script #${i} parses${parsed ? '' : ' — ' + err}`);
  }

  console.log('\n' + (fail === 0 ? 'DASHBOARD OK' : fail + ' FAILURES'));
} catch (e) {
  console.log('ERROR', e.message);
  fail++;
} finally {
  // Clean teardown: signal the child and wait for it to close before exiting, so we
  // don't trip a libuv async-handle assertion on Windows.
  process.exitCode = fail === 0 ? 0 : 1;
  await new Promise((resolve) => {
    srv.once('close', resolve);
    srv.kill();
    setTimeout(resolve, 1500).unref?.();
  });
}
