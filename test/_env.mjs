// Shared test scaffolding: ports that are actually free, and scratch directories that do not
// collide.
//
// Both exist because the suite used fixed values. A fixed port means anything already listening
// turns the run red with an unreadable message — `probeHealth on a closed port => null` is
// definitionally false when someone is on the port, and a dashboard that dies of EADDRINUSE
// reports itself as `Unexpected token 'o', "not stickies" is not valid JSON`. A fixed scratch
// directory in the shared tmpdir means two runs (two terminals, or a CI matrix on one runner)
// fight over the same sqlite file.

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A port nothing was listening on a moment ago. Bind :0, note what the OS handed us, release it.
// Inherently a small race — but a vanishingly smaller one than picking 4402 and hoping.
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function freePorts(n) {
  const out = [];
  const held = [];
  // Hold each one until all are chosen, so we cannot be handed the same port twice.
  for (let i = 0; i < n; i++) {
    const s = createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    out.push(s.address().port);
    held.push(s);
  }
  await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
  return out;
}

// A scratch directory unique to this process. `prefix` only labels it for a human reading
// %TEMP%; uniqueness comes from mkdtemp.
export function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), `stickies_${prefix}_`));
}

// Remove a scratch directory, retrying briefly.
//
// One attempt was not enough on Windows and the evidence was in %TEMP%: ten `stickies_browser_*`
// and thirty-one `stickies_dash_*` directories, one per run of two suites that both call this.
// A suite kills its dashboard and deletes the tree in the same tick, but the child has not
// finished exiting, so its sqlite handle still holds the file and rmSync fails with EBUSY —
// silently, since a leftover temp dir is not a test failure. Retrying costs nothing when the
// first attempt works, which is every time on POSIX.
export function cleanup(dir, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      sleepSync(120);
    }
  }
  return false;
}

// Read routes need proof of being the user (src/dashboard-auth.js). A suite drives them with the
// key header rather than a cookie: same check, no redirect to follow. `home` is the suite's
// STICKIES_HOME — the key file lives there, written by the dashboard at startup, so this must be
// called AFTER the server is up.
export function authHeaders(home, extra = {}) {
  try {
    const key = readFileSync(join(home, 'dashboard-auth.key'), 'utf8').trim();
    return { 'x-stickies-key': key, ...extra };
  } catch {
    return { ...extra }; // no key yet: let the assertion fail loudly rather than silently skipping
  }
}

// A synchronous pause, so cleanup() can stay callable from the end of a script and from a
// `finally` that must not become async.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Kill a child and WAIT for it to be gone, so whatever it had open is actually released before
// the caller deletes the directory underneath it.
export function killAndWait(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', done);
    try { child.kill(); } catch { done(); }
  });
}
