// One dashboard, many projects.
//
// The dashboard used to be pinned for life to its launch cwd while the port was fixed
// machine-wide, so a second terminal in another folder Ctrl+clicked its own statusline and
// silently got the FIRST project's board. The project is now per-request (?project=), which
// puts a request string on the path to buildBoard()/readPhaseDoc()/the store — so this file
// holds both halves of the contract:
//   1. a registered project IS servable, and the response really is that project's data
//   2. an unregistered path is REFUSED — never quietly swapped for the launch project
//      (which would just relocate the original lie), and never used as a filesystem probe
//
// Registration = has stickies, or a recent SessionStart marker. Both are covered.

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { freePorts, scratchDir, authHeaders } from './_env.mjs';
import { join } from 'node:path';

const ROOT = scratchDir('scope');
const [PORT, WB_PORT] = await freePorts(2);
const DB = join(ROOT, 'scope.db');
const HOME = join(ROOT, 'home');           // STICKIES_HOME -> session markers live here
const A = join(ROOT, 'projA');             // launch project (has a roadmap + a sticky)
const B = join(ROOT, 'projB');             // registered via a sticky
const C = join(ROOT, 'projC');             // registered via a session marker only
const D = join(ROOT, 'projD');             // NEVER registered — must be refused

const base = `http://127.0.0.1:${PORT}`;

rmSync(ROOT, { recursive: true, force: true });

// Two projects whose boards are trivially distinguishable, so "wrong project" can't hide.
function seedProject(dir, phase, title) {
  mkdirSync(join(dir, '.planning', 'phases', '01-only'), { recursive: true });
  writeFileSync(
    join(dir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n### Phase ${phase}: ${title}\n**Status:** Planned\n- [ ] ${phase}-01 plan\n`
  );
  writeFileSync(join(dir, '.planning', 'phases', '01-only', '01-01-PLAN.md'), `# ${title} plan\n\nbody of ${title}\n`);
}
seedProject(A, 1, 'ALPHA-ONLY');
seedProject(B, 9, 'BRAVO-ONLY');
seedProject(C, 5, 'CHARLIE-ONLY');
seedProject(D, 7, 'DELTA-ONLY');
mkdirSync(HOME, { recursive: true });

const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_DISCORD_WEBHOOK: '' };
const env = { ...process.env, STICKIES_DB: DB, STICKIES_HOME: HOME, ...NO_SYNC };

// Register A and B by giving them a sticky; register C with a session marker only.
Object.assign(process.env, { STICKIES_DB: DB, STICKIES_HOME: HOME, ...NO_SYNC });
const { createSticky, readStickies } = await import('../src/store.js');
const { writeMarker } = await import('../src/session-marker.js');
createSticky({ content: 'alpha note', category: 'context', importance: 'P2', project_path: A });
createSticky({ content: 'bravo note', category: 'context', importance: 'P2', project_path: B });
writeMarker('scope-test-session', C);

