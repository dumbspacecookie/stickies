// The two ways sync could destroy or leak data, pinned as tests.
//
// Both were found by audit round 4 and both had ZERO coverage before this file existed, which is
// why they survived: the sync suite asserts that notes converge, and notes converged perfectly
// well while these bugs did their damage alongside.
//
//   1. `git commit` with no pathspec commits THE WHOLE INDEX. Anything the user had staged in the
//      sync repo went out under a "stickies sync" message and got pushed. A forgotten `.env.local`
//      is enough to publish a credential.
//   2. `loadStore()` caught every error and returned an empty store, so a notes.json carrying git
//      conflict markers read as zero notes — and the next write replaced the real board with the
//      empty one and committed it.
//
// Everything here runs against real git repos in a scratch directory. Nothing leaves the machine:
// the "remote" is a local bare repo.
import { spawnSync, execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky } from '../src/store.js';
import { sync } from '../src/git-sync.js';
import { scratchDir } from './_env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'src', 'repo-mode', 'engine.mjs');

const ROOT = scratchDir('syncsafety');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

const g = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// --- 1. the commit must contain the sync file and nothing else -----------------------------

const REMOTE = join(ROOT, 'remote.git');
const WORK = join(ROOT, 'work');
spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
spawnSync('git', ['clone', REMOTE, WORK], { encoding: 'utf8' });
g(WORK, 'config', 'user.email', 'test@stickies.local');
g(WORK, 'config', 'user.name', 'Stickies Test');
g(WORK, 'commit', '--allow-empty', '-m', 'init');
g(WORK, 'branch', '-M', 'main');
g(WORK, 'push', '-u', 'origin', 'main');

closeDb();
process.env.STICKIES_DB = join(ROOT, 'a.db');
createSticky({ content: 'a note that should sync', category: 'context', project_path: null });

// The user stages an unrelated secret-bearing file and forgets about it. This is the whole
// scenario: they never asked stickies to touch it, and stickies has no business committing it.
const SECRET_FILE = join(WORK, '.env.local');
const SECRET_VALUE = ['sk', 'ant', 'api03', 'B'.repeat(24)].join('-');
writeFileSync(SECRET_FILE, `ANTHROPIC_API_KEY=${SECRET_VALUE}\n`);
g(WORK, 'add', '.env.local');

const staged = g(WORK, 'diff', '--cached', '--name-only').stdout.trim();
check(staged.includes('.env.local'), 'precondition: the unrelated file is staged before sync runs');

const res = sync({ repo: WORK });
check(res.steps.some((s) => s.startsWith('commit: ok')), `sync committed (${res.steps.join(' | ')})`);

// What actually landed in the commit stickies made?
const committed = g(WORK, 'show', '--name-only', '--format=', 'HEAD').stdout
  .split('\n').map((s) => s.trim()).filter(Boolean);
check(committed.some((f) => f.endsWith('stickies.json')),
  'the sync file is in the commit');
check(!committed.includes('.env.local'),
  `the staged .env.local is NOT in the commit (contents: ${JSON.stringify(committed)})`);

// And it must not have reached the remote either.
const remoteBlob = spawnSync('git', ['-C', REMOTE, 'grep', '-I', SECRET_VALUE, 'main'], { encoding: 'utf8' });
check(remoteBlob.status !== 0, 'the secret is nowhere in the pushed remote history');

// The file is still staged afterwards — stickies left the user's work exactly as it found it.
const stillStaged = g(WORK, 'diff', '--cached', '--name-only').stdout;
check(stillStaged.includes('.env.local'), "the user's staged file is left alone, not silently committed");

// --- 2. a corrupt store must never read as an empty board ------------------------------------

// engine.mjs resolves its store from CLAUDE_PROJECT_DIR at import time, so each case is a fresh
// child process with its own project dir.
function runEngine(projectDir, args, stdin = '') {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    input: stdin,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function project(name, notesJson) {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, '.stickies'), { recursive: true });
  if (notesJson !== undefined) writeFileSync(join(dir, '.stickies', 'notes.json'), notesJson);
  return dir;
}

const REAL_BOARD = JSON.stringify({
  notes: [
    { id: '1', content: 'first real note', category: 'context', created: '2026-07-01T00:00:00Z' },
    { id: '2', content: 'second real note', category: 'todo', created: '2026-07-02T00:00:00Z' },
    { id: '3', content: 'third real note', category: 'decision', created: '2026-07-03T00:00:00Z' },
  ],
}, null, 2);

// A merge left conflict markers in the store. The incoming file has one note.
const conflicted = project('conflicted', `<<<<<<< HEAD\n${REAL_BOARD}\n=======\n{"notes":[]}\n>>>>>>> branch\n`);
const incoming = join(ROOT, 'incoming.json');
writeFileSync(incoming, JSON.stringify({ notes: [{ id: '9', content: 'incoming note', category: 'todo', created: '2026-07-04T00:00:00Z' }] }));

