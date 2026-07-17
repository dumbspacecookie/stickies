// Flow board: the planning→execution Kanban that pairs with Stickies. Notes capture
// facts; the board shows the *flow* of the work those facts are about.
//
// Source of truth is the project's own GSD .planning/ROADMAP.md — the board is a
// projection of it, derived live, so it can never drift from the plan. For the
// cloud/mobile path (claude.ai/code, phone) where .planning/ is often gitignored and
// absent, snapshotBoard() writes a committed .flow/board.json + a human BOARD.md mirror
// that buildBoard() falls back to. Same repo-mode DNA the stickies board proved.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deriveGsdBoard, COLUMNS } from './derive-gsd.mjs';
import { derivePlanGraph, computeBlockedPhases } from './derive-plans.mjs';
import { readPhaseDoc } from './phase-doc.mjs';
import { crossLink, phaseNumberOf } from './cross-link.mjs';
import { readStickies } from '../store.js';

const COLUMN_TITLES = { todo: 'To-Do', doing: 'Doing', done: 'Done' };

// Board artifacts (BOARD.md, .flow/board.json) are committed and rendered on GitHub, so the
// "derived from" path must be repo-relative and OS-neutral — never an absolute home-dir path,
// which would disclose the OS username and machine layout in a public repo.
function relSourcePath(projectPath, abs) {
  if (!abs) return abs;
  const rel = projectPath ? relative(projectPath, abs) : String(abs);
  return (rel || String(abs)).replace(/\\/g, '/');
}

function emptyColumns() {
  return { todo: [], doing: [], done: [] };
}

function toColumns(cards) {
  const cols = emptyColumns();
  for (const c of cards) (cols[c.column] || cols.todo).push(c);
  return cols;
}

function counts(cols) {
  return { todo: cols.todo.length, doing: cols.doing.length, done: cols.done.length };
}

// Load the raw board columns for a project. Precedence: live GSD derivation, else a
// committed .flow/board.json snapshot (cloud/mobile), else "no board". This is the stable,
// disk-only projection — it carries NO dynamic/local data (sticky counts, blocked state),
// so it's what snapshotBoard() persists. buildBoard() layers the dynamic bits on at read time.
function loadColumns(projectPath) {
  const gsd = deriveGsdBoard(projectPath);
  if (gsd) {
    const cols = toColumns(gsd.cards);
    return {
      ok: true,
      source: 'gsd',
      sourcePath: relSourcePath(projectPath, gsd.source),
      generatedAt: new Date().toISOString(),
      counts: counts(cols),
      rollup: gsd.rollup,
      columns: cols, // cards already carry docs[]/metadata from deriveGsdBoard
    };
  }

  const snapshot = join(projectPath || '', '.flow', 'board.json');
  if (projectPath && existsSync(snapshot)) {
    try {
      const snap = JSON.parse(readFileSync(snapshot, 'utf8'));
      const cols = snap.columns || emptyColumns();
      // A snapshot board is indistinguishable from a live one to the UI: the cards carry
      // their docs[]/metadata (written by snapshotBoard) and the board carries the rollup.
      // Older snapshots without these fields degrade gracefully (cards lack docs[]; rollup 0).
      return {
        ok: true,
        source: 'snapshot',
        sourcePath: relSourcePath(projectPath, snapshot),
        generatedAt: snap.generatedAt || null,
        counts: counts(cols),
        rollup: snap.rollup || { done: 0, total: 0, pct: 0 },
        columns: cols,
      };
    } catch {
      // fall through to the empty board
    }
  }

  return {
    ok: false,
    source: null,
    reason: 'No .planning/ROADMAP.md or .flow/board.json found for this project.',
    counts: { todo: 0, doing: 0, done: 0 },
    columns: emptyColumns(),
  };
}

// Every phase card across all columns, as a flat list.
function flatCards(cols) {
  return [...(cols.todo || []), ...(cols.doing || []), ...(cols.done || [])];
}

// The plan-execution DAG for a project: live derivation, else the committed .flow/graph.json
// (repo-mode with no .planning/), else an empty graph. Mirrors the /api/plan-graph fallback.
function graphFor(projectPath) {
  let g = derivePlanGraph(projectPath);
  if (!g && projectPath) {
    try { g = JSON.parse(readFileSync(join(projectPath, '.flow', 'graph.json'), 'utf8')); }
    catch { g = null; }
  }
  return g || { nodes: [], edges: [] };
}

// Stamp read-time dynamic data onto each card: `blocked` (from the plan graph) and
// `relatedStickies` (cross-linked project stickies). Both are deliberately kept OUT of the
// committed snapshot — they're local/live and would churn git — so they live only here.
function annotate(cols, projectPath) {
  const cards = flatCards(cols);
  if (!cards.length) return;

  // Blocked: unmet upstream dependencies, from the (live or snapshot) plan graph.
  const blocked = computeBlockedPhases(graphFor(projectPath));
  for (const c of cards) {
    const n = phaseNumberOf(c);
    c.blocked = (n != null && blocked[n]) ? blocked[n] : null;
  }

  // Related stickies: project-scoped only (globals are cross-project noise here). A missing
  // or unreadable store must never break the board, so any failure degrades to "no counts".
  let stickies = [];
  try {
    stickies = readStickies({ project_path: projectPath, include_global: false, limit: 500 });
  } catch { stickies = []; }
  const { perPhase } = crossLink(cards, stickies);
  for (const c of cards) {
    const rel = perPhase[c.id];
    c.relatedStickies = (rel && rel.total) ? { counts: rel.counts, total: rel.total } : null;
  }
}

