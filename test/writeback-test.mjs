// Board writeback tests.
//
// This is the only code in Stickies that edits a GSD planning document, so the tests are
// weighted towards what must NOT happen: no collateral edits, no lost human remarks, no
// mangled line endings, and above all no silent write of a status the board will then ignore.

import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { scratchDir } from './_env.mjs';
import { join } from 'node:path';
import { rewriteRoadmapStatus, setPhaseStatus, STATUS_WORD } from '../src/flow/writeback.mjs';
import { parseRoadmap } from '../src/flow/derive-gsd.mjs';

const ROOT = scratchDir('writeback');
rmSync(ROOT, { recursive: true, force: true });

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
// `text || ''` so a regression that turns a rewrite into a refusal reports as a failed assertion
// instead of a TypeError that takes the remaining sections of this file with it.
const columnOf = (text, id) => (parseRoadmap(text || '').find((c) => c.id === id) || {}).column;

// A roadmap with the shapes that actually occur: a decorated heading, a status with a trailing
// remark, a phase with no status line at all, a partially-checked phase, and a dotted id.
const LF = [
  '# Roadmap',
  '',
  'Intro prose that must never be touched.',
  '',
  '### Phase 1: First thing',
  '**Status:** Planned',
  '- [ ] 01-01-PLAN.md',
  '- [ ] 01-02-PLAN.md',
  '',
  '### Phase 2: Second thing — ✅ EXECUTED',
  '**Status:** ✅ Complete — see 02-SUMMARY.md',
  '- [x] 02-01-PLAN.md',
  '',
  '### Phase 3: No status line',
  '- [ ] 03-01-PLAN.md',
  '',
  '### Phase 4b: Dotted id',
  '**Status:** In progress',
  '- [x] 04-01-PLAN.md',
  '- [ ] 04-02-PLAN.md',
  '',
  '## Notes',
  'Trailing section that must never be touched.',
  '',
].join('\n');

// --- the happy path -----------------------------------------------------------------------
let r = rewriteRoadmapStatus(LF, 'phase-1', 'done');
check(r.ok, 'todo -> done succeeds');
check(r.text.includes('**Status:** Complete'), 'writes the canonical word for the column');
check(columnOf(r.text, 'phase-1') === 'done', 'and the board re-derives it as done (round trip holds)');
for (const [col, word] of Object.entries(STATUS_WORD)) {
  const out = rewriteRoadmapStatus(LF, 'phase-1', col);
  check(out.ok && columnOf(out.text, 'phase-1') === col, `${col} -> "${word}" round-trips through the parser`);
}

// --- rule 1: exactly one line changes -----------------------------------------------------
r = rewriteRoadmapStatus(LF, 'phase-1', 'done');
const before = LF.split('\n');
const after = r.text.split('\n');
check(before.length === after.length, 'no lines added or removed');
const diff = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
check(diff.length === 1, `exactly one line differs (got ${diff.length})`);
check(/^\*\*Status:\*\*/.test(before[diff[0]]), 'and the changed line is a Status line');
check(r.text.includes('Intro prose that must never be touched.'), 'prose above is untouched');
check(r.text.includes('Trailing section that must never be touched.'), 'sections below are untouched');
check(r.text.includes('- [ ] 01-01-PLAN.md') && r.text.includes('- [ ] 01-02-PLAN.md'), 'checkboxes are untouched');
check(r.text.includes('### Phase 1: First thing'), 'the heading is untouched');

// Other phases must be bystanders.
r = rewriteRoadmapStatus(LF, 'phase-3', 'doing');
check(r.text.includes('**Status:** Planned') , "phase 1's status survives an edit to phase 3");
check(r.text.includes('**Status:** ✅ Complete — see 02-SUMMARY.md'), "phase 2's status survives untouched");

