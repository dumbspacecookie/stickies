// The dashboard has to be RUNNING for the statusline's Ctrl+click to land, and nothing ever
// started one — so the link pointed at a closed port and the feature looked broken. This
// covers the two halves of fixing that:
//
//   1. ensureDashboard() brings one up, exactly once, and knows when not to try (something
//      else owns the port, or the user opted out).
//   2. a port collision is REPORTED. It used to reach the process as an unhandled 'error'
//      event — a raw stack trace, or under --detach a silent death after the CLI had already
//      printed "started in background" while the port kept serving a different project.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePorts, scratchDir, cleanup } from './_env.mjs';

const ROOT = scratchDir('autostart');
const DB = join(ROOT, 'auto.db');
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
mkdirSync(PROJ, { recursive: true });
mkdirSync(HOME, { recursive: true });

// Ports the OS says are free right now, rather than a fixed block. With fixed ports, anything
// already listening turned this file red with an assertion that is definitionally false
// ("probeHealth on a closed port => null" when someone is on the port).
const [DEAD, FOREIGN, OPT, PORT, BROKEN, CI_PORT, IMPOSTOR] = await freePorts(7);

const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_DISCORD_WEBHOOK: '' };
Object.assign(process.env, { STICKIES_DB: DB, STICKIES_HOME: HOME, ...NO_SYNC });
// Start from a known state for every variable that can disable autostart.
//
// STICKIES_DASHBOARD_AUTOSTART is a documented user setting, so a developer may well have it
// exported. The CI keys matter more: headlessEnvironment() reads them, so on ANY CI provider
// this suite would otherwise assert "a dashboard starts" inside an environment where the code
// correctly refuses to start one — i.e. `npm test` could never pass in CI, which is precisely
// where it most needs to.
for (const k of [
  'STICKIES_DASHBOARD_AUTOSTART',
  'CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE',
  'JENKINS_URL', 'TF_BUILD', 'CODESPACES', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CLOUD_SESSION',
]) delete process.env[k];

const { probeHealth, ensureDashboard, autostartEnabled, readPidFile } = await import('../src/dashboard-autostart.js');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const spawned = [];
const listeners = [];

