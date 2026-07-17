// Unit tests for the two pure derivations behind the board's status badges:
// shippedFromDocs() (a plan is shipped once it has a SUMMARY) and computeBlockedPhases()
// (a phase is blocked by an unmet upstream dependency). Plain objects — no fs, no DB.

import { shippedFromDocs } from '../src/flow/derive-gsd.mjs';
import { computeBlockedPhases } from '../src/flow/derive-plans.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --- shippedFromDocs ---
const s1 = shippedFromDocs([
  { kind: 'PLAN', plan: '00-01' },
  { kind: 'SUMMARY', plan: '00-01' },
  { kind: 'PLAN', plan: '00-02' },
]);
ok(s1 && s1.done === 1 && s1.total === 2, 'one of two plans has a summary => 1/2 shipped');

const s2 = shippedFromDocs([{ kind: 'PLAN', plan: '00-01' }]);
ok(s2 && s2.done === 0 && s2.total === 1, 'plan with no summary => 0/1 shipped');

const s3 = shippedFromDocs([
  { kind: 'PLAN', plan: '00-01' }, { kind: 'SUMMARY', plan: '00-01' },
  { kind: 'PLAN', plan: '00-02' }, { kind: 'SUMMARY', plan: '00-02' },
]);
ok(s3 && s3.done === 2 && s3.total === 2, 'all plans summarized => 2/2 shipped');

ok(shippedFromDocs([{ kind: 'RESEARCH' }, { kind: 'CONTEXT' }]) === null, 'no numbered plans => null (nothing to show)');
ok(shippedFromDocs([]) === null, 'empty docs => null');
ok(shippedFromDocs(null) === null, 'null docs tolerated => null');

const s4 = shippedFromDocs([{ kind: 'SUMMARY', plan: '00-03' }]);
ok(s4 && s4.done === 1 && s4.total === 1, 'summary without a sibling PLAN still counts (1/1)');

// --- computeBlockedPhases ---
const graph = {
  nodes: [
    { id: '00-01', phase: '00', status: 'done' },
    { id: '00-02', phase: '00', status: 'doing' },
    { id: '01-01', phase: '01', status: 'todo' },
    { id: '01-02', phase: '01', status: 'done' },
    { id: '02-01', phase: '02', status: 'todo' },
  ],
  edges: [
    { from: '00-01', to: '01-01' }, // dependency DONE => not blocking
    { from: '00-02', to: '01-01' }, // dependency not done, dependent not done => BLOCKS phase 1
    { from: '00-02', to: '01-02' }, // dependent already DONE => not blocked
    { from: '00-02', to: '02-01' }, // dependency not done, dependent not done => BLOCKS phase 2
  ],
};
const blocked = computeBlockedPhases(graph);
ok(blocked['1'] && blocked['1'].count === 1 && blocked['1'].deps[0] === '00-02', 'phase 1 blocked by unmet dep 00-02');
ok(blocked['2'] && blocked['2'].count === 1, 'phase 2 blocked by unmet dep');
ok(!blocked['0'], 'phase 0 (the upstream) is not itself blocked');

// A done dependency never blocks even if the dependent is unstarted.
const g2 = {
  nodes: [{ id: '00-01', phase: '00', status: 'done' }, { id: '01-01', phase: '01', status: 'todo' }],
  edges: [{ from: '00-01', to: '01-01' }],
};
ok(Object.keys(computeBlockedPhases(g2)).length === 0, 'all upstream deps done => nothing blocked');

// Dedup: two unmet deps into the same phase => count 2, no duplicate ids.
const g3 = {
  nodes: [
    { id: '00-01', phase: '00', status: 'todo' },
    { id: '00-02', phase: '00', status: 'doing' },
    { id: '01-01', phase: '01', status: 'todo' },
  ],
  edges: [
    { from: '00-01', to: '01-01' },
    { from: '00-02', to: '01-01' },
    { from: '00-01', to: '01-01' }, // duplicate edge — must not double-count
  ],
};
const b3 = computeBlockedPhases(g3);
ok(b3['1'] && b3['1'].count === 2 && b3['1'].deps.length === 2, 'two distinct unmet deps => count 2, deduped');

ok(Object.keys(computeBlockedPhases({ nodes: [], edges: [] })).length === 0, 'empty graph => nothing blocked');
ok(Object.keys(computeBlockedPhases(null)).length === 0, 'null graph tolerated');

console.log(fail ? `\nFLOW-STATUS ${fail} FAILURES` : '\nFLOW-STATUS OK');
process.exit(fail ? 1 : 0);
