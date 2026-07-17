// Auto-sync: verifies the opt-in gate and that maybeAutoSync() (used by the hooks)
// pushes on one machine and pulls on another. Offline — local bare repo as "remote".
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky, getSticky } from '../src/store.js';
import { maybeAutoSync, autoSyncEnabled } from '../src/git-sync.js';

const ROOT = join(tmpdir(), 'stickies_autosync');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REMOTE = join(ROOT, 'remote.git');
const WA = join(ROOT, 'A');
const WB = join(ROOT, 'B');
const dbA = join(ROOT, 'a.db');
const dbB = join(ROOT, 'b.db');

const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
spawnSync('git', ['clone', REMOTE, WA], { encoding: 'utf8' });
g(WA, 'config', 'user.email', 't@s.local'); g(WA, 'config', 'user.name', 'T');
g(WA, 'commit', '--allow-empty', '-m', 'init'); g(WA, 'branch', '-M', 'main'); g(WA, 'push', '-u', 'origin', 'main');
spawnSync('git', ['clone', REMOTE, WB], { encoding: 'utf8' });
g(WB, 'config', 'user.email', 't@s.local'); g(WB, 'config', 'user.name', 'T');

// These fixtures are temp DBs by design (two temp stores = two machines). The scratch-DB
// guard would otherwise refuse to auto-sync them; opt back in explicitly. A real session
// never sets this — see isScratchDb() in git-sync.js.
process.env.STICKIES_ALLOW_SCRATCH_SYNC = '1';

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };
function machine(db, repo) { closeDb(); process.env.STICKIES_DB = db; if (repo) process.env.STICKIES_SYNC_REPO = repo; }

// Gate: off by default even with a repo set.
machine(dbA, WA);
delete process.env.STICKIES_AUTO_SYNC;
check(autoSyncEnabled() === false, 'auto-sync disabled by default');
check(maybeAutoSync() === null, 'maybeAutoSync is a no-op when disabled');

// Gate: enabled flag but no repo -> still off.
process.env.STICKIES_AUTO_SYNC = '1';
delete process.env.STICKIES_SYNC_REPO;
check(autoSyncEnabled() === false, 'auto-sync stays off without a repo configured');

// Enabled + repo: machine A writes and auto-syncs (push).
machine(dbA, WA);
process.env.STICKIES_AUTO_SYNC = '1';
const note = createSticky({ content: 'auto-synced decision', category: 'decision', importance: 'P1', project_path: WA });
const a = maybeAutoSync();
check(a && a.steps?.some((s) => s.startsWith('push: ok')), `A auto-pushed (${a?.steps?.join(' | ')})`);

// Machine B auto-syncs (pull) and gets A's note.
machine(dbB, WB);
process.env.STICKIES_AUTO_SYNC = '1';
const b = maybeAutoSync();
check(b && b.steps?.some((s) => s.startsWith('pull: ok')), `B auto-pulled (${b?.steps?.join(' | ')})`);
check(!!getSticky(note.id), 'B received A\'s note via auto-sync');

// Second sync with no new data must NOT churn a commit (deterministic export).
const b2 = maybeAutoSync();
check(b2 && b2.steps?.some((s) => s === 'commit: nothing changed'), `re-sync is a no-op, no commit churn (${b2?.steps?.join(' | ')})`);

console.log('\n' + (fail === 0 ? 'AUTO-SYNC OK' : fail + ' FAILURES'));
closeDb();
process.exitCode = fail === 0 ? 0 : 1;