try {
  // --- the shipped default ------------------------------------------------------------
  // OFF unless asked for. Pinned FIRST, before anything below opts in: every other assertion
  // in this file would pass just as happily if the default silently flipped back to on, so
  // this is the only line standing between a stranger and a web server they never requested.
  check(autostartEnabled() === false, 'unset => autostart is OFF (the shipped default)');
  const offRes = await ensureDashboard({ project: PROJ, port: DEAD, confirmMs: 400 });
  check(offRes.status === 'disabled', `default => no spawn (got ${offRes.status})`);
  check((await probeHealth(DEAD, 400)) === null, 'and nothing is listening as a result');

  // Everything below exercises the OPT-IN path, so turn it on explicitly.
  process.env.STICKIES_DASHBOARD_AUTOSTART = '1';

  // --- nothing listening --------------------------------------------------------------
  check((await probeHealth(DEAD, 500)) === null, 'probeHealth on a closed port => null (nobody home)');

  // --- a foreign listener is left strictly alone --------------------------------------
  const foreign = createServer((req, res) => { res.writeHead(200); res.end('not stickies'); });
  listeners.push(foreign);
  await new Promise((r) => foreign.listen(FOREIGN, '127.0.0.1', r));
  check((await probeHealth(FOREIGN, 700)) === 'foreign', 'probeHealth flags a non-stickies listener as foreign');
  const fr = await ensureDashboard({ project: PROJ, port: FOREIGN, confirmMs: 800 });
  check(fr.status === 'foreign', `ensureDashboard refuses to fight for the port (got ${fr.status})`);

  // --- opt-out ------------------------------------------------------------------------
  process.env.STICKIES_DASHBOARD_AUTOSTART = '0';
  check(autostartEnabled() === false, 'STICKIES_DASHBOARD_AUTOSTART=0 disables autostart');
  const dr = await ensureDashboard({ project: PROJ, port: OPT, confirmMs: 500 });
  check(dr.status === 'disabled', `opted out => no spawn (got ${dr.status})`);
  check((await probeHealth(OPT, 400)) === null, 'nothing was started while opted out');
  // …but an explicit `stickies dashboard --detach` still works (force bypasses the opt-out).
  const forced = await ensureDashboard({ project: PROJ, port: OPT, confirmMs: 20000, force: true });
  check(forced.status === 'started', `force:true starts despite the opt-out (got ${forced.status})`);
  spawned.push(OPT);
  process.env.STICKIES_DASHBOARD_AUTOSTART = '1'; // back to opted-in (unset would now mean off)

  // --- the normal path, and idempotence ------------------------------------------------
  const first = await ensureDashboard({ project: PROJ, port: PORT, confirmMs: 20000 });
  check(first.status === 'started', `ensureDashboard starts a dashboard (got ${first.status})`);
  spawned.push(PORT);
  const health = await probeHealth(PORT, 900);
  check(health && health !== 'foreign' && health.app === 'stickies', 'the started dashboard answers /api/health as ours');
  // The pidfile has to carry something an impostor cannot restate, or it vouches for nothing.
  const ownClaim = readPidFile(PORT);
  check(!!ownClaim && ownClaim.pid === health.pid, 'the dashboard records its own pid where --stop will look');
  check(!!ownClaim && !ownClaim.legacy && /^[0-9a-f]{32}$/.test(ownClaim.nonce || ''),
    'alongside a random ownership nonce');
  // …and that nonce must NOT be published. /api/health is unauthenticated, so anything it
  // returns can be scraped by any local process and replayed after this dashboard dies.
  check(!JSON.stringify(health).includes(ownClaim.nonce),
    'and does NOT publish that nonce on /api/health, where anything local could scrape it');

  const second = await ensureDashboard({ project: PROJ, port: PORT, confirmMs: 8000 });
  check(second.status === 'already', `a second call is a no-op, not a second server (got ${second.status})`);
  check(second.project === PROJ.replace(/\\/g, '/'), 'it reports which project the live instance was launched from');
  const health2 = await probeHealth(PORT, 900);
  check(health2 && health2.pid === health.pid, `and it is the SAME process, not a second one (pid ${health.pid} -> ${health2 && health2.pid})`);

  // --- --stop actually stops it, and only ours -----------------------------------------
  const { stopDashboard } = await import('../src/dashboard-autostart.js');
  const beforeStop = await probeHealth(PORT, 900);
  check(!!beforeStop && beforeStop !== 'foreign', 'a dashboard is up to stop');
  const stopped = await stopDashboard({ port: PORT });
  check(stopped.status === 'stopped', `stopDashboard reports it stopped (got ${stopped.status})`);
  check((await probeHealth(PORT, 700)) === null, 'and the port is genuinely free afterwards');
  const stopAgain = await stopDashboard({ port: PORT });
  check(stopAgain.status === 'not-running', `stopping nothing says so rather than erroring (got ${stopAgain.status})`);
  // A foreign listener must never be killed by a mistyped port.
  const foreignStop = await stopDashboard({ port: FOREIGN });
  check(foreignStop.status === 'foreign', `it refuses to kill a non-Stickies process (got ${foreignStop.status})`);
  check(foreign.listening, 'and that process is still alive');

  // --- --stop will not kill a pid that only the port-holder vouches for ------------------
  // The pid came from the /api/health BODY, so an impostor on the port chose the victim — and
  // 4317 is the OpenTelemetry default, so something else squatting it is ordinary. The kill now
  // requires a matching pidfile, which only a process that could write to STICKIES_HOME has.
  let victimPid = 999999; // a pid we never actually want signalled
  const impostor = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'stickies', pid: victimPid, project: null }));
  });
  listeners.push(impostor);
  await new Promise((r) => impostor.listen(IMPOSTOR, '127.0.0.1', r));
  const impostorStop = await stopDashboard({ port: IMPOSTOR });
  check(impostorStop.status === 'unverified',
    `an impostor answering as Stickies cannot nominate a pid to kill (got ${impostorStop.status})`);
  check(/pidfile/i.test(impostorStop.reason || ''), 'and the refusal says why');
  check(impostor.listening, 'the impostor is left running rather than force-killed');

  // A pidfile that disagrees with the port-holder is equally not proof.
  const { pidFilePath } = await import('../src/dashboard-autostart.js');
  mkdirSync(HOME, { recursive: true });
  writeFileSync(pidFilePath(IMPOSTOR), JSON.stringify({ pid: 123456, nonce: 'x'.repeat(32) }));
  const mismatch = await stopDashboard({ port: IMPOSTOR });
  check(mismatch.status === 'unverified', `a pidfile that disagrees is still refused (got ${mismatch.status})`);
  check(mismatch.claimed === 123456 && mismatch.pid === victimPid, 'and both pids are reported for the user to judge');

  // …and the pid ALONE is not proof either, which is the point of the nonce. A pid is public —
  // it is in the process table — so an impostor can read the recorded one and restate it. Here
  // it does exactly that. Nothing is signalled either way now: --stop ASKS the port-holder to
  // exit, so an impostor that simply does not exit is reported as still running, and no process
  // anywhere is harmed. That is the whole reason for asking rather than killing.
  victimPid = 123456;
  const restated = await stopDashboard({ port: IMPOSTOR });
  check(restated.status === 'still-running',
    `restating the recorded pid gets a stop REQUEST, not a kill (got ${restated.status})`);
  check(impostor.listening, 'and the impostor is still alive, because nothing was signalled');

  // A port-holder that answers the stop request with 403 — i.e. one that implements the route but
  // does not know our nonce — is reported as unverified rather than as a failure to stop.
  const REFUSER = (await freePorts(1))[0];
  const refuser = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/stop') { res.writeHead(403); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'stickies', pid: 123456, project: null }));
  });
  listeners.push(refuser);
  await new Promise((r) => refuser.listen(REFUSER, '127.0.0.1', r));
  writeFileSync(pidFilePath(REFUSER), JSON.stringify({ pid: 123456, nonce: 'b'.repeat(32) }));
  const refused = await stopDashboard({ port: REFUSER });
  check(refused.status === 'unverified', `a port-holder that rejects the nonce is unverified (got ${refused.status})`);
  check(/nonce/i.test(refused.reason || ''), `and the refusal names what was wrong (${refused.reason})`);
  rmSync(pidFilePath(REFUSER), { force: true });
  // A pidfile from before the nonce existed is a weaker claim, and is called out as such rather
  // than being quietly accepted.
  writeFileSync(pidFilePath(IMPOSTOR), '123456');
  const legacy = await stopDashboard({ port: IMPOSTOR });
  check(legacy.status === 'unverified', `a pre-nonce pidfile is refused (got ${legacy.status})`);
  check(/older build/i.test(legacy.reason || ''), 'and says the dashboard predates the check');
  check(readPidFile(IMPOSTOR).legacy === true, 'the reader reports the legacy format rather than guessing');
  victimPid = 999999;
  rmSync(pidFilePath(IMPOSTOR), { force: true });

  // --- headless environments do not get a server nobody can open -----------------------
  const { headlessEnvironment } = await import('../src/dashboard-autostart.js');
  // Every key, not just CI: a guard that only works on one provider is a guard that ships a
  // surprise server to the other six.
  for (const k of ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD', 'CODESPACES']) {
    process.env[k] = 'true';
    check(headlessEnvironment() === k, `${k} is detected as headless`);
    delete process.env[k];
  }
  for (const k of ['CLAUDE_CODE_REMOTE', 'CLAUDE_CLOUD_SESSION']) {
    process.env[k] = '1';
    check(headlessEnvironment() === 'a remote session', `${k} is detected as headless`);
    delete process.env[k];
  }
  // A provider that sets CI=false must NOT be treated as headless.
  for (const sentinel of ['false', '0']) {
    process.env.CI = sentinel;
    check(headlessEnvironment() === null, `CI=${sentinel} is not headless`);
  }
  process.env.CI = 'true';
  check(headlessEnvironment() === 'CI', 'CI is detected as headless');
  check(autostartEnabled() === false, 'and autostart is off there');
  const ciRes = await ensureDashboard({ project: PROJ, port: CI_PORT, confirmMs: 400 });
  check(ciRes.status === 'disabled', `no spawn in CI (got ${ciRes.status})`);
  check((await probeHealth(CI_PORT, 400)) === null, 'nothing was started in CI');
  // An explicit opt-in no longer overrides the CI guard. It used to, back when =1 merely forced
  // the default-on behaviour; now =1 is the ONLY way autostart ever happens, so honouring it here
  // would make the whole guard unreachable and put a listener on every build agent whose repo
  // exports the variable.
  process.env.STICKIES_DASHBOARD_AUTOSTART = '1';
  check(headlessEnvironment() === 'CI', 'CI is still detected as headless despite an opt-in');
  check(autostartEnabled() === false, 'and an explicit opt-in does NOT start one on a CI runner');
  const ciOptIn = await ensureDashboard({ project: PROJ, port: CI_PORT, confirmMs: 400 });
  check(ciOptIn.status === 'disabled', `still no spawn in CI when opted in (got ${ciOptIn.status})`);
  delete process.env.CI;

  // Put one back: the collision test below needs PORT occupied, and --stop just freed it.
  const restarted = await ensureDashboard({ project: PROJ, port: PORT, confirmMs: 20000 });
  check(restarted.status === 'started', `a stopped dashboard can be started again (got ${restarted.status})`);

  // --- a spawn that fails must be REPORTED, not thrown ---------------------------------
  // spawn() signals failure with an async 'error' event, and an unhandled one on a
  // ChildProcess is a process-level uncaught exception. Unhandled, it killed the SessionStart
  // hook mid-await — before it wrote its digest — so the user lost their notes to a stack trace.
  const realExec = process.execPath;
  Object.defineProperty(process, 'execPath', { value: join(ROOT, 'no-such-node.exe'), configurable: true });
  let threw = null;
  let failed;
  try {
    failed = await ensureDashboard({ project: PROJ, port: BROKEN, confirmMs: 5000 });
  } catch (e) {
    threw = e.message;
  }
  Object.defineProperty(process, 'execPath', { value: realExec, configurable: true });
  check(threw === null, `a broken spawn does not throw out of ensureDashboard (${threw || 'clean'})`);
  check(failed && failed.status === 'failed', `it is reported as 'failed' (got ${failed && failed.status})`);
  check(!!(failed && failed.error), 'and carries the underlying error for the caller to print');

  // --- port collision is explained, not dumped ----------------------------------------
  const collide = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/dashboard.js', '--port', String(PORT), '--project', PROJ],
    { env: { ...process.env, STICKIES_DB: DB, STICKIES_HOME: HOME, ...NO_SYNC } }
  );
  let cErr = '';
  collide.stderr.on('data', (d) => (cErr += d));
  const code = await new Promise((r) => collide.on('exit', r));
  check(code === 1, `a colliding launch exits 1 (got ${code})`);
  check(/already in use/i.test(cErr), 'the collision is explained in plain words');
  check(cErr.includes(String(PORT)), 'the message names the port');
  check(/already a Stickies dashboard/i.test(cErr), 'it identifies who owns the port');
  check(!/Unhandled 'error' event/.test(cErr), 'no raw unhandled-error stack trace');
  check(/project=/.test(cErr), 'it points at the ?project= way to reach your own board');
} catch (err) {
  console.log('  FAIL  ' + (err?.stack || err));
  fail++;
} finally {
  // Shut down everything we started, on every path — INCLUDING a path that threw, which used to
  // leak a detached dashboard for every red run.
  for (const port of [...new Set([...spawned, CI_PORT, BROKEN])]) {
    try {
      const h = await probeHealth(port, 400);
      if (h && h !== 'foreign' && h.pid) process.kill(h.pid);
    } catch { /* fall through to the port sweep below */ }
  }
  for (const l of listeners) { try { l.close(); } catch {} }
}

// The dashboards were spawned detached, so kill them by port rather than by handle.
for (const port of spawned) {
  try {
    const { execSync } = await import('node:child_process');
    if (process.platform === 'win32') {
      // Anchor the match. `findstr :4463` is a SUBSTRING match, so it also matched 44630-44639
      // and force-killed whatever unrelated process was listening there. /R with a trailing
      // space pins it to the port field.
      const out = execSync(`netstat -ano -p tcp | findstr /R /C:":${port} "`, { encoding: 'utf8' });
      for (const pid of new Set([...out.matchAll(/LISTENING\s+(\d+)/g)].map((m) => m[1]))) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      }
    } else {
      execSync(`kill $(lsof -ti tcp:${port}) 2>/dev/null || true`);
    }
  } catch { /* already gone */ }
}

console.log(fail ? `\ndashboard-autostart: ${fail} FAILED` : '\ndashboard-autostart: all passed');
try { (await import('../src/db.js')).closeDb(); } catch {}
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
