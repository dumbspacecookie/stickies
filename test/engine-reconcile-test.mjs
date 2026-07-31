// `reconcile` is the one mode of src/repo-mode/engine.mjs that reads a file it did not write.
//
// The stickies-sync workflow hands it `.stickies/notes.json` taken from the branch that triggered
// the run, and pushes the result to main. On any repository that accepts pull requests that file
// is contributor-controlled text, and until now the only thing checked about it was that each
// entry was an object. Verified before the fix, all three landing in the store committed to main:
// an unknown category, a 200 KB content, and a live-shaped `ghp_…` token in the clear.
//
// The second half of this file is the resurrection bug. Union is by id and the collapse pass only
// ever keyed OPEN notes, so a note dismissed on main and captured again on a branch under a NEW id
// came back open — the user's dismissal undone by a merge.
//
// Everything here spawns the REAL engine and asserts on the store it writes. A unit test on the
// sanitiser would stay green if somebody deleted the call to it.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'src', 'repo-mode', 'engine.mjs');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// An inherited STICKIES_DISCORD_WEBHOOK makes a test post into a real channel — it happened once
// while this suite was being written. Autocommit off so nothing here can touch git either.
const ENV = { STICKIES_DISCORD_WEBHOOK: '', STICKIES_REPO_AUTOCOMMIT: '0' };

function makeRepo(baseNotes) {
  const dir = mkdtempSync(join(tmpdir(), 'stickies-reconcile-'));
  mkdirSync(join(dir, '.stickies'), { recursive: true });
  writeFileSync(join(dir, '.stickies', 'notes.json'),
    JSON.stringify({ notes: baseNotes }, null, 2) + '\n');
  return dir;
}

