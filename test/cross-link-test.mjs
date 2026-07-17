// Unit tests for the sticky<->phase association heuristic and per-category counting. Pure —
// plain objects, no DB, no filesystem.

import { phaseNumberOf, stickyRelatesToPhase, crossLink } from '../src/flow/cross-link.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const phase0 = { id: 'phase-0', phase: 'Phase 0', title: 'Foundations' };
const phase1 = { id: 'phase-1', phase: 'Phase 1', title: 'Build Pipeline' };
const phase12 = { id: 'phase-12', phase: 'Phase 12', title: 'Cleanup' };
const st = (o) => ({ id: 'x', category: 'todo', tags: [], content: '', ...o });

// --- phaseNumberOf: canonical number, null when unnumbered ---
ok(phaseNumberOf(phase0) === '0', 'Phase 0 => "0"');
ok(phaseNumberOf(phase12) === '12', 'Phase 12 => "12"');
ok(phaseNumberOf({ phase: 'Phase 03' }) === '3', 'Phase 03 => "3" (leading zero normalized)');
ok(phaseNumberOf({ phase: 'Intro' }) === null, 'unnumbered phase => null');

// --- tag association ---
ok(stickyRelatesToPhase(st({ tags: ['0'] }), phase0), 'tag "0" matches Phase 0');
ok(!stickyRelatesToPhase(st({ tags: ['0'] }), phase1), 'tag "0" does NOT match Phase 1');
ok(stickyRelatesToPhase(st({ tags: ['00'] }), phase0), 'zero-padded tag "00" matches Phase 0');
ok(stickyRelatesToPhase(st({ tags: ['phase-1'] }), phase1), 'tag "phase-1" matches Phase 1');
ok(stickyRelatesToPhase(st({ tags: ['PHASE1'] }), phase1), 'tag "PHASE1" matches (case-insensitive)');
ok(stickyRelatesToPhase(st({ tags: ['foundations'] }), phase0), 'title-slug tag "foundations" matches Phase 0');
ok(stickyRelatesToPhase(st({ tags: ['build-pipeline'] }), phase1), 'title-slug tag "build-pipeline" matches Phase 1');
ok(!stickyRelatesToPhase(st({ tags: ['unrelated', 'v0.10'] }), phase0), 'a tag merely containing "0" (v0.10) does NOT match');

// --- content fallback (only the explicit "phase N" form, never a bare number) ---
ok(stickyRelatesToPhase(st({ tags: [], content: 'blocked on Phase 1 work' }), phase1), 'content "Phase 1" matches Phase 1');
ok(stickyRelatesToPhase(st({ tags: [], content: 'see phase00 notes' }), phase0), 'content "phase00" matches Phase 0');
ok(!stickyRelatesToPhase(st({ tags: [], content: 'version 0 baseline' }), phase0), 'bare "0" in prose does NOT match (no "phase")');
ok(!stickyRelatesToPhase(st({ tags: [], content: 'nothing here' }), phase1), 'unrelated content => no match');

// --- crossLink: per-phase category counts + first-match perSticky ---
const cards = [phase0, phase1];
const stickies = [
  { id: 'a', category: 'blocker', tags: ['phase-1'], content: '' },
  { id: 'b', category: 'todo', tags: ['1'], content: '' },
  { id: 'c', category: 'todo', tags: ['phase-0'], content: '' },
  { id: 'd', category: 'context', tags: [], content: 'note about phase 1' },
  { id: 'e', category: 'decision', tags: ['phase-0', 'phase-1'], content: '' },
  { id: 'f', category: 'preference', tags: ['unrelated'], content: 'no phase here' },
];
const { perPhase, perSticky } = crossLink(cards, stickies);

ok(perPhase['phase-1'].total === 4, 'Phase 1 relates to 4 stickies (a,b,d,e)');
ok(perPhase['phase-1'].counts.blocker === 1 && perPhase['phase-1'].counts.todo === 1
   && perPhase['phase-1'].counts.context === 1 && perPhase['phase-1'].counts.decision === 1,
   'Phase 1 counts split by category');
ok(perPhase['phase-0'].total === 2 && perPhase['phase-0'].counts.todo === 1 && perPhase['phase-0'].counts.decision === 1,
   'Phase 0 relates to 2 stickies (c,e)');
ok(!('f' in perSticky), 'unrelated sticky f gets no phase link');
ok(perSticky['a'].id === 'phase-1', 'sticky a chips to Phase 1');
ok(perSticky['e'].id === 'phase-0', 'multi-phase sticky e chips to its FIRST match (Phase 0, roadmap order)');

// --- empty / defensive inputs ---
const empty = crossLink([], []);
ok(Object.keys(empty.perPhase).length === 0 && Object.keys(empty.perSticky).length === 0, 'empty inputs => empty maps');
ok(Object.keys(crossLink(null, null).perPhase).length === 0, 'null inputs tolerated');

console.log(fail ? `\nCROSS-LINK ${fail} FAILURES` : '\nCROSS-LINK OK');
process.exit(fail ? 1 : 0);
