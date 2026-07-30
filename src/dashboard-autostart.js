// Make sure a local dashboard is actually listening.
//
// The statusline segments are OSC 8 hyperlinks to http://127.0.0.1:<port>/ — but nothing ever
// started a server, so unless you had manually run `stickies dashboard` the Ctrl+click landed
// on a closed port and appeared to do nothing at all. The link looked broken because it was.
//
// One dashboard is enough for the whole machine: the port is fixed and the server now serves
// any registered project via ?project=, so every terminal shares one instance. This is
// idempotent and never destructive — if ours is already up we do nothing, and if some OTHER
// program owns the port we leave it strictly alone instead of spawning a process that would
// die on EADDRINUSE.

import { spawn } from 'node:child_process';
import { get, request as httpRequest } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Re-exported so the many existing importers of these two keep working; the values themselves
// now live in one module (see dashboard-port.js for why the default moved off 4317).
export { DEFAULT_PORT, dashboardPort } from './dashboard-port.js';
import { dashboardPort } from './dashboard-port.js';

// Somewhere a background HTTP server is pointless or unwanted: nobody can open a browser, and
// the process just sits there for the life of the container. SessionStart fires in all of these
// (`claude -p` in a pipeline, a CI job, a devcontainer, a cloud sandbox), so check before
// spawning rather than leaving a listener nobody asked for on every build agent.
export function headlessEnvironment() {
  const env = process.env;
  // No opt-in escape hatch here any more. It existed to let =1 override CI detection back when
  // =1 was merely "force the default-on behaviour"; now =1 is the ONLY way autostart happens, so
  // honouring it here would make every check below unreachable and put a listener on build agents.
  for (const key of ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD', 'CODESPACES']) {
    if (env[key] && env[key] !== 'false' && env[key] !== '0') return key;
  }
  if (env.CLAUDE_CODE_REMOTE || env.CLAUDE_CLOUD_SESSION) return 'a remote session';
  return null;
}

// Where the dashboard records "this instance is mine", so --stop has a claim to check that does
// not come from the port-holder itself. Shared by the writer (src/dashboard.js) and the reader.
export function pidFilePath(port = dashboardPort()) {
  return join(process.env.STICKIES_HOME || homedir() + '/.stickies', `dashboard-${port}.pid`);
}

// Read it back, in either format. `{ pid, nonce }` is what a current dashboard writes; a bare
// number is what one from before the nonce wrote, and is reported as legacy so the caller can
// refuse rather than silently accept the weaker claim.
export function readPidFile(port = dashboardPort()) {
  let raw;
  try {
    raw = readFileSync(pidFilePath(port), 'utf8').trim();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && typeof parsed.nonce === 'string' && parsed.nonce) {
      return { pid: parsed.pid, nonce: parsed.nonce };
    }
  } catch { /* not JSON — fall through to the legacy form */ }
  const pid = Number(raw);
  if (Number.isInteger(pid) && pid > 0) return { pid, nonce: null, legacy: true };
  return null;
}

// OPT-IN. Installing a notes plugin must not start a web server on someone's machine, so the
// default is off and STICKIES_DASHBOARD_AUTOSTART=1 turns it on. It used to be the other way
// round (on unless =0), which meant a stranger who ran `claude` got a long-lived listener they
// never asked for and had no reason to look for.
//
// An explicit opt-in is still refused on a CI runner or a remote session: a background server
// there is never what was meant, it would outlive the job, and nobody can open a browser to it.
// `stickies dashboard --detach` (which passes force) is the way to get one anyway.
export function autostartEnabled() {
  if (process.env.STICKIES_DASHBOARD_AUTOSTART !== '1') return false;
  return headlessEnvironment() === null;
}

