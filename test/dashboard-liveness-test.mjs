// The statusline must not draw a link to a port nothing serves.
//
// Both statuslines wrapped their segment in an OSC 8 hyperlink unconditionally, on a premise
// their own comments stated: "the SessionStart hook starts a dashboard if none is running." That
// premise died when autostart became opt-in, and nobody revisited the link — so on every machine
// without STICKIES_DASHBOARD_AUTOSTART=1, and on every machine that has rebooted since the last
// manual `stickies dashboard`, Ctrl+click landed on ERR_CONNECTION_REFUSED.
//
// The reboot case is the one that made this recur rather than merely happen: the dashboard is
// detached, so it survives every session but no restart, and it leaves its pidfile behind when it
// dies that way. A check that only asked "does the pidfile exist?" would therefore pass in exactly
// the situation being fixed. That is what `stale pidfile` below pins.
//
// These assertions drive the RENDERED BYTES of both statuslines, not dashboardLikelyUp() alone —
// the bug was never in a predicate, it was in a caller that did not consult one.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, scratchDir, cleanup } from './_env.mjs';

const ROOT = scratchDir('liveness');
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
const DB = join(ROOT, 'live.db');
mkdirSync(HOME, { recursive: true });
mkdirSync(join(PROJ, '.planning'), { recursive: true });

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const PORT = await freePort();

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// A board with something on it, so the flow segment has a reason to render at all (it prints
// nothing for a project with no ROADMAP, and "no link" would then be trivially true).
writeFileSync(join(PROJ, '.planning', 'ROADMAP.md'), [
  '# Roadmap', '',
  '### Phase 1: shipped', '- [x] done thing', '',
  '### Phase 2: in flight', '- [ ] pending thing', '',
].join('\n'));

// And a note, for the same reason: the stickies segment renders nothing for a project with no
// stickies, so without this "no link" would hold trivially for it in every case below.
process.env.STICKIES_DB = DB;
process.env.STICKIES_HOME = HOME;
const { createSticky } = await import('../src/store.js');
createSticky({ content: 'a note to render', category: 'context', project_path: PROJ });

const pidFile = join(HOME, `dashboard-${PORT}.pid`);
const writePid = (pid) => writeFileSync(pidFile, JSON.stringify({ pid, nonce: 'n'.repeat(32) }));

const env = {
  ...process.env,
  STICKIES_HOME: HOME,
  STICKIES_DB: DB,
  STICKIES_DASHBOARD_PORT: String(PORT),
  // The renderers must be judged on the dashboard's liveness alone. TMUX and NO_COLOR both
  // suppress or reshape output on their own, and a developer running the suite inside tmux would
  // otherwise get a green "no link" for entirely the wrong reason.
  TMUX: '',
  STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_DISCORD_WEBHOOK: '',
};

// OSC 8 is `ESC ] 8 ; ; <uri> ESC \`. Testing for the introducer rather than for the URL means the
// assertion still means "is this clickable" if the link's query string is ever changed.
const OSC8 = '\x1b]8;;';
const render = (script) =>
  execFileSync(process.execPath, [join(SRC, script), '--project', PROJ, '--no-color'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });

const SEGMENTS = [['flow/statusline.js', '📋 board'], ['statusline.js', '🟨 stickies']];

