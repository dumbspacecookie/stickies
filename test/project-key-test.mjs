// Cross-machine project identity: the same git repo cloned to DIFFERENT paths must
// resolve to the same project_key, so a project-scoped note written on machine A shows
// under machine B's project view after sync — despite different filesystem paths.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky, readStickies, upsertFromSync, exportAllRows } from '../src/store.js';
import { deriveProjectKey, canonicalizeRemote, _clearCache, _stats } from '../src/project-key.js';
import { scratchDir, cleanup } from './_env.mjs';

// Own directory per run: this file wiped a FIXED root at startup, so a concurrent run deleted
// the other's git checkouts mid-test.
const ROOT = scratchDir('pk');
mkdirSync(ROOT, { recursive: true });
const REMOTE = join(ROOT, 'remote.git');
const WA = join(ROOT, 'alpha-checkout');   // machine A working copy
const WB = join(ROOT, 'beta-elsewhere');   // machine B working copy (different path!)
const dbA = join(ROOT, 'a.db');
const dbB = join(ROOT, 'b.db');

spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
spawnSync('git', ['clone', REMOTE, WA], { encoding: 'utf8' });
spawnSync('git', ['clone', REMOTE, WB], { encoding: 'utf8' });

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Same remote, different working-copy paths -> identical project_key.
_clearCache();
const keyA = deriveProjectKey(WA);
const keyB = deriveProjectKey(WB);
check(keyA && keyA === keyB, `same remote -> same key (A=${keyA}, B=${keyB})`);
check(keyA.startsWith('git:'), 'key is derived from the git remote, not the path');

// Machine A writes a project note; capture the row to "sync".
closeDb(); process.env.STICKIES_DB = dbA;
createSticky({ content: 'A: project-scoped decision', category: 'decision', importance: 'P1', project_path: WA });
const exported = exportAllRows();
check(exported[0].project_key === keyA, 'written note carries the git project_key');

// Machine B imports it, then reads ITS project (different path).
closeDb(); process.env.STICKIES_DB = dbB;
for (const rec of exported) upsertFromSync(rec);
const seenOnB = readStickies({ project_path: WB });
check(seenOnB.some((s) => s.content === 'A: project-scoped decision'), 'A\'s project note shows under B\'s project view (different path)');

// Sanity: a note for a DIFFERENT project must NOT leak into this view.
const other = join(ROOT, 'unrelated');
mkdirSync(other, { recursive: true });
createSticky({ content: 'unrelated note', category: 'todo', project_path: other });
const stillB = readStickies({ project_path: WB });
check(!stillB.some((s) => s.content === 'unrelated note'), 'unrelated project note does not leak into B\'s view');

