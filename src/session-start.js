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
import { readStickies } from './store.js';
import { buildDigest, stripManagedSectionFromClaudeMd } from './digest.js';
import { maybeAutoSync } from './git-sync.js';
import { writeMarker, sweepStaleMarkers } from './session-marker.js';

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
      additionalContext: digest,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  process.stderr.write(`stickies session-start failed: ${err?.stack || err}\n`);
  process.exit(0); // never block session start
});