// Ask whoever owns the port to identify itself. Resolves to the parsed health body for our
// dashboard, the string 'foreign' for anything else answering, or null when nothing answers.
// Never rejects and never outlives its timeout — this runs on the SessionStart path.
export function probeHealth(port = dashboardPort(), timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = get(
      { host: '127.0.0.1', port, path: '/api/health', headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            done(parsed && parsed.app === 'stickies' ? parsed : 'foreign');
          } catch {
            done('foreign');
          }
        });
        res.on('error', () => done('foreign'));
      }
    );
    req.on('error', () => done(null)); // ECONNREFUSED => nobody is listening
    req.setTimeout(timeoutMs, () => { req.destroy(); done('foreign'); });
    setTimeout(() => { req.destroy(); done(null); }, timeoutMs + 100).unref?.();
  });
}

// Poll health until it answers as ours, or the budget runs out.
async function waitForOurs(port, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const h = await probeHealth(port, 400);
    if (h && h !== 'foreign') return h;
    if (Date.now() >= deadline) return null;
    // Deliberately NOT unref'd. This timer is awaited, and by the time SessionStart calls us
    // stdin has closed and every other handle is gone — an unref'd timer would let node decide
    // the event loop is empty and exit mid-await, so the hook would print no digest at all.
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function spawnDashboard(project, port) {
  const args = ['--disable-warning=ExperimentalWarning', join(HERE, 'dashboard.js'), '--port', String(port)];
  if (project) args.push('--project', project);
  // Detached + unref'd so it outlives the hook process that started it; stdio ignored because
  // there is no terminal to write to (its output would otherwise be injected into the hook's
  // JSON channel and corrupt it).
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  // spawn() reports failure asynchronously via an 'error' event, NOT by throwing — and an
  // unhandled 'error' on a ChildProcess is a process-level uncaught exception. Without this
  // listener an ENOENT/EMFILE/AV-blocked spawn takes the SessionStart hook down mid-await,
  // before it writes its JSON payload, so the user loses their whole sticky digest to a raw
  // stack trace. Swallowing it here lets waitForOurs() time out and report 'starting' or
  // 'failed' honestly, which is the whole point of returning a status.
  child.on('error', () => { /* surfaced as a failure to confirm, not as a crash */ });
  child.unref();
  return child;
}

// Ensure a dashboard is up. Returns a status describing what was true or what we did:
//   'disabled' | 'already' | 'foreign' | 'started' | 'starting' | 'failed'
// 'starting' means we spawned it but the confirm budget expired before it answered — the
// honest answer, since node cold start can outlast a hook's patience.
// `force` bypasses the STICKIES_DASHBOARD_AUTOSTART opt-out: that env var exists to stop the
// SessionStart hook starting a server behind your back, not to break an explicit
// `stickies dashboard --detach`, which is the user asking for one out loud.
export async function ensureDashboard({ project, port = dashboardPort(), confirmMs = 1500, force = false } = {}) {
  if (!force && !autostartEnabled()) {
    return { status: 'disabled', port, headless: headlessEnvironment() };
  }

  const existing = await probeHealth(port);
  if (existing === 'foreign') return { status: 'foreign', port };
  if (existing) return { status: 'already', port, project: existing.project ?? null };

  let spawnError = null;
  let child;
  try {
    child = spawnDashboard(project, port);
  } catch (err) {
    return { status: 'failed', port, error: err?.message || String(err) };
  }
  // The synchronous throw above is the rare case; the usual failure arrives on this event
  // after spawn() has already returned. Recording it turns 'failed' from an unreachable
  // branch into the answer the caller gets when the process never came up.
  child.on('error', (err) => { spawnError = err; });

  const confirmed = await waitForOurs(port, confirmMs);
  if (confirmed) return { status: 'started', port, project: confirmed.project ?? null };
  if (spawnError) return { status: 'failed', port, error: spawnError?.message || String(spawnError) };
  return { status: 'starting', port };
}

// Stop the dashboard we started. Deliberately narrow: it will only kill a process that answers
// /api/health as ours, so a mistyped port cannot be turned into a kill switch for an unrelated
// program. The spawned server is detached and outlives every session, so without this the only
// way to get rid of one was Task Manager.
// POST /api/stop with the ownership nonce. Resolves to a status code, or 0 if nothing answered.
function askToStop(port, nonce, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = httpRequest(
      {
        host: '127.0.0.1', port, path: '/api/stop', method: 'POST',
        headers: { host: `127.0.0.1:${port}`, 'x-stickies-owner': nonce, 'content-length': '0' },
      },
      (res) => { res.resume(); res.on('end', () => done(res.statusCode)); }
    );
    req.on('error', () => done(0));
    req.setTimeout(timeoutMs, () => { req.destroy(); done(0); });
    req.end();
  });
}