// --- rule 2: shape preserved --------------------------------------------------------------
const CRLF = LF.replace(/\n/g, '\r\n');
r = rewriteRoadmapStatus(CRLF, 'phase-1', 'done');
check(r.ok && r.text.includes('\r\n'), 'CRLF input stays CRLF');
check(!/[^\r]\n/.test(r.text), 'no lone LF is introduced into a CRLF file');
r = rewriteRoadmapStatus(LF, 'phase-1', 'done');
check(!r.text.includes('\r'), 'LF input stays LF');

// A human's trailing remark on the status line must survive the rewrite.
r = rewriteRoadmapStatus(LF, 'phase-2', 'todo');
check(r.ok, 'phase 2 (status carries a remark) rewrites');
check(/\*\*Status:\*\* Planned — see 02-SUMMARY\.md/.test(r.text), 'the trailing remark is preserved');
check(columnOf(r.text, 'phase-2') === 'todo', 'and it still re-derives to the requested column');

// A phase with no status line gets one, inserted directly under its heading.
r = rewriteRoadmapStatus(LF, 'phase-3', 'doing');
check(r.ok, 'a phase with no Status line can still be moved');
const idx = r.text.split('\n').findIndex((l) => l === '### Phase 3: No status line');
check(r.text.split('\n')[idx + 1] === '**Status:** In progress', 'the new Status line lands right under the heading');
check(columnOf(r.text, 'phase-3') === 'doing', 'and derives correctly');

// Dotted/suffixed phase ids resolve.
r = rewriteRoadmapStatus(LF, 'phase-4b', 'doing');
check(r.ok, 'a suffixed phase id (4b) is found');

// --- rule 3: never write a move that would not hold ---------------------------------------
// Phase 4b has 1 of 2 boxes ticked. Partial progress classifies as 'doing' no matter what the
// status text says, so done/todo must be REFUSED rather than written and silently ignored.
for (const target of ['done', 'todo']) {
  const out = rewriteRoadmapStatus(LF, 'phase-4b', target);
  check(out.ok === false, `partially-checked phase refuses a move to ${target}`);
  check(out.wouldNotHold === true, 'the refusal is flagged as "would not hold"');
  check(out.derived === 'doing', 'and reports what the board would actually derive');
  check(/checkbox/i.test(out.reason), `the reason explains the checkbox rule (got: ${out.reason})`);
}
const held = rewriteRoadmapStatus(LF, 'phase-4b', 'doing');
check(held.ok, 'but moving it to the column it genuinely is in succeeds');

// A remark containing a status keyword would flip the classification — must be caught, not written.
const trap = ['### Phase 9: Trap', '**Status:** Complete — next after Phase 3', ''].join('\n');
const trapOut = rewriteRoadmapStatus(trap, 'phase-9', 'todo');
check(trapOut.ok === false && trapOut.derived === 'doing',
  `a preserved remark that re-classifies the phase is refused (derived ${trapOut.derived})`);
check(!/checkbox/i.test(trapOut.reason) && /classif/i.test(trapOut.reason),
  'and the reason points at the status text, not at checkboxes');

// --- warnings, not silent surprises -------------------------------------------------------
r = rewriteRoadmapStatus(LF, 'phase-2', 'todo');
check((r.warnings || []).some((w) => /decoration/i.test(w)), 'a ✅ decoration left on the heading is warned about');
r = rewriteRoadmapStatus(LF, 'phase-1', 'doing');
check((r.warnings || []).length === 0, 'an undecorated heading produces no warning noise');

// --- idempotence: a same-column request must be INERT, not a reformat ---------------------
// Found live: asking for the column a phase is already in rewrote its status prose to the
// canonical word, destroying "✅ Complete (4/4 plans)" while moving nothing. Status text carries
// information the canonical word does not, so an unchanged column must change nothing at all.
r = rewriteRoadmapStatus(LF, 'phase-1', 'todo');
check(r.ok && r.changed === false, 'moving a phase to the column it is already in is a no-op');
check(r.text === LF, 'and the text is returned byte-identical');

