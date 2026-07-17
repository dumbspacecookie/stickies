// Regression: a scratch/test store must never auto-sync into the operator's corpus.
//
// The leak this locks shut: a test points STICKIES_DB at a temp file for isolation, but
// inherits the developer's real STICKIES_AUTO_SYNC + STICKIES_SYNC_REPO. The spawned hook
// then exports its fixtures to the shared sync file, commits, and pushes — and every
// machine that syncs pulls them in as genuine notes. One `npm test` run per pair; a live
// corpus reached ~40% GLOBAL_TASK/LOCAL_TASK rows this way.
//
// autoSyncEnabled() must refuse for any DB under the OS temp dir, regardless of env.
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

const { isScratchDb, autoSyncEnabled } = await import('../src/git-sync.js');

// --- isScratchDb: classification ---------------------------------------------
check('a DB in the OS temp dir is scratch', isScratchDb(join(tmpdir(), 'stickies_test.db')) === true);
check('a nested temp DB is scratch', isScratchDb(join(tmpdir(), 'deep', 'nest', 'x.db')) === true);
check('the real ~/.stickies store is NOT scratch', isScratchDb(join(homedir(), '.stickies', 'stickies.db')) === false);
check('a user-chosen path outside temp is NOT scratch', isScratchDb(join(homedir(), 'notes', 'mine.db')) === false);
// A path that merely starts with the temp string but is a sibling dir must not match.
check('a sibling of the temp dir is NOT scratch', isScratchDb(tmpdir() + '_evil/x.db') === false);
check('an unreadable path degrades to not-scratch', isScratchDb(null) === false);

// --- autoSyncEnabled: the gate ------------------------------------------------
// Fully "enabled" sync config, pointed at a temp DB: must still refuse.
process.env.STICKIES_AUTO_SYNC = '1';
process.env.STICKIES_SYNC_REPO = join(tmpdir(), 'some_repo');
process.env.STICKIES_DB = join(tmpdir(), 'stickies_guard_test.db');
check('auto-sync REFUSES a temp DB even with sync fully configured', autoSyncEnabled() === false);

// Same config against a non-temp store: the gate must still open, or we have broken sync
// for real users rather than fixed the leak.
process.env.STICKIES_DB = join(homedir(), '.stickies', 'stickies.db');
check('auto-sync still allowed for a real store', autoSyncEnabled() === true);

// The explicit test override opts a temp DB back in (used by the sync machinery's own
// end-to-end tests). Must work, and must NOT weaken classification when unset.
process.env.STICKIES_AUTO_SYNC = '1';
process.env.STICKIES_SYNC_REPO = join(tmpdir(), 'some_repo');
process.env.STICKIES_DB = join(tmpdir(), 'stickies_guard_test.db');
process.env.STICKIES_ALLOW_SCRATCH_SYNC = '1';
check('override lets a temp DB auto-sync (for sync tests)', autoSyncEnabled() === true);
check('override flips isScratchDb to false', isScratchDb(join(tmpdir(), 'x.db')) === false);
delete process.env.STICKIES_ALLOW_SCRATCH_SYNC;
check('temp DB blocked again once override is cleared', autoSyncEnabled() === false);

// The pre-existing opt-in gates must keep working.
process.env.STICKIES_AUTO_SYNC = '';
check('auto-sync off when STICKIES_AUTO_SYNC is unset', autoSyncEnabled() === false);
process.env.STICKIES_AUTO_SYNC = '1';
process.env.STICKIES_SYNC_REPO = '';
check('auto-sync off when no sync repo configured', autoSyncEnabled() === false);

for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
const allOk = checks.every(([, ok]) => ok);
console.log('\n' + (allOk ? 'SCRATCH-DB GUARD OK' : 'SCRATCH-DB GUARD FAILED'));
process.exit(allOk ? 0 : 1);
