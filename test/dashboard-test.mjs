// Boots the real dashboard server and exercises the API + CSRF gate.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { rmSync } from 'node:fs';
import { freePort, scratchDir, cleanup, authHeaders } from './_env.mjs';
import { join } from 'node:path';

const SCRATCH = scratchDir('dash');
const db = join(SCRATCH, 'dash.db');
const PORT = await freePort();
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
// Isolate from the developer's real sync config. An inherited STICKIES_AUTO_SYNC +
// STICKIES_SYNC_REPO makes a dismiss trigger maybeAutoSync(), which pulls the real note
// repo into this temp DB — so read counts jump around (the long-standing "count grows
// each run" flake). Blanking the sync vars keeps the test hermetic.
// STICKIES_HOME too: without it the spawned dashboard reads the developer's real
// ~/.stickies/sessions when building its project allowlist. Read-only today, but it is one
// project-count assertion away from being the next "count grows each run" flake.
const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_HOME: join(SCRATCH, 'home') };
const env = { ...process.env, STICKIES_DB: db, ...NO_SYNC };
const PROJECT = join(SCRATCH, 'proj');

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
  // /api/health, not /api/stickies: liveness must not depend on being authorized, or a broken
  // gate would present as "the server never started".
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/health'); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

let fail = 0;
const check = (cond, msg) => console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`) || (cond ? 0 : fail++);

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // Reads need proof of being the user now (src/dashboard-auth.js). Rather than thread a header
  // through sixty call sites, authorize this whole client once — which is what a real browser is
  // after it redeems the link. Per-request `headers` still win, so the tests that deliberately
  // send a bad mutation token, or none, still exercise exactly what they did before.
  const AUTH = authHeaders(join(SCRATCH, 'home'));
  if (!AUTH['x-stickies-key']) throw new Error('no dashboard auth key was written — cannot authorize the test client');
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => rawFetch(u, { ...o, headers: { ...AUTH, ...(o.headers || {}) } });

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

  // --- a body is bounded before it is buffered ---------------------------------------
  // readBody used to concatenate with no ceiling, so a huge POST was assembled in memory in
  // full and only then failed a content check. The token gates it, but a cap is one line.
  // The assertion has to DISCRIMINATE. A 2MB `content` is rejected either way — capped before
  // buffering, or buffered in full and then failed by createSticky's 500-char rule — so it
  // passes against the unfixed code too. Instead: a VALID note, with the bulk in a field the
  // server ignores. Capped => refused and nothing stored. Uncapped => 200 and a new sticky.
  const beforeCount = (await (await fetch(base + '/api/stickies?all=1')).json()).count;
  const padded = await fetch(base + '/api/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'a perfectly valid note', category: 'context', importance: 'P3', _pad: 'x'.repeat(400 * 1024) }),
  }).catch((e) => ({ status: 'connection-closed: ' + e.message }));
  check(padded.status !== 200, `a 400KB body is refused even when the note itself is valid (got ${padded.status})`);
  const afterCount = (await (await fetch(base + '/api/stickies?all=1')).json()).count;
  check(afterCount === beforeCount, `and nothing was stored (${beforeCount} -> ${afterCount})`);
  // A body just under the cap with the same shape must still work, or the cap is simply broken.
  const okSized = await fetch(base + '/api/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'a note with modest padding', category: 'context', importance: 'P3', _pad: 'x'.repeat(1024) }),
  });
  check(okSized.status === 200, `a normal-sized body still succeeds (got ${okSized.status})`);
  // Put the store back: later assertions in this file count notes, and a probe that leaves one
  // behind makes an unrelated test fail for a reason that has nothing to do with what it tests.
  const okBody = await okSized.json();
  await fetch(base + '/api/dismiss', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ id: okBody.sticky.id }),
  });
  const stillUp = await (await fetch(base + '/api/health')).json();
  check(stillUp.app === 'stickies', 'and the server is still healthy afterwards');

  // --- a bad token must not be able to KILL the server ------------------------------------
  // The constant-time comparison first shipped with a JS-string length check, but timingSafeEqual
  // compares BYTES: 'é'.repeat(32) is 32 code units and 64 bytes, so it passed the gate and threw
  // RangeError inside the async handler — an unhandled rejection, which by default ends the
  // process. One header, no token, dashboard dead for every terminal using it.
  const multibyte = 'é'.repeat(token.length);
  const killRes = await fetch(base + '/api/dismiss', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': multibyte },
    body: JSON.stringify({ id: 'whatever' }),
  }).catch((e) => ({ status: 'connection-died: ' + e.message }));
  check(killRes.status === 403, `a multi-byte token is refused, not fatal (got ${killRes.status})`);
  const aliveAfter = await (await fetch(base + '/api/health')).json().catch(() => null);
  check(aliveAfter && aliveAfter.app === 'stickies', 'and the server is still serving afterwards');
  // fetch() refuses to SEND a header outside Latin-1, so the reachable version of this is raw
  // bytes on a socket — which is what "any local process" actually means here. Every byte value
  // 0x80-0xFF arrives as a one-char latin1 string and re-encodes to two UTF-8 bytes.
  const rawStatus = await new Promise((resolve) => {
    const sock = netConnect(PORT, '127.0.0.1', () => {
      const hdr = Buffer.from(Array.from({ length: token.length }, (_, i) => 0x80 + (i % 0x7f)));
      const body = '{"id":"x"}';
      sock.write(Buffer.concat([
        // Carries the read key like any authorized client would: the point of this case is what
        // the MUTATION token check does with high bytes, so it must get past the read gate first
        // or it would prove only that the gate answered 401.
        Buffer.from(`POST /api/dismiss HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\ncontent-type: application/json\r\nx-stickies-key: ${AUTH['x-stickies-key']}\r\ncontent-length: ${body.length}\r\nx-stickies-token: `, 'latin1'),
        hdr,
        Buffer.from(`\r\n\r\n${body}`, 'latin1'),
      ]));
    });
    let got = '';
    sock.on('data', (d) => { got += d; if (got.includes('\r\n\r\n')) { sock.destroy(); resolve(got.split(' ')[1]); } });
    sock.on('error', () => resolve('socket-error'));
    setTimeout(() => { sock.destroy(); resolve(got ? got.split(' ')[1] : 'no-response'); }, 3000);
  });
  check(rawStatus === '403', `raw high-byte token bytes are refused, not fatal (got ${rawStatus})`);
  check((await (await fetch(base + '/api/health')).json()).app === 'stickies', 'server survives all of them');

  // The mutation gate is a constant-time comparison now; it must still behave exactly as before.
  for (const bad of ['', 'x', token.slice(0, -1), token + 'a', token.toUpperCase()]) {
    const r = await fetch(base + '/api/dismiss', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': bad },
      body: JSON.stringify({ id: 'whatever' }),
    });
    check(r.status === 403, `a wrong token (${JSON.stringify(bad.slice(0, 8))}) is still refused (got ${r.status})`);
  }

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
    // Authorized, so this measures the Host guard rather than the read gate.
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/stickies', method: 'GET', headers: { ...AUTH, ...headers } }, (res) => {
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
  // join() output, so normalize before comparing rather than matching a literal folder name.
  check(!!here && here.project_path === PROJECT.replace(/\\/g, '/'),
    `command center includes the launched project, flagged current (got ${here && here.project_path})`);
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
  // …and then take the scratch directory with us. This suite never deleted it: thirty-one
  // `stickies_dash_*` trees, one per run, each holding a sqlite database of test fixtures.
  try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
  cleanup(SCRATCH);
}