const RICH = [
  '### Phase 7: Rich status',
  '**Status:** ✅ Complete (4/4 plans, shipped v0.10.0)',
  '- [x] 07-01-PLAN.md',
  '',
].join('\n');
r = rewriteRoadmapStatus(RICH, 'phase-7', 'done'); // already done
check(r.ok && r.changed === false, 'a phase already in the target column is untouched');
check(r.text === RICH, 'its hand-written status prose survives byte-for-byte');
// The same phase moved to a DIFFERENT column may legitimately be rewritten.
r = rewriteRoadmapStatus(RICH, 'phase-7', 'todo');
check(r.ok && r.changed && /\*\*Status:\*\* Planned/.test(r.text), 'a genuine column change still rewrites');

// --- a status annotation is the human's text, so a MOVE must not eat it -------------------
// "(4/4 plans)" lives inside the status text rather than after a dash, so remark-preservation
// alone lost it: "✅ Complete (4/4 plans) — see 04-SUMMARY" became "Planned — see 04-SUMMARY".
const ANNOT = [
  '### Phase 8: Annotated',
  '**Status:** ✅ Complete (4/4 plans) — see 08-SUMMARY.md',
  '- [x] 08-01-PLAN.md',
  '',
].join('\n');
r = rewriteRoadmapStatus(ANNOT, 'phase-8', 'todo');
check(r.ok, 'an annotated status can be moved');
check(/\*\*Status:\*\* Planned \(4\/4 plans\) — see 08-SUMMARY\.md/.test(r.text),
  `the annotation AND the remark both survive (got: ${(r.text.match(/^\*\*Status:.*$/m) || [])[0]})`);
check(columnOf(r.text, 'phase-8') === 'todo', 'and the move still holds through the parser');
check((r.warnings || []).some((w) => /may no longer be true/i.test(w)),
  'a carried completion tally is warned about rather than silently trusted');

// Carrying it must never cost the move: an annotation that would re-classify the phase is
// dropped (with a warning), not allowed to turn a legitimate move into a refusal.
const TRAP_ANNOT = ['### Phase 10: Trap annotation', '**Status:** Planned (complete)', ''].join('\n');
r = rewriteRoadmapStatus(TRAP_ANNOT, 'phase-10', 'doing');
check(r.ok, 'an annotation that would flip the classification does not block the move');
check(!/\(complete\)/.test(r.text), 'the offending annotation is dropped from the written line');
check(columnOf(r.text, 'phase-10') === 'doing', 'and the requested column is what the board derives');
check((r.warnings || []).some((w) => /was dropped/i.test(w)), 'and the drop is reported, not silent');

// No annotation => no annotation warnings.
r = rewriteRoadmapStatus(LF, 'phase-1', 'doing');
check(!(r.warnings || []).some((w) => /annotation/i.test(w)), 'an unannotated status produces no annotation noise');
// A move TO done keeps a tally without the staleness warning — it is still true there.
const DONE_ANNOT = ['### Phase 11: Tally', '**Status:** In progress (3/3 plans)', ''].join('\n');
r = rewriteRoadmapStatus(DONE_ANNOT, 'phase-11', 'done');
check(r.ok && /\*\*Status:\*\* Complete \(3\/3 plans\)/.test(r.text), 'a tally survives a move to done');
check(!(r.warnings || []).some((w) => /no longer be true/i.test(w)), 'and is not warned about when moving to done');

check(rewriteRoadmapStatus(LF, 'phase-99', 'done').ok === false, 'an unknown phase is refused');
check(rewriteRoadmapStatus(LF, 'phase-1', 'archived').ok === false, 'an unknown column is refused');

