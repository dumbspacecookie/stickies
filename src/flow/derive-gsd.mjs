// Derive a Kanban board (To-Do / Doing / Done) from a GSD .planning/ROADMAP.md.
// Graduated from a proven scratchpad spike (tested against a real GSD roadmap).
//
// The one rule that matters: the ✅/⏳ emoji is NOT the signal. In real GSD roadmaps
// "✅ Planned" and "✅ EXECUTED" both wear ✅ — so a phase is classified by the STATUS
// KEYWORD, never the icon. A phase with some plans checked and some not is unambiguously
// in-flight regardless of what its prose Status claims.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
// NOTE: keep this module dependency-free (only node:fs/node:path + the local dependency-free
// frontmatter parser) so it can be inlined into repo-mode's self-contained engine later,
// same as the stickies engine.mjs.

const DONE = /\b(complete|completed|executed|shipped|live|merged|done)\b/i;
const DOING = /\b(in[ -]?progress|next|unblocked|executing|wip|underway|building)\b/i;
// everything else (planned, skeleton, ratified, stub, blocked, scoping) => To-Do

export const COLUMNS = ['todo', 'doing', 'done'];

// checkboxRatio: fraction of a phase's plan checkboxes that are checked, or null if none.
export function classify(statusText, checkboxRatio) {
  // Partial progress beats prose: some-but-not-all plans checked => actively in flight.
  if (checkboxRatio !== null && checkboxRatio > 0 && checkboxRatio < 1) return 'doing';
  const s = statusText || '';
  if (DONE.test(s)) return 'done';
  if (DOING.test(s)) return 'doing';
  return 'todo';
}

// Parse ROADMAP.md text into phase cards. Exported separately so it can be unit-tested
// without touching the filesystem.
export function parseRoadmap(md) {
  const lines = md.split(/\r?\n/); // ROADMAP.md is CRLF on Windows; strip \r or $ anchors miss
  const cards = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const total = cur._boxTotal;
    const ratio = total > 0 ? cur._boxDone / total : null;
    cur.column = classify(cur.statusText, ratio);
    cur.progress = total > 0 ? { done: cur._boxDone, total } : null;
    delete cur._boxDone;
    delete cur._boxTotal;
    cards.push(cur);
  };

  for (const line of lines) {
    const h = line.match(/^###\s+(Phase\s+[\w.]+)\s*[:—-]?\s*(.*)$/i);
    if (h) {
      flush();
      // Strip a trailing "— ✅ STATUS" decoration off the title for a clean card name.
      const title = h[2].replace(/\s*[—-]\s*[✅⏳🚧🔲◻️].*$/u, '').trim();
      cur = {
        id: h[1].replace(/\s+/g, '-').toLowerCase(),
        phase: h[1],
        title,
        statusText: null,
        column: 'todo',
        progress: null,
        _boxDone: 0,
        _boxTotal: 0,
      };
      continue;
    }
    if (!cur) continue;
    const st = line.match(/^\*\*Status:\*\*\s*(.+)$/);
    if (st) {
      cur.statusText = st[1].replace(/[✅⏳🚧]/gu, '').trim();
      continue;
    }
    const box = line.match(/^\s*[-*]\s*\[([ xX])\]/);
    if (box) {
      cur._boxTotal++;
      if (box[1].toLowerCase() === 'x') cur._boxDone++;
    }
  }
  flush();
  return cards;
}

// Classify a phase-dir doc file into a GSD kind by its filename. Presence-driven: only
// kinds that actually exist get attached to a card. VALIDATION is included so a
// `NN-VALIDATION.md` earns a drawer tab instead of being silently dropped.
function classifyDoc(filename) {
  const f = filename.toUpperCase();
  if (!f.endsWith('.MD')) return null;
  if (f.includes('RESEARCH')) return 'RESEARCH';
  if (f.includes('CONTEXT')) return 'CONTEXT';
  if (f.includes('VERIFICATION')) return 'VERIFICATION';
  if (f.includes('VALIDATION')) return 'VALIDATION';
  if (f.includes('SUMMARY')) return 'SUMMARY';
  if (f.includes('PLAN')) return 'PLAN';
  return null;
}

// The "NN-MM" plan id prefix (e.g. 00-01) for PLAN/SUMMARY docs; undefined otherwise.
function planIdOf(filename) {
  const m = filename.match(/^(\d+-\d+)-/);
  return m ? m[1] : undefined;
}

function labelFor(kind, plan) {
  const nice = kind.charAt(0) + kind.slice(1).toLowerCase(); // RESEARCH -> Research
  return plan ? `${nice} ${plan}` : nice;
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  return [v];
}

// Shipped tally for a phase from its docs[]: a plan counts as "shipped" once a
// `NN-MM-SUMMARY.md` exists next to it (a phase's plan is only summarized after it executes).
// done = distinct plan ids with a SUMMARY; total = distinct plan ids seen (PLAN or SUMMARY).
// Returns null when the phase has no numbered plans at all, so the card shows nothing.
export function shippedFromDocs(docs) {
  const plans = new Set();
  const summaries = new Set();
  for (const d of docs || []) {
    if (!d || !d.plan) continue;
    if (d.kind === 'PLAN') plans.add(d.plan);
    else if (d.kind === 'SUMMARY') summaries.add(d.plan);
  }
  const total = new Set([...plans, ...summaries]).size;
  if (total === 0) return null;
  return { done: summaries.size, total };
}

