// snapshotBoard() must only ever write inside the project it was pointed at.
//
// It had no containment check at all. `.flow` shipped as a symlink — or a Windows junction, which
// any user can create without privilege — steered all four snapshot writes (board.json, BOARD.md,
// docs.json, graph.json) outside the project, overwriting whatever was already at those names.
// Reproduced here with a real junction, not a stub: the point is that the filesystem, not a mock,
// is what follows the link.
//
// The sibling backupRoadmap() in writeback.mjs has resolved before writing since it was written;
// this is the same guard on the same class of hole.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the stickies DB at a throwaway BEFORE importing the board module: buildBoard()/loadColumns()
// cross-link project stickies, so importing it opens a store. Never the developer's real one.
process.env.STICKIES_DB = join(tmpdir(), `flow-snapcontain-${process.pid}-${Date.now()}.db`);

const { snapshotBoard } = await import('../src/flow/board.mjs');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const ROADMAP = [
  '# Roadmap', '',
  '### Phase 1: Foundations', '**Status:** ⏳ in progress',
  '- [x] 01-01-PLAN.md', '- [ ] 01-02-PLAN.md', '',
].join('\n');

// A directory link, by whichever mechanism the platform allows an unprivileged user. Junctions
// need no elevation on Windows; 'dir' symlinks are ordinary everywhere else.
const linkDir = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

const seedProject = (dir) => {
  mkdirSync(join(dir, '.planning'), { recursive: true });
  writeFileSync(join(dir, '.planning', 'ROADMAP.md'), ROADMAP);
};

const ROOT = mkdtempSync(join(tmpdir(), 'snapcontain-'));
try {
  // --- 1. .flow as a junction pointing OUT of the project -----------------------------------
  {
    const proj = join(ROOT, 'a-proj');
    const outside = join(ROOT, 'a-outside');
    seedProject(proj);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'board.json'), 'PRECIOUS');

    let linked = true;
    try { linkDir(outside, join(proj, '.flow')); } catch (err) { linked = false; console.log(`  (could not create a directory link: ${err.code} — this environment forbids it)`); }
    check(linked, 'the test can create a directory junction/symlink at all');

    if (linked) {
      let threw = null;
      try { snapshotBoard(proj); } catch (err) { threw = err; }
      check(threw !== null, 'snapshotBoard REFUSES a project whose .flow is a link pointing outside it');
      check(threw !== null && /resolves outside/.test(threw.message), `the refusal says why (${threw && threw.message.slice(0, 60)}…)`);
      check(readFileSync(join(outside, 'board.json'), 'utf8') === 'PRECIOUS', 'the file already at the far end is NOT overwritten');
      check(readdirSync(outside).length === 1, `nothing new is written outside the project (found ${readdirSync(outside).join(', ') || 'nothing'})`);
    }
  }

  // --- 2. the ordinary case still works ------------------------------------------------------
  {
    const proj = join(ROOT, 'b-proj');
    seedProject(proj);
    const r = snapshotBoard(proj);
    check(existsSync(r.jsonPath) && existsSync(r.mdPath) && existsSync(r.docsPath) && existsSync(r.graphPath),
      'a project with a real .flow still gets all four snapshot files');
    check(r.jsonPath.startsWith(proj), 'and they are inside the project');

    // Re-snapshotting must still overwrite: the guard must not have been implemented with an
    // exclusive-create flag, which would make the second snapshot of every project fail.
    const again = snapshotBoard(proj);
    check(again.jsonPath === r.jsonPath, 'snapshotting twice overwrites rather than failing');
  }

  // --- 3. a link that stays INSIDE the project is still allowed ------------------------------
  // Containment, not equality: over-tightening this to "must be a real directory" would break a
  // legitimate layout for no security gain, since the write still lands in the project.
  {
    const proj = join(ROOT, 'c-proj');
    seedProject(proj);
    const inner = join(proj, 'derived');
    mkdirSync(inner, { recursive: true });
    let linked = true;
    try { linkDir(inner, join(proj, '.flow')); } catch { linked = false; }
    if (linked) {
      let threw = null;
      try { snapshotBoard(proj); } catch (err) { threw = err; }
      check(threw === null, 'a .flow linked to another directory INSIDE the project is accepted');
      check(existsSync(join(inner, 'board.json')), 'and the snapshot lands there');
    } else {
      console.log('  (skipped: no directory links available)');
    }
  }

  // --- 4. a project reached THROUGH a link still works ---------------------------------------
  // The project root itself being a symlink is ordinary (a worktree, a mapped share). Comparing
  // resolved paths on both sides is what keeps that case working.
  {
    const real = join(ROOT, 'd-real');
    const via = join(ROOT, 'd-via');
    seedProject(real);
    let linked = true;
    try { linkDir(real, via); } catch { linked = false; }
    if (linked) {
      let threw = null;
      try { snapshotBoard(via); } catch (err) { threw = err; }
      check(threw === null, 'a project reached through a link snapshots normally');
      check(existsSync(join(real, '.flow', 'board.json')), 'and the snapshot lands in the real directory');
    } else {
      console.log('  (skipped: no directory links available)');
    }
  }

  // --- 5. a link planted at a LEAF file name -------------------------------------------------
  // Windows only grants unprivileged symlink creation with Developer Mode on, and a junction is
  // directory-only, so this cannot be staged on an ordinary Windows box. Say so rather than
  // asserting something weaker and calling it covered.
  {
    const proj = join(ROOT, 'e-proj');
    const outside = join(ROOT, 'e-outside');
    seedProject(proj);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(proj, '.flow'), { recursive: true });
    let staged = true;
    try { symlinkSync(join(outside, 'stolen.json'), join(proj, '.flow', 'board.json'), 'file'); }
    catch (err) { staged = false; console.log(`  (skipped: this environment forbids file symlinks — ${err.code}; the dangling-leaf-link case is guarded in code but UNVERIFIED here)`); }
    if (staged) {
      let threw = null;
      try { snapshotBoard(proj); } catch (err) { threw = err; }
      check(threw !== null, 'snapshotBoard REFUSES a leaf name that is a link pointing outside the project');
      check(!existsSync(join(outside, 'stolen.json')), 'and nothing is created at the far end');
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fail ? `\nflow-snapshot-containment: ${fail} FAILED` : '\nflow-snapshot-containment: all passed');
process.exit(fail ? 1 : 0);
