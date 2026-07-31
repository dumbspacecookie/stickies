// Board writeback: dragging a card between columns edits the project's real
// .planning/ROADMAP.md.
//
// This is the only code in Stickies that writes to a GSD planning document, so it is
// deliberately the most conservative thing here. Three rules:
//
//  1. Change ONE line. The `**Status:**` line of the target phase, and nothing else — not the
//     heading, not the checkboxes, not another phase, not the whitespace. Plan checkboxes in
//     particular mean "a plan was authored", which is not the board's business to assert.
//  2. Preserve the file's shape. Original line endings (these roadmaps are CRLF on Windows) and
//     any trailing remark on the status line (`— see 04-SUMMARY`) survive.
//  3. Never claim a move that won't hold. The board classifies a phase by status keyword AND
//     checkbox ratio, and a partially-checked phase is 'doing' no matter what the text says. So
//     after rewriting we re-derive through the real parser and report when the result differs
//     from what was asked. Silently writing a status the board then ignores is the one outcome
//     worse than refusing.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync, existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';
import { parseRoadmap, classify, COLUMNS } from './derive-gsd.mjs';
import { fencedLineFlags } from './fences.mjs';

// The word written for each column. Chosen so it round-trips through classify(): 'Planned'
// matches neither the DONE nor DOING keyword set, 'In progress' matches DOING, 'Complete'
// matches DONE. Changing these without re-checking derive-gsd.mjs will break the round trip.
export const STATUS_WORD = { todo: 'Planned', doing: 'In progress', done: 'Complete' };

const HEADING = /^###\s+(Phase\s+[\w.]+)\s*[:—-]?\s*(.*)$/i;
// `[\s\S]*`, not `.*`: a JS dot refuses to cross any line terminator (CR, LS, PS), so a status
// line carrying one read as "no status line here" — which makes writeback add a SECOND one. The
// line has already been cut at its real terminator, so there is nothing left to over-consume.
const STATUS = /^\*\*Status:\*\*\s*([\s\S]*)$/;
const CHECKBOX = /^\s*[-*]\s*\[([ xX])\]/;
// A "— ✅ EXECUTED" style decoration on the heading itself. The board ignores it (the emoji is
// explicitly not the signal), but a human reading the file would be misled if it went stale.
const HEADING_DECORATION = /[—–-]\s*[✅⏳🚧🔲◻️]/u;
// A completion tally inside a carried annotation ("4/4 plans"), which a move away from done
// may have just falsified. Warned about rather than edited — the number is the human's claim.
const TALLY = /\d+\s*\/\s*\d+/;

// derive-gsd builds card ids this way; matching it exactly is what lets the UI send back an id.
function idOf(phaseLabel) {
  return phaseLabel.replace(/\s+/g, '-').toLowerCase();
}

// Split into lines while REMEMBERING each line's own terminator, so a rewrite can put the file
// back exactly as it was apart from the one line it changes. A split-then-join-with-one-eol
// round trip cannot do that: it silently converts every ending in the file to whichever style
// won a vote, which on a mixed-ending roadmap is a whole-file diff on a human's planning doc —
// exactly what rule 1 ("change ONE line ... not the whitespace") forbids.
// A LONE `\r` counts as a terminator too. It is a line ending in its own right (classic Mac, and
// anything that has been through a careless string edit), and treating it as ordinary text left
// it sitting INSIDE the line — where `**Status:** Planned\rnote` no longer matches STATUS,
// because `.` does not cross a carriage return. The status line then looked absent, so writeback
// took the "this phase has no status yet" branch and INSERTED a second `**Status:**` line above
// the one already there. Two contradicting status lines in a planning document, from a stray
// byte. Splitting on it also keeps the round trip honest: each line still carries its own
// terminator, so a \r-delimited file comes back \r-delimited.
function splitLines(text) {
  const lines = [];
  const eols = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    lines.push(text.slice(last, m.index));
    eols.push(m[0]);
    last = re.lastIndex;
  }
  lines.push(text.slice(last)); // trailing fragment (empty when the file ends in a newline)
  eols.push('');
  return { lines, eols };
}