// --- a status that is ENTIRELY a remark ---------------------------------------------------
// STATUS's own `\s*` eats the leading space, so a remark at position 0 had no whitespace left
// for the separator pattern to find — and the whole note was replaced by the canonical word
// with no warning. This is the exact shape the module header promises to preserve.
for (const [prose, sep] of [['— see 04-SUMMARY', 'em dash'], ['- see A', 'hyphen'], ['– notes here', 'en dash']]) {
  const md = `### Phase 16: All remark\n**Status:** ${prose}\n`;
  const out = rewriteRoadmapStatus(md, 'phase-16', 'doing');
  check(out.ok, `a status that is only a remark (${sep}) still moves`);
  check(out.text.includes(prose), `and the remark survives verbatim (${sep}): ${JSON.stringify((out.text.match(/^\*\*Status:.*$/m) || [])[0])}`);
  check(/\*\*Status:\*\* In progress /.test(out.text), `with the canonical word in front of it (${sep})`);
}

// --- every trailing parenthetical, not just the last one ----------------------------------
// /\([^()]*\)$/ took only the final group and could not see a nested one at all, so the rest
// was deleted in silence.
const annotCases = [
  ['Complete (a) (b)', 'todo', '(a) (b)', 'multiple groups all survive'],
  ['Complete ((a) b)', 'todo', '((a) b)', 'a nested group survives whole'],
  ['Complete (4/4 plans)', 'todo', '(4/4 plans)', 'a single group still works'],
];
for (const [status, col, want, label] of annotCases) {
  const out = rewriteRoadmapStatus(`### Phase 17: Annot\n**Status:** ${status}\n`, 'phase-17', col);
  const line = (out.text.match(/^\*\*Status:.*$/m) || [])[0];
  check(out.ok && line.includes(want), `${label} (got ${JSON.stringify(line)})`);
}
// An UNBALANCED paren cannot be claimed as an annotation, so it must at least be reported.
{
  const out = rewriteRoadmapStatus('### Phase 18: Unclosed\n**Status:** Complete (4/4 plans\n', 'phase-18', 'todo');
  check(out.ok, 'an unclosed parenthesis does not break the move');
  check((out.warnings || []).some((w) => w.includes('(4/4 plans')), `and the text it cost you is quoted back (${JSON.stringify(out.warnings)})`);
}

// --- an annotation that contradicts the new column ----------------------------------------
{
  const out = rewriteRoadmapStatus('### Phase 19: Contradiction\n**Status:** Planned (in progress)\n', 'phase-19', 'done');
  check(out.ok && /\*\*Status:\*\* Complete \(in progress\)/.test(out.text), 'the annotation is carried, as it is the human\'s text');
  check((out.warnings || []).some((w) => /two different things/.test(w)),
    `but the contradiction is pointed out (${JSON.stringify(out.warnings)})`);
}
// …and an annotation with no status keyword must NOT trip that warning.
{
  const out = rewriteRoadmapStatus('### Phase 20: Tally\n**Status:** In progress (3/3 plans)\n', 'phase-20', 'done');
  check(!(out.warnings || []).some((w) => /two different things/.test(w)), 'a plain tally is not a contradiction');
}

// --- a destroyed phrase is ALWAYS reported; a status word never is ------------------------
// This was got wrong twice by counting words: at >3 it warned on ordinary statuses, and raising
// it to >6 to quieten that turned four-to-six-word deletions SILENT — the text was destroyed
// either way and only the notice went away. The test is now the real question: is the thing
// being replaced a status word, or the author's own sentence?
// NB: each of these must be moved to a column it is not already in, or the same-column no-op
// (which correctly preserves the text byte-for-byte) fires instead and nothing is replaced.
for (const phrase of ['Ready for code review', 'Blocked by phase 2', 'Awaiting owner sign off',
  'Waiting on upstream fix', 'Done pending final review', 'Complete ‒ see notes',
  'Blocked -- waiting on counsel', 'Planned, pending owner sign-off']) {
  const out = rewriteRoadmapStatus(`### Phase 21: Prose\n**Status:** ${phrase}\n`, 'phase-21', 'doing');
  const warned = (out.warnings || []).find((w) => /was replaced by/.test(w));
  check(!!warned, `"${phrase}" is the author's wording, so its replacement is reported`);
  if (warned) check(warned.includes(phrase.replace(/\s+/g, ' ')), `and the warning quotes it back: ${phrase}`);
}
for (const status of ['Planned', 'In progress', 'Complete', 'Blocked', 'Ready', 'Queued',
  'Not started', 'On hold', 'Shipped', 'WIP', 'TBD']) {
  const out = rewriteRoadmapStatus(`### Phase 21b: Status\n**Status:** ${status}\n`, 'phase-21b', 'done');
  check(!(out.warnings || []).some((w) => /was replaced by/.test(w)), `"${status}" is a status word — no warning noise`);
}

