// `stickies doctor` tests.
//
// The point of doctor is to make invisible breakage visible, so the tests that matter are the
// ones proving it does NOT report healthy when something is wrong — above all the stale-plugin
// trap: an installed copy holding different bytes at the SAME version number, which no plugin
// update will refresh and which silently disables every hook-side feature.
//
// Hermetic via CLAUDE_CONFIG_DIR (a synthetic ~/.claude), STICKIES_DB, and a dead port.

import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { freePort, scratchDir } from './_env.mjs';
import { join } from 'node:path';

const ROOT = scratchDir('doctor');
const DOC_PORT = await freePort();
rmSync(ROOT, { recursive: true, force: true });
const CLAUDE = join(ROOT, 'claude');
const DB = join(ROOT, 'doc.db');
const PROJ = join(ROOT, 'proj');
mkdirSync(join(CLAUDE, 'plugins'), { recursive: true });
mkdirSync(join(PROJ, '.planning'), { recursive: true });
writeFileSync(join(PROJ, '.planning', 'ROADMAP.md'), '### Phase 1: Only\n**Status:** Planned\n- [ ] 01-01\n');

Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: CLAUDE,
  STICKIES_DB: DB,
  // Without STICKIES_HOME this suite wrote dashboard-<port>.pid files into the developer's REAL
  // ~/.stickies, and the dashboard it spawns read their REAL session markers — so its project
  // allowlist was the actual machine's rather than a fixture.
  STICKIES_HOME: join(ROOT, 'home'),
  STICKIES_DASHBOARD_PORT: String(DOC_PORT), // deliberately dead for most of the run
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  STICKIES_DISCORD_WEBHOOK: '',
});
delete process.env.FORCE_HYPERLINK;

const { runDoctor, renderDoctor, ROOT: SRC_ROOT } = await import('../src/doctor.js');

