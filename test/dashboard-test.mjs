// Boots the real dashboard server and exercises the API + CSRF gate.
import { spawn } from 'node:child_process';
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
