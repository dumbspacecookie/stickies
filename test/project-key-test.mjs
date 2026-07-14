// Cross-machine project identity: the same git repo cloned to DIFFERENT paths must
// resolve to the same project_key, so a project-scoped note written on machine A shows
// under machine B's project view after sync — despite different filesystem paths.
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky, readStickies, upsertFromSync, exportAllRows } from '../src/store.js';
import { deriveProjectKey, _clearCache } from '../src/project-key.js';

const ROOT = join(tmpdir(), 'stickies_pk');
rmSync(ROOT, { recursive: true, force: true });
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

console.log('\n' + (fail === 0 ? 'PROJECT KEY OK' : fail + ' FAILURES'));
closeDb();
process.exitCode = fail === 0 ? 0 : 1;