// --- a dash INSIDE an annotation is not a remark separator --------------------------------
// Matching the remark pattern against the whole value split "Complete (a - b)" in half, writing
// "Planned - b)" to disk: the opening bracket deleted and an orphan ")" left in a planning doc.
for (const [status, want] of [['Complete (a - b)', '(a - b)'], ['Complete (a — b)', '(a — b)'],
  ['Complete (4/4 - counted twice)', '(4/4 - counted twice)']]) {
  const out = rewriteRoadmapStatus(`### Phase 21c: Dashy\n**Status:** ${status}\n`, 'phase-21c', 'todo');
  const line = (out.text.match(/^\*\*Status:.*$/m) || [])[0];
  check(out.ok && line.includes(want), `a dash inside parentheses stays inside them (got ${JSON.stringify(line)})`);
  check(!/\)\s*$/.test(line) || line.includes('('), 'and no orphan bracket is written');
}

// --- an inserted Status line must not glue itself to the heading --------------------------
// When the heading is the last line of a file with no trailing newline its terminator is '',
// and inserting after it produced "### Phase 1: A**Status:** Complete".
{
  const noNl = '# R\n### Phase 22: Last line';
  const out = rewriteRoadmapStatus(noNl, 'phase-22', 'done');
  check(out.ok, 'a heading with no trailing newline can still be given a status');
  check(/### Phase 22: Last line\n\*\*Status:\*\* Complete/.test(out.text),
    `the status lands on its own line (got ${JSON.stringify(out.text)})`);
  check(!out.text.endsWith('\n'), 'and the file still ends without a newline, as it did before');
  check(columnOf(out.text, 'phase-22') === 'done', 'and the board derives it');
}

// --- two headings with one id: refuse, never guess ----------------------------------------
// parseRoadmap emits a card per heading, so a duplicated "### Phase 1" renders two draggable
// cards. Editing the first match means dragging the second silently rewrites the first.
const DUPE = [
  '### Phase 1: First',
  '**Status:** Planned',
  '',
  '### Phase 1: Duplicate',
  '**Status:** Complete',
  '',
].join('\n');
check(parseRoadmap(DUPE).filter((c) => c.id === 'phase-1').length === 2, 'the parser really does emit two cards for a duplicated id');
r = rewriteRoadmapStatus(DUPE, 'phase-1', 'doing');
check(r.ok === false && r.ambiguous === true, 'a duplicated phase id is refused rather than written');
check(/2 headings/.test(r.reason) && /lines 1, 4/.test(r.reason), `the reason names the count and the lines (got: ${r.reason})`);
check(rewriteRoadmapStatus(DUPE, 'phase-1', 'done').ok === false, 'and it is refused for every column, including one that looks like a no-op');

// --- mixed line endings: change one line, not every line ----------------------------------
// dominantEol used to vote on the whole file and rewrite every terminator to the winner. Its
// LF counter could not see a \n preceded by a \n, so blank lines — ~40% of a markdown file —
// were invisible, and a drag on an LF-dominant file converted the lot to CRLF (or the reverse).
const MIXED = '# Roadmap\r\n\r\n### Phase 1: A\n**Status:** Planned\n\n- [ ] a\n\n- [ ] b\n\ntail\n';
const eolCount = (t) => ({ crlf: (t.match(/\r\n/g) || []).length, lf: (t.match(/(?<!\r)\n/g) || []).length });
r = rewriteRoadmapStatus(MIXED, 'phase-1', 'doing');
check(r.ok && r.changed, 'a mixed-ending roadmap can be moved');
const eBefore = eolCount(MIXED), eAfter = eolCount(r.text);
check(eBefore.crlf === eAfter.crlf && eBefore.lf === eAfter.lf,
  `every other line keeps its own ending (before ${JSON.stringify(eBefore)}, after ${JSON.stringify(eAfter)})`);
