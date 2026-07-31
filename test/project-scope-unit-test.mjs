// project-scope unit tests.
//
// The module had none: it was only ever exercised over HTTP, which cannot reach the parts that
// decide how EXPENSIVE a request is (the 2s positive cache, the one-fresh-rebuild retry, and the
// negative cache that stops an unknown project forcing a rebuild every time). Those are exactly
// the paths a hostile page drives, so they are worth pinning directly.

import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { scratchDir } from './_env.mjs';
import { join } from 'node:path';

const ROOT = scratchDir('scopeunit');
rmSync(ROOT, { recursive: true, force: true });
const HOME = join(ROOT, 'home');
mkdirSync(join(HOME, 'sessions'), { recursive: true });

// Hermetic: own DB, own STICKIES_HOME, sync and webhook blanked, set BEFORE the store is imported.
Object.assign(process.env, {
  STICKIES_DB: join(ROOT, 'scope.db'),
  STICKIES_HOME: HOME,
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  STICKIES_DISCORD_WEBHOOK: '',
});

const { resolveProject, knownProjects, _clearCache } = await import('../src/project-scope.js');
const { createSticky } = await import('../src/store.js');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const LAUNCH = 'C:/Launch/Proj';
// Slightly wider than the module's own throttle window, so the wait is not a coin flip.
const FRESH_WINDOW_MS = 300;

// --- the launch project is always servable, cache or no cache ------------------------------
_clearCache();
check(resolveProject(null, LAUNCH).project === LAUNCH, 'no ?project= means the launch project');
check(resolveProject(undefined, LAUNCH).project === LAUNCH, 'undefined behaves the same');
check(resolveProject('', LAUNCH).project === LAUNCH, 'and an empty string');
check(knownProjects(LAUNCH).has(LAUNCH), 'the launch project is always in the allowlist');

// --- present-but-degenerate is refused, not substituted -----------------------------------
// The module's contract: a value that is not allowlisted is REJECTED rather than quietly
// replaced. A value that normalizes to nothing was still a value the caller sent.
for (const junk of ['/', '///', '   ', '\\', '\\\\', 'C:/x</script>']) {
  const r = resolveProject(junk, LAUNCH);
  check(r.ok === false && r.project === null, `${JSON.stringify(junk)} is refused, not downgraded to the launch project`);
}

// --- an ordinary POSIX path with a quote in it is NOT dangerous ---------------------------
// The first version of the markup guard rejected quotes and backticks too. Those are legal in
// POSIX directory names, so every note from `/home/dev/john's-app` normalized to null — which
// means GLOBAL, i.e. the note leaked into every other project's digest. Narrow the guard;
// quotes are handled by HTML-escaping at render time, which is where they matter.
const { normalizeProjectPath, isUnsafeProjectPath } = await import('../src/store-path.js');
for (const ok of ["/home/dev/john's-app", '/Users/x/It\u2019s Mine', '/srv/a"b', '/srv/back`tick', 'C:/Users/dev/my app']) {
  check(normalizeProjectPath(ok) !== null, `an ordinary path survives normalization: ${ok}`);
  check(isUnsafeProjectPath(ok) === false, `and is not flagged unsafe: ${ok}`);
}
for (const bad of ['C:/x</script>', 'C:/x<img>', 'C:/x\u0000y', 'C:/x\u2028y']) {
  check(normalizeProjectPath(bad) === null, `markup/control chars are still refused: ${JSON.stringify(bad)}`);
  check(isUnsafeProjectPath(bad) === true, `and flagged unsafe: ${JSON.stringify(bad)}`);
}
// And an unsafe path must be REFUSED at write time, never silently filed as a global note.
let threw = null;
try {
  createSticky({ content: 'should not be stored', category: 'context', importance: 'P3', project_path: 'C:/x</script>' });
} catch (e) { threw = e.message; }
check(threw !== null && /project_path/.test(threw), `createSticky refuses an unsafe project_path (${threw})`);
const quoted = "/home/dev/john's-app";
const made = createSticky({ content: 'a note from a quoted path', category: 'context', importance: 'P3', project_path: quoted });
check(made.project_path === quoted, 'while a quoted path is stored against its own project, not globally');

// --- normalization is applied on the way in ------------------------------------------------
check(resolveProject('C:/Launch/Proj/', LAUNCH).ok, 'a trailing slash still matches');
check(resolveProject('C:\\Launch\\Proj', LAUNCH).ok, 'and so do backslashes');
check(resolveProject('C:/Launch/Proj/../Proj', LAUNCH).ok === false, 'but a ..-path is not resolved into a match');

// --- a project that registers later is picked up despite the positive cache ---------------
// The one-fresh-rebuild retry exists so a terminal opened 200ms ago is not told "unknown".
const LATE = join(ROOT, 'late-project').replace(/\\/g, '/');
_clearCache();
knownProjects(LAUNCH);                                   // warm the 2s cache without LATE in it
check(resolveProject(LATE, LAUNCH).ok === false, 'an unregistered project is unknown');
createSticky({ content: 'registers the late project', category: 'context', importance: 'P3', project_path: LATE });
await new Promise((r) => setTimeout(r, FRESH_WINDOW_MS));
check(resolveProject(LATE, LAUNCH).ok === true,
  'a project registered after the cache was warmed still resolves (the fresh-rebuild retry fires)');

