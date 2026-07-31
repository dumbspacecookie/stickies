// Two things doctor was reporting wrongly, both of the same family: a check that answers a
// different question from the one it prints.
//
//   1. THE READ-ONLY CONTRACT. doctor.js says "read-only. Never writes" at the top, and its store
//      check called readStickies(), which runs sweepExpired() — an UPDATE that flips past-TTL rows
//      to 'stale' and rewrites updated_at, the column sync resolves last-writer-wins on. So asking
//      doctor how many notes you had mutated the store it was diagnosing. And on a store that
//      cannot be written the UPDATE threw, so doctor said `store: bad — cannot read <path>:
//      attempt to write a readonly database` — blaming the read for a write failure, in the one
//      command whose job is to name the actual fault.
//
//   2. SYNC HEALTH. The sync check asked "is this a git repo?" and printed
//      `✓ sync <repo> (auto-sync ON)` over a repo four commits ahead and one behind, where
//      `pull --ff-only` and push both fail on every cycle forever. The report ended
//      `Nothing broken`.
//
// Everything here runs against scratch DBs and throwaway git repos under the OS temp dir. No real
// store, no real sync repo, and STICKIES_HOME is redirected so nothing lands in ~/.stickies.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { freePort, scratchDir, cleanup } from './_env.mjs';
import { engineStamp } from '../src/engine-stamp.js';

const ROOT = scratchDir('docdiag');
const DEAD_PORT = await freePort(); // nothing is listening on it; the dashboard check just says so
mkdirSync(ROOT, { recursive: true });

Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(ROOT, 'claude'),
  STICKIES_HOME: join(ROOT, 'home'),
  STICKIES_DASHBOARD_PORT: String(DEAD_PORT),
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  // Set in this machine's USER environment, so it is inherited by every test run. A suite that
  // left it alone posted to the owner's real Discord channel.
  STICKIES_DISCORD_WEBHOOK: '',
});
mkdirSync(join(ROOT, 'claude'), { recursive: true });

const { runDoctor, renderDoctor, syncHealth, repoEngineHealth, ROOT: SRC_ROOT } = await import('../src/doctor.js');
// The engine `stickies init-repo` would copy into a repo right now. Read, never written.
const OUR_ENGINE = join(SRC_ROOT, 'src', 'repo-mode', 'engine.mjs');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const storeChecks = (r) => r.checks.filter((c) => c.name === 'store');
const syncCheck = (r) => r.checks.find((c) => c.name === 'sync');