const srv = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', 'src/dashboard.js', '--port', String(PORT), '--project', A],
  { env }
);
srv.stderr.on('data', (d) => process.stdout.write('  srv: ' + d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const titlesOf = (board) =>
  ['todo', 'doing', 'done'].flatMap((k) => (board.columns?.[k] || []).map((c) => c.title)).join(',');

try {
  if (!(await waitUp())) throw new Error('server did not start');

  // Authorize this client for reads (src/dashboard-auth.js), the way a browser is once it has
  // redeemed the link. Per-request headers still win, so nothing below changes meaning.
  const AUTH = authHeaders(HOME);
  if (!AUTH['x-stickies-key']) throw new Error('no dashboard auth key was written — cannot authorize the test client');
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => rawFetch(u, { ...o, headers: { ...AUTH, ...(o.headers || {}) } });

  // --- identity ------------------------------------------------------------------------
  const health = await (await fetch(base + '/api/health')).json();
  check(health.ok && health.app === 'stickies', 'health identifies the app (so autostart can tell ours from foreign)');
  check(health.project === A.replace(/\\/g, '/'), 'health reports the launch project');

  // --- default scope is unchanged ------------------------------------------------------
  const dflt = await (await fetch(base + '/api/board')).json();
  check(titlesOf(dflt) === 'ALPHA-ONLY', `no ?project= => launch project (got ${titlesOf(dflt)})`);

  // --- the actual fix: another terminal's project, served correctly --------------------
  const bBoard = await (await fetch(base + '/api/board?project=' + encodeURIComponent(B))).json();
  check(titlesOf(bBoard) === 'BRAVO-ONLY', `?project=B serves B's board (got ${titlesOf(bBoard)})`);
  check(bBoard.project === B.replace(/\\/g, '/'), 'board response names the project it is for');

  const cBoard = await (await fetch(base + '/api/board?project=' + encodeURIComponent(C))).json();
  check(titlesOf(cBoard) === 'CHARLIE-ONLY', 'a session-marker-only project is servable (no stickies needed yet)');

  // --- the boundary: an unregistered path is refused, not substituted -----------------
  const dRes = await fetch(base + '/api/board?project=' + encodeURIComponent(D));
  const dBody = await dRes.json();
  check(dRes.status === 403, `unregistered project => 403 (got ${dRes.status})`);
  check(dBody.error === 'unknown project', 'refusal names the reason');
  check(!JSON.stringify(dBody).includes('DELTA-ONLY'), 'refusal leaks no board data for the unregistered path');
  check(!JSON.stringify(dBody).includes('ALPHA-ONLY'), 'refusal does NOT silently fall back to the launch project');

  const dPage = await fetch(base + '/board?project=' + encodeURIComponent(D));
  check(dPage.status === 403, `page route refuses an unregistered project too (got ${dPage.status})`);

  // A filesystem root is not a project, however plausible it looks.
  const rootRes = await fetch(base + '/api/board?project=' + encodeURIComponent(tmpdir()));
  check(rootRes.status === 403, 'an arbitrary real directory is still refused');

  // A value that normalizes to nothing was still a value the caller asked for. Serving the
  // launch project under it is the same substitution this module exists to refuse.
  for (const junk of ['/', '///', '   ', '\\', 'C:/x</script>']) {
    const jr = await fetch(base + '/api/board?project=' + encodeURIComponent(junk));
    const jb = await jr.json().catch(() => ({}));
    check(jr.status === 403, `a degenerate ?project=${JSON.stringify(junk)} is refused (got ${jr.status})`);
    check(!JSON.stringify(jb).includes('ALPHA-ONLY'), `and does not quietly serve the launch project (${JSON.stringify(junk)})`);
  }
  // The absent case is different and must keep working: no ?project= at all means the launch one.
  const noParam = await (await fetch(base + '/api/board')).json();
  check(noParam.project === A.replace(/\\/g, '/'), 'omitting ?project= still means the launch project');

  // Allowlist entries are normalized real paths and the comparison is exact — no `..` walk is
  // resolved on the way in, so a dot-dot dressed up as an allowlisted project misses. Locked in
  // because "resolve it first, then compare" looks tidier and would silently widen the gate.
  const dots = await fetch(base + '/api/board?project=' + encodeURIComponent(B + '/../projD'));
  check(dots.status === 403, `a ..-relative path is not a way into an unregistered project (got ${dots.status})`);
  const dotsSelf = await fetch(base + '/api/board?project=' + encodeURIComponent(B + '/../projB'));
  check(dotsSelf.status === 403, 'even a ..-path that would resolve to an allowlisted project is refused');

  // --- scoped page rendering ----------------------------------------------------------
  const bPage = await (await fetch(base + '/board?project=' + encodeURIComponent(B))).text();
  check(bPage.includes(B.replace(/\\/g, '/')), 'board page header shows the scoped project path');

  // --- every page carries the project, not just /board --------------------------------
  // The switcher was originally only on /board, so you could change which project's BOARD you
  // were viewing but not its NOTES or graph — the pages then disagreed with each other. All
  // three now share flow/project-switcher.mjs. Two things must hold on each: the switcher is
  // present, and the page does NOT redeclare a top-level `PROJ`/`withProj` (separate classic
  // <script> blocks share one global lexical scope, so a second `const PROJ` is a SyntaxError
  // that silently kills the entire page script).
  for (const [route, label] of [['/', 'notes'], ['/board', 'board'], ['/graph', 'graph']]) {
    const html = await (await fetch(base + route + '?project=' + encodeURIComponent(B))).text();
    check(/<button class="proj" id="projLabel"/.test(html), `${label} page has the project switcher`);
    check(html.includes('window.withProj'), `${label} page defines withProj before its own script`);
    check((html.match(/const PROJ =/g) || []).length === 0, `${label} page has no duplicate PROJ declaration`);
    check(html.includes(B.replace(/\\/g, '/')), `${label} page header names the scoped project`);
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let parseErr = null;
    for (const b of blocks) { try { new Function(b); } catch (e) { parseErr = e.message; break; } }
    check(!parseErr, `${label} page inline scripts parse (${parseErr || 'clean'})`);
  }

  // --- phase docs follow the scope, and stay confined ---------------------------------
  const bDoc = await (await fetch(
    base + '/api/phase-doc?project=' + encodeURIComponent(B) + '&path=' + encodeURIComponent('phases/01-only/01-01-PLAN.md')
  )).json();
  check(bDoc.ok && JSON.stringify(bDoc).includes('BRAVO-ONLY'), 'phase-doc reads the scoped project\'s doc');

  // The sharpest version of the traversal case: a path that really exists, in a project that
  // is itself allowlisted. Scoping to B must not become a door into A's .planning.
  const sibling = await (await fetch(
    base + '/api/phase-doc?project=' + encodeURIComponent(B) + '&path=' + encodeURIComponent('../../projA/.planning/ROADMAP.md')
  )).json();
  check(sibling.ok !== true, `cannot read a sibling project's docs through a scoped project (reason: ${sibling.reason})`);
  check(!JSON.stringify(sibling).includes('ALPHA-ONLY'), 'sibling traversal returns no content from A');

  const escape = await (await fetch(
    base + '/api/phase-doc?project=' + encodeURIComponent(B) + '&path=' + encodeURIComponent('../../../../Windows/win.ini')
  )).json();
  check(escape.ok !== true, `traversal out of the project is blocked (reason: ${escape.reason})`);

  // --- the switcher's source of truth -------------------------------------------------
  const list = await (await fetch(base + '/api/projects')).json();
  const paths = (list.projects || []).map((p) => p.project_path);
  check(paths.includes(A.replace(/\\/g, '/')), 'projects list includes the launch project');
  check(paths.includes(B.replace(/\\/g, '/')), 'projects list includes a sticky-registered project');
  check(paths.includes(C.replace(/\\/g, '/')), 'projects list includes a session-registered project');
  check(!paths.includes(D.replace(/\\/g, '/')), 'projects list excludes the never-registered project');

  // --- the label must say WHICH project, unambiguously ---------------------------------
  // Two projects under a deep shared prefix are told apart only by their last segment. With a
  // clip-the-end ellipsis they rendered as the identical string — and writeback edits a real
  // ROADMAP.md, so mistaking the project is the expensive error.
  const { switcherButton } = await import('../src/flow/project-switcher.mjs');
  const deepA = 'C:/Users/dev/AppData/Local/Temp/scratch/writeback-fixture';
  const deepB = 'C:/Users/dev/AppData/Local/Temp/scratch/writeback-e2e';
  const btnA = switcherButton(deepA), btnB = switcherButton(deepB);
  check(btnA.includes(`title="${deepA}"`), 'the button carries the full path in title=, not "Switch project"');
  check(btnA.includes('<span class="base">writeback-fixture</span>'), 'the basename is its own element so it cannot be clipped');
  check(btnB.includes('<span class="base">writeback-e2e</span>'), 'and it differs between two projects sharing a long prefix');
  const baseOf = (h) => (h.match(/<span class="base">([^<]*)<\/span>/) || [])[1];
  check(baseOf(btnA) !== baseOf(btnB), 'so the two are distinguishable without hovering');
  check(switcherButton(null).includes('(global)'), 'a null project still renders a label');
  check(!switcherButton('C:/x<img src=x>').includes('<img'), 'and the label is HTML-escaped');

  // --- a project path can never break out of the boot script ---------------------------
  // The switcher serializes the current project into a <script> body. JSON.stringify does not
  // escape `/`, so a path containing `</script>` would close the element and turn the rest into
  // markup — in the same document that holds the mutation token. project_path arrives from
  // whatever an agent passes to stickies_write, so it is untrusted.
  const { switcherBoot } = await import('../src/flow/project-switcher.mjs');
  const boot = switcherBoot('C:/x</script><img src=x onerror=alert(1)>');
  check(!boot.includes('</script><img'), 'a </script> in a project path cannot close the boot script');
  check(boot.includes('\\u003c/script\\u003e'), 'it is emitted as a unicode escape instead');
  const bootBlocks = [...boot.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check(bootBlocks.length === 1, 'the payload does not split the block in two');
  let bootErr = null;
  try { new Function(bootBlocks[0]); } catch (e) { bootErr = e.message; }
  check(bootErr === null, `the escaped boot script still parses (${bootErr || 'ok'})`);
  // And the store refuses to record such a path in the first place — defence at both ends.
  const { normalizeProjectPath } = await import('../src/store-path.js');
  check(normalizeProjectPath('C:/x</script><img src=x>') === null, 'a path with angle brackets is not storable');
  check(normalizeProjectPath('C:/Users/dev/proj') === 'C:/Users/dev/proj', 'an ordinary path is untouched');

  // --- writes land in the project you were looking at ---------------------------------
  const page = await (await fetch(base + '/')).text();
  const token = (page.match(/const TOKEN = "([0-9a-f]+)"/) || [])[1];
  check(!!token, 'notes page embeds a launch token');
  const created = await fetch(base + '/api/create?project=' + encodeURIComponent(B), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'typed on B\'s page', category: 'context', importance: 'P3' }),
  });
  check(created.status === 200, 'create on a scoped page succeeds');
  const bNotes = readStickies({ project_path: B, include_global: false, limit: 50 }).map((s) => s.content);
  const aNotes = readStickies({ project_path: A, include_global: false, limit: 50 }).map((s) => s.content);
  check(bNotes.some((c) => c.includes("typed on B's page")), 'the note filed under B (the page you typed it on)');
  check(!aNotes.some((c) => c.includes("typed on B's page")), 'the note did NOT file under the launch project');

  // --- board writeback is gated three ways --------------------------------------------
  // It is the only route that edits a planning document, so: mutation gate, opt-in env gate,
  // and the project allowlist. Default-off is the important one — a dashboard must not gain the
  // power to rewrite ROADMAP.md just by being open.
  const wbNoToken = await fetch(base + '/api/board/status', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase: 'phase-1', column: 'done' }),
  });
  check(wbNoToken.status === 403, `writeback without the token => 403 (got ${wbNoToken.status})`);

  const wbOff = await fetch(base + '/api/board/status', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ phase: 'phase-1', column: 'done' }),
  });
  const wbOffBody = await wbOff.json();
  check(wbOff.status === 403 && wbOffBody.error === 'writeback disabled',
    `writeback is OFF unless STICKIES_BOARD_WRITEBACK=1 (got ${wbOff.status} ${wbOffBody.error})`);
  check(/STICKIES_BOARD_WRITEBACK/.test(wbOffBody.detail || ''), 'and the refusal names the switch that enables it');
  check(readFileSync(join(A, '.planning', 'ROADMAP.md'), 'utf8').includes('**Status:** Planned'),
    'and the roadmap was not touched');

  const boardOff = await (await fetch(base + '/board')).text();
  check(/const WRITEBACK = false/.test(boardOff), 'the board page reports writeback off');
  check(!/const WB_TOKEN = "/.test(boardOff), 'and is handed no mutation token it cannot use');

  const badCreate = await fetch(base + '/api/create?project=' + encodeURIComponent(D), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stickies-token': token },
    body: JSON.stringify({ content: 'should never exist', category: 'context', importance: 'P3' }),
  });
  check(badCreate.status === 403, `create against an unregistered project => 403 (got ${badCreate.status})`);

  // --- writeback ENABLED: a real edit, still fully scoped ------------------------------
  const wbPort = WB_PORT;
  const wbBase = `http://127.0.0.1:${wbPort}`;
  const wbSrv = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/dashboard.js', '--port', String(wbPort), '--project', A],
    { env: { ...env, STICKIES_BOARD_WRITEBACK: '1' } }
  );
  wbSrv.stderr.on('data', (d) => process.stdout.write('  wb-srv: ' + d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await fetch(wbBase + '/api/health'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) throw new Error('writeback server did not start');

    const wbPage = await (await fetch(wbBase + '/board')).text();
    const wbToken = (wbPage.match(/const WB_TOKEN = "([0-9a-f]+)"/) || [])[1];
    check(/const WRITEBACK = true/.test(wbPage), 'the board page reports writeback on');
    check(!!wbToken, 'and carries a mutation token');
    check(wbPage.includes("d.draggable = true"), 'cards are made draggable');

    // --- what the SERVED PAGE must contain ---------------------------------------------
    // Only structural facts belong here. The drag client's *behaviour* — the one-at-a-time
    // lock, which 403 gets which message, warnings appending rather than replacing, the
    // pending cue — is driven for real in test/board-client-test.mjs, because asserting that
    // `if (PENDING) return;` appears in the page source proves the characters shipped and
    // nothing else. A regression that silently killed every drag passed that kind of check.
    check(/id="moveBar"/.test(wbPage), 'a keyboard/touch route to a move exists (HTML5 drag fires on neither)');
    check(/role', 'status'/.test(wbPage) && /aria-live', 'polite'/.test(wbPage), 'toast outcomes are announced to a screen reader');
    check(/col\.contains\(e\.relatedTarget\)/.test(wbPage), 'the dropzone outline does not strobe as the pointer crosses cards');
    check(/DRAGGING\.lane === String\(laneWave\)/.test(wbPage), 'a swimlane drop cannot promise a lane the move will not deliver');

    // Move A's only phase (no partially-ticked boxes, so the move holds) to done.
    const moved = await (await fetch(wbBase + '/api/board/status?project=' + encodeURIComponent(A), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': wbToken },
      body: JSON.stringify({ phase: 'phase-1', column: 'done' }),
    })).json();
    check(moved.ok && moved.changed, `the phase moved (${JSON.stringify(moved.reason || 'ok')})`);
    check(readFileSync(join(A, '.planning', 'ROADMAP.md'), 'utf8').includes('**Status:** Complete'),
      "A's ROADMAP.md was actually rewritten");

    // The board must now agree with the file — writeback is only real if the derive follows.
    const reBoard = await (await fetch(wbBase + '/api/board?project=' + encodeURIComponent(A))).json();
    check((reBoard.columns.done || []).some((c) => c.title === 'ALPHA-ONLY'), 'and the board now shows it under Done');

    // Scoping still applies to the write path.
    const wbBad = await fetch(wbBase + '/api/board/status?project=' + encodeURIComponent(D), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': wbToken },
      body: JSON.stringify({ phase: 'phase-7', column: 'done' }),
    });
    check(wbBad.status === 403, `writeback to an unregistered project => 403 (got ${wbBad.status})`);
    check(readFileSync(join(D, '.planning', 'ROADMAP.md'), 'utf8').includes('**Status:** Planned'),
      "D's roadmap was not touched");

    // A partially-checked phase must be refused with an explanation, not silently written.
    writeFileSync(join(B, '.planning', 'ROADMAP.md'),
      '### Phase 9: BRAVO-ONLY\n**Status:** In progress\n- [x] 09-01 plan\n- [ ] 09-02 plan\n');
    const wbHold = await fetch(wbBase + '/api/board/status?project=' + encodeURIComponent(B), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': wbToken },
      body: JSON.stringify({ phase: 'phase-9', column: 'done' }),
    });
    const wbHoldBody = await wbHold.json();
    check(wbHold.status === 409, `a move that would not hold => 409 (got ${wbHold.status})`);
    check(wbHoldBody.wouldNotHold && /checkbox/i.test(wbHoldBody.reason), 'with the checkbox rule explained');

    const missing = await fetch(wbBase + '/api/board/status', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': wbToken },
      body: JSON.stringify({ phase: 'phase-1' }),
    });
    check(missing.status === 400, `a request missing "column" => 400 (got ${missing.status})`);
  } finally {
    wbSrv.kill();
  }
} catch (err) {
  console.log('  FAIL  ' + (err?.message || err));
  fail++;
} finally {
  srv.kill();
}

console.log(fail ? `\nproject-scope: ${fail} FAILED` : '\nproject-scope: all passed');

// Windows will not unlink an open sqlite file, so close our handle first — and never let a
// cleanup EPERM turn a green run red (the temp dir is disposable either way).
try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* left for the OS to reap */ }
process.exit(fail ? 1 : 0);
