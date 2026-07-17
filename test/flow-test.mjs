// Flow board tests: the deriver's classification rules (the tricky part) + buildBoard
// precedence. Pure/offline — no shared DB, so this one is isolated by construction.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// buildBoard() now cross-links project stickies onto its cards, so it opens the stickies DB.
// Point it at a throwaway file BEFORE anything reads it, keeping this suite hermetic (it must
// never touch — or sweep-expire — the developer's real ~/.stickies store). Set before the
// board module's first getDb() call; resolveDbPath() reads the env var lazily at that point.
process.env.STICKIES_DB = join(tmpdir(), `flow-test-${process.pid}-${Date.now()}.db`);

const { parseRoadmap, classify } = await import('../src/flow/derive-gsd.mjs');
const { buildBoard, snapshotBoard, exportBoardMd } = await import('../src/flow/board.mjs');
const { readPhaseDoc } = await import('../src/flow/phase-doc.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --- classify(): keyword beats emoji; partial checkboxes => doing ---
ok(classify('Planned — 6 plans', 1) === 'todo', '"Planned" with all plans authored is still To-Do (not the ✅)');
ok(classify('EXECUTED + LIVE', 0) === 'done', '"EXECUTED + LIVE" is Done even with 0 checked sub-boxes');
ok(classify('Complete (5/5)', null) === 'done', '"Complete" with no checkboxes is Done');
ok(classify('Skeleton only', null) === 'todo', '"Skeleton only" is To-Do');
ok(classify('Unblocked — plannable', null) === 'doing', '"Unblocked" is Doing');
ok(classify('anything', 0.5) === 'doing', 'partial checkboxes force Doing regardless of prose');
ok(classify('Ratified — sequenced later', null) === 'todo', '"Ratified" is To-Do');

// --- parseRoadmap(): CRLF + real-shaped roadmap ---
const md = [
  '# Roadmap', '',
  '### Phase 1: Foundations — ✅ COMPLETE',
  '**Status:** ✅ Complete (3/3 plans)',
  '- [x] 01-01-PLAN.md', '- [x] 01-02-PLAN.md', '- [x] 01-03-PLAN.md', '',
  '### Phase 2: Build — in progress',
  '**Status:** ⏳ in progress',
  '- [x] 02-01-PLAN.md', '- [ ] 02-02-PLAN.md', '',
  '### Phase 3: Later',
  '**Status:** ⏳ Skeleton only', '',
].join('\r\n'); // CRLF on purpose — the bug that ate the first spike run

const cards = parseRoadmap(md);
ok(cards.length === 3, `parsed 3 phase cards (got ${cards.length})`);
const byId = Object.fromEntries(cards.map((c) => [c.phase, c]));
ok(byId['Phase 1'].column === 'done', 'Phase 1 => Done');
ok(byId['Phase 2'].column === 'doing', 'Phase 2 (1 of 2 boxes) => Doing');
ok(byId['Phase 3'].column === 'todo', 'Phase 3 (skeleton) => To-Do');
ok(byId['Phase 1'].title === 'Foundations', 'title strips the trailing status decoration');
ok(byId['Phase 2'].progress && byId['Phase 2'].progress.done === 1 && byId['Phase 2'].progress.total === 2, 'Phase 2 progress = 1/2');

// --- buildBoard precedence: gsd live, then snapshot, then none ---
const root = mkdtempSync(join(tmpdir(), 'flow-'));
try {
  ok(buildBoard(root).ok === false, 'no .planning + no .flow => board not ok');

  // exportBoardMd must not litter a stub BOARD.md on the failure path.
  const noBoard = exportBoardMd(root, join(root, 'BOARD.md'));
  ok(noBoard.ok === false, 'exportBoardMd on a project with no board => ok:false');
  ok(!existsSync(join(root, 'BOARD.md')), 'exportBoardMd writes NO stub file when there is no board');

  mkdirSync(join(root, '.planning'), { recursive: true });
  writeFileSync(join(root, '.planning', 'ROADMAP.md'), md);
  const live = buildBoard(root);
  ok(live.ok && live.source === 'gsd', 'with .planning/ROADMAP.md => live gsd board');
  ok(live.counts.done === 1 && live.counts.doing === 1 && live.counts.todo === 1, 'live counts 1/1/1');

  const { jsonPath, mdPath } = snapshotBoard(root);
  const snap = JSON.parse(readFileSync(jsonPath, 'utf8'));
  ok(snap.columns.done.length === 1, 'snapshot board.json written with columns');
  ok(/## Doing \(1\)/.test(readFileSync(mdPath, 'utf8')), 'BOARD.md mirror lists the Doing column');

  // exportBoardMd: a committable, GitHub-renderable BOARD.md at an arbitrary path.
  const ex = exportBoardMd(root, join(root, 'BOARD.md'));
  const exText = readFileSync(join(root, 'BOARD.md'), 'utf8');
  ok(ex.ok && /^# Flow Board/.test(exText), 'exportBoardMd writes a committable BOARD.md');
  ok(/## Done \(1\)/.test(exText), 'exported BOARD.md lists the Done column');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- self-sufficient .flow/ snapshot: docs[]/metadata/rollup + doc bodies survive the
//     deletion of .planning/ entirely (the cloud/mobile repo-mode path) ---
const proj = mkdtempSync(join(tmpdir(), 'flowsnap-'));
try {
  const pdir = join(proj, '.planning', 'phases', '00-x');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, '00-RESEARCH.md'), '# R\n\nbody with **bold** text\n');
  writeFileSync(join(pdir, '00-01-PLAN.md'), '---\nwave: 1\ndepends_on: []\nrequirements: [FR-01]\n---\n# plan\n');
  writeFileSync(join(proj, '.planning', 'ROADMAP.md'), [
    '# Roadmap', '',
    '### Phase 0: Snap', '**Status:** ⏳ in progress',
    '- [x] 00-01-PLAN.md', '- [ ] 00-02-PLAN.md', '',
  ].join('\n'));

  const { docsPath } = snapshotBoard(proj);
  ok(/docs\.json$/.test(docsPath), 'snapshotBoard writes a .flow/docs.json');
  const docsMap = JSON.parse(readFileSync(docsPath, 'utf8'));
  ok(!!docsMap['phases/00-x/00-RESEARCH.md'] && Array.isArray(docsMap['phases/00-x/00-RESEARCH.md'].blocks), 'docs.json holds tokenized doc bodies');

  // Nuke the live planning dir — repo-mode now relies solely on .flow/.
  rmSync(join(proj, '.planning'), { recursive: true, force: true });

  const snapBoard = buildBoard(proj);
  ok(snapBoard.source === 'snapshot', 'after .planning deleted => snapshot-sourced board');
  const card = [...snapBoard.columns.todo, ...snapBoard.columns.doing, ...snapBoard.columns.done].find((c) => c.phase === 'Phase 0');
  ok(card && Array.isArray(card.docs) && card.docs.length > 0, 'snapshot card still carries docs[]');
  ok(card && card.metadata && Array.isArray(card.metadata.waves), 'snapshot card still carries metadata');
  ok(snapBoard.rollup && snapBoard.rollup.total === 2, 'snapshot board carries the rollup');

  const doc = readPhaseDoc(proj, 'phases/00-x/00-RESEARCH.md');
  ok(doc.ok && Array.isArray(doc.blocks) && doc.blocks.length > 0, 'readPhaseDoc serves body from .flow/docs.json with .planning gone');
} finally {
  rmSync(proj, { recursive: true, force: true });
}

// --- older snapshot (no docs.json / no rollup) still loads without throwing ---
const legacy = mkdtempSync(join(tmpdir(), 'flowold-'));
try {
  mkdirSync(join(legacy, '.flow'), { recursive: true });
  writeFileSync(join(legacy, '.flow', 'board.json'), JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    counts: { todo: 1, doing: 0, done: 0 },
    columns: { todo: [{ phase: 'Phase 9', title: 'Legacy', column: 'todo', progress: null }], doing: [], done: [] },
  }));
  const b = buildBoard(legacy);
  ok(b.ok && b.source === 'snapshot', 'legacy board.json (no docs.json/rollup) still loads');
  ok(b.rollup && b.rollup.total === 0, 'legacy board degrades to a zero rollup');
  ok(!b.columns.todo[0].docs, 'legacy card degrades to no docs[] without throwing');
} finally {
  rmSync(legacy, { recursive: true, force: true });
}

console.log(fail ? `\nFLOW ${fail} FAILURES` : '\nFLOW OK');
process.exit(fail ? 1 : 0);