// A store with one note that lives and one whose TTL has already run out. The expired one is the
// interesting row: it is what sweepExpired() would rewrite.
const PAST = '2001-01-01T00:00:00.000Z';
function makeStore(path, { expiredUpdatedAt = PAST } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE stickies (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, importance TEXT NOT NULL,
    project_path TEXT, project_key TEXT, tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
    source TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'active', dismiss_reason TEXT)`);
  const ins = db.prepare(`INSERT INTO stickies
    (id, content, category, importance, created_at, updated_at, expires_at, status)
    VALUES (?, ?, 'context', 'P2', ?, ?, ?, 'active')`);
  ins.run('live', 'still current', PAST, PAST, null);
  ins.run('gone', 'past its TTL', PAST, expiredUpdatedAt, PAST);
  db.close();
}

function readRow(path, id) {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare('SELECT status, updated_at FROM stickies WHERE id = ?').get(id);
  db.close();
  return row;
}

try {
  // --- 1. doctor does not write to the store it is diagnosing --------------------------------
  {
    const dbPath = join(ROOT, 'sweep.db');
    makeStore(dbPath);
    process.env.STICKIES_DB = dbPath;
    const r = await runDoctor({ project: ROOT });
    const store = storeChecks(r).find((c) => c.status === 'ok');
    check(!!store, 'a readable store reports ok');
    // The assertion that actually catches the bug: the expired row is untouched. With
    // readStickies() in the store check this row comes back status='stale' with a fresh
    // updated_at, and sync would then republish it as the newest version of itself.
    const after = readRow(dbPath, 'gone');
    check(after.status === 'active', `doctor left the expired row alone (status is still ${after.status})`);
    check(after.updated_at === PAST, `and did not rewrite updated_at (still ${after.updated_at})`);
    // Same number readStickies would have returned — the sweep is applied in the reading, not in
    // the database.
    check(/\b1 active note\(s\)/.test(store.detail), `it still counts only the live note (${store.detail})`);
    check(/past their TTL/.test(store.detail) && /doctor never writes/.test(store.detail),
      'and says the expired one is pending rather than silently omitting it');
  }

  // --- 2. a read-only store is diagnosed as a WRITE problem, not a read problem ---------------
  {
    const dbPath = join(ROOT, 'readonly.db');
    makeStore(dbPath);
    chmodSync(dbPath, 0o444);
    process.env.STICKIES_DB = dbPath;
    const r = await runDoctor({ project: ROOT });
    const all = storeChecks(r);
    const bad = all.find((c) => c.status === 'bad');
    check(!!bad, 'a read-only store is reported as bad');
    check(!!bad && /READ-ONLY/.test(bad.detail), 'and named as READ-ONLY rather than unreadable');
    check(!!bad && /new notes/.test(bad.detail) && /fail/.test(bad.detail),
      'the consequence is spelled out: writes are what fail');
    check(!!bad && !!bad.fix && /STICKIES_DB|attrib|chmod/.test(bad.fix), 'and there is a fix that addresses permissions');
    // The old message. It sent you looking at the wrong half of the system.
    check(!all.some((c) => /cannot read/.test(c.detail)), 'no check claims the store cannot be READ — it reads fine');
    check(all.some((c) => c.status === 'ok' && /active note/.test(c.detail)),
      'the notes are still counted, because reading a read-only store works');
    chmodSync(dbPath, 0o666);
  }

  // --- 3. no store yet is not a fault, and doctor must not create one -------------------------
  {
    const dbPath = join(ROOT, 'never-written.db');
    process.env.STICKIES_DB = dbPath;
    const r = await runDoctor({ project: ROOT });
    const store = storeChecks(r)[0];
    check(store.status === 'ok' && /no store yet/.test(store.detail), 'a store that does not exist yet reports ok, not bad');
    check(!existsSync(dbPath), 'and doctor did not create it — running a diagnostic is not a write');
  }

  // --- sync health, against throwaway repos --------------------------------------------------
  // A bare "remote" plus two clones standing in for two machines. Every git call below is a local
  // filesystem operation; nothing reaches the network.
  const git = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const REMOTE = join(ROOT, 'remote.git');
  const A = join(ROOT, 'machine-a');
  const B = join(ROOT, 'machine-b');
  spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
  spawnSync('git', ['clone', REMOTE, A], { encoding: 'utf8' });
  const commit = (repo, text) => {
    writeFileSync(join(repo, 'stickies.json'), text);
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'add', 'stickies.json');
    git(repo, 'commit', '--no-verify', '-m', text, '--', 'stickies.json');
  };
  commit(A, 'first');
  git(A, 'push', '-u', 'origin', 'main');
  spawnSync('git', ['clone', REMOTE, B], { encoding: 'utf8' });
  git(B, 'config', 'user.email', 'test@example.invalid');
  git(B, 'config', 'user.name', 'test');

  {
    const h = syncHealth(B);
    check(h.status === 'ok' && /in step with/.test(h.detail), `a clone in step with its remote is ok (${h.detail})`);
  }

  // Behind only: machine A publishes, B has not merged it.
  commit(A, 'second');
  git(A, 'push');
  git(B, 'fetch');
  {
    const h = syncHealth(B);
    check(h.status === 'warn' && /1 commit\(s\) behind/.test(h.detail), `behind-only is a warn that says how far (${h.detail})`);
    check(/another machine/.test(h.detail), 'and explains that someone else has written notes');
  }

  // Ahead as well: B commits locally without merging. This is the 4-ahead/1-behind shape, and it
  // is terminal — pull --ff-only refuses, push is rejected, and sync never recovers on its own.
  commit(B, 'local-only');
  {
    const h = syncHealth(B);
    check(h.status === 'bad', `a diverged sync repo is BAD, not ok (got ${h.status})`);
    check(/DIVERGED/.test(h.detail), 'and the word for it is said out loud');
    check(/1 ahead and 1 behind/.test(h.detail), `with both numbers (${h.detail})`);
    check(/ff-only/.test(h.detail) && /rejected/.test(h.detail), 'naming both failures: the pull refuses and the push is rejected');
    check(/every sync cycle fails/.test(h.detail) && /no note has left this machine/.test(h.detail),
      'and stating the consequence — this does not fix itself');
    check(!!h.fix && /pull --rebase/.test(h.fix), 'with a fix that actually unsticks it');
    check(/last fetch/.test(h.detail), 'and it admits the comparison is only as fresh as the last fetch');
  }

  // Ahead only: a repo whose pushes are failing.
  {
    const C = join(ROOT, 'machine-c');
    spawnSync('git', ['clone', REMOTE, C], { encoding: 'utf8' });
    git(C, 'config', 'user.email', 'test@example.invalid');
    git(C, 'config', 'user.name', 'test');
    commit(C, 'never pushed');
    const h = syncHealth(C);
    check(h.status === 'warn' && /never reached/.test(h.detail), `ahead-only says the commits never reached the remote (${h.detail})`);
  }

  // No upstream: sync commits and then skips the push, every time, silently.
  {
    const D = join(ROOT, 'machine-d');
    spawnSync('git', ['clone', REMOTE, D], { encoding: 'utf8' });
    git(D, 'checkout', '-b', 'wip');
    const h = syncHealth(D);
    check(h.status === 'bad', `a branch with no upstream is bad, not ok (got ${h.status})`);
    check(/no upstream/.test(h.detail) && /skips the push/.test(h.detail), 'and says what sync actually does about it');
    check(!!h.fix && /push -u origin wip/.test(h.fix), 'the fix names the branch, so it can be pasted');
  }

  // A local-only notes repo is a legitimate setup, not a fault. A check that shouts at it is a
  // check people learn to skim.
  {
    const L = join(ROOT, 'local-only');
    mkdirSync(L, { recursive: true });
    spawnSync('git', ['init', '-b', 'main', L], { encoding: 'utf8' });
    git(L, 'config', 'user.email', 'test@example.invalid');
    git(L, 'config', 'user.name', 'test');
    commit(L, 'local');
    const h = syncHealth(L);
    check(h.status === 'ok' && /local-only/.test(h.detail), `a repo with no remote is ok and labelled (${h.detail})`);
    check(!/behind|ahead/.test(h.detail), 'and is not described in terms of a remote it does not have');
  }

  // A half-finished merge stops every cycle, and sync's own output only ever says "commit: failed".
  {
    const M = join(ROOT, 'mid-merge');
    spawnSync('git', ['clone', REMOTE, M], { encoding: 'utf8' });
    const gitDir = spawnSync('git', ['-C', M, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    const h = syncHealth(M);
    check(h.status === 'bad' && /unfinished merge/.test(h.detail), `an unfinished merge is reported (${h.detail})`);
    check(!!h.fix && /--abort/.test(h.fix), 'and offers the way out');
  }

  // --- end-to-end: the diverged repo must reach the rendered report --------------------------
  // Unit-testing syncHealth proves the logic; only running the real command proves it is wired
  // in. This is the assertion that would have caught the original bug, which was entirely one of
  // wiring: the logic to notice divergence simply was not called.
  {
    process.env.STICKIES_DB = join(ROOT, 'sweep.db');
    process.env.STICKIES_SYNC_REPO = B;
    const r = await runDoctor({ project: ROOT });
    const s = syncCheck(r);
    check(s.status === 'bad', `runDoctor reports the diverged sync repo as bad (got ${s.status})`);
    check(r.ok === false, 'and the report as a whole is not "Nothing broken"');
    const text = renderDoctor(r);
    check(/Problems found/.test(text), 'the rendered summary says Problems found');
    check(/DIVERGED/.test(text), 'and the rendered line names the divergence');
  }

  // --- a sync remote URL can carry a credential; doctor must never print it ------------------
  {
    const S = join(ROOT, 'secret-remote');
    spawnSync('git', ['clone', REMOTE, S], { encoding: 'utf8' });
    git(S, 'remote', 'set-url', 'origin', 'https://user:ghp_NOTAREALTOKEN9999@example.invalid/notes.git');
    process.env.STICKIES_SYNC_REPO = S;
    const r = await runDoctor({ project: ROOT });
    const text = renderDoctor(r) + JSON.stringify(r);
    check(!text.includes('ghp_NOTAREALTOKEN9999'), 'the remote URL (and the token in it) never appears in the report');
    check(!text.includes('example.invalid'), 'nor the host it points at');
    process.env.STICKIES_SYNC_REPO = '';
  }

  // --- 3. a stale repo-mode engine committed in someone's repository -------------------------
  //
  // `stickies init-repo` copies src/repo-mode/engine.mjs to .stickies/engine.mjs and the user
  // COMMITS it. That file carries the secret redactor and the directive parser, and from then on
  // the repo runs its own frozen copy: install.js refreshes it, but only when somebody re-runs
  // init-repo, and nothing used to say they should. The copy that shipped for three releases was
  // missing nine credential patterns and had a directive parser still anchored `^\s*` — the hole a
  // quoted directive in a hostile README uses to write a note into another project. The package
  // got fixed; the installed copies did not, and nothing on any screen said so.
  //
  // Everything below builds real project directories with real engine files and runs the real
  // `runDoctor` against them. A unit test on the comparison would stay green if someone deleted
  // the call to it, which is the failure mode this whole check exists to catch in the first place.
  const engineChecks = (r) => r.checks.filter((c) => c.name === 'repo engine');
  const CURRENT_ENGINE = readFileSync(OUR_ENGINE, 'utf8');
  const CURRENT_STAMP = CURRENT_ENGINE.match(/^const ENGINE_STAMP = '([a-f0-9]+)';$/m)?.[1];

  // A project with a .stickies/engine.mjs whose text is `body`.
  const repoWith = (name, body) => {
    const dir = join(ROOT, 'repos', name);
    mkdirSync(join(dir, '.stickies'), { recursive: true });
    if (body !== null) writeFileSync(join(dir, '.stickies', 'engine.mjs'), body);
    return dir;
  };

  check(!!CURRENT_STAMP, `the shipped engine carries an ENGINE_STAMP (${CURRENT_STAMP}) for doctor to compare against`);

  // A repo that never ran init-repo must produce NO line at all. Repo-mode is opt-in; a check
  // that prints "no engine here" in every project is one people learn to skim past.
  {
    const dir = join(ROOT, 'repos', 'plain');
    mkdirSync(dir, { recursive: true });
    const r = await runDoctor({ project: dir });
    check(engineChecks(r).length === 0, 'a project with no .stickies/ gets no repo-engine line at all');
    check(!/repo engine/.test(renderDoctor(r)), 'and nothing about it reaches the rendered report');
  }

  // The real thing, end to end: a genuinely stale engine — an engine whose CODE is older, which is
  // what a repo that ran init-repo six months ago has committed.
  //
  // This fixture used to stage staleness by rewriting the `ENGINE_STAMP` literal and leaving the
  // code alone. That stopped being staleness the moment doctor started computing the stamp from
  // content instead of believing the line, and the change was made because believing the line was
  // demonstrably wrong: an engine with the path-containment guard cut out of it still declared the
  // current stamp and was reported as matching. So the fixture now does what the real case does —
  // it ships different code. The `insist` guard is the right thing to remove for it, because that
  // is precisely the kind of fix an old committed engine is missing.
  {
    const older = CURRENT_ENGINE.replace(/if \(!contained\(p\)\) \{/, 'if (false) {');
    check(older !== CURRENT_ENGINE, 'control: the stale fixture really does differ from the shipped engine');
    const dir = repoWith('stale', older);
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e, 'a repo with a stale engine gets a repo-engine line');
    check(!!e && e.status === 'warn', `and it is a warning, not silence (got ${e?.status})`);
    check(!!e && /does NOT match/.test(e.detail), 'which says the committed copy does not match');
    // Both stamps, so a reader can tell the two copies apart in a bug report. The stale one is
    // computed from the fixture's own bytes rather than asserted as a literal — the whole point of
    // the change is that the number is derived from content, so hardcoding one here would be
    // asserting the opposite of the property under test.
    check(!!e && e.detail.includes(engineStamp(older)) && e.detail.includes(CURRENT_STAMP),
      `naming both stamps so the two copies can be told apart (${e?.detail})`);
    check(engineStamp(older) !== CURRENT_STAMP,
      'control: changing engine CODE moves the stamp, even though the ENGINE_STAMP line is untouched');
    // What is out of date has to be named as the security controls, not as a version number — a
    // reader who is told "0.13.0 vs 0.14.0" shrugs; one who is told their redactor is old does not.
    // Write-path guards are in the list because the stamp covers the whole engine, so this check
    // now reports engines missing those too, and a message naming only the redactor would be
    // narrower than the thing it is reporting.
    check(!!e && /redactor/.test(e.detail) && /directive parser/.test(e.detail) && /write-path guards/.test(e.detail),
      'and says what is actually out of date — the security controls, not a version number');
    check(!!e && !!e.fix && /init-repo/.test(e.fix) && e.fix.includes(dir),
      'the fix is a pasteable command naming the repo');
    check(!!e && /commit/.test(e.fix), 'and says the refreshed file has to be committed, since that is how it got there');
    // A stale engine is not "Stickies is broken": the notes still work, they are being scrubbed by
    // older rules. `bad` is what sets report.ok=false and makes the CLI exit non-zero, and this
    // drift begins the instant the package updates — so `bad` here would be a near-permanent red
    // on a working install, the kind of alarm people learn to skim. (This suite's dashboard check
    // is deliberately bad — a dead port — so the whole report cannot be asserted on.)
    check(!engineChecks(r).some((c) => c.status === 'bad'),
      'a stale engine is never `bad`, so it alone cannot make `stickies doctor` exit non-zero');
    const text = renderDoctor(r);
    check(/repo engine/.test(text) && /does NOT match/.test(text), 'and the rendered report carries the line');
  }

  // No stamp line at all. This is an engine from before stamping existed, so it is older than
  // every stamped release — it must NOT read as "fine", and it must not read as "unknown" either.
  {
    const dir = repoWith('unstamped', CURRENT_ENGINE.replace(/^const ENGINE_STAMP = '[a-f0-9]+';$/m, ''));
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e && e.status === 'warn', `an engine with no stamp is a warning (got ${e?.status})`);
    check(!!e && e.status !== 'ok' && e.status !== 'unknown', 'and neither ok nor unknown — absence of a stamp IS the finding');
    check(!!e && /NO ENGINE_STAMP/.test(e.detail), 'the detail names the missing stamp line');
    check(!!e && /predates stamping/.test(e.detail) && /older than every/.test(e.detail),
      'and says out loud that this makes it older than every stamped release');
    check(!!e && /credential patterns/.test(e.detail) && /injection/.test(e.detail),
      'naming the concrete fixes it is missing');
    check(!!e && !!e.fix && /init-repo/.test(e.fix), 'with the same pasteable fix');
  }

  // Current: doctor's convention is to print passing checks, so this is a tick, not silence.
  {
    const dir = repoWith('current', null);
    copyFileSync(OUR_ENGINE, join(dir, '.stickies', 'engine.mjs'));
    const before = readFileSync(join(dir, '.stickies', 'engine.mjs'));
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e && e.status === 'ok', `an up-to-date engine reports ok (got ${e?.status})`);
    check(!!e && e.detail.includes(CURRENT_STAMP), 'and shows the stamp it matched');
    check(!!e && !e.fix, 'with nothing to do');
    // The read-only contract. doctor stopped mutating the store once; it must not start
    // mutating somebody's repository instead.
    check(Buffer.compare(before, readFileSync(join(dir, '.stickies', 'engine.mjs'))) === 0,
      'doctor did not rewrite the engine it was diagnosing');
    check(readdirSync(join(dir, '.stickies')).join(',') === 'engine.mjs',
      'and created nothing else in .stickies/ — the check is read-only');
  }

  // .stickies/ exists but the engine is gone. The repo's own hooks run `node .stickies/engine.mjs`,
  // so this repo captures nothing at all.
  {
    const dir = repoWith('gutted', null);
    writeFileSync(join(dir, '.stickies', 'notes.json'), '{"notes":[]}');
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e && e.status === 'warn', `a .stickies/ with no engine is a warning (got ${e?.status})`);
    check(!!e && /no engine\.mjs/.test(e.detail) && /nothing is captured/.test(e.detail),
      'and names the consequence rather than just the missing file');
  }

  // Hostile / broken shapes. The requirement is that doctor still answers — a diagnostic that
  // throws on the machine you ran it for has failed at the only job it has.
  {
    const dir = join(ROOT, 'repos', 'dirshaped');
    mkdirSync(join(dir, '.stickies', 'engine.mjs'), { recursive: true });
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e && e.status === 'warn', `an engine.mjs that is a DIRECTORY does not crash doctor (got ${e?.status})`);
    check(!!e && /a directory/.test(e.detail), 'and is described as what it is');
    check(r.checks.length > 1, 'the rest of the report still completed');
  }
  {
    // Just over the 4 MiB cap, and binary. Two branches are being told apart here: if the cap were
    // removed this file WOULD be read, find no stamp, and come back as the "predates stamping"
    // message instead. The size-shaped message is the evidence that stat answered it.
    const dir = repoWith('junk', null);
    writeFileSync(join(dir, '.stickies', 'engine.mjs'), Buffer.alloc(5 * 1024 * 1024, 0xff));
    const r = await runDoctor({ project: dir });
    const e = engineChecks(r)[0];
    check(!!e && e.status === 'warn', `5 MB of garbage at .stickies/engine.mjs does not crash doctor (got ${e?.status})`);
    check(!!e && /5\.0 MB/.test(e.detail) && /not the engine/.test(e.detail),
      `and is rejected on size without being read (${e?.detail})`);
    check(!!e && !/predates stamping/.test(e.detail), 'not misreported as an old engine');
  }

  // Nothing to compare against — a damaged install of Stickies itself. Reporting `ok` because the
  // reference could not be found is the one answer that must not happen.
  {
    const dir = repoWith('noref', CURRENT_ENGINE);
    const h = repoEngineHealth(dir, join(ROOT, 'no-such-engine.mjs'));
    check(h.status === 'unknown', `with no reference engine the verdict is unknown, not ok (got ${h.status})`);
    check(/no stamp to compare/.test(h.detail), 'and says why it could not answer');
  }
} catch (err) {
  console.log('  FAIL  ' + (err?.stack || err));
  fail++;
}

console.log(fail ? `\ndoctor diagnostics: ${fail} FAILED` : '\ndoctor diagnostics: all passed');
try { (await import('../src/db.js')).closeDb(); } catch { /* never opened */ }
cleanup(ROOT);
process.exit(fail ? 1 : 0);
