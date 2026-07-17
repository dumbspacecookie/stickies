// Plan-graph tests: the deriver's node/edge/status rules + the .flow/graph.json snapshot
// and repo-mode fallback. Pure/offline — hermetic tmpdirs, no shared DB, no network.

import { derivePlanGraph } from '../src/flow/derive-plans.mjs';
import { snapshotBoard } from '../src/flow/board.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const mkPlan = (dir, name, body) => writeFileSync(join(dir, name), body);

// --- deriver: nodes, waves, status, progress, edges, dangling drop, null guard ---
const root = mkdtempSync(join(tmpdir(), 'flowgraph-'));
try {
  ok(derivePlanGraph(root) === null, 'no .planning/phases => derivePlanGraph returns null');

  const pdir = join(root, '.planning', 'phases', '00-demo');
  mkdirSync(pdir, { recursive: true });
  // wave 1, no deps, all boxes checked => done
  mkPlan(pdir, '00-01-PLAN.md', '---\nwave: 1\ndepends_on: []\n---\n# p1\n- [x] a\n- [x] b\n');
  // wave 2, depends_on [00-01], some checked => doing
  mkPlan(pdir, '00-02-PLAN.md', '---\nwave: 2\ndepends_on: [00-01]\n---\n# p2\n- [x] a\n- [ ] b\n');
  // wave 2, depends_on [00-01, 99-99 (dangling)], none checked => todo
  mkPlan(pdir, '00-03-PLAN.md', '---\nwave: 2\ndepends_on: [00-01, 99-99]\n---\n# p3\n- [ ] a\n- [ ] b\n');
  // missing wave, no checkboxes => wave 0, progress null, todo
  mkPlan(pdir, '00-04-PLAN.md', '---\ndepends_on: []\n---\n# p4\nno boxes here\n');

  const g = derivePlanGraph(root);
  ok(g && Array.isArray(g.nodes) && Array.isArray(g.edges), 'returns { nodes, edges }');
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  ok(g.nodes.length === 4, `4 plan nodes (got ${g.nodes.length})`);
  ok(!!byId['00-01'] && !!byId['00-02'], 'node ids 00-01 and 00-02 present');
  ok(byId['00-01'].wave === 1 && byId['00-02'].wave === 2, 'waves parsed from frontmatter');
  ok(byId['00-01'].status === 'done', 'all boxes checked => done');
  ok(byId['00-02'].status === 'doing', 'some boxes checked => doing');
  ok(byId['00-03'].status === 'todo', 'zero boxes checked => todo');
  ok(byId['00-01'].progress && byId['00-01'].progress.done === 2 && byId['00-01'].progress.total === 2, '00-01 progress 2/2');
  ok(byId['00-02'].progress && byId['00-02'].progress.done === 1 && byId['00-02'].progress.total === 2, '00-02 progress 1/2');
  ok(byId['00-04'].wave === 0, 'missing wave defaults to 0');
  ok(byId['00-04'].progress === null, 'no checkboxes => progress null');

  const hasEdge = (from, to) => g.edges.some((e) => e.from === from && e.to === to);
  ok(hasEdge('00-01', '00-02'), 'edge points dependency -> dependent (00-01 -> 00-02)');
  ok(hasEdge('00-01', '00-03'), 'edge 00-01 -> 00-03 present');
  ok(!g.edges.some((e) => e.from === '99-99' || e.to === '99-99'), 'edge to unknown id (99-99) dropped');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- snapshot writes .flow/graph.json and the graph survives .planning deletion ---
const proj = mkdtempSync(join(tmpdir(), 'flowgraphsnap-'));
try {
  const pdir = join(proj, '.planning', 'phases', '00-demo');
  mkdirSync(pdir, { recursive: true });
  mkPlan(pdir, '00-01-PLAN.md', '---\nwave: 1\ndepends_on: []\n---\n# p1\n- [x] a\n');
  mkPlan(pdir, '00-02-PLAN.md', '---\nwave: 2\ndepends_on: [00-01]\n---\n# p2\n- [ ] a\n');
  writeFileSync(join(proj, '.planning', 'ROADMAP.md'), [
    '# Roadmap', '',
    '### Phase 0: Demo', '**Status:** ⏳ in progress',
    '- [x] 00-01-PLAN.md', '- [ ] 00-02-PLAN.md', '',
  ].join('\n'));

  snapshotBoard(proj);
  const graphPath = join(proj, '.flow', 'graph.json');
  ok(existsSync(graphPath), 'snapshotBoard writes .flow/graph.json');
  const snapGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
  ok(snapGraph.nodes.length === 2 && snapGraph.edges.length === 1, 'graph.json holds 2 nodes + 1 edge');

  const live = derivePlanGraph(proj);

  // Nuke the live planning dir — repo-mode now relies solely on .flow/graph.json.
  rmSync(join(proj, '.planning'), { recursive: true, force: true });
  ok(derivePlanGraph(proj) === null, 'after .planning deleted, the live deriver returns null');

  const fallback = JSON.parse(readFileSync(graphPath, 'utf8'));
  ok(fallback.nodes.length === live.nodes.length && fallback.edges.length === live.edges.length,
    'snapshot graph.json returns the same nodes/edges as the pre-deletion live graph');
  ok(fallback.edges[0].from === '00-01' && fallback.edges[0].to === '00-02', 'fallback edge preserved (00-01 -> 00-02)');
} finally {
  rmSync(proj, { recursive: true, force: true });
}

console.log(fail ? `\nFLOW-GRAPH ${fail} FAILURES` : '\nFLOW-GRAPH OK');
process.exit(fail ? 1 : 0);