// Scan `<project>/.planning/phases/<NN>-*/` for a phase card and return its docs[] plus
// distilled metadata. Dependency-free (node:fs only). NN = the card's zero-padded number.
export function scanPhaseDocs(projectPath, phaseCard) {
  const empty = { docs: [], metadata: { waves: [], dependsOnCount: 0, requirementIds: [], lastTouched: null, shipped: null } };
  if (!projectPath || !phaseCard || !phaseCard.phase) return empty;
  const numMatch = String(phaseCard.phase).match(/(\d+)/);
  if (!numMatch) return empty;
  const nn = numMatch[1].padStart(2, '0');

  const phasesDir = join(projectPath, '.planning', 'phases');
  if (!existsSync(phasesDir)) return empty;

  let dirName = null;
  try {
    for (const d of readdirSync(phasesDir)) {
      if (d === nn || d.startsWith(`${nn}-`)) {
        try { if (statSync(join(phasesDir, d)).isDirectory()) { dirName = d; break; } } catch { /* skip */ }
      }
    }
  } catch { return empty; }
  if (!dirName) return empty;

  const dirPath = join(phasesDir, dirName);
  let files;
  try { files = readdirSync(dirPath); } catch { return empty; }

  const docs = [];
  const wavesSet = new Set();
  const dependsSet = new Set();
  const reqSet = new Set();
  let newest = 0;

  for (const file of files.slice().sort()) {
    const kind = classifyDoc(file);
    if (!kind) continue;
    const full = join(dirPath, file);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;

    const mtime = st.mtime.getTime();
    if (mtime > newest) newest = mtime;

    const plan = planIdOf(file);
    docs.push({ kind, path: `phases/${dirName}/${file}`, label: labelFor(kind, plan), ...(plan ? { plan } : {}) });

    if (kind === 'PLAN') {
      try {
        const { frontmatter } = parseFrontmatter(readFileSync(full, 'utf8'));
        const n = Number(frontmatter.wave);
        if (frontmatter.wave !== undefined && frontmatter.wave !== '' && Number.isFinite(n)) wavesSet.add(n);
        for (const dep of toArray(frontmatter.depends_on)) if (dep) dependsSet.add(dep);
        for (const r of toArray(frontmatter.requirements)) if (r) reqSet.add(r);
      } catch { /* a malformed PLAN.md contributes no metadata but never breaks the scan */ }
    }
  }

  return {
    docs,
    metadata: {
      waves: [...wavesSet].sort((a, b) => a - b),
      dependsOnCount: dependsSet.size, // distinct union across all of the phase's PLANs
      requirementIds: [...reqSet],
      lastTouched: newest > 0 ? new Date(newest).toISOString() : null,
      shipped: shippedFromDocs(docs), // {done,total} of plans with a SUMMARY, or null
    },
  };
}

// True progress = work DONE, not plans authored. A GSD phase's real completion signal is a
// sibling NN-MM-SUMMARY.md (a plan is only summarized after it executes); its PLAN.md work
// lives in <task> tags that carry no checkbox state, so the ROADMAP's own [x] boxes only ever
// mean "plan written". So prefer the shipped tally (SUMMARY presence) when the phase has real
// plan docs on disk, and fall back to the ROADMAP checkbox count for roadmaps with no phase
// dirs (e.g. an inline-checkbox roadmap that hand-maintains its own progress).
export function effectiveProgress(card) {
  const roadmap = card ? card.progress : null;
  const shipped = card && card.metadata && card.metadata.shipped;
  if (shipped && typeof shipped.total === 'number' && shipped.total > 0) {
    // done = plans actually executed (a SUMMARY exists). total = the fuller planned scope:
    // the ROADMAP's plan list or what's on disk, whichever is larger, so a plan that's listed
    // but not yet authored still counts against progress (it's real remaining work).
    const total = Math.max(roadmap && roadmap.total ? roadmap.total : 0, shipped.total);
    return { done: shipped.done, total };
  }
  return roadmap;
}

// Board-level rollup: sum every card's effective (execution-preferred) progress into
// {done, total, pct}.
function computeRollup(cards) {
  let done = 0, total = 0;
  for (const c of cards) {
    const p = effectiveProgress(c);
    if (p && typeof p.done === 'number' && typeof p.total === 'number') {
      done += p.done;
      total += p.total;
    }
  }
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

// Locate a .planning/ROADMAP.md under a project root and derive its board. Each card is
// enriched with docs[]/metadata from its phase dir, and the board carries a rollup.
// Returns { source, cards, rollup } or null when no roadmap is present.
export function deriveGsdBoard(projectPath) {
  if (!projectPath) return null;
  const roadmap = join(projectPath, '.planning', 'ROADMAP.md');
  if (!existsSync(roadmap)) return null;
  let md;
  try {
    md = readFileSync(roadmap, 'utf8');
  } catch {
    return null;
  }
  const cards = parseRoadmap(md);
  for (const card of cards) {
    const { docs, metadata } = scanPhaseDocs(projectPath, card);
    card.docs = docs;
    card.metadata = metadata;
  }
  return { source: roadmap, cards, rollup: computeRollup(cards) };
}