try {
  const { dashboardLikelyUp } = await import('../src/dashboard-liveness.js');
  process.env.STICKIES_HOME = HOME;

  // --- no pidfile: a fresh machine, or one that has never opted in ---------------------
  rmSync(pidFile, { force: true });
  check(dashboardLikelyUp(PORT) === false, 'no pidfile => not up');
  for (const [script, label] of SEGMENTS) {
    const out = render(script);
    check(out.length > 0, `${label}: still renders its counts with no dashboard`);
    check(!out.includes(OSC8), `${label}: renders NO link when nothing is listening`);
  }

  // --- stale pidfile: the reboot case, and the reason this recurs ----------------------
  // A pid that cannot exist. Every platform Node supports keeps pids well under this, and
  // process.kill(_, 0) rejects it without ever addressing a live process — so this can never
  // become a flake that kills something real.
  const DEAD_PID = 0x7ffffffe;
  writePid(DEAD_PID);
  check(dashboardLikelyUp(PORT) === false, 'pidfile naming a dead pid => not up (survives a reboot)');
  for (const [script, label] of SEGMENTS) {
    check(!render(script).includes(OSC8), `${label}: renders NO link for a stale pidfile`);
  }

  // --- a live dashboard: the link must come back --------------------------------------
  // This process is alive by definition, which keeps the assertion honest without binding a
  // port: the predicate's job is liveness of the recorded pid, and nothing here should depend
  // on a real HTTP server to prove the caller consults it.
  writePid(process.pid);
  check(dashboardLikelyUp(PORT) === true, 'pidfile naming a live pid => up');
  for (const [script, label] of SEGMENTS) {
    check(render(script).includes(OSC8), `${label}: renders the link again once one is running`);
  }

  // --- the OLDER suppression reasons still win, on BOTH segments ------------------------
  // The liveness gate is an ADDITIONAL reason to suppress the link, never a replacement for the
  // reasons that already existed. Both are asserted here because a review found neither was
  // pinned for both scripts: deleting `!process.env.TMUX &&` from both call sites left the whole
  // suite green, and `--no-link` was covered for the flow segment only. A guard nothing tests is
  // a guard the next edit deletes — under tmux that one mangles every prompt render.
  const renderWith = (script, extraArgs = [], extraEnv = {}) =>
    execFileSync(process.execPath, [join(SRC, script), '--project', PROJ, '--no-color', ...extraArgs],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  for (const [script, label] of SEGMENTS) {
    check(!renderWith(script, ['--no-link']).includes(OSC8),
      `${label}: --no-link still suppresses the link while a dashboard is up`);
    check(!renderWith(script, [], { TMUX: '/tmp/tmux-1000/default,1234,0' }).includes(OSC8),
      `${label}: TMUX still suppresses the link while a dashboard is up`);
  }

  // --- hostile pidfile shapes -----------------------------------------------------------
  // pid 0 is the one that matters: process.kill(0, 0) NEVER fails — on POSIX it addresses the
  // caller's own process group — so a `{"pid":0}` file reads as up forever. Unlike a recycled
  // pid, which dies eventually, that false positive does not self-heal.
  for (const [label, body] of [
    ['{"pid":0}', JSON.stringify({ pid: 0, nonce: 'n'.repeat(32) })],
    ['{"pid":-1}', JSON.stringify({ pid: -1, nonce: 'n'.repeat(32) })],
    ['{"pid":1.5}', '{"pid":1.5,"nonce":"nnnn"}'],
    ['pid as string', '{"pid":"1234","nonce":"nnnn"}'],
  ]) {
    writeFileSync(pidFile, body);
    check(dashboardLikelyUp(PORT) === false, `non-positive/non-integer pid rejected: ${label}`);
  }

  // A directory where the pidfile should be: must answer rather than throw, because this runs on
  // the prompt-render path. NOTE this assertion does NOT prove the isFile() guard — readFileSync
  // throws EISDIR and the catch handles it either way, so it holds with the guard removed. It is
  // kept as a contract check, not as cover for the guard, and labelled so nobody assumes
  // otherwise. isFile()'s real target is a POSIX FIFO, where open(2) BLOCKS rather than throwing
  // and would hang the prompt; that cannot be built on Windows, so it is genuinely unpinned here.
  // Written down rather than left to look covered — this project has shipped a guard test whose
  // fixture never reached the code it claimed to protect.
  rmSync(pidFile, { force: true });
  mkdirSync(pidFile, { recursive: true });
  check(dashboardLikelyUp(PORT) === false, 'a DIRECTORY at the pidfile path => not up, no throw (contract, not guard cover)');
  rmSync(pidFile, { recursive: true, force: true });

  // The size cap, pinned by the ONE shape that distinguishes it. A file of junk proves nothing —
  // JSON.parse fails and Number() gives NaN, so it returns null cap or no cap. This is a VALID
  // pidfile naming a LIVE pid, padded past the cap with whitespace that .trim() would remove: read
  // it and you get a live pid and a link; refuse it on size and you do not. First version of this
  // assertion used 64 KB of 'x' and passed with the guard deleted.
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, nonce: 'n'.repeat(32) }) + ' '.repeat(8192));
  check(dashboardLikelyUp(PORT) === false, 'a VALID pidfile padded past the size cap is refused (not merely unparseable)');
  for (const [script, label] of SEGMENTS) {
    check(!render(script).includes(OSC8), `${label}: renders NO link for an over-cap pidfile`);
  }

  // --- a legacy bare-number pidfile is still understood ---------------------------------
  // Written by a dashboard from before the ownership nonce. It is too weak to authorize a
  // --stop, but it is ample for deciding whether to draw an underline, and refusing it would
  // hide a working link from anyone who has not restarted their dashboard since upgrading.
  writeFileSync(pidFile, String(process.pid));
  check(dashboardLikelyUp(PORT) === true, 'legacy bare-number pidfile is still read as up');

  // --- a corrupt pidfile fails to "not up", never throws --------------------------------
  // This runs on every prompt render; an exception here is a statusline that vanishes.
  writeFileSync(pidFile, '{"pid": not json');
  check(dashboardLikelyUp(PORT) === false, 'corrupt pidfile => not up, no throw');
  writeFileSync(pidFile, '');
  check(dashboardLikelyUp(PORT) === false, 'empty pidfile => not up, no throw');
} finally {
  rmSync(pidFile, { recursive: true, force: true });
  // Close the sqlite handle BEFORE cleanup. Without this, rmSync hits EBUSY on Windows, burns all
  // eight retries in _env.mjs (~1s) and gives up silently — leaving a scratch dir with a live WAL
  // behind on EVERY run. Verified: 33+ stickies_liveness_* dirs had accumulated in %TEMP% from one
  // afternoon's runs. Ten other suites already do this; this one inherited the omission.
  try { const { closeDb } = await import('../src/db.js'); closeDb(); } catch { /* never fatal */ }
  cleanup(ROOT);
}

console.log(fail === 0 ? 'dashboard-liveness: OK' : `dashboard-liveness: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