// Build the board for a project (the API/read path). Same shape as loadColumns() plus the
// read-time annotations (blocked, relatedStickies) painted onto each card.
export function buildBoard(projectPath) {
  const board = loadColumns(projectPath);
  if (board.ok) annotate(board.columns, projectPath);
  return board;
}

// Flat list of a project's phase cards WITHOUT the dynamic annotations — used by the
// /api/stickies route to cross-link stickies back to phases (a sticky's phase chip) without
// paying for, or recursing into, the board's own sticky read.
export function phaseCards(projectPath) {
  const board = loadColumns(projectPath);
  return board.ok ? flatCards(board.columns) : [];
}

// Render the human-readable BOARD.md mirror (the NOTES.md analog). Committed alongside
// board.json so the board is reviewable in a diff / on GitHub without the dashboard.
export function renderBoardMd(board) {
  const lines = ['# Flow Board', ''];
  const r = board.rollup;
  if (r && r.total) lines.push(`**Progress:** ${r.done}/${r.total} plans (${r.pct}%)`, '');
  if (board.sourcePath) lines.push(`_Derived from ${board.sourcePath}_`);
  if (board.generatedAt) lines.push(`_Updated ${board.generatedAt}_`);
  lines.push('');
  for (const col of COLUMNS) {
    const items = board.columns[col];
    lines.push(`## ${COLUMN_TITLES[col]} (${items.length})`, '');
    if (!items.length) lines.push('_(none)_', '');
    for (const c of items) {
      const bits = [];
      if (c.progress) bits.push(`${c.progress.done}/${c.progress.total}`);
      const m = c.metadata || {};
      if (Array.isArray(m.waves) && m.waves.length) {
        const lo = Math.min(...m.waves), hi = Math.max(...m.waves);
        bits.push('W' + (lo === hi ? lo : `${lo}–${hi}`));
      }
      if (m.shipped && m.shipped.total) bits.push(`✓ shipped ${m.shipped.done}/${m.shipped.total}`);
      if (c.blocked && c.blocked.count) bits.push('⛔ blocked');
      const tail = bits.length ? ` — ${bits.join(' · ')}` : '';
      lines.push(`- **${c.phase}**: ${c.title}${tail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Write a committable BOARD.md at an arbitrary path (default: the project root) so the board
// renders natively on GitHub — a phone-browser-viewable snapshot, no server or network needed.
// Uses the full live board (dynamic shipped/blocked), unlike the static .flow/ snapshot mirror.
export function exportBoardMd(projectPath, outPath) {
  const board = buildBoard(projectPath);
  const target = outPath || join(projectPath, 'BOARD.md');
  // Never leave a bogus stub board on the failure path — a caller that ignores !ok could
  // otherwise commit an empty "# Flow Board" file. Only write when there is a real board.
  if (!board.ok) return { ok: false, outPath: target, source: board.source };
  const md = renderBoardMd(board);
  writeFileSync(target, md.endsWith('\n') ? md : `${md}\n`);
  return { ok: true, outPath: target, source: board.source };
}

// Write the committed snapshot + human mirror into <project>/.flow/. Explicit (not called
// on every read) so it never churns git on a plain dashboard refresh. Returns the paths.
export function snapshotBoard(projectPath) {
  // Raw columns only — the snapshot must never carry read-time dynamic data (sticky counts,
  // blocked state), which is local and would churn the committed board.json on every read.
  const board = loadColumns(projectPath);
  const dir = join(projectPath, '.flow');
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, 'board.json');
  const mdPath = join(dir, 'BOARD.md');
  const docsPath = join(dir, 'docs.json');
  const graphPath = join(dir, 'graph.json');

  // Pre-tokenize every doc referenced by any card (via readPhaseDoc so the tokenization is
  // byte-identical to the live /api/phase-doc route). This makes .flow/ self-sufficient:
  // a cloud/mobile session with no .planning/ still has the doc bodies to render.
  const docsMap = {};
  for (const col of COLUMNS) {
    for (const card of board.columns[col] || []) {
      for (const doc of card.docs || []) {
        if (docsMap[doc.path]) continue;
        const read = readPhaseDoc(projectPath, doc.path);
        if (read.ok) docsMap[doc.path] = { kind: read.kind, frontmatter: read.frontmatter, blocks: read.blocks };
      }
    }
  }

  writeFileSync(jsonPath, JSON.stringify({
    generatedAt: board.generatedAt,
    sourcePath: board.sourcePath || null,
    counts: board.counts,
    rollup: board.rollup || null,
    columns: board.columns, // cards carry docs[]/metadata
  }, null, 2) + '\n');
  writeFileSync(docsPath, JSON.stringify(docsMap, null, 2) + '\n');

  // Snapshot the plan-execution DAG too, so /graph survives the repo-mode path (no .planning/).
  // Same self-sufficient .flow/ DNA as board.json/docs.json above.
  const graph = derivePlanGraph(projectPath) || { nodes: [], edges: [] };
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n');

  writeFileSync(mdPath, renderBoardMd(board));
  return { jsonPath, mdPath, docsPath, graphPath, board };
}