// Read the live version rather than hardcoding one: the "same version" case is the whole point
// of the stale-install check, so it has to keep meaning "same as whatever this repo is now" —
// a literal here silently turns into the version-mismatch case on the next bump.
const OUR_VERSION = JSON.parse(readFileSync(join(SRC_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const OTHER_VERSION = OUR_VERSION === '0.0.1' ? '0.0.2' : '0.0.1';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// --- the pin detector must prove what it claims ------------------------------------------
// It used to be "a --project within 400 characters of the flow segment", which reported a pin
// for one written in a COMMENT, or one belonging to a different segment — telling the user to
// remove an argument that was not there. Fixing that must not lose the true positive: a real
// composer puts each argument on its own line, so the pin sits several lines below its path.
//
// NB: this block must use check(), like everything else in this file. It first shipped setting
// `process.exitCode`, which the `process.exit(fail ? 1 : 0)` at the bottom silently overwrites —
// so six assertions printed FAIL and the file still exited 0, and `npm test` stayed green.
{
  const { pinsFlowSegment } = await import('../src/doctor.js');
  const seg = (body) => `{ name: 'flow', args: [\n  'x/src/flow/statusline.js',\n${body}\n] },`;
  const pinCases = [
    ['a pin several lines below the path is found', seg("  '--project',\n  'C:/p',"), true],
    ['a --project in a line comment is not a pin', seg('  // remove --project to follow cwd'), false],
    ['a --project in a block comment is not a pin', seg('  /* --project would pin it */'), false],
    ['a pin on the NOTES segment is not the board segment',
      `{ name: 'flow', args: ['x/src/flow/statusline.js'] },\n{ name: 'n', args: ['x/src/statusline.js', '--project', 'C:/p'] },`, false],
    ['no pin anywhere', `{ name: 'flow', args: ['x/src/flow/statusline.js'] },`, false],
    ['the single-line shell form still counts', 'node x/src/flow/statusline.js --project C:/p', true],
    // A composer that chains two path-qualified segments on ONE line: the scan must stop at the
    // second script, not run to the end of the string and find its --project.
    ['a later path-qualified segment ends the scan',
      'node a/src/flow/statusline.js && node b/src/statusline.js --project /a/b', false],
    ['…including with a semicolon', 'node a/src/flow/statusline.js; node other/statusline.js --project /x', false],
  ];
  for (const [label, text, want] of pinCases) {
    check(pinsFlowSegment(text) === want, label);
  }
}

// --- the report is meant to be pasted into a bug report -----------------------------------
// Unredacted it hands over the OS username, the home layout, private repo folder names and the
// notes-backup location. This is the whole reason the command exists, so the default must be safe.
{
  const { tildify, renderDoctor } = await import('../src/doctor.js');
  const HOME = 'C:\\Users\\somebody';
  check(tildify('at C:\\Users\\somebody\\.stickies\\x.db', HOME) === 'at ~\\.stickies\\x.db', 'a Windows home path is abbreviated');
  check(tildify('at C:/Users/somebody/.claude', HOME) === 'at ~/.claude', 'and the forward-slash form of the same path');
  check(tildify('at c:/users/SOMEBODY/x', HOME) === 'at ~/x', 'case-insensitively, as Windows hands them to us');
  check(tildify('/home/somebody/x', '/home/somebody') === '~/x', 'and a POSIX home');
  check(!tildify('C:\\Users\\somebody\\p', HOME).toLowerCase().includes('somebody'), 'the username never survives');
  // Boundary: a DIFFERENT directory that merely starts with the home string must be left alone.
  // `C:\Users\somebodyelse` became `~else`, i.e. the report claimed a file was under your home
  // when it was not — a wrong statement in a document whose only job is to be accurate.
  check(tildify('C:\\Users\\somebodyelse\\x', HOME) === 'C:\\Users\\somebodyelse\\x', 'a longer sibling directory is not redacted');
  check(tildify('/home/somebodyelse/x', '/home/somebody') === '/home/somebodyelse/x', 'and the same on POSIX');
  check(tildify('C:\\Users\\somebody', HOME) === '~', 'the bare home path alone still becomes ~');
  // Git Bash renders the same directory as /c/Users/... — this project's own dev shell.
  check(tildify('/c/Users/somebody/x', HOME) === '~/x', 'the Git-Bash form of the home path is redacted too');
  // A degenerate home must not turn every separator into a tilde.
  check(tildify('/home/somebody/proj', '/') === '/home/somebody/proj', 'a root home is ignored rather than mangling everything');
  check(tildify('C:\\Users\\somebody\\p', 'C:\\') === 'C:\\Users\\somebody\\p', 'and so is a drive root');
  // JSON form, so `doctor --json` redacts as well as the rendered report.
  check(tildify(JSON.stringify({ p: 'C:\\Users\\somebody\\x' }), HOME) === JSON.stringify({ p: '~\\x' }),
    'the JSON-escaped form is redacted too');
  const fakeReport = {
    root: 'C:\\Users\\somebody\\dev\\stickies',
    checks: [{ name: 'store', status: 'ok', detail: 'at C:\\Users\\somebody\\.stickies\\stickies.db', fix: 'see C:\\Users\\somebody\\x' }],
    counts: { ok: 1 }, ok: true,
  };
  const rendered = renderDoctor(fakeReport, { home: HOME });
  check(!rendered.includes('somebody'), 'a rendered report leaks no username, in details or fixes');
  check(rendered.includes('~'), 'and says ~ instead');
  check(renderDoctor(fakeReport, { raw: true, home: HOME }).includes('somebody'), '--raw opts back into full paths for local debugging');
}
const find = (r, name) => r.checks.filter((c) => c.name === name);
const one = (r, name) => find(r, name)[0];

function writeInstalled(installPath) {
  writeFileSync(join(CLAUDE, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'stickies@stickies-local': [{ scope: 'user', installPath, version: OUR_VERSION }] },
  }));
}

// A fake "installed copy": same declared version, but only one src file and a modified one at
// that — the exact shape of the trap.
function fakeStaleInstall(dir, version) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stickies-mcp', version }));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stickies', version }));
  copyFileSync(join(SRC_ROOT, 'src', 'db.js'), join(dir, 'src', 'db.js'));
  writeFileSync(join(dir, 'src', 'db.js'), '// a stale copy\n', { flag: 'w' });
}

