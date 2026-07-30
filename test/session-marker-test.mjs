// session-marker had no direct tests, and it is the SECOND source of the dashboard's project
// allowlist — so its staleness bound and its failure modes decide which folders a local caller
// can read boards and .planning/ docs for.
//
// It is also the expensive half of the allowlist rebuild that an unauthenticated request can
// trigger, so the parse cache below is a security property as much as a performance one.

import { writeFileSync, mkdirSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, cleanup } from './_env.mjs';

const ROOT = scratchDir('marker');
const HOME = join(ROOT, 'home');
const SESSIONS = join(HOME, 'sessions');
mkdirSync(SESSIONS, { recursive: true });
process.env.STICKIES_HOME = HOME;

const { sessionProjects, sweepStaleMarkers, writeMarker, markerPath, _clearMarkerCache, _markerParseCount, _markerCacheSize } =
  await import('../src/session-marker.js');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const DAY = 24 * 60 * 60 * 1000;
function marker(name, project, ageMs = 0) {
  const p = join(SESSIONS, name);
  writeFileSync(p, JSON.stringify({ session_id: name, project_path: project, started_at: new Date().toISOString() }));
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

// --- the staleness bound --------------------------------------------------------------------
// If this comparison ever inverted, every folder a session had EVER run in would become
// servable. If it were too tight, a terminal open since yesterday would 403 on its own board.
_clearMarkerCache();
marker('fresh.json', 'C:/proj/fresh');
marker('sixdays.json', 'C:/proj/sixdays', 6 * DAY);
marker('eightdays.json', 'C:/proj/eightdays', 8 * DAY);
let got = sessionProjects();
check(got.includes('C:/proj/fresh'), 'a fresh marker is returned');
check(got.includes('C:/proj/sixdays'), 'and one from six days ago is still inside the week');
check(!got.includes('C:/proj/eightdays'), 'but one from eight days ago has expired');

// --- one bad marker must not take the rest with it -------------------------------------------
// A single malformed file used to be the difference between "the switcher lists your projects"
// and "the allowlist collapses to the launch project and every other terminal 403s".
_clearMarkerCache();
writeFileSync(join(SESSIONS, 'garbage.json'), '{{ not json at all');
writeFileSync(join(SESSIONS, 'empty.json'), '');
writeFileSync(join(SESSIONS, 'noproject.json'), JSON.stringify({ session_id: 'x' }));
writeFileSync(join(SESSIONS, 'notjson.txt'), 'ignored entirely');
got = sessionProjects();
check(got.includes('C:/proj/fresh'), 'a malformed marker does not hide the good ones');
check(!got.some((p) => /garbage|empty|noproject/.test(p)), 'and contributes nothing itself');
check(sessionProjects().length === got.length, 'the result is stable across calls');

// --- the parse cache ------------------------------------------------------------------------
// Re-reading and re-parsing the whole directory on every allowlist rebuild is what an
// unauthenticated caller can drive. Same mtime => no re-read.
_clearMarkerCache();
for (let i = 0; i < 400; i++) marker(`bulk${i}.json`, `C:/bulk/p${i}`);
const cold = sessionProjects();
const afterCold = _markerParseCount();
const warm = sessionProjects();
const afterWarm = _markerParseCount();
check(cold.length === warm.length && warm.length >= 400, `both passes see every marker (${cold.length} / ${warm.length})`);
// Counted, not timed. "The second walk was faster" measures the OS file cache and the JIT as
// much as this module, and it goes red on a busy machine for reasons nobody can act on. The
// actual claim is that an unchanged marker is not opened again.
check(afterCold >= 400, `the cold walk parses every marker (${afterCold})`);
check(afterWarm === afterCold, `and the warm walk parses none of them again (${afterWarm - afterCold} re-reads)`);

// …but a NEW marker must still appear, or the cache would be a correctness bug rather than a
// speed-up: a just-opened terminal would be told its own project is unknown.
marker('brandnew.json', 'C:/proj/brand-new');
check(sessionProjects().includes('C:/proj/brand-new'), 'a marker written after the cache was warm is still found');

// …and a REMOVED marker must stop being returned.
rmSync(join(SESSIONS, 'brandnew.json'));
check(!sessionProjects().includes('C:/proj/brand-new'), 'a removed marker stops being returned');

// …and an edited marker (same name, new content) is re-read, because its mtime moved.
marker('fresh.json', 'C:/proj/fresh-moved');
const afterEdit = sessionProjects();
check(afterEdit.includes('C:/proj/fresh-moved'), 'an edited marker is re-read rather than served from cache');
check(!afterEdit.includes('C:/proj/fresh'), 'and the old value is gone');

// …and a marker rewritten WITHIN the same clock tick is re-read. Windows file timestamps move
// with the system clock tick (~15.6ms), so two writes close together genuinely carry the same
// mtime — and back-to-back `claude -p` sessions do exactly that. Both timestamps here are set
// from one Date, so the mtime is byte-identical by construction and only the size differs.
const tick = new Date(Date.now() - 60_000);
const sameTick = join(SESSIONS, 'sametick.json');
writeFileSync(sameTick, JSON.stringify({ session_id: 's', project_path: 'C:/proj/tick-before' }));
utimesSync(sameTick, tick, tick);
check(sessionProjects().includes('C:/proj/tick-before'), 'a marker is picked up before the rewrite');
writeFileSync(sameTick, JSON.stringify({ session_id: 's', project_path: 'C:/proj/tick-after-rewrite' }));
utimesSync(sameTick, tick, tick);
const sameTickGot = sessionProjects();
check(sameTickGot.includes('C:/proj/tick-after-rewrite'), 'a same-mtime rewrite is still re-read');
check(!sameTickGot.includes('C:/proj/tick-before'), 'and the stale value it replaced is gone');
rmSync(sameTick);

// --- the cache is pruned even when the counts happen to balance -------------------------------
// The prune used to be guarded on `cache.size > seen.size`, which is false whenever a marker in
// the directory never makes it into the cache — an expired one, or a malformed one. One of those
// plus one ended session balances the books, and the entry for the ended session is kept forever.
{
  const HOME2 = join(ROOT, 'home2');
  const SESSIONS2 = join(HOME2, 'sessions');
  mkdirSync(SESSIONS2, { recursive: true });
  const prev = process.env.STICKIES_HOME;
  process.env.STICKIES_HOME = HOME2;
  _clearMarkerCache();
  const old = join(SESSIONS2, 'expired.json');
  writeFileSync(old, JSON.stringify({ session_id: 'old', project_path: 'C:/proj/expired' }));
  const t = (Date.now() - 8 * DAY) / 1000;
  utimesSync(old, t, t);
  writeFileSync(join(SESSIONS2, 'ended.json'), JSON.stringify({ session_id: 'a', project_path: 'C:/proj/ended' }));
  sessionProjects();
  rmSync(join(SESSIONS2, 'ended.json'));
  writeFileSync(join(SESSIONS2, 'started.json'), JSON.stringify({ session_id: 'b', project_path: 'C:/proj/started' }));
  const after = sessionProjects();
  check(!after.includes('C:/proj/ended'), 'a session that ended stops being served');
  check(_markerCacheSize() === 1, `and its cache entry is dropped rather than kept forever (${_markerCacheSize()} entries)`);
  process.env.STICKIES_HOME = prev;
  _clearMarkerCache();
  sessionProjects(); // re-warm against the original directory for the sections below
}

// --- the sweep ------------------------------------------------------------------------------
const before = readdirSync(SESSIONS).length;
const removed = sweepStaleMarkers();
check(removed >= 1, `the sweep removes stale markers (${removed})`);
check(readdirSync(SESSIONS).length === before - removed, 'and removes exactly what it reported');
check(sessionProjects().includes('C:/proj/sixdays'), 'while leaving markers inside the window alone');

// --- a session id cannot escape the sessions directory ---------------------------------------
const escaped = markerPath('../../evil');
check(!escaped.includes('..'), `a traversal id is sanitised (${escaped.split(/[\\/]/).pop()})`);
check(markerPath('a/b').endsWith('a_b.json'), 'and separators are replaced rather than honoured');
writeMarker('legit-session', 'C:/proj/written');
check(sessionProjects().includes('C:/proj/written'), 'writeMarker registers a project');

console.log(fail ? `\nsession-marker: ${fail} FAILED` : '\nsession-marker: all passed');
cleanup(ROOT);
process.exit(fail ? 1 : 0);