const mixBefore = MIXED.split(/\r\n|\n/), mixAfter = r.text.split(/\r\n|\n/);
check(mixBefore.filter((l, i) => l !== mixAfter[i]).length === 1, 'and exactly one line differs');
// The same guarantee for an inserted Status line.
const MIXED_NOSTATUS = '### Phase 2: B\r\n- [ ] a\n\n### Phase 3: C\n**Status:** Planned\n';
r = rewriteRoadmapStatus(MIXED_NOSTATUS, 'phase-2', 'doing');
check(r.ok && /\*\*Status:\*\* In progress\r\n/.test(r.text),
  'an inserted Status line borrows its heading\'s ending rather than the file\'s majority');
const insBefore = eolCount(MIXED_NOSTATUS), insAfter = eolCount(r.text);
check(insAfter.crlf === insBefore.crlf + 1 && insAfter.lf === insBefore.lf,
  `inserting adds exactly one CRLF and converts nothing (before ${JSON.stringify(insBefore)}, after ${JSON.stringify(insAfter)})`);

// --- a lone \r is a line ending, not text ---------------------------------------------------
// A dot in a JS regex will not cross a carriage return, so a status line carrying one did not
// match STATUS at all — writeback concluded the phase had no status yet and took the INSERT
// branch, putting a second `**Status:**` line above the real one. What the user then saw
// depended on what the parser made of two status lines: either both were written (two
// contradicting statuses in their planning document) or the move was refused quoting a status
// text nobody could see on screen. A \r-delimited file failed even earlier — one "line", so no
// phase headings at all, and every card in the file became undraggable.
// Tolerates a refusal (text undefined) so a regression here reports every assertion rather than
// crashing the suite on the first one.
const statusLines = (t) => ((t || '').match(/\*\*Status:\*\*/g) || []).length;
const CR_ONLY = '# Roadmap\r\r### Phase 1: A\r**Status:** Planned\r- [ ] a\r';
r = rewriteRoadmapStatus(CR_ONLY, 'phase-1', 'done');
check(r.ok && r.changed, 'a \\r-delimited roadmap can be moved');
check(statusLines(r.text) === 1, `and gains no second status line (${statusLines(r.text)} present)`);
check(/\*\*Status:\*\* Complete\r/.test(r.text || ''), 'the existing line is the one that was rewritten');
check(!(r.text || '\n').includes('\n'), 'and the file keeps its own line endings rather than being converted');
check(columnOf(r.text, 'phase-1') === 'done', 'the board re-derives the move from a \\r-delimited file');
// The likelier version: one stray \r inside an otherwise normal CRLF file.
const CR_STRAY = '### Phase 1: A\r\n**Status:** Planned\rleftover note\r\n- [ ] a\r\n';
r = rewriteRoadmapStatus(CR_STRAY, 'phase-1', 'done');
check(r.ok && statusLines(r.text) === 1, `a stray \\r does not duplicate the status line (${statusLines(r.text)})`);
check((r.text || '').includes('leftover note'), 'and the text after it is left alone');

