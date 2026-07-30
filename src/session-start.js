#!/usr/bin/env node
// SessionStart hook entry point.
//
// Claude Code pipes a JSON event on stdin (session_id, cwd, source, ...) and reads
// any JSON we print on stdout. We:
//   1. resolve the current project path (cwd from the hook, or $CLAUDE_PROJECT_DIR),
//   2. read active stickies for that project + globals,
//   3. emit the digest as additionalContext so it lands in the live session — WITHOUT
//      touching any file (a git-tracked CLAUDE.md must not carry your notes into a diff),
//   4. strip any managed section left behind by older versions that did write to CLAUDE.md.
//
// Failures are non-fatal: we never want a sticky problem to break session start.

import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readStickies } from './store.js';
import { buildDigest, stripManagedSectionFromClaudeMd } from './digest.js';
import { maybeAutoSync } from './git-sync.js';
import { writeMarker, sweepStaleMarkers } from './session-marker.js';

// A one-shot flag for "the user has been told a background server exists". Its absence must be
// harmless (we simply announce again) and its write must never break session start.
function announceFlagPath() {
  return join(process.env.STICKIES_HOME || join(homedir(), '.stickies'), 'dashboard-announced');
}
function alreadyAnnounced() {
  try { return existsSync(announceFlagPath()); } catch { return false; }
}
function markAnnounced() {
  try {
    const p = announceFlagPath();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, new Date().toISOString());
  } catch { /* announcing twice is better than failing to start */ }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    // Guard against a hung pipe.
    setTimeout(() => resolve(data), 1000).unref?.();
  });
}

async function main() {
  let event = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) event = JSON.parse(raw);
  } catch {
    // ignore malformed input; fall back to env/cwd
  }

  const projectPath = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Pull the latest synced stickies before building the digest (opt-in, best-effort).
  const synced = maybeAutoSync();
  if (synced && !synced.error) {
    process.stderr.write(`stickies: auto-synced (${synced.steps?.join('; ')})\n`);
  }

  const stickies = readStickies({
    project_path: projectPath,
    include_global: true,
    limit: 100,
  });

  // Bracket the session so SessionEnd can report exactly what changed within it.
  try {
    writeMarker(event.session_id, projectPath);
    sweepStaleMarkers();
  } catch {
    // a missing marker only costs us the end-of-session report; never block startup
  }

  // Make the statusline's Ctrl+click link actually land: bring up a dashboard if none is
  // running. One instance serves every project (it takes ?project=), so this is a no-op in
  // every session after the first. Off unless STICKIES_DASHBOARD_AUTOSTART=1. Best-effort
  // and time-boxed — session start must never wait on, or fail because of, a web server.
  // Anything worth telling the user goes here, not to stderr: this hook exits 0, and Claude Code
  // only surfaces exit-0 hook stderr in the transcript view. Starting a long-lived HTTP server on
  // someone's machine is exactly the kind of thing they should hear about in a channel they can
  // actually see — once, the first time it happens.
  let dashboardNote = '';
  let announcedStart = false; // only a real start consumes the once-per-machine flag
  try {
    const { ensureDashboard } = await import('./dashboard-autostart.js');
    const r = await ensureDashboard({ project: projectPath, confirmMs: 1200 });
    if (r.status === 'started' || r.status === 'starting') {
      announcedStart = true;
      process.stderr.write(`stickies: dashboard on http://127.0.0.1:${r.port}/ (${r.status})\n`);
      dashboardNote =
        `Stickies started a local board at http://127.0.0.1:${r.port}/ (loopback only; it serves ` +
        `every project you take notes in). You asked for this with STICKIES_DASHBOARD_AUTOSTART=1; ` +
        `unset it to stop, or ` +
        `stop this one with \`stickies dashboard --stop\`. Mention this to the user once.`;
    } else if (r.status === 'foreign') {
      process.stderr.write(`stickies: port ${r.port} is used by something else — dashboard not started\n`);
      dashboardNote =
        `Stickies could not start its board: port ${r.port} is held by another program (that port ` +
        `is also the OpenTelemetry OTLP default). Pick another with STICKIES_DASHBOARD_PORT, or ` +
        `run \`stickies doctor\`. Mention this to the user once.`;
    } else if (r.status === 'failed') {
      process.stderr.write(`stickies: dashboard failed to start (${r.error})\n`);
    }
  } catch (err) {
    process.stderr.write(`stickies: dashboard autostart skipped (${err?.message || err})\n`);
  }

  // Once per machine, not once per session: a notice you get every morning is noise, and noise
  // is how a real one gets missed.
  //
  // Only a note about a server that actually STARTED burns the flag. The failure notice used to
  // burn it too, so one unlucky first session (port already busy) permanently suppressed the
  // disclosure that a background server exists — the one thing this is here to tell you.
  if (dashboardNote && (!announcedStart || !alreadyAnnounced())) {
    if (announcedStart) markAnnounced();
  } else {
    dashboardNote = '';
  }

  const digest = buildDigest(stickies);

  // Undo the old behaviour: if a previous version wrote a managed section into CLAUDE.md,
  // remove it. One-time per file, then it's a no-op. Never blocks startup.
  try {
    stripManagedSectionFromClaudeMd(join(projectPath, 'CLAUDE.md'));
  } catch (err) {
    process.stderr.write(`stickies session-start: could not clean CLAUDE.md: ${err.message}\n`);
  }

  // Inject into the live session via the hook's additionalContext channel — this is the
  // whole delivery mechanism now. Nothing is written to disk.
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: dashboardNote ? `${dashboardNote}\n\n${digest}` : digest,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  process.stderr.write(`stickies session-start failed: ${err?.stack || err}\n`);
  process.exit(0); // never block session start
});