function joinLines(lines, eols) {
  let out = '';
  for (let i = 0; i < lines.length; i++) out += lines[i] + (eols[i] || '');
  return out;
}

// Status prose we are about to replace with the canonical word, which looks like a human's note
// rather than a status: a `--`/`;`/`,`/`:` separator, an unbalanced parenthesis (an annotation
// the bracket-matcher could not claim), or simply too long to be a status. Used to WARN, never
// to guess where the text should go — writeback's job is to move a card, and inventing a new
// home for someone's sentence is not that.
//
// The word threshold is deliberately loose. At >3 it fired on ordinary statuses — "Ready for
// code review", "Blocked by phase 2", "Awaiting owner sign off" — and a warning that cries wolf
// on a normal roadmap is one nobody reads when it matters.
// The status words a roadmap actually uses. Anything else in the status position is the human's
// own wording, and replacing it is a deletion they should hear about.
const STATUS_VOCAB = new Set([
  'planned', 'complete', 'completed', 'done', 'shipped', 'live', 'merged', 'executed',
  'in progress', 'in-progress', 'wip', 'underway', 'building', 'next', 'up next', 'unblocked',
  'executing', 'blocked', 'scoping', 'ratified', 'stub', 'skeleton', 'not started', 'todo',
  'to-do', 'to do', 'pending', 'ready', 'queued', 'paused', 'on hold', 'draft', 'backlog',
  'in review', 'review', 'deferred', 'cancelled', 'canceled', 'archived', 'n/a', 'tbd', '',
]);

function looksLikeProse(text) {
  // A word-count threshold was the wrong test twice over. At >3 it warned on ordinary statuses;
  // raised to >6 to quieten that, it turned four-to-six-word deletions SILENT — which is worse,
  // because the text is destroyed either way and only the notice went away. The honest question
  // is not "how long is it" but "is this a status word, or the author's own sentence".
  const t = String(text).trim().replace(/\s+/g, ' ').toLowerCase();
  return !STATUS_VOCAB.has(t);
}

// The first remark separator that is NOT inside parentheses. Matching the bare regex against the
// whole value meant a dash inside an annotation split it: "Complete (a - b)" became
// "Planned - b)" on disk — the opening bracket deleted and an orphan ")" written into a planning
// document, which is the worst thing this module can do.
// At position 0 a bare leading dash IS the separator (a status that is only a remark). Anywhere
// else it must be the whitespace-delimited form — otherwise the second dash of "Blocked --
// waiting" looks like the start of a remark, which cut the status at "Blocked -" and quoted that
// back as though the author had written it.
const LEADING_REMARK = /^[—–-]\s+/;
const INLINE_REMARK = /\s+[—–]\s+|\s+-\s+/y; // sticky: matched AT an index, without slicing
const WS = /\s/;

function findRemark(value) {
  const s = String(value);
  if (LEADING_REMARK.test(s)) return { index: 0 };
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;
    if (i === 0) continue; // position 0 is LEADING_REMARK's business, but its depth still counts
    // Two things keep this linear, where `s.slice(i).match(...)` was quadratic — it allocated a
    // fresh copy of the tail at every index, and re-scanned a run of whitespace once per
    // character in it. A pathological status ("**Status:** Planned" followed by a few thousand
    // spaces, which is just a file someone's editor mangled) took the drag from instant to
    // seconds. First: a separator must begin with whitespace, so a non-space index cannot start
    // one. Second: only the START of a whitespace run needs testing — `\s+` is greedy in both
    // cases, so if the run's first character does not begin a separator, no later character in
    // the same run does either, and the earliest index is what we are looking for anyway.
    if (!WS.test(c) || WS.test(s[i - 1])) continue;
    INLINE_REMARK.lastIndex = i;
    if (INLINE_REMARK.test(s)) return { index: i };
  }
  return null;
}

