// One folder, two spellings, one row.
//
// projectIdentity() folds Windows path casing on the READ path — readStickies() scopes on
// project_key, which is built from it — but none of the aggregates did. They grouped on the raw
// stored project_path, so a folder written to from two shells that capitalised it differently
// came back as TWO projects with the counts split between them: twelve notes shown as seven and
// five in the command centre, counted as two projects by apprentice, and reported five-of-twelve
// by the session report.
//
// Asserted against the real artifacts — the running dashboard's JSON, the `stickies apprentice`
// CLI, and the SessionEnd hook process — not against the helpers, because a helper test stays
// green when someone deletes the call to it.
//
// PLATFORM-CONDITIONAL BY DESIGN. On POSIX `<root>/Proj` and `<root>/proj` are two real
// directories holding two real projects, and folding them would pour one project's notes into
// the other. This suite asserts the opposite outcome there, and says which one it is checking.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort, scratchDir, cleanup, authHeaders, killAndWait } from './_env.mjs';

const WIN = process.platform === 'win32';
const SCRATCH = scratchDir('casesplit');
const HOME = join(SCRATCH, 'home');
const DB = join(SCRATCH, 'notes.db');

// Isolation. STICKIES_DB (not STICKIES_HOME alone) is what actually moves the store off the
// developer's real ~/.stickies/notes.db. The sync vars are blanked so a dismiss cannot pull the
// real note repo in, and the DISCORD webhook is blanked because it IS set in this machine's user
// environment — a spawned hook would otherwise post this test's fixture notes to a real channel.
const ENV = {
  ...process.env,
  STICKIES_DB: DB,
  STICKIES_HOME: HOME,
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  STICKIES_DISCORD_WEBHOOK: '',
};
Object.assign(process.env, {
  STICKIES_DB: DB,
  STICKIES_HOME: HOME,
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  STICKIES_DISCORD_WEBHOOK: '',
});

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
console.log(`  (platform: ${process.platform} — two spellings are ${WIN ? 'ONE folder' : 'TWO folders'} here)`);

// Two spellings of the same path. On Windows these address one directory; on POSIX, two.
const UPPER = join(SCRATCH, 'Proj');
const LOWER = join(SCRATCH, 'proj');
mkdirSync(UPPER, { recursive: true });
mkdirSync(LOWER, { recursive: true });

const EXPECTED_ROWS = WIN ? 1 : 2;

const { createSticky } = await import('../src/store.js');
for (let i = 0; i < 7; i++) createSticky({ content: `parked upper ${i}`, category: 'todo', importance: 'P1', project_path: UPPER });
for (let i = 0; i < 5; i++) createSticky({ content: `parked lower ${i}`, category: 'todo', importance: 'P2', project_path: LOWER });

