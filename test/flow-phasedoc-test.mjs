// Flow phase-doc tests: deriver docs[]/metadata/rollup + the path-confined readPhaseDoc.
// Hermetic — builds a throwaway project under a tmpdir, no shared state, cleans up after.
// The negative path-traversal cases are the load-bearing security assertions.

import { readPhaseDoc } from '../src/flow/phase-doc.mjs';
import { deriveGsdBoard } from '../src/flow/derive-gsd.mjs';
import { buildBoard } from '../src/flow/board.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const root = mkdtempSync(join(tmpdir(), 'flowdoc-'));
try {
  const phaseDir = join(root, '.planning', 'phases', '00-x');
  mkdirSync(phaseDir, { recursive: true });

  writeFileSync(join(phaseDir, '00-RESEARCH.md'), '# Research\n\nSome **findings** and a [link](https://a.b).\n');
  writeFileSync(join(phaseDir, '00-VALIDATION.md'), '# Validation\n\n- [x] validated\n');
  writeFileSync(join(phaseDir, '00-01-PLAN.md'), '---\nwave: 1\ndepends_on: []\nrequirements: [FR-01]\n---\n# Plan one\n');
  writeFileSync(join(phaseDir, '00-02-PLAN.md'), '---\nwave: 2\ndepends_on: [00-01, 00-01]\nrequirements: [FR-02]\n---\n# Plan two\n');
  // A GSD-shaped PLAN with lone section tags + a rich frontmatter (for the humanizer path).
  writeFileSync(join(phaseDir, '00-03-PLAN.md'),
    '---\nwave: 2\ntype: execute\ndepends_on: []\nfiles_modified:\n  - a.js\n  - b.js\nrequirements: [FR-09]\n---\n'
    + '<objective>\n\nBuild the thing.\n\n</objective>\n\n<success_criteria>\n\n- it works\n');

  // ROADMAP with two phases: Phase 0 (has a dir) + Phase 5 (no dir => lastTouched null).
  const roadmap = [
    '# Roadmap', '',
    '### Phase 0: Test Phase', '**Status:** ⏳ in progress',
    '- [x] 00-01-PLAN.md', '- [ ] 00-02-PLAN.md', '',
    '### Phase 5: Empty', '**Status:** ⏳ Skeleton only', '',
  ].join('\n');
  writeFileSync(join(root, '.planning', 'ROADMAP.md'), roadmap);

  // A secret OUTSIDE .planning + a symlink inside .planning pointing at it (escape bait).
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'TOP SECRET');
  let symlinkMade = false;
  try { symlinkSync(secret, join(root, '.planning', 'escape-link')); symlinkMade = true; } catch { /* needs privilege on Windows; skip */ }

  // (a) readPhaseDoc returns ok + blocks for a confined doc.
  const good = readPhaseDoc(root, 'phases/00-x/00-RESEARCH.md');
  ok(good.ok === true && Array.isArray(good.blocks) && good.blocks.length > 0, 'readPhaseDoc: confined doc => ok with blocks');
  ok(good.kind === 'RESEARCH', 'readPhaseDoc: kind derived from filename');

  // (a2) GSD humanizer: lone section tags become headings + a non-empty frontmatter summary.
  const gsdDoc = readPhaseDoc(root, 'phases/00-x/00-03-PLAN.md');
  const sectionHeads = (gsdDoc.blocks || []).filter((b) => b.type === 'heading' && (b.spans || []).some((s) => s.text === 'Objective' || s.text === 'Success Criteria'));
  ok(gsdDoc.ok === true && sectionHeads.length >= 1, 'readPhaseDoc: lone GSD section tag -> heading block');
  ok(!(gsdDoc.blocks || []).some((b) => b.type === 'para' && (b.spans || []).some((s) => s.text === '</objective>')), 'readPhaseDoc: closing section tag dropped (no literal </objective>)');
  ok(typeof gsdDoc.summary === 'string' && gsdDoc.summary.length > 0, 'readPhaseDoc: returns a non-empty frontmatter summary string');

  // (b) traversal / absolute / symlink escapes are all rejected and never read.
  ok(readPhaseDoc(root, '../../etc/passwd').ok === false, 'reject ../../ traversal');
  ok(readPhaseDoc(root, resolve(secret)).ok === false, 'reject absolute path outside .planning');
  const anyDots = readPhaseDoc(root, 'phases/00-x/../../../secret.txt');
  ok(anyDots.ok === false, 'reject mid-path ../ escape');
  if (symlinkMade) {
    const via = readPhaseDoc(root, 'escape-link');
    ok(via.ok === false && !(via.blocks && /SECRET/.test(JSON.stringify(via.blocks))), 'reject symlink escaping .planning (secret never read)');
  } else {
    ok(true, 'symlink escape case skipped (no symlink privilege) — traversal+absolute still proven');
  }

  // (c)+(d)+(e)+(f) deriver: docs[], metadata, rollup.
  const gsd = deriveGsdBoard(root);
  const p0 = gsd.cards.find((c) => c.phase === 'Phase 0');
  const kinds = new Set(p0.docs.map((d) => d.kind));
  ok(kinds.has('RESEARCH') && kinds.has('PLAN') && kinds.has('VALIDATION'), 'docs[] kinds include RESEARCH, PLAN and VALIDATION');
  ok(p0.docs.some((d) => d.kind === 'PLAN' && d.plan === '00-01'), 'PLAN doc carries its plan id');
  ok(p0.metadata.dependsOnCount === 1, 'dependsOnCount = 1 (distinct union, duplicate collapsed)');
  ok(p0.metadata.waves.length === 2 && p0.metadata.waves[0] === 1 && p0.metadata.waves[1] === 2, 'waves = [1,2] unique+sorted');
  ok(p0.metadata.requirementIds.includes('FR-01') && p0.metadata.requirementIds.includes('FR-02'), 'requirementIds unioned across plans');
  ok(typeof p0.metadata.lastTouched === 'string' && !Number.isNaN(Date.parse(p0.metadata.lastTouched)), 'lastTouched is a parseable ISO string');

  const p5 = gsd.cards.find((c) => c.phase === 'Phase 5');
  ok(p5.metadata.lastTouched === null, 'a phase with no dir has lastTouched === null');

  // True progress = EXECUTION, not authoring. The phase has 3 PLANs on disk and 0 SUMMARYs,
  // so nothing has shipped yet: 0/3, 0% — even though the ROADMAP checked one plan box. The
  // total is the fuller scope (3 on disk > 2 in the roadmap list).
  ok(gsd.rollup.done === 0 && gsd.rollup.total === 3 && gsd.rollup.pct === 0, 'rollup counts shipped plans, not roadmap checkboxes (0/3 => 0%)');

  // Ship one plan (its SUMMARY appears) and the rollup moves: 1/3 => 33%.
  writeFileSync(join(phaseDir, '00-01-SUMMARY.md'), '# Summary\n\nDone.\n');
  const gsd2 = deriveGsdBoard(root);
  ok(gsd2.rollup.done === 1 && gsd2.rollup.total === 3 && gsd2.rollup.pct === 33, 'a shipped SUMMARY advances true progress (1/3 => 33%)');

  // buildBoard keeps its live provenance; cards carry docs[]/metadata through the columns.
  // (buildBoard-level rollup surfacing is added + tested in 00-01 Task 3.)
  const board = buildBoard(root);
  ok(board.source === 'gsd' && typeof board.generatedAt === 'string', 'buildBoard keeps source:gsd + generatedAt provenance');
  const boardP0 = board.columns.doing.find((c) => c.phase === 'Phase 0');
  ok(boardP0 && Array.isArray(boardP0.docs) && boardP0.metadata, 'board columns carry docs[]/metadata on the card');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nFLOW-PHASEDOC ${fail} FAILURES` : '\nFLOW-PHASEDOC OK');
process.exit(fail ? 1 : 0);