function runReconcile(dir, incomingNotes) {
  const inc = join(dir, 'incoming.json');
  writeFileSync(inc, JSON.stringify({ notes: incomingNotes }));
  let stderr = '';
  try {
    execFileSync(process.execPath, [ENGINE, 'reconcile', inc], {
      env: { ...process.env, ...ENV, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    stderr = String(err.stderr || '');
    throw Object.assign(new Error(`reconcile exited non-zero: ${stderr}`), { stderr });
  }
  return {
    raw: readFileSync(join(dir, '.stickies', 'notes.json'), 'utf8'),
    get store() { return JSON.parse(this.raw); },
    mirror: readFileSync(join(dir, '.stickies', 'NOTES.md'), 'utf8'),
  };
}

// Assembled from pieces: a fixture that looks like a live token is one push protection rejects,
// and the fix for that must never be to click "allow the secret".
const GH_TOKEN = 'ghp_' + 'B'.repeat(30);

const note = (over = {}) => ({
  id: 'n1', category: 'todo', importance: 'P2', content: 'a note',
  tags: [], created: '2026-01-01T00:00:00.000Z', dismissed: false, ...over,
});

// --- 1. incoming notes are validated, capped and redacted ---------------------------------------
{
  const dir = makeRepo([]);
  try {
    const r = runReconcile(dir, [
      note({ id: 'bad-cat', category: 'NOT-A-CATEGORY', content: 'garbage category' }),
      note({ id: 'huge', content: 'Z'.repeat(200000) }),
      note({ id: 'leak', content: `the deploy token is ${GH_TOKEN} rotate it` }),
      note({ id: 'coerce', importance: 'P9', content: 'bad importance', tags: ['x'.repeat(500)] }),
      note({ id: 'blob', content: 'has an extra field', payload: 'Q'.repeat(100000) }),
      note({ id: { not: 'a string' }, content: 'no usable id' }),
      note({ id: 'ok', importance: 'P1', content: 'a perfectly ordinary note', tags: ['ship'] }),
    ]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));

    check(!byId['bad-cat'], 'a note with an unknown category does not reach the store');
    check(r.store.notes.every((n) => ['decision', 'blocker', 'preference', 'context', 'todo'].includes(n.category)),
      'and every category that survives is one of the five known ones');

    check(byId.huge && byId.huge.content.length === 500,
      `a 200KB content is capped at 500 chars (got ${byId.huge && byId.huge.content.length})`);
    check(!r.raw.includes('Z'.repeat(1000)), 'and the rest of it is not in the file anywhere');

    check(!r.raw.includes(GH_TOKEN), 'a github token in incoming content is not persisted verbatim');
    check(byId.leak && byId.leak.content.includes('[REDACTED]'), 'it is replaced with the marker');
    check(byId.leak && byId.leak.content.includes('rotate it'), 'and the rest of the note survives');

    check(byId.coerce && byId.coerce.importance === 'P2',
      `an unknown importance becomes P2 (got ${byId.coerce && byId.coerce.importance})`);
    check(byId.coerce && byId.coerce.tags.every((t) => t.length <= 40), 'an over-long tag is capped');

    // An id is how `dismiss wins` finds a note, so it must be a short opaque string. The note is
    // kept with a fresh one rather than dropped: the worst case is that it matches nothing.
    const repaired = r.store.notes.find((n) => n.content === 'no usable id');
    check(repaired && typeof repaired.id === 'string' && repaired.id.length > 0,
      'a note whose id is not a string is given a real one rather than dropped');

    check(byId.blob && byId.blob.payload === undefined, 'an unknown field is not carried into the store');
    check(!r.raw.includes('Q'.repeat(1000)), 'so a blob smuggled in an unknown field is nowhere in the file');

    // The control. A guard that drops everything would pass every assertion above.
    check(byId.ok && byId.ok.content === 'a perfectly ordinary note' && byId.ok.importance === 'P1'
      && byId.ok.tags.join(',') === 'ship',
      'a well-formed incoming note comes through completely unchanged');
    check(r.mirror.includes('a perfectly ordinary note'), 'and reaches the committed NOTES.md mirror');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 2. what was refused is reported, not swallowed ---------------------------------------------
// This runs in CI where nobody is watching the store. A note dropped for a bad category has to be
// visible in the job log, or it is indistinguishable from a note that was never written.
{
  const dir = makeRepo([]);
  try {
    const inc = join(dir, 'incoming.json');
    writeFileSync(inc, JSON.stringify({ notes: [
      note({ id: 'bad-cat', category: 'nope', content: 'dropped' }),
      note({ id: 'huge', content: 'Z'.repeat(20000) }),
      note({ id: 'leak', content: `token ${GH_TOKEN}` }),
    ] }));
    const r = spawnSync(process.execPath, [ENGINE, 'reconcile', inc], {
      env: { ...process.env, ...ENV, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    check(r.status === 0, `reconcile still succeeds with hostile input (exit ${r.status})`);
    check(/unknown category/.test(r.stderr), `the log names the dropped note (${r.stderr.trim()})`);
    check(/truncated to 500/.test(r.stderr), 'and says content was truncated');
    check(/redacted/.test(r.stderr), 'and says something was redacted');
    check(!r.stderr.includes(GH_TOKEN), 'and does not print the token it just redacted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 3. a dismissed note does not come back under a new id --------------------------------------
// The reported bug, end to end. Note X dismissed on main; the same category+content captured
// fresh on a branch as a NEW id Y, open. Before the fix Y survived open and the mirror showed it.
{
  const dir = makeRepo([
    note({ id: 'X', content: 'wire the dashboard', dismissed: true,
      created: '2026-01-01T00:00:00.000Z', dismissed_at: '2026-03-01T00:00:00.000Z' }),
  ]);
  try {
    const r = runReconcile(dir, [
      note({ id: 'Y', content: 'wire the dashboard', created: '2026-02-01T00:00:00.000Z' }),
    ]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));
    check(byId.Y !== undefined, 'the branch copy is still in the store — tombstoned, not deleted');
    check(byId.Y && byId.Y.dismissed === true,
      'a copy created BEFORE the dismissal is itself dismissed');
    check(byId.Y && byId.Y.dismissed_at === '2026-03-01T00:00:00.000Z',
      'and it carries the dismissal time it was matched against');
    check(!r.mirror.includes('wire the dashboard'),
      'so the note the user dismissed is not back on the board');
    check(r.store.notes.filter((n) => !n.dismissed).length === 0, 'nothing is open');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 4. a note raised AFTER the dismissal is a re-raise, and must stay open ----------------------
// The other half of the rule, and the one a blunt "dismiss anything matching a tombstone" would
// break: saying the same thing again later is a deliberate act, not a resurrection.
{
  const dir = makeRepo([
    note({ id: 'X', content: 'wire the dashboard', dismissed: true,
      created: '2026-01-01T00:00:00.000Z', dismissed_at: '2026-03-01T00:00:00.000Z' }),
  ]);
  try {
    const r = runReconcile(dir, [
      note({ id: 'Y', content: 'wire the dashboard', created: '2026-04-01T00:00:00.000Z' }),
    ]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));
    check(byId.Y && byId.Y.dismissed === false, 'a copy created AFTER the dismissal stays open');
    check(r.mirror.includes('wire the dashboard'), 'and it is on the board');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 5. an old store with no dismissal timestamp still works ------------------------------------
// Nothing wrote `dismissed_at` before this change, so every store in the wild is this one. The
// documented behaviour: the unknown time is backfilled to now, which suppresses the copy in front
// of us (created earlier, by definition) and lets anything raised afterwards through. Paid once,
// because the backfill is written to the store.
{
  const dir = makeRepo([
    note({ id: 'X', content: 'old dismissal', dismissed: true, created: '2026-01-01T00:00:00.000Z' }),
  ]);
  try {
    const r = runReconcile(dir, [
      note({ id: 'Y', content: 'old dismissal', created: '2026-02-01T00:00:00.000Z' }),
    ]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));
    check(typeof byId.X.dismissed_at === 'string' && !Number.isNaN(Date.parse(byId.X.dismissed_at)),
      'the undated dismissal is given a date, so the next run has something to compare against');
    check(byId.Y.dismissed === true, 'and the pre-existing open copy is suppressed');

    // Now the self-healing half: a note written after the backfill is a re-raise and stays open.
    const future = new Date(Date.now() + 60000).toISOString();
    const r2 = runReconcile(dir, [note({ id: 'Z', content: 'old dismissal', created: future })]);
    const byId2 = Object.fromEntries(r2.store.notes.map((n) => [n.id, n]));
    check(byId2.Z.dismissed === false, 'a copy raised after the backfill is honoured as a re-raise');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 6. an incoming dismissal cannot be dated in the future -------------------------------------
// A dismissal dated 2099 would suppress every future re-raise of that content forever — a one-line
// way for a branch to make a note un-writable on main.
{
  const dir = makeRepo([]);
  try {
    const r = runReconcile(dir, [
      note({ id: 'X', content: 'silence me', dismissed: true, dismissed_at: '2099-01-01T00:00:00.000Z' }),
    ]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));
    check(Date.parse(byId.X.dismissed_at) <= Date.now() + 5000,
      `a future dismissal time is clamped to now (got ${byId.X.dismissed_at})`);

    const future = new Date(Date.now() + 60000).toISOString();
    const r2 = runReconcile(dir, [note({ id: 'Y', content: 'silence me', created: future })]);
    const byId2 = Object.fromEntries(r2.store.notes.map((n) => [n.id, n]));
    check(byId2.Y.dismissed === false, 'so a later note with the same content can still be raised');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 7. the collapse pass never deletes a note ---------------------------------------------------
// Union is by id. A note the collapse removed is re-added by the next push from the branch that
// still has it, and an id that is not in the store is an id `dismiss wins` can never land on.
{
  const dir = makeRepo([note({ id: 'A', content: 'same thing', created: '2026-01-01T00:00:00.000Z' })]);
  try {
    const r = runReconcile(dir, [note({ id: 'B', content: 'same thing', created: '2026-02-01T00:00:00.000Z' })]);
    const byId = Object.fromEntries(r.store.notes.map((n) => [n.id, n]));
    check(r.store.notes.length === 2, `both ids survive the collapse (got ${r.store.notes.length})`);
    check(byId.A.dismissed === false, 'the earliest copy stays open');
    check(byId.B.dismissed === true && byId.B.collapsed === true,
      'the duplicate is tombstoned and marked as a collapse, not as the user\'s decision');
    check((r.mirror.match(/same thing/g) || []).length === 1, 'the board shows it once');

    // The collapse tombstone must NOT read as a dismissal on the next run, or the surviving copy
    // — older than the tombstone by construction — would be suppressed as "created before a
    // dismissal", and the board would eat itself one reconcile at a time.
    const r2 = runReconcile(dir, []);
    const byId2 = Object.fromEntries(r2.store.notes.map((n) => [n.id, n]));
    check(byId2.A.dismissed === false, 'and re-running reconcile leaves it open');
    const r3 = runReconcile(dir, []);
    check(r3.raw === r2.raw, 'reconcile has converged — a third run changes nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 8. dismissing on a branch still wins ---------------------------------------------------------
// The behaviour all of the above must not break.
{
  const dir = makeRepo([note({ id: 'X', content: 'kill this one' })]);
  try {
    const r = runReconcile(dir, [note({ id: 'X', content: 'kill this one', dismissed: true })]);
    check(r.store.notes[0].dismissed === true, 'an incoming dismissal of a known id is applied');
    check(typeof r.store.notes[0].dismissed_at === 'string', 'and it is dated');
    check(!r.mirror.includes('kill this one'), 'and the board no longer shows it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `\nengine-reconcile: ${fail} FAILED` : '\nengine-reconcile: all passed');
process.exit(fail ? 1 : 0);