const before = readFileSync(join(conflicted, '.stickies', 'notes.json'), 'utf8');
const rec = runEngine(conflicted, ['reconcile', incoming]);
const after = readFileSync(join(conflicted, '.stickies', 'notes.json'), 'utf8');

check(after === before, 'reconcile did NOT overwrite a conflict-markered store');
check(rec.code !== 0, `reconcile FAILS the CI job rather than exiting 0 (exit ${rec.code})`);
check(/not valid JSON|conflict/i.test(rec.err), `and says why (${rec.err.trim().split('\n')[0]})`);

// The same corrupt store must not be wiped by the capture hook either — but a hook must not
// break the session, so it exits 0 having written nothing.
const conflicted2 = project('conflicted2', `<<<<<<< HEAD\n${REAL_BOARD}\n=======\n{"notes":[]}\n>>>>>>> b\n`);
const before2 = readFileSync(join(conflicted2, '.stickies', 'notes.json'), 'utf8');
const transcript = join(ROOT, 't.jsonl');
writeFileSync(transcript, JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: '!!sticky todo P2 :: a captured note' }] },
}) + '\n');
const cap = runEngine(conflicted2, ['capture'], JSON.stringify({ transcript_path: transcript }));
const after2 = readFileSync(join(conflicted2, '.stickies', 'notes.json'), 'utf8');

check(after2 === before2, 'capture did NOT overwrite a conflict-markered store');
check(cap.code === 0, `capture still exits 0 so the session is never broken (exit ${cap.code})`);

// An empty file is a half-written save, not an empty board.
const emptyFile = project('emptyfile', '   \n');
const beforeEmpty = readFileSync(join(emptyFile, '.stickies', 'notes.json'), 'utf8');
const recEmpty = runEngine(emptyFile, ['reconcile', incoming]);
check(readFileSync(join(emptyFile, '.stickies', 'notes.json'), 'utf8') === beforeEmpty,
  'an empty store file is refused, not treated as a board with no notes');
check(recEmpty.code !== 0, 'and it fails the job too');
// Assert the DIAGNOSTIC, not just the refusal. Without its own guard an empty file still dies —
// inside JSON.parse — so the file survives either way and a "did it refuse?" assertion cannot
// tell the two apart. What the guard actually buys is a message that names the real problem, so
// that is what has to be pinned.
check(/is empty/i.test(recEmpty.err),
  `and says the file is EMPTY rather than blaming JSON (${recEmpty.err.trim().split('\n')[0].slice(-60)})`);

// A JSON document with no notes array.
const noArray = project('noarray', '{"stickies":[]}');
const recNoArray = runEngine(noArray, ['reconcile', incoming]);
check(readFileSync(join(noArray, '.stickies', 'notes.json'), 'utf8') === '{"stickies":[]}',
  'a document with no notes array is refused rather than replaced');
check(recNoArray.code !== 0, 'and it fails the job');
// Same reasoning: without the guard this crashes later on `base.notes.map` — the file survives by
// luck, via a TypeError nobody can act on. Pin the explanation.
check(/no "notes" array/i.test(recNoArray.err) && !/TypeError/.test(recNoArray.err),
  `and explains it rather than throwing a TypeError (${recNoArray.err.trim().split('\n')[0].slice(-60)})`);

// The control: a genuinely absent file IS an empty board, and reconcile still works normally.
const fresh = project('fresh');
const recFresh = runEngine(fresh, ['reconcile', incoming]);
const freshPath = join(fresh, '.stickies', 'notes.json');
check(recFresh.code === 0, `a first run with no store file succeeds (exit ${recFresh.code}, ${recFresh.err.trim()})`);
check(existsSync(freshPath) && JSON.parse(readFileSync(freshPath, 'utf8')).notes.length === 1,
  'and it writes the incoming note through');

// The control that matters most: a VALID store still reconciles, so the guard did not just
// break the feature. Three local notes + one incoming = four.
const valid = project('valid', REAL_BOARD);
const recValid = runEngine(valid, ['reconcile', incoming]);
const merged = JSON.parse(readFileSync(join(valid, '.stickies', 'notes.json'), 'utf8')).notes;
check(recValid.code === 0, `a valid store reconciles normally (exit ${recValid.code})`);
check(merged.length === 4, `and keeps all three local notes plus the incoming one (got ${merged.length})`);

// --- 3. the INCOMING file gets the same treatment as the base store --------------------------
//
// The base-store fix left the second input alone: a corrupt branch file hit `catch { return; }`
// and exited 0, so the sync workflow went green while that branch's notes silently never merged.