// Everything from the start of the trailing run of balanced parentheses to the end of the
// string: "Complete (a) (b)" → "(a) (b)", "Complete ((a) b)" → "((a) b)". A single
// /\([^()]*\)$/ took only the LAST group and could not see a nested one at all, so the rest was
// deleted in silence. Returns { head, annotation } with the annotation exactly as written.
function splitAnnotation(text) {
  const s = String(text);
  let end = s.length;
  let start = s.length;
  for (;;) {
    let i = end;
    while (i > 0 && /\s/.test(s[i - 1])) i--;          // skip space before a group
    if (i === 0 || s[i - 1] !== ')') break;             // no (more) groups
    let depth = 0;
    let j = i - 1;
    for (; j >= 0; j--) {
      if (s[j] === ')') depth++;
      else if (s[j] === '(') { depth--; if (depth === 0) break; }
    }
    if (j < 0 || depth !== 0) break;                    // unbalanced — leave it for looksLikeProse
    start = j;
    end = j;
  }
  if (start >= s.length) return { head: s, annotation: '' };
  return { head: s.slice(0, start).trimEnd(), annotation: s.slice(start).trim() };
}

// Pure text transform, exported separately so the parsing rules can be tested without touching
// a filesystem. Returns { ok, text, changed, warnings, [reason] }.
export function rewriteRoadmapStatus(md, phaseId, column) {
  if (!COLUMNS.includes(column)) return { ok: false, reason: `unknown column: ${column}` };
  const word = STATUS_WORD[column];
  const { lines, eols } = splitLines(md);

  // Locate the phase and the extent of its section.
  const wanted = String(phaseId).toLowerCase();
  // Same fence rule as the board builder, from the same helper. When these two disagreed, a
  // fenced example heading was a card on the board but not a heading here (or the reverse), and
  // the write landed on a different phase's section — silently, reporting success.
  const fenced = fencedLineFlags(lines);
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].match(HEADING);
    if (m && idOf(m[1]) === wanted) heads.push(i);
  }
  if (heads.length === 0) return { ok: false, reason: `phase not found in ROADMAP.md: ${phaseId}` };
  // Two headings can share an id ("### Phase 1: Foo" twice). parseRoadmap emits a card for each,
  // so the board shows two draggable cards — and editing "the first match" means dragging the
  // second one silently rewrites the first one's status. There is no way to tell from the id
  // which card the user grabbed, so refuse: a wrong-target write to a planning document is
  // worse than a move that didn't happen.
  if (heads.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      reason: `ROADMAP.md has ${heads.length} headings for "${phaseId}" (lines ${heads.map((i) => i + 1).join(', ')}). ` +
        'Give them distinct phase numbers — writeback will not guess which one you meant.',
    };
  }
  const head = heads[0];

  // If the phase is ALREADY in the requested column, do nothing at all — do not "normalize" the
  // wording. A human's status prose ("✅ Complete (4/4 plans)") carries information the canonical
  // word does not, and rewriting it to "Complete" would destroy that while moving no card. The
  // board's job is to move phases between columns, not to reformat status text.
  const current = parseRoadmap(md).find((c) => c.id === String(phaseId).toLowerCase());
  if (current && current.column === column) {
    return { ok: true, text: md, changed: false, warnings: [], derived: column };
  }

  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    // Any heading at the same or a higher level ends this phase's section — unless it is inside
    // a code fence, where it is example text. A fenced heading used to cut the section short, so
    // the real `**Status:**` line fell outside the measured range, the writer took the INSERT
    // branch, and the phase ended up with two contradicting status lines.
    if (fenced[i]) continue;
    if (/^#{1,3}\s/.test(lines[i])) { end = i; break; }
  }

  const warnings = [];
  let statusLine = -1;
  let checked = 0, boxes = 0;
  for (let i = head + 1; i < end; i++) {
    if (statusLine === -1 && STATUS.test(lines[i])) statusLine = i;
    const b = lines[i].match(CHECKBOX);
    if (b) { boxes++; if (b[1].toLowerCase() === 'x') checked++; }
  }

  // Keep a trailing remark ("— see 04-SUMMARY") so writeback never eats a human's note, and
  // likewise a parenthetical annotation hung off the status word itself ("(4/4 plans)"). Both
  // are the human's text; the canonical word replaces the STATUS, not their notes about it.
  let remark = '';
  let annotation = '';
  let droppedProse = '';
  if (statusLine !== -1) {
    const value = lines[statusLine].match(STATUS)[1];
    const cut = findRemark(value);
    // Keep the remark EXACTLY as written, separator and all, instead of re-joining the parts
    // with an em dash — a split/rejoin turns the author's " - " into " — " and collapses a
    // multi-part remark into one style. Everything from the first separator onward is theirs.
    // A remark at position 0 has no leading space of its own, so give it one.
    if (cut) {
      remark = value.slice(cut.index);
      if (!/^\s/.test(remark)) remark = ' ' + remark;
    }
    const headText = (cut ? value.slice(0, cut.index) : value).trim();
    const split = splitAnnotation(headText);
    if (split.annotation) annotation = ' ' + split.annotation;
    // What is left once the emoji, the annotation and the remark are accounted for is the
    // status wording itself — which the canonical word replaces. If it reads like a sentence
    // rather than a status, say so: it is about to disappear from the file.
    const residue = split.head.replace(/[✅⏳🚧🔲◻️]/gu, '').trim();
    if (looksLikeProse(residue)) droppedProse = residue;
  }

  // The file's prevailing terminator, for the one case that needs to invent one. A file whose
  // only endings are bare \r gets a \r, rather than being handed the one ending it does not use.
  const fallbackEol = eols.some((e) => e === '\r\n') ? '\r\n'
    : eols.some((e) => e === '\n') ? '\n'
      : eols.some((e) => e === '\r') ? '\r' : '\n';

  const build = (ann) => {
    const copy = lines.slice();
    const copyEols = eols.slice();
    const next = `**Status:** ${word}${ann}${remark}`;
    const changed = statusLine === -1 || copy[statusLine] !== next;
    if (statusLine !== -1) {
      copy[statusLine] = next; // its own terminator is left untouched
    } else {
      // No Status line yet: give the phase one, borrowing the heading's line ending so the
      // inserted line matches its neighbours in a mixed-ending file. When the heading is the
      // LAST line of a file with no trailing newline its terminator is '' — inserting after it
      // then glued the status onto the heading text. The heading gets a real terminator and the
      // new line inherits the empty one, so the file still ends without a newline.
      const headEol = eols[head] || fallbackEol;
      copy.splice(head + 1, 0, next);
      copyEols.splice(head + 1, 0, eols[head]);
      copyEols[head] = headEol;
    }
    return { text: joinLines(copy, copyEols), changed };
  };

  // Rule 3: verify through the real parser rather than trusting our own word choice. A carried
  // annotation can itself flip the classification (an annotation reading "(complete)" would drag
  // the phase back to done), so try WITH it, then fall back to dropping it — a move the human
  // asked for should not fail over their parenthetical, but they must be told it was dropped.
  let chosen = null;
  let lastCard = null;      // the verdict of the most recent attempt — drives the refusal text
  let blockedCard = null;   // the verdict of the attempt the annotation broke, if any
  let droppedAnnotation = false;
  for (const ann of annotation ? [annotation, ''] : ['']) {
    const attempt = build(ann);
    const card = parseRoadmap(attempt.text).find((c) => c.id === String(phaseId).toLowerCase());
    if (!card) {
      return { ok: false, reason: 'the rewritten roadmap no longer parses this phase — refusing to write' };
    }
    lastCard = card;
    if (card.column === column) {
      chosen = { ...attempt, card };
      droppedAnnotation = annotation !== '' && ann === '';
      break;
    }
    if (ann === annotation && annotation !== '') blockedCard = card;
  }

  if (!chosen) {
    const why = boxes > 0 && checked > 0 && checked < boxes
      ? `${checked} of ${boxes} plan checkboxes are ticked, and partial progress always classifies a phase as "doing" regardless of its status text`
      : `the status text now reads "${lastCard.statusText}", which the board classifies as "${lastCard.column}"`;
    return {
      ok: false,
      wouldNotHold: true,
      derived: lastCard.column,
      reason: `Cannot move this phase to "${column}": ${why}.`,
    };
  }

  if (HEADING_DECORATION.test(lines[head])) {
    warnings.push('The phase heading carries its own ✅/⏳ decoration, which was left untouched — it may now disagree with the status. The board ignores it; a reader will not.');
  }
  if (droppedProse) {
    warnings.push(`The status text "${droppedProse}" was replaced by "${word}" — writeback rewrites the status itself, and only a trailing "— remark" or a "(parenthetical)" is carried across. Put anything you want to keep after a dash.`);
  }
  if (droppedAnnotation) {
    // Report the column the ANNOTATION forced, not the one we ended up in — those are different
    // and naming the target here would read as "moving it to X would not have held" while X is
    // exactly where it went.
    warnings.push(`The status annotation "${annotation.trim()}" was dropped: carrying it would have left the board classifying this phase as "${blockedCard ? blockedCard.column : 'a different column'}", so the move you asked for would not have held.`);
  } else if (annotation && TALLY.test(annotation) && column !== 'done') {
    warnings.push(`The status annotation "${annotation.trim()}" was carried over as written — it is your text, not the board's — but it may no longer be true now that this phase is "${column}".`);
  } else if (annotation) {
    // An annotation can carry a status word of its own — "Planned (in progress)" moved to done
    // writes "Complete (in progress)", which holds (classify tests DONE before DOING) but now
    // says two different things. Only flag a real keyword: classify() returns 'todo' for text
    // with no keyword at all, and warning on that would fire for every "(4/4 plans)".
    const annColumn = classify(annotation.replace(/[()]/g, ' '), null);
    if (annColumn !== 'todo' && annColumn !== column) {
      warnings.push(`The status annotation "${annotation.trim()}" still reads as "${annColumn}", so the line now says two different things. It is your text, so it was left alone.`);
    }
  }

  return { ok: true, text: chosen.text, changed: chosen.changed, warnings, derived: chosen.card.column };
}