// --- the cost of deriving a key, and the cost of remembering one --------------------------
// deriveProjectKey used to launch a `git` process for every path it had not seen before, and
// remember the answer forever. Measured on Windows: 30.3 ms for a write that went through the
// spawn against 0.6 ms for one that did not — a 50x tax paid on the single-threaded event loop
// that also serves the dashboard and the MCP server, so it is 30 ms during which the whole
// process does nothing else. And the cache it filled was keyed on caller-supplied paths, which
// makes an unbounded Map a slow memory leak in any long-running dashboard.
//
// Both properties are asserted on the OBSERVABLE, not on a stopwatch: how many processes were
// started, and what the cache still remembers. A timing assertion here would be a coin toss on a
// loaded machine, which is how a test becomes something people re-run until it goes green.
{
  const noSpawn = (label) => check(_stats().spawns === 0, `${label} (git processes started: ${_stats().spawns})`);

  // (a) a directory that is not a repo at all. The old code paid for a whole process to be told
  // "not a git repository" — for every project you have that is not under version control.
  _clearCache();
  const plain = join(ROOT, 'not-a-repo');
  mkdirSync(plain, { recursive: true });
  const plainKey = deriveProjectKey(plain);
  check(plainKey.startsWith('path:'), `a non-repo still falls back to a path key (${plainKey})`);
  noSpawn('and derives it without launching git');

  // (b) the ordinary case: a clone with an origin remote. The key must be identical to the one
  // the spawn produced — this is what makes a note written on machine A visible on machine B, so
  // a faster answer that is a DIFFERENT answer would silently split one project into two.
  _clearCache();
  check(deriveProjectKey(WA) === keyA, 'a real clone derives the same key as before');
  noSpawn('reading the remote straight out of .git/config instead of spawning git');

  // (c) a repo with no remote: still no spawn, because "this config has no origin" is an answer,
  // not a maybe.
  _clearCache();
  const bare = join(ROOT, 'no-remote');
  mkdirSync(bare, { recursive: true });
  spawnSync('git', ['init', '-b', 'main', bare], { encoding: 'utf8' });
  check(deriveProjectKey(bare).startsWith('path:'), 'a repo with no remote falls back to a path key');
  noSpawn('and does not spawn to discover that');

  // (d) the fallback is real code, not decoration. An `[includeIf]` directive can define a remote
  // in another file; we do not follow those, so this must hand back to git rather than answer
  // "no remote" and key the project wrongly forever.
  _clearCache();
  const included = join(ROOT, 'included-config');
  spawnSync('git', ['clone', REMOTE, included], { encoding: 'utf8' });
  const cfgPath = join(included, '.git', 'config');
  writeFileSync(cfgPath, '[includeIf "gitdir:/nowhere/"]\n\tpath = other\n' + readFileSync(cfgPath, 'utf8'));
  check(deriveProjectKey(included) === keyA, 'a config we will not fully parse still yields the right key');
  check(_stats().spawns === 1, `by falling back to git exactly once (spawns: ${_stats().spawns})`);

  // (d2) git writes a Windows path remote into config ESCAPED — `C:\repos\x.git` is stored as
  // `C:\\repos\\x.git`. A reader that takes those bytes literally derives a different key from
  // the one git reports, which means every note written before this change stops matching its
  // project. Same key as canonicalizeRemote gets from git's own answer, or it is a regression.
  _clearCache();
  const winPath = join(ROOT, 'win-remote');
  spawnSync('git', ['clone', REMOTE, winPath], { encoding: 'utf8' });
  spawnSync('git', ['-C', winPath, 'remote', 'set-url', 'origin', 'C:\\repos\\notes.git'], { encoding: 'utf8' });
  check(deriveProjectKey(winPath) === canonicalizeRemote('C:\\repos\\notes.git'),
    `an escaped Windows remote unescapes to the same key git would give (${deriveProjectKey(winPath)})`);
  noSpawn('without falling back to a process');

  // (e) the cache is bounded. Fill it well past its limit and it must not have grown past it.
  _clearCache();
  const { max } = _stats();
  for (let i = 0; i < max + 50; i++) deriveProjectKey(join(ROOT, 'fill', String(i)));
  check(_stats().size <= max, `the cache stops growing at ${max} entries (size: ${_stats().size})`);

  // (f) …and it evicts the LEAST RECENTLY USED, not the most recent. Observable because the key
  // is derived from the config: rewrite the remote, and a cached path keeps answering with the
  // old key while an evicted one re-reads and answers with the new one.
  _clearCache();
  const lru = join(ROOT, 'lru-repo');
  spawnSync('git', ['clone', REMOTE, lru], { encoding: 'utf8' });
  const first = deriveProjectKey(lru);
  check(first === keyA, 'a fresh clone keys off its remote');
  spawnSync('git', ['-C', lru, 'remote', 'set-url', 'origin', 'https://example.invalid/moved.git'], { encoding: 'utf8' });
  check(deriveProjectKey(lru) === first, 'a cached path is answered from the cache (the remote changed underneath it)');
  // Fill to exactly the limit, touch it again so it is the most recently used, then fill again.
  for (let i = 0; i < max - 1; i++) deriveProjectKey(join(ROOT, 'wave1', String(i)));
  check(deriveProjectKey(lru) === first, 'it survives a cache filled exactly to the limit');
  for (let i = 0; i < max - 1; i++) deriveProjectKey(join(ROOT, 'wave2', String(i)));
  check(deriveProjectKey(lru) === first, 'and survives the next wave, because using it made it recent');
  // Now let it go cold: a full cache's worth of other paths, with no touch in between.
  for (let i = 0; i < max + 1; i++) deriveProjectKey(join(ROOT, 'wave3', String(i)));
  check(deriveProjectKey(lru) === 'git:example.invalid/moved',
    `a cold entry IS evicted and re-derived (got ${deriveProjectKey(lru)})`);
}

console.log('\n' + (fail === 0 ? 'PROJECT KEY OK' : fail + ' FAILURES'));
closeDb();
cleanup(ROOT);
process.exitCode = fail === 0 ? 0 : 1;
