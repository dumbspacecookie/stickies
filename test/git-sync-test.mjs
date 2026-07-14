// Offline end-to-end git sync: a bare repo stands in for the "remote"; two clones are
// two machines. Verifies notes converge both directions through real git pull/push.
// Nothing leaves the machine — the remote is a local bare repo in tmp.
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky, getSticky, exportAllRows } from '../src/store.js';
import { sync } from '../src/git-sync.js';

const ROOT = join(tmpdir(), 'stickies_gitsync');
const REMOTE = join(ROOT, 'remote.git');
const WA = join(ROOT, 'machineA');
const WB = join(ROOT, 'machineB');
const dbA = join(ROOT, 'a.db');
const dbB = join(ROOT, 'b.db');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const g = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
function configure(repo) {
  g(repo, 'config', 'user.email', 'test@stickies.local');
  g(repo, 'config', 'user.name', 'Stickies Test');
}

// Set up a non-empty remote with a main branch both clones can track.
spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
spawnSync('git', ['clone', REMOTE, WA], { encoding: 'utf8' });
configure(WA);
g(WA, 'commit', '--allow-empty', '-m', 'init');
g(WA, 'branch', '-M', 'main');
g(WA, 'push', '-u', 'origin', 'main');
spawnSync('git', ['clone', REMOTE, WB], { encoding: 'utf8' });
configure(WB);

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

function machine(db, repo) {
  closeDb();
  process.env.STICKIES_DB = db;
  process.env.STICKIES_SYNC_REPO = repo;
}

// Machine A: add note, sync (push to remote).
machine(dbA, WA);
const aNote = createSticky({ content: 'A: decided on git sync', category: 'decision', importance: 'P1', project_path: '/proj' });
const rA1 = sync();
check(rA1.steps.some((s) => s.startsWith('push: ok')), `A pushed (${rA1.steps.join(' | ')})`);

// Machine B: add a different note, sync (pull A's, merge, push both).
machine(dbB, WB);
const bNote = createSticky({ content: 'B: added a todo', category: 'todo', importance: 'P2', project_path: '/proj' });
const rB1 = sync();
check(rB1.steps.some((s) => s.includes('import: +1')), `B pulled & imported A's note (${rB1.steps.join(' | ')})`);
check(!!getSticky(aNote.id), 'B now has A\'s note');
check(!!getSticky(bNote.id), 'B still has its own note');

// Machine A again: sync (pull B's addition).
machine(dbA, WA);
const rA2 = sync();
check(!!getSticky(bNote.id), 'A now has B\'s note after second sync');
check(!!getSticky(aNote.id), 'A still has its own note');

// Both machines converged to the same 2 stickies.
machine(dbA, WA);
const aCount = exportAllRows().length;
machine(dbB, WB);
const bCount = exportAllRows().length;
check(aCount === 2 && bCount === 2, `both machines converged to 2 stickies (A=${aCount}, B=${bCount})`);

console.log('\n' + (fail === 0 ? 'GIT SYNC OK' : fail + ' FAILURES'));
closeDb();
process.exitCode = fail === 0 ? 0 : 1;