// --- dismissing your last note must not un-register the project ---------------------------
// The allowlist used to be built from projectSummaries(), which filters `status = 'active'`
// because it feeds a display of what is on your board NOW. So a project dropped out of the
// allowlist the moment its last note was dismissed: clearing your board — the tidy thing to do —
// took the board away. Reported live from ash's own machine, where every note in the stickies
// repo itself was dismissed and its Flow Board answered "Unknown project" from every terminal.
// The Flow Board is derived from ROADMAP.md and involves stickies not at all, which is what
// makes this severe rather than cosmetic.
const TIDIED = join(ROOT, 'tidied-project').replace(/\\/g, '/');
const doomed = createSticky({ content: 'the only note here', category: 'todo', importance: 'P3', project_path: TIDIED });
_clearCache();
check(resolveProject(TIDIED, LAUNCH).ok === true, 'a project with a note is servable');
const { dismissSticky } = await import('../src/store.js');
dismissSticky(doomed.id, 'done with it');
_clearCache();
check(resolveProject(TIDIED, LAUNCH).ok === true,
  'and STAYS servable once that note is dismissed — a dismissed note still proves the project is yours');
check(knownProjects(LAUNCH).has(TIDIED), 'so it is still offered in the project switcher');

// --- a miss cannot be used to force a rebuild per request ---------------------------------
// This is the amplification the throttle exists for, so the test drives it the way an attacker
// would: a DIFFERENT unknown path every time, which defeats any per-path memoization.
_clearCache();
for (let i = 0; i < 40; i++) createSticky({ content: 'bulk ' + i, category: 'context', importance: 'P3', project_path: `C:/bulk/p${i}` });
resolveProject('C:/warm/the/throttle', LAUNCH); // consumes this window's one rebuild
const t0 = process.hrtime.bigint();
for (let i = 0; i < 200; i++) resolveProject(`C:/nope/${i}`, LAUNCH); // each one unique
const perReqUs = Number(process.hrtime.bigint() - t0) / 200 / 1000;
check(perReqUs < 200, `200 distinct unknown projects stay cheap (${perReqUs.toFixed(1)}us each)`);
check(resolveProject('C:/nope/7', LAUNCH).ok === false, 'and every one of them is still a rejection');

// --- but the throttle must not lock out a project that just appeared ----------------------
const SOON = join(ROOT, 'soon-project').replace(/\\/g, '/');
_clearCache();
knownProjects(LAUNCH);                        // warm the positive cache without SOON in it
createSticky({ content: 'registers soon-project', category: 'context', importance: 'P3', project_path: SOON });
await new Promise((r) => setTimeout(r, FRESH_WINDOW_MS));
check(resolveProject(SOON, LAUNCH).ok === true,
  'a project registered a moment ago resolves on the next click, throttle or no throttle');

// --- a broken store costs you the switcher, not your own board ----------------------------
// knownProjects swallows a store failure by design: the launch project must survive it.
check(knownProjects('C:/Some/Other/Launch').has('C:/Some/Other/Launch'), 'any launch project is permitted even when nothing else is known');

// --- a path that reduces to nothing must not become GLOBAL -----------------------------------
//
// `null` is the global sentinel, and `normalizeProjectPath` returns null for a bare separator or
// a whitespace-only string. So a note written for project "/" was filed into EVERY project's
// digest. The guard only tested for markup characters, while three comments beside it described
// a protection it did not provide. Reachable from the Stop hook with cwd `/` on POSIX, and from
// a synced document — which is untrusted input written by whoever can push to the sync repo.
{
  const BS = String.fromCharCode(92);
  // Only forms that genuinely reduce to nothing. `./` and `/./` are NOT in this list: they
  // normalize to `.`, which is a real relative path, not the global sentinel.
  for (const p of ['/', '//', BS, BS + BS, '   ', '\t', ' / ', BS + ' ']) {
    check(normalizeProjectPath(p) === null, `precondition: ${JSON.stringify(p)} normalizes to null`);
    check(isUnsafeProjectPath(p) === true,
      `a path that reduces to nothing is refused, not silently made global: ${JSON.stringify(p)}`);
  }
  // The two documented ways of ASKING for global stay allowed — this must not become a blanket ban.
  check(isUnsafeProjectPath(null) === false, 'null still means global and is allowed');
  check(isUnsafeProjectPath(undefined) === false, 'undefined still means global and is allowed');
  check(isUnsafeProjectPath('') === false, 'the empty string still means global and is allowed');
  // And ordinary paths are untouched.
  for (const p of ['/home/x', 'C:/Users/ash/proj', 'C:/', '.', 'rel/path']) {
    check(isUnsafeProjectPath(p) === false, `an ordinary path is still accepted: ${JSON.stringify(p)}`);
  }
}

console.log(fail ? `\nproject-scope-unit: ${fail} FAILED` : '\nproject-scope-unit: all passed');
try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