// Backups live in .flow/, which is derived and gitignored — so recovery is available without
// putting a .bak next to a tracked planning doc and dirtying every git status.
const KEEP_BACKUPS = 10;

function backupRoadmap(projectPath, original, stamp) {
  try {
    const dir = join(projectPath, '.flow', 'roadmap-backups');
    // `wx` on the file stops a symlink planted at the backup NAME. It does nothing about `.flow`
    // itself being a symlink or junction — mkdirSync(recursive) happily traverses one, and the
    // file genuinely does not exist on the far side. A hostile repo can ship `.flow` as a
    // junction (no admin rights needed on Windows) and have one card drag deposit a file of its
    // own choosing anywhere the user can write.
    //
    // Resolve BEFORE creating anything: checking after mkdirSync still leaves an empty
    // roadmap-backups/ directory on the far side of the link.
    const realProject = realpathSync(projectPath);
    const contained = (p) => p === realProject || p.startsWith(realProject + sep);
    const flowDir = join(projectPath, '.flow');
    if (existsSync(flowDir) && !contained(realpathSync(flowDir))) return null;
    mkdirSync(dir, { recursive: true });
    if (!contained(realpathSync(dir))) return null; // re-check: a nested link, or a race
    // 'wx' for the same reason the temp file uses it: the stamp is a wall-clock ISO string, so a
    // hostile repo can predict this name, plant a symlink at it, and have the backup written
    // through to somewhere else. Failing here is harmless — the caller treats a missing backup
    // as a soft failure and git remains the real safety net.
    writeFileSync(join(dir, `ROADMAP.${stamp}.md`), original, { flag: 'wx' });
    const old = readdirSync(dir).filter((f) => f.startsWith('ROADMAP.') && f.endsWith('.md')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
      try { rmSync(join(dir, f)); } catch { /* leave it */ }
    }
    // A crash between openSync and renameSync leaves ROADMAP.md.<hex>.tmp beside a tracked
    // planning doc, and the randomized name means nothing ever overwrites it — every crash
    // leaves another one dirtying `git status`. Sweep them while we are already here.
    try {
      const planning = join(projectPath, '.planning');
      for (const f of readdirSync(planning)) {
        if (/^ROADMAP\.md\.[0-9a-f]{12}\.tmp$/.test(f)) {
          try { rmSync(join(planning, f)); } catch { /* next time */ }
        }
      }
    } catch { /* no .planning to sweep */ }
    return dir;
  } catch {
    return null; // a failed backup must not block the edit; git is the real safety net
  }
}