try {
  // --- no ~/.claude content at all: degrade, never crash -------------------------------
  let r = await runDoctor({ project: PROJ });
  check(Array.isArray(r.checks) && r.checks.length >= 5, `doctor returns a full report (${r.checks.length} checks)`);
  check(one(r, 'plugin install').status === 'unknown', 'no installed_plugins.json => plugin check is "unknown", not a crash');
  check(one(r, 'statusline').status === 'warn', 'no statusLine configured => warn');
  check(typeof renderDoctor(r) === 'string' && renderDoctor(r).includes('Stickies doctor'), 'renders human-readable text');

  // --- dashboard down is BAD (this is the bug that made Ctrl+click do nothing) ---------
  check(one(r, 'dashboard').status === 'bad', 'no dashboard listening => bad');
  // Pinned on substance, not phrasing: it must name the statusline AND say what happens to the
  // link. The old assertion matched the literal words "nowhere to land", which stopped being true
  // when the statusline started withholding the link instead of offering a dead one — so the
  // sentence had to change, and this check went red for a message that had gotten MORE accurate.
  const down = one(r, 'dashboard').detail;
  check(/statusline/.test(down) && /link/.test(down), 'and it explains the consequence for the statusline link');
  check(!!one(r, 'dashboard').fix, 'and offers a fix');
  check(r.ok === false, 'report.ok is false when anything is bad');

  // --- the store + board checks -------------------------------------------------------
  check(find(r, 'store').some((c) => c.status === 'ok'), 'store reads');
  check(find(r, 'store').some((c) => /temp dir/.test(c.detail)), 'a temp-dir store is called out as scratch');
  check(one(r, 'flow board').status === 'ok', 'a project with a ROADMAP.md reports a board');
  const noBoard = await runDoctor({ project: join(ROOT, 'nope') });
  check(one(noBoard, 'flow board').status === 'warn', 'a project without a ROADMAP.md warns instead of failing');
  check(one(r, 'sync').status === 'ok' && /not configured/.test(one(r, 'sync').detail), 'unconfigured sync is fine, not an error');

  // --- THE TRAP: stale install at an identical version --------------------------------
  const stale = join(ROOT, 'stale-install');
  fakeStaleInstall(stale, OUR_VERSION);
  writeInstalled(stale);
  r = await runDoctor({ project: PROJ });
  let pi = one(r, 'plugin install');
  check(pi.status === 'bad', `same-version stale install => bad (got ${pi.status})`);
  check(/STALE/.test(pi.detail) && /same version/i.test(pi.detail), 'the message says stale AND same-version');
  check(/differ/.test(pi.detail) && /missing/.test(pi.detail), 'it quantifies the drift');
  check(/NOT running/.test(pi.detail), 'it states the consequence: hook-side changes are not running');
  check(/bump "version"/.test(pi.fix), 'the fix names the version bump (a reinstall alone would not work)');

  check(/hooks/i.test(pi.detail), 'and says the drift reaches code the hooks execute');
  // Named files, not just counts — "12 files differ" tells you nothing you can act on.
  //
  // This used to pin three specific names (db.js|session-start.js|store.js). doctor prints only
  // the FIRST FOUR drifted files, sorted, so the assertion was really pinning alphabetical
  // position: adding any hook-reachable source file whose name sorts before "db.js" pushed all
  // three out of the sample and turned this red with nothing broken. (src/dashboard-liveness.js
  // did exactly that.) What the check is actually for is that the message names real files, so
  // that is what it now tests — cross-checked against our own src/ tree so a message naming
  // plausible-looking nonsense still fails.
  const named = pi.detail.match(/[\w.-]+\.m?js/g) || [];
  const real = named.filter((f) => existsSync(join(SRC_ROOT, 'src', f)));
  // EVERY name must be real, not merely one of them — `real.length > 0` would pass a message
  // reading `(fnord.js, dashboard-liveness.js, …)`, which is not what the comment above claims.
  check(named.length > 0 && real.length === named.length,
    `naming only real drifted hook files (named: ${named.join(', ') || 'none'})`);

  // --- same version, but the drift does NOT touch hook code => warn, not bad -----------
  // During normal development the installed copy is behind almost constantly. A check that
  // shouts "broken" for a dashboard-only edit trains you to ignore it, so severity turns on
  // whether the changed files are actually reachable from hooks/hooks.json's entrypoints.
  const sideOnly = join(ROOT, 'side-only-install');
  mkdirSync(join(sideOnly, '.claude-plugin'), { recursive: true });
  cpSync(join(SRC_ROOT, 'src'), join(sideOnly, 'src'), { recursive: true });
  cpSync(join(SRC_ROOT, 'hooks'), join(sideOnly, 'hooks'), { recursive: true });
  writeFileSync(join(sideOnly, 'package.json'), JSON.stringify({ name: 'stickies-mcp', version: OUR_VERSION }));
  writeFileSync(join(sideOnly, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stickies', version: OUR_VERSION }));
  // dashboard-page.js is imported by no hook — but SessionStart spawns src/dashboard.js from the
  // installed copy, and that imports it. So this is neither "hooks are running stale code" nor
  // "nothing that runs" — it is the third case, and the message has to say which.
  writeFileSync(join(sideOnly, 'src', 'dashboard-page.js'), '// a launch-side difference\n');
  writeInstalled(sideOnly);
  r = await runDoctor({ project: PROJ });
  pi = one(r, 'plugin install');
  check(pi.status === 'warn', `same-version drift in spawned-only code => warn, not bad (got ${pi.status})`);
  check(/no hook imports/i.test(pi.detail), 'it says no hook imports the drift');
  check(/spawns/i.test(pi.detail) && /autostarted/i.test(pi.detail),
    'and that the autostarted dashboard is nonetheless serving the older copy');
  check(/dashboard-page\.js/.test(pi.detail), 'naming the file that differs');
  check(!find(r, 'plugin install').some((c) => c.status === 'bad'), 'a launch-side-only difference contributes no failure');
  check(/launch/i.test(pi.fix) || /reinstall/i.test(pi.fix), 'and the fix offers both ways out');

  // A file nothing executes at all is the mildest case, and must not borrow the louder message.
  writeFileSync(join(sideOnly, 'src', 'dashboard-page.js'), readFileSync(join(SRC_ROOT, 'src', 'dashboard-page.js')));
  mkdirSync(join(sideOnly, 'src', 'repo-mode'), { recursive: true });
  writeFileSync(join(sideOnly, 'src', 'cli-main.js'), '// a CLI-only difference\n');
  r = await runDoctor({ project: PROJ });
  pi = one(r, 'plugin install');
  check(pi.status === 'warn', `CLI-only drift stays a warn (got ${pi.status})`);
  check(/none of it runs inside the hooks/i.test(pi.detail), 'and gets the mildest wording');
  check(/when you want/.test(pi.fix), 'with a fix phrased as optional, not urgent');

  // --- a DIFFERENT version is only a warn: a normal update fixes that ------------------
  const older = join(ROOT, 'older-install');
  fakeStaleInstall(older, OTHER_VERSION);
  writeInstalled(older);
  r = await runDoctor({ project: PROJ });
  pi = one(r, 'plugin install');
  check(pi.status === 'warn', `version-behind install => warn, not bad (got ${pi.status})`);
  check(/reinstall the plugin/.test(pi.fix) && !/bump/.test(pi.fix), 'and the fix is just a reinstall');

  // --- installed copy IS this copy: in sync by definition -----------------------------
  writeInstalled(SRC_ROOT);
  r = await runDoctor({ project: PROJ });
  check(one(r, 'plugin install').status === 'ok', 'installPath === running copy => ok');
  // Slash direction must not defeat that comparison on Windows.
  writeInstalled(SRC_ROOT.replace(/\\/g, '/').toUpperCase());
  r = await runDoctor({ project: PROJ });
  check(one(r, 'plugin install').status === 'ok', 'the same path in different case/slashes still matches');

  // --- a missing install path is broken ------------------------------------------------
  writeInstalled(join(ROOT, 'does-not-exist'));
  r = await runDoctor({ project: PROJ });
  check(one(r, 'plugin install').status === 'bad', 'an install path that does not exist => bad');

  // --- statusline: wired, pinned, and the Windows link prerequisite -------------------
  const compose = join(CLAUDE, 'compose.mjs');
  writeFileSync(compose, `const SEGMENTS=[{args:['${SRC_ROOT.replace(/\\/g, '/')}/src/flow/statusline.js','--project','C:/somewhere']}];\n`);
  writeFileSync(join(CLAUDE, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${compose}"` } }));
  r = await runDoctor({ project: PROJ });
  check(one(r, 'statusline').status === 'ok', 'a statusline that reaches Stickies via a composer script is detected');
  // Regression: the composer's own PATH here contains "stickies" (the temp dir is named
  // stickies_doctor_test). Doctor used to follow into the script only when the command string
  // did NOT mention stickies, so this exact shape skipped the read and never saw the pin.
  check(find(r, 'statusline pin').length === 1, 'the --project pin is reported even when the composer path itself contains "stickies"');
  check(one(r, 'statusline').detail.includes(compose), 'and it names the file the pin lives in');
  if (process.platform === 'win32') {
    check(find(r, 'statusline link').some((c) => /FORCE_HYPERLINK/.test(c.detail)),
      'on Windows, a missing FORCE_HYPERLINK is reported');
  }

  // An unpinned statusline must NOT report a pin.
  writeFileSync(compose, `const SEGMENTS=[{args:['${SRC_ROOT.replace(/\\/g, '/')}/src/flow/statusline.js']}];\n`);
  r = await runDoctor({ project: PROJ });
  check(find(r, 'statusline pin').length === 0, 'no pin reported when there is no --project argument');

  // --- malformed settings must not take doctor down -----------------------------------
  writeFileSync(join(CLAUDE, 'settings.json'), '{ this is not json');
  r = await runDoctor({ project: PROJ });
  check(one(r, 'statusline').status === 'warn', 'unparseable settings.json degrades to a warn');

  // --- a live dashboard flips that check to ok ----------------------------------------
  const { ensureDashboard } = await import('../src/dashboard-autostart.js');
  const started = await ensureDashboard({ project: PROJ, port: DOC_PORT, confirmMs: 20000, force: true });
  check(started.status === 'started', `test dashboard started (got ${started.status})`);
  r = await runDoctor({ project: PROJ });
  check(one(r, 'dashboard').status === 'ok', 'a live dashboard => ok');
  check(/pid \d+/.test(one(r, 'dashboard').detail), 'and it reports the pid so you can kill it');
  check(find(r, 'statusline link').every((c) => !/no dashboard is running/.test(c.detail)),
    'and the statusline-link check stops warning that none is running');

  // --- ANSWERING BUT UNFINDABLE: healthy dashboard, no pidfile ------------------------
  // The statusline decides whether to draw its link from the pidfile, never from a socket probe
  // — it cannot afford a round trip on every prompt render. So this state is a healthy dashboard
  // with NO link, and doctor used to report it as a plain green tick: the user sees no link,
  // asks the one tool built to explain it, and is told everything is fine. Reachable without
  // malice via a full or read-only $STICKIES_HOME, AV holding the path, or launching the
  // dashboard from a shell whose STICKIES_HOME differs from Claude Code's.
  const { pidFilePath } = await import('../src/dashboard-liveness.js');
  const livePid = pidFilePath(DOC_PORT);
  const saved = readFileSync(livePid, 'utf8');
  rmSync(livePid, { force: true });
  r = await runDoctor({ project: PROJ });
  const orphan = one(r, 'dashboard');
  check(orphan.status === 'warn', `answering with no pidfile => warn, not ok (got ${orphan.status})`);
  check(/is answering/.test(orphan.detail) && /will NOT draw/.test(orphan.detail),
    'and it says the dashboard is fine but the link is gone, which is the confusing part');
  check(!!orphan.fix, 'and offers a fix');
  writeFileSync(livePid, saved); // put it back so the teardown below still finds the pid
} catch (err) {
  console.log('  FAIL  ' + (err?.stack || err));
  fail++;
}

// Kill the dashboard we started (detached, so by port).
try {
  const { execSync } = await import('node:child_process');
  if (process.platform === 'win32') {
    // Anchored: a bare `findstr :4463` is a SUBSTRING match, so it also hit 44630-44639 and
    // force-killed whatever unrelated process was listening there.
    const out = execSync(`netstat -ano -p tcp | findstr /R /C:":${DOC_PORT} "`, { encoding: 'utf8' });
    for (const pid of new Set([...out.matchAll(/LISTENING\s+(\d+)/g)].map((m) => m[1]))) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    }
  } else {
    execSync('kill $(lsof -ti tcp:4463) 2>/dev/null || true');
  }
} catch { /* already gone */ }

console.log(fail ? `\ndoctor: ${fail} FAILED` : '\ndoctor: all passed');
try { (await import('../src/db.js')).closeDb(); } catch {}
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