const okBase = project('okbase', REAL_BOARD);
const corruptIncoming = join(ROOT, 'corrupt-incoming.json');
writeFileSync(corruptIncoming, '{"notes": [ oops');
const badIn = runEngine(okBase, ['reconcile', corruptIncoming]);
check(badIn.code !== 0, `a corrupt INCOMING file fails the job (exit ${badIn.code})`);
check(/cannot read incoming/i.test(badIn.err), 'and says which input was unreadable');
check(readFileSync(join(okBase, '.stickies', 'notes.json'), 'utf8') === REAL_BOARD,
  'and the base store is left untouched');

const missingIn = runEngine(project('missingin', REAL_BOARD), ['reconcile', join(ROOT, 'nope.json')]);
check(missingIn.code !== 0, 'a MISSING incoming file fails the job rather than silently doing nothing');

const noArrayIn = join(ROOT, 'noarray-incoming.json');
writeFileSync(noArrayIn, '{"stickies":[]}');
const badShape = runEngine(project('noarrayin', REAL_BOARD), ['reconcile', noArrayIn]);
check(badShape.code !== 0 && /no "notes" array/i.test(badShape.err),
  'an incoming document with no notes array is refused and explained');

// Elements, not just the container: `notes: [1,"two",true]` used to collapse to a single note.
const junkEls = join(ROOT, 'junk-elements.json');
writeFileSync(junkEls, '{"notes":[1,"two",true]}');
const junkProject = project('junkels', REAL_BOARD);
const junk = runEngine(junkProject, ['reconcile', junkEls]);
check(junk.code !== 0, 'entries that are not note objects fail the job');
check(/not note objects/i.test(junk.err), 'and are named as the reason');
check(readFileSync(join(junkProject, '.stickies', 'notes.json'), 'utf8') === REAL_BOARD,
  'and the three real notes are NOT collapsed into one');

// --- 4. a pre-commit hook must not be able to widen our commit --------------------------------
//
// The pathspec bounds what we ASK to commit. A `pre-commit` hook doing `git add -A` — an ordinary
// formatter setup — runs first and puts everything else back, so the commit contained a `.env`
// again. We pass --no-verify: these commits are bookkeeping, not authored changes.

const HOOKREPO = join(ROOT, 'hookrepo');
spawnSync('git', ['init', '-b', 'main', HOOKREPO], { encoding: 'utf8' });
g(HOOKREPO, 'config', 'user.email', 'test@stickies.local');
g(HOOKREPO, 'config', 'user.name', 'Stickies Test');
g(HOOKREPO, 'commit', '--allow-empty', '-m', 'init');
mkdirSync(join(HOOKREPO, '.git', 'hooks'), { recursive: true });
writeFileSync(join(HOOKREPO, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit add -A\n');
try { execFileSync('chmod', ['+x', join(HOOKREPO, '.git', 'hooks', 'pre-commit')]); } catch { /* windows */ }
writeFileSync(join(HOOKREPO, '.env.hooked'), 'SECRET=should-not-be-committed\n');

closeDb();
process.env.STICKIES_DB = join(ROOT, 'b.db');
createSticky({ content: 'a note for the hook repo', category: 'context', project_path: null });
sync({ repo: HOOKREPO });
const hookCommitted = g(HOOKREPO, 'show', '--name-only', '--format=', 'HEAD').stdout
  .split('\n').map((s) => s.trim()).filter(Boolean);
check(!hookCommitted.includes('.env.hooked'),
  `a pre-commit hook running \`git add -A\` cannot widen the commit (got ${JSON.stringify(hookCommitted)})`);

// --- 5. push sends our commit, not the user's unrelated local work ----------------------------
//
// `push -u origin HEAD` pushed the whole branch — every unpushed local commit went out under a
// sync, and on a branch with no upstream it CREATED that branch on the remote.

const NOUP = join(ROOT, 'noupstream');
spawnSync('git', ['clone', REMOTE, NOUP], { encoding: 'utf8' });
g(NOUP, 'config', 'user.email', 'test@stickies.local');
g(NOUP, 'config', 'user.name', 'Stickies Test');
g(NOUP, 'checkout', '-b', 'wip-feature');
closeDb();
process.env.STICKIES_DB = join(ROOT, 'c.db');
createSticky({ content: 'a note on a wip branch', category: 'context', project_path: null });
const noUpRes = sync({ repo: NOUP });
const remoteBranches = spawnSync('git', ['-C', REMOTE, 'branch', '--list'], { encoding: 'utf8' }).stdout;
check(!remoteBranches.includes('wip-feature'),
  `a WIP branch with no upstream is not published (remote branches: ${JSON.stringify(remoteBranches.trim())})`);
check(noUpRes.steps.some((s) => /push: skipped \(no upstream/.test(s)),
  `and the reason is reported (${noUpRes.steps.join(' | ')})`);

closeDb();
console.log(fail === 0 ? '\nOK — sync safety' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
