#!/usr/bin/env node
// SessionEnd hook: post one summary of what this session did to the sticky board.
//
// Why a session report instead of a ping per note: a webhook that fires on every write
// turns the channel into noise you learn to ignore, which is the same failure mode as a
// statusline that always reads zero. One post per session, listing what was parked and
// what was cleared, is a thing you actually read.
//
// The session window is bracketed by a marker file written at SessionStart. If the marker
// is missing (hook didn't run, or a session predating this feature), we skip rather than
// guess a window and report the wrong notes.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { getDb } from './db.js';
import { normalizeProjectPath } from './store-path.js';
import { notifySessionReport } from './notify.js';
import { markerPath } from './session-marker.js';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 1000).unref?.();
  });
}

// Everything created, and everything dismissed, inside [since, now] for this project.
// Scoped to the project so a session in one folder doesn't report another folder's notes.
export function collectSessionActivity(db, { since, projectPath }) {
  const np = normalizeProjectPath(projectPath);

  const created = db
    .prepare(
      `SELECT * FROM stickies
        WHERE created_at >= @since
          AND (project_path = @pp OR project_path IS NULL)
        ORDER BY created_at ASC`
    )
    .all({ since, pp: np });

  // A dismissal is a status flip, so it shows up as an updated_at inside the window on a
  // row that is now dismissed. created_at may well be from a session weeks ago.
  const dismissed = db
    .prepare(
      `SELECT * FROM stickies
        WHERE status = 'dismissed'
          AND updated_at >= @since
          AND (project_path = @pp OR project_path IS NULL)
        ORDER BY updated_at ASC`
    )
    .all({ since, pp: np });

  const parse = (r) => ({ ...r, tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })() });

  // A note created AND cleared in the same session belongs in "cleared", not both lists.
  const dismissedIds = new Set(dismissed.map((r) => r.id));
  return {
    created: created.filter((r) => !dismissedIds.has(r.id)).map(parse),
    dismissed: dismissed.map(parse),
  };
}

async function main() {
  let event = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) event = JSON.parse(raw);
  } catch {
    // fall through to env/cwd
  }

  const projectPath = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = event.session_id || 'unknown';

  const marker = markerPath(sessionId);
  if (!existsSync(marker)) return; // no window -> nothing trustworthy to report

  let started;
  try {
    started = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    return;
  }

  const db = getDb();
  const { created, dismissed } = collectSessionActivity(db, {
    since: started.started_at,
    projectPath,
  });

  // Nothing happened to the board this session — say nothing.
  if (created.length || dismissed.length) {
    await notifySessionReport({
      created,
      dismissed,
      projectPath,
      startedAt: started.started_at,
      endedAt: new Date().toISOString(),
      sessionId,
    });
  }

  try {
    rmSync(marker, { force: true });
  } catch {
    // a stale marker is harmless; it is keyed by session id and will never match again
  }
}

main().catch((err) => {
  process.stderr.write(`stickies session-report failed: ${err?.message}\n`);
  process.exitCode = 0; // never fail a session teardown
});