const srvs = [];
try {
  // --- 1. the dashboard's command centre -----------------------------------------------------
  // Launched on the LOWER-case spelling deliberately. The folded row displays whichever spelling
  // canonicalSpelling() picks — here the upper-case one — so a dashboard that still compared the
  // launch path as a STRING would fail to recognise its own project, add it a second time with
  // zeroed counts, and highlight nothing. Launching on the spelling that happens to be displayed
  // would hide exactly that.
  const PORT = await freePort();
  const srv = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/dashboard.js', '--port', String(PORT), '--project', LOWER],
    { env: ENV });
  srvs.push(srv);
  srv.stderr.on('data', (d) => process.stdout.write('  srv: ' + d));
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(base + '/api/health'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('dashboard did not start');
  const AUTH = authHeaders(HOME);
  if (!AUTH['x-stickies-key']) throw new Error('no dashboard auth key was written — cannot authorize the test client');

  const cmd = await (await fetch(base + '/api/command', { headers: AUTH })).json();
  const mine = cmd.projects.filter((p) => /[/\\]proj$/i.test(p.project_path));
  const shown = () => mine.map((p) => `${p.stickies.total}@${p.project_path}`).join(' | ');
  check(mine.length === EXPECTED_ROWS, `/api/command lists the folder ${EXPECTED_ROWS === 1 ? 'ONCE' : 'twice'} (got ${mine.length}: ${shown()})`);
  check(mine.reduce((n, p) => n + p.stickies.total, 0) === 12, `no notes are lost or double-counted (${shown()})`);
  check(mine.filter((p) => p.current).length === 1, `exactly one row is flagged as the project the dashboard is serving (${shown()})`);
  if (WIN) {
    check(mine[0] && mine[0].stickies.total === 12, `the single row carries all 12 notes (got ${mine[0] && mine[0].stickies.total})`);
    check(mine[0] && mine[0].stickies.p1 === 7, `and the P1 tally survives the fold (got ${mine[0] && mine[0].stickies.p1})`);
    check(cmd.totals.projects === 1, `the command-centre header counts 1 project (got ${cmd.totals.projects})`);
    // Deliberate, not arbitrary: a spelling picked per-run would make the card re-label itself
    // between refreshes.
    const again = await (await fetch(base + '/api/command', { headers: AUTH })).json();
    const path2 = again.projects.filter((p) => /[/\\]proj$/i.test(p.project_path))[0];
    check(path2 && mine[0] && path2.project_path === mine[0].project_path, 'the displayed spelling is the same on the next refresh');
  }

  // The header's project switcher, from the same registered set.
  const list = await (await fetch(base + '/api/projects', { headers: AUTH })).json();
  const listed = list.projects.filter((p) => /[/\\]proj$/i.test(p.project_path));
  check(listed.length === EXPECTED_ROWS, `/api/projects offers the folder ${EXPECTED_ROWS === 1 ? 'once' : 'twice'} (got ${listed.length}: ${listed.map((p) => p.project_path).join(' | ')})`);
  check(listed.filter((p) => p.current).length === 1, 'and marks exactly one of them as the current project');

  await killAndWait(srv);

  // --- 2. the apprentice CLI ------------------------------------------------------------------
  // Build-conditional, for the same reason src/dashboard.js resolves apprentice with an optional
  // import: this file is ported verbatim to the public tree, which does not have the feature, and
  // any divergence here becomes a hand-merge on every release — which is the exact process that
  // let the inlined engine drift nine credential patterns behind. Skipping is announced rather
  // than silent, so a build that has apprentice and somehow stops testing it is visible.
  if (existsSync('src/apprentice.js')) {
    const cli = await run(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'apprentice', '--json']);
    check(cli.code === 0, `stickies apprentice exits 0 (got ${cli.code}${cli.code === 0 ? '' : ` — ${cli.err.trim().slice(0, 200)}`})`);
    let report = null;
    try { report = JSON.parse(cli.out); } catch { /* asserted below */ }
    check(report !== null, 'apprentice emits parseable JSON');
    check(report && report.totals.projects === EXPECTED_ROWS, `apprentice counts ${EXPECTED_ROWS} project(s) (got ${report && report.totals.projects})`);

    const prose = await run(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'apprentice']);
    check(new RegExp(`· ${EXPECTED_ROWS} projects\\b`).test(prose.out), `the prose report the user reads says "${EXPECTED_ROWS} projects"`);
  } else {
    console.log('  SKIP  apprentice CLI — not in this build (no src/apprentice.js)');
  }

  // --- 3. the SessionEnd report hook ----------------------------------------------------------
  // Driven as the real process, with globalThis.fetch replaced in the driver BEFORE the hook is
  // imported — so the report is genuinely built and rendered, and nothing leaves the machine. A
  // driver (rather than an env var) because if it failed to apply, the hook would simply never
  // load, instead of quietly reaching the network.
  const capture = join(SCRATCH, 'posted.json');
  const driver = join(SCRATCH, 'hook-driver.mjs');
  writeFileSync(driver, [
    "import { writeFileSync } from 'node:fs';",
    `globalThis.fetch = async (url, init) => { writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null })); return { ok: true, status: 204 }; };`,
    `await import(${JSON.stringify(pathToFileURL(resolve('src/session-report.js')).href)});`,
  ].join('\n'));

  const { writeMarker } = await import('../src/session-marker.js');
  const SESSION = 'casesplit-session';
  writeMarker(SESSION, LOWER);
  // Backdate the window so every fixture note falls inside it.
  const mpath = join(HOME, 'sessions', `${SESSION}.json`);
  const marker = JSON.parse(readFileSync(mpath, 'utf8'));
  marker.started_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(mpath, JSON.stringify(marker));

  // A syntactically valid Discord URL so parseWebhook() accepts it; the stub above is what
  // actually receives it. The id is fake and could not post to a real channel even unstubbed.
  const hookEnv = { ...ENV, STICKIES_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/0/test-only' };
  const hook = await run(process.execPath, ['--disable-warning=ExperimentalWarning', driver], {
    env: hookEnv,
    stdin: JSON.stringify({ cwd: LOWER, session_id: SESSION }),
  });
  check(hook.code === 0, `the session-report hook exits 0 (got ${hook.code}${hook.code === 0 ? '' : ` — ${hook.err.trim().slice(0, 200)}`})`);
  check(existsSync(capture), 'the hook built and posted a report');
  if (existsSync(capture)) {
    const posted = JSON.parse(readFileSync(capture, 'utf8'));
    const parked = JSON.stringify(posted.body).match(/Parked \((\d+)\)/);
    const expectParked = WIN ? 12 : 5; // scoped to the lower-case spelling
    check(parked && Number(parked[1]) === expectParked,
      `the posted report says "Parked (${expectParked})" (got ${parked ? parked[1] : 'no Parked section'})`);
  }
} finally {
  for (const s of srvs) await killAndWait(s);
  const { closeDb } = await import('../src/db.js');
  closeDb();
  cleanup(SCRATCH);
}

function run(cmd, args, { env = ENV, stdin = null } = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => res({ code, out, err }));
    if (stdin !== null) p.stdin.write(stdin);
    p.stdin.end();
  });
}

console.log(fail ? `\nproject-case-aggregate: ${fail} FAILED` : '\nproject-case-aggregate: all passed');
process.exit(fail ? 1 : 0);
