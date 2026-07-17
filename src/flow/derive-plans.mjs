// Derive a plan-execution DAG from a project's GSD PLAN.md frontmatter. Every PLAN.md
// declares a `wave` and a `depends_on` list — a real dependency graph — so the flow
// dashboard can render plans as nodes, depends_on as edges, and light each node by its own
// checkbox completion. Dependency-free (node:fs/node:path + the local frontmatter parser)
// so it inlines into repo-mode's self-contained engine, same rule as derive-gsd.mjs.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

const BOX = /^\s*[-*]\s*\[([ xX])\]/; // same checkbox shape derive-gsd.mjs counts

// Status from a plan's own checkbox ratio: all checked => done, some => doing (partial
// beats prose, like classify()), none or zero boxes => todo. Kept explicit because
// classify() only maps a full ratio to 'done' through status prose, which a PLAN.md lacks.
function planStatus(done, total) {
  if (total > 0 && done === total) return 'done';
  if (done > 0) return 'doing';
  return 'todo';
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [v];
}

// Count a plan file's checkbox boxes. Frontmatter carries no boxes, so scanning the whole
// text is safe and CRLF-tolerant (Windows-authored PLAN.md files are CRLF).
function countBoxes(text) {
  let done = 0, total = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(BOX);
    if (m) { total++; if (m[1].toLowerCase() === 'x') done++; }
  }
  return { done, total };
}

// Build { nodes, edges } for every <project>/.planning/phases/*/*-PLAN.md. A node id is the
// "<paddedPhase>-<plan>" filename prefix (e.g. "00-01"), which is exactly the token a
// depends_on entry references. Edges point dependency -> dependent; edges to an id with no
// matching PLAN.md are dropped. Returns null when there is no .planning/phases dir.
export function derivePlanGraph(projectPath) {
  if (!projectPath) return null;
  const phasesDir = join(projectPath, '.planning', 'phases');
  if (!existsSync(phasesDir)) return null;

  let phaseDirs;
  try {
    phaseDirs = readdirSync(phasesDir).filter((d) => {
      try { return statSync(join(phasesDir, d)).isDirectory(); } catch { return false; }
    });
  } catch { return null; }

  const nodes = [];
  const rawEdges = [];

  for (const dir of phaseDirs.slice().sort()) {
    const dirPath = join(phasesDir, dir);
    let files;
    try { files = readdirSync(dirPath); } catch { continue; }

    for (const file of files.slice().sort()) {
      const m = file.match(/^(\d+)-(\d+)-PLAN\.md$/i);
      if (!m) continue;
      const phase = m[1];
      const plan = m[2];
      const id = `${phase}-${plan}`;
      const full = join(dirPath, file);

      let text;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }

      let frontmatter = {};
      try { ({ frontmatter } = parseFrontmatter(text)); } catch { frontmatter = {}; }

      // Missing/invalid wave degrades to a single lane (0), per assumption A2; never throws.
      const waveN = Number(frontmatter.wave);
      const wave = (frontmatter.wave !== undefined && frontmatter.wave !== '' && Number.isFinite(waveN)) ? waveN : 0;

      const { done, total } = countBoxes(text);

      // A plan is "done" the moment it ships a SUMMARY.md — that's the reliable completion
      // signal. GSD PLAN.md files describe work in <task> tags, not markdown checkboxes, so
      // countBoxes() returns 0 for them and the checkbox ratio alone would peg every real
      // plan at 'todo' (and, transitively, mark every downstream phase falsely blocked).
      // SUMMARY presence takes precedence; the checkbox ratio is the fallback for plans that
      // do track boxes and haven't shipped yet.
      const shipped = existsSync(join(dirPath, `${phase}-${plan}-SUMMARY.md`));

      nodes.push({
        id,
        phase,
        plan,
        label: id,
        wave,
        status: shipped ? 'done' : planStatus(done, total),
        progress: total > 0 ? { done, total } : (shipped ? { done: 1, total: 1 } : null),
      });

      for (const dep of toArray(frontmatter.depends_on)) {
        if (dep) rawEdges.push({ from: String(dep).trim(), to: id });
      }
    }
  }

  // Drop dangling edges: keep only those whose endpoints both resolve to a real plan node.
  const known = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => known.has(e.from) && known.has(e.to));

  return { nodes, edges };
}

// Which phases are blocked, from a { nodes, edges } graph. A phase is blocked when one of
// its plans (the edge's `to`) is not yet done AND that plan depends on a plan (the edge's
// `from`) that is not yet done — an unmet upstream dependency. A dependent that's already
// done is not blocked (the dependency stopped mattering once it shipped). Pure; keyed by the
// canonical phase-number string (Number()-normalized), matching cross-link's phaseNumberOf.
// Returns { "<phaseNum>": { count, deps: [unmet dependency ids...] }, ... }.
export function computeBlockedPhases(graph) {
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
  const statusById = new Map(nodes.map((n) => [n.id, n.status]));
  const phaseById = new Map(nodes.map((n) => [n.id, String(Number(n.phase))]));

  const blocked = {};
  for (const e of edges) {
    if (statusById.get(e.from) === 'done') continue; // dependency satisfied
    if (statusById.get(e.to) === 'done') continue;   // dependent already shipped
    const pnum = phaseById.get(e.to);
    if (pnum == null) continue;
    const entry = blocked[pnum] || (blocked[pnum] = { count: 0, deps: [] });
    if (!entry.deps.includes(e.from)) { entry.deps.push(e.from); entry.count = entry.deps.length; }
  }
  return blocked;
}