// --- the separator scan must stay linear ----------------------------------------------------
// findRemark used to slice the tail of the value at every index and re-scan a whitespace run
// once per character in it. A status line padded out by an editor is enough to make a drag take
// seconds — the same shape of denial-of-service the session-marker cache exists to prevent,
// except this one is reachable from a file in the repo.
const PADDED = `### Phase 20: Padded\n**Status:** Planned${' '.repeat(50000)}— see SUMMARY\n`;
const tPad = process.hrtime.bigint();
r = rewriteRoadmapStatus(PADDED, 'phase-20', 'done');
const padMs = Number(process.hrtime.bigint() - tPad) / 1e6;
check(r.ok, 'a status line padded with 50k spaces still moves');
check((r.text || '').includes('— see SUMMARY'), 'and the remark on the far side of the padding survives');
check(padMs < 500, `without a quadratic scan (${padMs.toFixed(0)}ms)`);

// --- status prose that is not dash-delimited is reported, never silently eaten -------------
// "Blocked -- waiting on counsel" and "Planned, pending owner sign-off" carry a human's note
// with no em dash for the remark rule to find. The canonical word replaces them; the least we
// owe the author is to say which words went.
for (const [prose, why] of [
  ['Blocked -- waiting on counsel sign-off', 'a `--` separator'],
  ['Planned, pending owner sign-off and budget', 'a comma'],
  ['Waiting until the vendor confirms the date', 'a long phrase'],
]) {
  const md = `### Phase 12: Prose\n**Status:** ${prose}\n`;
  const out = rewriteRoadmapStatus(md, 'phase-12', 'done');
  check(out.ok, `prose status (${why}) still moves`);
  check((out.warnings || []).some((w) => w.includes(prose)),
    `and the dropped text is quoted back verbatim (${why})`);
}
// A plain status word is not prose and must not warn. ("Not started yet" used to be listed here
// and is NOT one — the trailing "yet" is the author's, and replacing it is a deletion. It now
// warns, which is covered below.)
for (const plain of ['Planned', 'In progress', 'Not started']) {
  const out = rewriteRoadmapStatus(`### Phase 13: Plain\n**Status:** ${plain}\n`, 'phase-13', 'done');
  check(!(out.warnings || []).some((w) => /was replaced by/.test(w)), `"${plain}" is a status, not prose — no warning`);
}

// --- a remark is preserved byte-for-byte, separator included ------------------------------
// The old code split on the separator and re-joined with ' — ', silently converting a hyphen
// remark to an em dash and flattening multi-part remarks into one style.
const HYPHEN = '### Phase 14: Hyphen\n**Status:** Complete - see SUMMARY - and NOTES\n';
r = rewriteRoadmapStatus(HYPHEN, 'phase-14', 'todo');
check(r.ok, 'a hyphen-separated remark moves');
check(r.text.includes('- see SUMMARY - and NOTES'),
  `the author's separators survive untouched (got: ${(r.text.match(/^\*\*Status:.*$/m) || [])[0]})`);
check(!/— see SUMMARY/.test(r.text), 'and are not upgraded to em dashes');

// --- the dropped-annotation warning names the blocking column, not the target -------------
r = rewriteRoadmapStatus('### Phase 15: Blocked annot\n**Status:** Planned (merged upstream)\n', 'phase-15', 'doing');
check(r.ok && (r.warnings || []).some((w) => /was dropped/.test(w)), 'the blocking annotation is dropped and reported');
check(!(r.warnings || []).some((w) => /classifying this phase as "doing"/.test(w)),
  `the warning must not name the column we moved to (got: ${(r.warnings || []).find((w) => /was dropped/.test(w))})`);
check((r.warnings || []).some((w) => /classifying this phase as "done"/.test(w)),
  'it names the column the annotation would have forced');

// --- the IO layer -------------------------------------------------------------------------
const PROJ = join(ROOT, 'proj');
mkdirSync(join(PROJ, '.planning'), { recursive: true });
const ROADMAP = join(PROJ, '.planning', 'ROADMAP.md');
writeFileSync(ROADMAP, CRLF);

let io = setPhaseStatus(PROJ, 'phase-1', 'done', { stamp: 'T1' });
check(io.ok && io.changed, 'setPhaseStatus writes');
check(readFileSync(ROADMAP, 'utf8').includes('**Status:** Complete'), 'the file on disk changed');
check(readFileSync(ROADMAP, 'utf8').includes('\r\n'), 'and kept its CRLF endings');
check(!existsSync(ROADMAP + '.tmp'), 'no .tmp file is left behind');

