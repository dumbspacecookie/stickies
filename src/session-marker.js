// Brackets a session so the SessionEnd report knows which notes belong to it.
//
// SessionStart drops a marker holding the start timestamp; SessionEnd reads it, reports
// everything created/dismissed since, then removes it. Keyed by session id so concurrent
// Claude Code windows in different folders don't clobber each other's windows.

import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week

function sessionsDir() {
  const base = process.env.STICKIES_HOME || join(homedir(), '.stickies');
  const dir = join(base, 'sessions');
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return tmpdir(); // read-only home shouldn't break session start
  }
}

// Session ids come from the hook event, but treat them as untrusted: a value containing
// path separators would otherwise let a marker escape the sessions dir.
function safeId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function markerPath(sessionId) {
  return join(sessionsDir(), `${safeId(sessionId)}.json`);
}

export function writeMarker(sessionId, projectPath) {
  const path = markerPath(sessionId);
  writeFileSync(
    path,
    JSON.stringify({
      session_id: String(sessionId ?? 'unknown'),
      project_path: projectPath ?? null,
      started_at: new Date().toISOString(),
    }),
    'utf8'
  );
  return path;
}

// A session that is killed (crash, closed terminal) never fires SessionEnd, so its marker
// is orphaned. Sweep old ones so the directory doesn't grow without bound.
export function sweepStaleMarkers(now = Date.now()) {
  let removed = 0;
  try {
    for (const f of readdirSync(sessionsDir())) {
      if (!f.endsWith('.json')) continue;
      const p = join(sessionsDir(), f);
      try {
        if (now - statSync(p).mtimeMs > MAX_MARKER_AGE_MS) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        // racing another session's sweep — fine
      }
    }
  } catch {
    // no dir yet
  }
  return removed;
}
