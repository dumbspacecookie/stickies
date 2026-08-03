// Is a dashboard actually there — cheaply enough to ask on every prompt render.
//
// This exists because the statuslines lied. Both of them wrapped their segment in an OSC 8
// hyperlink unconditionally, on the premise recorded in their own comments: "the SessionStart
// hook starts a dashboard if none is running, so the click lands without setup." That premise
// stopped being true when autostart became opt-in (STICKIES_DASHBOARD_AUTOSTART=1) — installing a
// notes plugin must not start a web server on someone's machine. Nobody revisited the link.
//
// So on every machine that has not opted in, and on every machine that has rebooted since the last
// manual `stickies dashboard`, the segment renders as a live, underlined, Ctrl+clickable link to a
// port nothing serves. The click lands on ERR_CONNECTION_REFUSED. `stickies doctor` has always
// diagnosed this correctly — but you only run doctor once you already suspect something, and a
// link that looks alive is precisely what stops you suspecting.
//
// WHY A PIDFILE AND NOT A HEALTH PROBE. probeHealth() is the authoritative answer and it is what
// --stop and doctor use, but it is async, it opens a socket, and it costs a timeout when nothing
// answers. A statusline is a short-lived process re-spawned on every render, so paying an
// ECONNREFUSED round trip hundreds of times a day to decide a display detail is the wrong trade.
// The pidfile is written by the dashboard at listen time and removed on exit, and a dead pid is
// two syscalls to detect.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. It is a liveness HINT, not proof of identity — the name
// says likely. After a reboot the OS may hand the recorded pid to an unrelated process (measured:
// ~4% of low pids are addressable on a fresh Windows boot), and we would then render a link that
// does not land. That is the pre-existing behaviour, so a false positive costs nothing that was
// not already being paid.
//
// It is NOT true, as an earlier draft of this comment said, that "nothing security-bearing rests
// on this: it chooses whether to draw an underline". The underline carries a link token, and a
// review demonstrated the token reaching a foreign server's request log via a stale pidfile whose
// pid happened to be reused. What is true is narrower and worth stating exactly: this predicate is
// conjunctive and only ever SUPPRESSES a link, so no pidfile — hostile or corrupt — can cause a
// link to be emitted anywhere the code before this change would not already have emitted one. The
// worst it can do is fail to improve matters. Authorization remains dashboard-auth.js's job, the
// token is still port-bound and five-minute-bucketed, and none of that is touched here.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dashboardPort } from './dashboard-port.js';

// The pidfile the dashboard writes is ~50 bytes. Anything larger is not one, and reading it is
// pure cost on a path that re-runs every prompt render — a 64 MB file measured 172 ms per call,
// which is linear rather than the ambiguity-driven blowup this project has shipped three times,
// but a frozen-feeling prompt does not care which kind of slow it was.
const MAX_PIDFILE_BYTES = 4096;

// Where the dashboard records "this instance is mine", so --stop has a claim to check that does
// not come from the port-holder itself. Shared by the writer (src/dashboard.js) and the readers.
export function pidFilePath(port = dashboardPort()) {
  return join(process.env.STICKIES_HOME || homedir() + '/.stickies', `dashboard-${port}.pid`);
}

// Read it back, in either format. `{ pid, nonce }` is what a current dashboard writes; a bare
// number is what one from before the nonce wrote, and is reported as legacy so the caller can
// refuse rather than silently accept the weaker claim.
export function readPidFile(port = dashboardPort()) {
  let raw;
  try {
    const path = pidFilePath(port);
    // stat BEFORE opening, and refuse anything that is not a plain file.
    //
    // On POSIX, open(2) on a FIFO BLOCKS until a writer arrives. Before the statusline consulted
    // this, readPidFile ran only from `--stop` and inside the server; it now runs in a process the
    // user's shell is waiting on, so a named pipe left at this path would hang the prompt rather
    // than inconvenience one command. stat() does not open, so it answers instead of blocking.
    // The size cap rides along on the same call.
    //
    // This does introduce a stat-then-read window, which the single readFileSync did not have.
    // That trade is deliberate and the race is benign: the file is swapped for a different plain
    // file, and we read that one — the same outcome as being called a millisecond later. Nothing
    // is created, locked or acted on between the two calls.
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_PIDFILE_BYTES) return null;
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    // `> 0` matches the legacy branch below, which has always had it. Without it a hand-edited or
    // corrupted `{"pid":0}` reads as up FOREVER: process.kill(0, 0) never fails — on POSIX pid 0
    // means the caller's own process group, so it is asking whether WE exist. Unlike a recycled
    // pid, which eventually dies, that false positive never self-heals. Three separate reviewers
    // found this independently, which is a fair verdict on moving code without re-reading it.
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0
        && typeof parsed.nonce === 'string' && parsed.nonce) {
      return { pid: parsed.pid, nonce: parsed.nonce };
    }
  } catch { /* not JSON — fall through to the legacy form */ }
  const pid = Number(raw);
  if (Number.isInteger(pid) && pid > 0) return { pid, nonce: null, legacy: true };
  return null;
}

// Signal 0 sends nothing; it only asks the kernel whether that pid is addressable. Node maps this
// onto OpenProcess on Windows, so it is one call there too.
//
// EPERM means the process EXISTS and belongs to somebody else, so it counts as alive. Be honest
// about why: an earlier version of this comment justified it as protecting "anyone whose
// dashboard runs under a different account", and a review showed that scenario cannot reach here
// — that user's pidfile is under THEIR $STICKIES_HOME, and a shared one is mode 0600, so
// readFileSync throws EACCES and we return null long before process.kill. The real reason to keep
// the branch is plainer: EPERM is the kernel answering "yes, it exists", and a predicate named
// `likely up` that turned a yes into a no would be lying. ESRCH (and anything else) is a no.
export function dashboardLikelyUp(port = dashboardPort()) {
  const claim = readPidFile(port);
  if (!claim) return false;
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}