// Backups go to .flow/ (gitignored), NOT next to the tracked planning doc.
const backups = join(PROJ, '.flow', 'roadmap-backups');
check(existsSync(join(backups, 'ROADMAP.T1.md')), 'a backup is written under .flow/roadmap-backups');
check(readFileSync(join(backups, 'ROADMAP.T1.md'), 'utf8') === CRLF, 'the backup holds the pre-edit content byte for byte');
check(!existsSync(join(PROJ, '.planning', 'ROADMAP.md.bak')), 'nothing is dropped beside the tracked roadmap');

io = setPhaseStatus(PROJ, 'phase-1', 'done', { stamp: 'T2' });
check(io.ok && io.changed === false, 'a repeat write is reported as unchanged');

// A hostile repo can ship `.flow` itself as a symlink/junction — mkdirSync(recursive) traverses
// one happily, and the backup file genuinely does not exist on the far side, so 'wx' does not
// help. The backup must land inside the project or not at all. (Symlink creation needs Developer
// Mode on Windows, so skip rather than fail when it is unavailable — the containment check is
// what is under test, not the OS's permission model.)
{
  const linkProj = join(ROOT, 'linkproj');
  const elsewhere = join(ROOT, 'elsewhere');
  mkdirSync(join(linkProj, '.planning'), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(linkProj, '.planning', 'ROADMAP.md'), LF);
  let linked = false;
  try { symlinkSync(elsewhere, join(linkProj, '.flow'), 'junction'); linked = true; } catch { /* no privilege */ }
  if (linked) {
    const out = setPhaseStatus(linkProj, 'phase-1', 'done', { stamp: 'ESCAPE' });
    check(out.ok, 'a move still succeeds when .flow escapes the project');
    check(out.backupDir === null, 'but no backup is written through the link');
    check(readdirSync(elsewhere).length === 0, `and nothing lands outside the project (found ${readdirSync(elsewhere).join(', ') || 'nothing'})`);
  } else {
    console.log('  SKIP  .flow symlink containment (no symlink privilege on this machine)');
  }
}

// A backup name is a predictable wall-clock stamp, so it is plantable: opened 'wx', it must
// refuse rather than write through whatever is already sitting at that path.
writeFileSync(join(backups, 'ROADMAP.PLANTED.md'), 'someone else was here');
io = setPhaseStatus(PROJ, 'phase-1', 'todo', { stamp: 'PLANTED' });
check(io.ok, 'a move whose backup name is already taken still succeeds');
check(readFileSync(join(backups, 'ROADMAP.PLANTED.md'), 'utf8') === 'someone else was here',
  'and does NOT write through the pre-existing file');

io = setPhaseStatus(PROJ, 'phase-4b', 'done', { stamp: 'T3' });
check(io.ok === false && io.wouldNotHold, 'the IO layer refuses a move that would not hold');
check(!existsSync(join(backups, 'ROADMAP.T3.md')), 'a refused move writes no backup (nothing was touched)');

// Backup retention stays bounded.
for (let i = 0; i < 14; i++) {
  setPhaseStatus(PROJ, 'phase-1', i % 2 ? 'done' : 'todo', { stamp: 'R' + String(i).padStart(2, '0') });
}
const kept = readdirSync(backups).filter((f) => f.endsWith('.md'));
check(kept.length <= 10, `backups are capped at 10 (got ${kept.length})`);

check(setPhaseStatus(join(ROOT, 'nope'), 'phase-1', 'done').ok === false, 'a project with no ROADMAP.md is refused');
check(/no \.planning/.test(setPhaseStatus(join(ROOT, 'nope'), 'phase-1', 'done').reason), 'and says why');

console.log(fail ? `\nwriteback: ${fail} FAILED` : '\nwriteback: all passed');
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