// Apply a column change to <project>/.planning/ROADMAP.md.
// `stamp` is injected so callers control the backup filename (and tests stay deterministic).
export function setPhaseStatus(projectPath, phaseId, column, { stamp = null } = {}) {
  if (!projectPath) return { ok: false, reason: 'no project' };
  const roadmap = join(projectPath, '.planning', 'ROADMAP.md');
  if (!existsSync(roadmap)) {
    return { ok: false, reason: 'this project has no .planning/ROADMAP.md to write to' };
  }

  // Confine the target to the project.
  //
  // The backup directory below has been resolved and contained since it was written, and the temp
  // file is opened 'wx' so a planted `ROADMAP.md.<hex>.tmp` cannot be followed — but the file we
  // actually edit was never checked. A `.planning` directory (or the ROADMAP.md inside it) that is
  // a symlink or a Windows junction pointing elsewhere therefore made one card drag rewrite a
  // `**Status:**` line in a file outside the project. Reproduced on Windows with an unprivileged
  // junction: the victim file changed, while the backup landed inside the project — so the code
  // knew where the root was and simply never compared.
  //
  // A repository can ship that link, and writeback is reachable on any project in the dashboard's
  // allowlist. Opting into writeback is consent to edit THIS project's roadmap, not an arbitrary
  // file the current user happens to be able to write.
  //
  // Both sides are resolved so a legitimately symlinked project root still works, and containment
  // (not equality) so a `.planning` that links elsewhere INSIDE the project is still allowed.
  let realRoadmap;
  try {
    const realProject = realpathSync(projectPath);
    realRoadmap = realpathSync(roadmap);
    if (realRoadmap !== realProject && !realRoadmap.startsWith(realProject + sep)) {
      return {
        ok: false,
        reason: 'refusing to write: .planning/ROADMAP.md resolves outside this project',
        resolved: realRoadmap,
      };
    }
  } catch (err) {
    return { ok: false, reason: `cannot resolve ROADMAP.md: ${err?.message || err}` };
  }

  let original;
  try { original = readFileSync(roadmap, 'utf8'); }
  catch (err) { return { ok: false, reason: `cannot read ROADMAP.md: ${err?.message || err}` }; }

  const result = rewriteRoadmapStatus(original, phaseId, column);
  if (!result.ok) return result;
  if (!result.changed) {
    return { ok: true, changed: false, warnings: result.warnings, phase: phaseId, column };
  }

  const backupDir = backupRoadmap(projectPath, original, stamp || new Date().toISOString().replace(/[:.]/g, '-'));

  // Write to a sibling temp file and rename over the target: on both POSIX and Windows that
  // replacement is atomic, so an interrupted write can never leave a half-written roadmap.
  //
  // The temp name is random and opened 'wx' (O_CREAT|O_EXCL), which fails rather than follows
  // if anything already exists at that path. A fixed `.tmp` name opened with the default 'w'
  // would follow a symlink at the final component, so a hostile repo could ship
  // `.planning/ROADMAP.md.tmp` as a link to ~/.bashrc or a git hook and have one card drag
  // write through it. O_EXCL also keeps two writers off the same scratch path.
  const tmp = `${roadmap}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx');
    writeFileSync(fd, result.text);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, roadmap);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, reason: `cannot write ROADMAP.md: ${err?.message || err}` };
  }

  return { ok: true, changed: true, phase: phaseId, column, warnings: result.warnings, backupDir };
}
