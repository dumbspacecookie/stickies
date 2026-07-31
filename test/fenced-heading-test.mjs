// A heading inside a code fence is example text, not document structure.
//
// This is a data-corruption bug, not a cosmetic one. `### Phase 2` written inside a ```-block —
// an ordinary thing to do when a roadmap documents its own format — became a real, draggable
// card on the board. Dragging it sent writeback looking for that phase, it found a DIFFERENT
// one, and rewrote that phase's `**Status:**` on disk. Silently. `warnings: []`. A second shape:
// a fenced heading truncated the section writeback measured, so the real status line fell
// outside the range, the insert branch ran, and the phase ended up with two contradicting
// status lines.
//
// The load-bearing property is not "skip fences" — it is that the READER and the WRITER agree.
// Two independent copies of the rule would drift, and a disagreement between what the board
// shows and what the writer edits is exactly how the wrong section gets rewritten. So both
// import `fences.mjs`, and the end-to-end assertions below are what prove they still agree.
import { fencedLineFlags, outsideFences } from '../src/flow/fences.mjs';
import { rewriteRoadmapStatus } from '../src/flow/writeback.mjs';
import { parseRoadmap } from '../src/flow/derive-gsd.mjs';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const F = '```';
const T = '~~~';

// --- the fence scanner itself ----------------------------------------------------------------

const flags = (text) => fencedLineFlags(text.split('\n'));

check(JSON.stringify(flags(`a\n${F}\nb\n${F}\nc`)) === JSON.stringify([false, true, true, true, false]),
  'a simple backtick fence marks its delimiters and contents');

check(flags(`${F}js\n### Phase 9\n${F}`)[1] === true, 'an info string still opens a fence');
check(flags(`${T}\n### Phase 9\n${T}`)[1] === true, 'tilde fences work too');
check(flags(`${F}\n### Phase 9\n${T}\nstill inside\n${F}`)[3] === true,
  'a tilde line does not close a backtick fence');
check(flags(`${F}${F}\n### Phase 9\n${F}\nstill inside`)[3] === true,
  'a shorter run does not close a longer fence');
check(flags(`   ${F}\n### Phase 9\n   ${F}`)[1] === true, 'a fence indented up to 3 spaces still opens');
check(flags(`${F}\n### Phase 9\nunclosed forever`)[2] === true,
  'an UNCLOSED fence runs to end of document — the safe reading');
check(flags('### Phase 9\nplain text')[0] === false, 'an ordinary heading is not fenced');
check(flags('`inline ` + `code`')[0] === false, 'inline code spans do not open a fence');

const pred = outsideFences(['a', F, 'b', F, 'c']);
check(pred(0) === true && pred(2) === false && pred(4) === true, 'outsideFences() reads the right way round');

// --- the board must not invent a card ---------------------------------------------------------

const ROADMAP = [
  '# Roadmap',
  '',
  '### Phase 1: Real work',
  '**Status:** Planned',
  '',
  'Here is how you write a phase heading:',
  '',
  F,
  '### Phase 2: Just an example',
  '**Status:** Complete',
  F,
  '',
  '### Phase 3: Also real',
  '**Status:** Planned',
  '',
].join('\n');

const cards = parseRoadmap(ROADMAP);
const ids = cards.map((c) => c.id);
check(!ids.includes('phase-2'), `the fenced example is NOT a card (cards: ${JSON.stringify(ids)})`);
check(ids.includes('phase-1') && ids.includes('phase-3'), 'the two real phases still are');
check(cards.length === 2, `exactly two cards (got ${cards.length})`);

// --- and the writer must edit the phase you actually asked for --------------------------------

const moved = rewriteRoadmapStatus(ROADMAP, 'phase-1', 'done');
check(moved.ok === true, `moving a real phase succeeds (${moved.reason || ''})`);

const out = moved.text.split('\n');
// Phase 1's status changed...
check(/\*\*Status:\*\*\s*Complete/.test(out[3]), 'Phase 1 is the line that changed');
// ...and nothing inside the fence was touched.
check(out[8] === '### Phase 2: Just an example' && out[9] === '**Status:** Complete',
  'the fenced example block is byte-identical afterwards');
// ...and Phase 3 was not collateral damage.
check(/\*\*Status:\*\*\s*Planned/.test(out[13]), 'Phase 3 is untouched');

// Exactly one status line per real phase — the duplicate-insert shape of this bug.
const statusCount = out.filter((l) => /^\*\*Status:\*\*/.test(l)).length;
check(statusCount === 3, `still exactly 3 status lines, none inserted (got ${statusCount})`);

// The reader and the writer agree about phase-2: it is not a card, so it cannot be written.
const ghost = rewriteRoadmapStatus(ROADMAP, 'phase-2', 'done');
check(ghost.ok === false, 'a fenced phase cannot be written to at all');
check(/not found/i.test(ghost.reason || ''), `and says why (${ghost.reason})`);

// --- the extent shape: a fence BETWEEN a heading and its status line --------------------------
//
// The assertions above all have `**Status:**` sitting directly under its heading, so truncating
// the measured section at a fenced heading changes nothing and the extent guard looks redundant.
// It is not. Put the fence in between and the real status line falls outside the range: the
// writer finds none, takes the INSERT branch, and the phase ends up with two contradicting
// status lines — the exact outcome the lone-`\r` fix exists to prevent, reached through a fence.
const EXTENT = [
  '# Roadmap',
  '',
  '### Phase 1: Real work',
  '',
  'The format looks like this:',
  '',
  F,
  '### Phase 99: Example inside the fence',
  F,
  '',
  '**Status:** Planned',
  '',
  '### Phase 3: Also real',
  '**Status:** Planned',
  '',
].join('\n');

const ext = rewriteRoadmapStatus(EXTENT, 'phase-1', 'done');
check(ext.ok === true, `a phase whose status sits after a fenced block still moves (${ext.reason || ''})`);
const extOut = (ext.text || '').split('\n');
const extStatuses = extOut.filter((l) => /^\*\*Status:\*\*/.test(l));
check(extStatuses.length === 2,
  `exactly 2 status lines — none inserted (got ${extStatuses.length}: ${JSON.stringify(extStatuses)})`);
check(/\*\*Status:\*\*\s*Complete/.test(extOut[10]),
  'the EXISTING status line was rewritten in place, not duplicated above the fence');
check(extOut[7] === '### Phase 99: Example inside the fence',
  'and the fenced example is still byte-identical');

// --- control: without the fence, the same document behaves as it always did -------------------

const UNFENCED = ROADMAP.split('\n').filter((l) => l !== F).join('\n');
const unfencedCards = parseRoadmap(UNFENCED);
check(unfencedCards.length === 3,
  `control: with the fences removed all three headings ARE cards (${unfencedCards.length}) — so the assertions above are about fencing, not about the parser being broken`);

console.log(fail === 0 ? '\nOK — fenced headings' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
