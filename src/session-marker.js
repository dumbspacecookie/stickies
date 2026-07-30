// Brackets a session so the SessionEnd report knows which notes belong to it.
//
// SessionStart drops a marker holding the start timestamp; SessionEnd reads it, reports
// everything created/dismissed since, then removes it. Keyed by session id so concurrent
// Claude Code windows in different folders don't clobber each other's windows.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week

// Null when the directory cannot be created. It used to fall back to the OS temp dir, which is
// world-writable on POSIX — and these markers are one of the two sources of the dashboard's
// project allowlist, which is what gates reading a project's board and WRITING its ROADMAP.md.
// A shared-machine user could have dropped a marker naming any path and had it become servable,
// and could read every project path this user works in. The fallback bought a SessionEnd report
// on a machine with an unwritable home; the caller already treats a missing marker as "no
// report", so losing it is the cheaper half of that trade by a wide margin.
function sessionsDir() {
  const base = process.env.STICKIES_HOME || join(homedir(), '.stickies');
  const dir = join(base, 'sessions');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

// Session ids come from the hook event, but treat them as untrusted: a value containing
// path separators would otherwise let a marker escape the sessions dir.
function safeId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function markerPath(sessionId) {
  const dir = sessionsDir();
  return dir === null ? null : join(dir, `${safeId(sessionId)}.json`);
}

export function writeMarker(sessionId, projectPath) {
  const path = markerPath(sessionId);
  if (path === null) return null; // nowhere private to put it; see sessionsDir()
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

// Every project path a recent session registered. This is the dashboard's answer to "which
// folders may I serve a board for" — a project gets here by having had a Claude session in
// it, so a fresh project with a ROADMAP but no notes yet is still selectable, and a path
// nobody has ever worked in never is. Stale markers are excluded by the same age bound the
// sweep uses. Never throws: an unreadable marker is skipped, a missing dir yields [].
// Parsed markers, keyed by filename, remembered with the mtime they were read at. A marker is
// written once at session start and never edited, so a matching mtime means the parse is still
// good and the file need not be opened again.
//
// This matters because the dashboard rebuilds its project allowlist on a cache miss, and every
// UNKNOWN ?project= is a miss — a request that needs no token and no preflight. Re-reading and
// re-parsing the whole directory each time measured 110ms at 300 markers and 332ms at 1,000,
// which is a single-threaded server spending its entire budget on unauthenticated GETs. Markers
// live seven days, so four figures is an ordinary number for a heavy `claude -p` user.
const markerCache = new Map(); // filename -> { stamp, project }
let parses = 0;                // how many markers were actually opened and parsed

// The identity of a file's CONTENT, as cheaply as stat can tell it. mtimeMs alone was not that:
// its resolution is milliseconds, so a marker rewritten within the same millisecond as the read
// that cached it kept serving the OLD project path forever — the file changed and the mtime did
// not. That is not exotic here, because a marker is written at session start and `claude -p`
// sessions are scripted back to back. Nanosecond mtime plus size plus inode closes the ordinary
// cases (same-tick rewrite, same-length rewrite, delete-and-recreate under a reused name).
function stampOf(st) {
  return `${st.mtimeNs}:${st.size}:${st.ino}:${st.dev}`;
}

export function sessionProjects(now = Date.now()) {
  const out = [];
  const seen = new Set();
  try {
    const dir = sessionsDir();
    if (dir === null) return out;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      seen.add(f);
      const p = join(dir, f);
      try {
        const st = statSync(p, { bigint: true });
        if (now - Number(st.mtimeMs) > MAX_MARKER_AGE_MS) continue;
        const stamp = stampOf(st);
        const hit = markerCache.get(f);
        if (hit && hit.stamp === stamp) {
          if (hit.project) out.push(hit.project);
          continue;
        }
        const marker = JSON.parse(readFileSync(p, 'utf8'));
        parses++;
        const project = marker && marker.project_path ? String(marker.project_path) : null;
        markerCache.set(f, { stamp, project });
        if (project) out.push(project);
      } catch {
        // malformed or racing removal — skip this marker, keep the rest
      }
    }
    // Drop entries for markers that are gone, so a long-lived dashboard does not accumulate
    // memory for sessions that ended days ago. Guarding this on `cache.size > seen.size` skipped
    // it in exactly the case that matters: one session ends and another begins between two
    // rebuilds, so a stale entry and a new one balance the count and nothing is ever pruned. The
    // walk is O(cache) against a readdir we have already paid for.
    for (const key of markerCache.keys()) if (!seen.has(key)) markerCache.delete(key);
  } catch {
    // no sessions dir yet
  }
  return out;
}

// Tests reach for these; nothing in the product should need them.
export function _clearMarkerCache() {
  markerCache.clear();
  parses = 0;
}

// How many markers this process has parsed. The cache test used to assert that the second walk
// was FASTER than the first, which is a coin flip on a loaded machine — it measures the OS file
// cache and the JIT as much as anything we wrote, and it goes red for reasons no one can act on.
// The claim is "a marker whose stamp is unchanged is not opened again", so count the opens.
export function _markerParseCount() {
  return parses;
}

export function _markerCacheSize() {
  return markerCache.size;
}

// A session that is killed (crash, closed terminal) never fires SessionEnd, so its marker
// is orphaned. Sweep old ones so the directory doesn't grow without bound.
export function sweepStaleMarkers(now = Date.now()) {
  let removed = 0;
  try {
    const dir = sessionsDir();
    if (dir === null) return 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(dir, f);
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