export async function stopDashboard({ port = dashboardPort() } = {}) {
  const health = await probeHealth(port);
  if (health === null) return { status: 'not-running', port };
  if (health === 'foreign') return { status: 'foreign', port };
  const pid = Number(health.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'unknown-pid', port };
  // Cross-check against the pidfile the dashboard writes at listen time. The pid in the health
  // BODY is chosen by whoever holds the port, and something else being there is ordinary
  // rather than exotic (the old default, 4317, was the OpenTelemetry OTLP port). Without this, an impostor answering
  // {"app":"stickies","pid":<someone else>} turns `--stop` into an arbitrary kill.
  //
  // A pid on its own is weak proof, because a pid is PUBLIC: it is in the process table, so an
  // impostor can read the one Stickies recorded and restate it. So the dashboard also writes a
  // random nonce into the 0600 pidfile — and `--stop` PRESENTS that nonce rather than asking the
  // server to prove it knows it.
  //
  // That direction is the point. Signalling a pid means trusting that the number still belongs to
  // the process we think it does, and after a SIGKILL the pidfile outlives the process, so the OS
  // is free to hand that number to something unrelated before anyone runs `--stop`. Asking the
  // process to exit itself cannot hit the wrong process: only the one holding the nonce acts on
  // it. It also means the nonce never appears on /api/health, so there is nothing for a local
  // process to scrape and replay later — which was the residual this design closes.
  //
  // The nonce is sent to whoever holds the port, so an impostor squatting there does learn it.
  // That is harmless by construction: the only thing it authorizes is that dashboard terminating
  // itself, and an impostor cannot be that dashboard.
  const claim = readPidFile(port);
  if (claim === null) {
    return { status: 'unverified', port, pid, reason: 'no pidfile — refusing to act on a claim only the port-holder vouches for' };
  }
  if (claim.pid !== pid) {
    return { status: 'unverified', port, pid, claimed: claim.pid, reason: 'the pid on the port does not match the one Stickies recorded' };
  }
  if (claim.legacy) {
    return {
      status: 'unverified', port, pid, claimed: claim.pid,
      reason: 'the pidfile predates the ownership nonce — this dashboard was started by an older build. Stop it from the terminal that owns it, or end that pid yourself.',
    };
  }

  const code = await askToStop(port, claim.nonce);
  if (code === 404) {
    return {
      status: 'unverified', port, pid, claimed: claim.pid,
      reason: 'the dashboard on this port predates self-stop — it was started by an older build. Stop it from the terminal that owns it, or end that pid yourself.',
    };
  }
  if (code === 403) {
    return {
      status: 'unverified', port, pid, claimed: claim.pid,
      reason: 'the process on the port does not know the ownership nonce Stickies recorded, so it is not the dashboard that wrote it',
    };
  }
  if (code !== 200) {
    return { status: 'failed', port, pid, error: code ? `stop request answered ${code}` : 'stop request got no answer' };
  }
  // Confirm it actually went, rather than reporting a hopeful request as success.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await probeHealth(port, 300)) === null) {
      // Belt and braces: the server removes its own pidfile on exit, but a stale one must never
      // be left vouching for a pid the OS may later reuse.
      try { rmSync(pidFilePath(port), { force: true }); } catch { /* it will be overwritten */ }
      return { status: 'stopped', port, pid };
    }
  }
  // Something is still on the port. Nothing was signalled, so nothing was harmed — say so plainly
  // rather than escalating to a kill, which is the behaviour this change exists to remove.
  return { status: 'still-running', port, pid };
}
