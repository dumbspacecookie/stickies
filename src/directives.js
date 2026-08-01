// Parses inline sticky directives out of assistant message text.
//
// The model may capture a durable fact by writing a single line of the form:
//
//   !!sticky <category> [P1|P2|P3] [global] [#tag ...] :: <content>
//
// Examples:
//   !!sticky decision P1 #storage #arch :: Phase 1 storage is node:sqlite, no native deps
//   !!sticky todo :: wire the dashboard to the dismiss endpoint
//   !!sticky blocker P2 #ci :: integration tests blocked on staging creds
//   !!sticky todo P1 global :: cut the npm release  (applies across every project)
//
// category is required; importance defaults to P2; `global` and tags are optional and may
// appear in any order. Content is the rest of the line after `::`. The post-turn Stop hook
// reads these and persists them, so capture is guaranteed by code rather than relying on a
// tool round-trip.
//
// WHAT THIS PARSER'S INPUT ACTUALLY IS. It is model output, and model output is shaped by
// whatever the model just read — a file in a cloned repo, a web page, a tool result. So a
// hostile repository can put a `!!sticky ... global :: ...` line in its README and win if the
// model ever reproduces that line while explaining what it found. `global` makes that a
// cross-project write: the note lands unscoped and then shows up in the session-start context
// of a completely unrelated project. That was reproducible through the real hook, including
// when the quoted line sat inside a fenced code block.
//
// The rule this file now enforces is: a directive counts only when the model is SPEAKING, not
// when it is QUOTING. In practice quoting has a shape, and it is the shape we can check:
//
//   - inside a ``` or ~~~ fence — how a model shows you file contents;
//   - indented — a markdown indented code block, or a nested list/quote item;
//   - preceded by anything at all on the line (`> `, `- `, `` ` ``, "the file says ...").
//
// All three are refused by requiring the directive to begin at column 0 of a line that is not
// inside a fence. That is not a proof of provenance and it is not claimed to be one — a model
// that decides to restate a hostile line at column 0, unfenced, has effectively written the
// directive itself, which is the feature. It closes the mechanical reproduction, which is the
// part a parser can close. The rest is bounded downstream, in src/auto-capture.js, by the
// per-turn cap and by scope policy.

import { fencedLineFlags } from './flow/fences.mjs';

const CATEGORY = '(decision|blocker|preference|context|todo)';
// One modifier blob (importance / `global` / #tags / due:<when> in any order), parsed out
// below — an ordered grammar would silently ignore `global P1` while accepting `P1 global`.
// Importance may arrive bracketed (`[P2]`) because the model often copies the
// `[P1|P2|P3]` notation from the convention doc literally — tolerate it.
const MODIFIER = String.raw`(?:\[?P[123]\]?|global|due:[\w:-]+|#[\w./-]+)`;
// Anchored hard at column 0. It used to be `^\s*`, which accepted every indented and quoted
// form above; see the header. Anything the model wants captured it can write flush left.
const DIRECTIVE = new RegExp(
  String.raw`^!!sticky\s+${CATEGORY}` + //     category
    String.raw`((?:\s+${MODIFIER})*)` + //     optional modifiers, any order
    String.raw`\s*::\s*(.+?)\s*$`, //          :: content
  'i'
);

// A line that is directive-SHAPED but was not honoured. Used only to count and explain the
// refusals, so that "your note was dropped" is something the user is told rather than
// something they find out by the note not being there. Requires a real category word, so
// prose about the grammar itself (`!!sticky <category> ...`) is not counted.
const DIRECTIVE_SHAPED = new RegExp(String.raw`!!sticky\s+${CATEGORY}\b`, 'i');
const INDENTED_DIRECTIVE = new RegExp(String.raw`^\s+!!sticky\s+${CATEGORY}\b`, 'i');

// Fence detection is NOT implemented here. It is `fencedLineFlags`, imported above, and the
// import is the fix for a live bypass of this very file's security rule.
//
// This file used to carry its own: a regex matching any ``` or ~~~ line, toggling a boolean.
// The comment defending it said being too eager was "the safe direction". It was not eager, it
// was PARITY-COUNTING, and an odd number of fence-shaped lines inside a fence leaves the parser
// believing it is outside one. Both shapes that trigger it are the normal way a model quotes text
// that itself contains a fence:
//
//     ~~~                     <- outer fence opens   (toggle on)
//     ```                     <- inner, part of the quoted content (toggle OFF — wrong)
//     !!sticky todo P1 global :: honoured, though every reader sees it fenced
//
// Reproduced end to end: a hostile README quoted by the model wrote itself a P1 `global` note —
// cross-project, injected into the SessionStart context of every other project — and `ignored.fenced`
// stayed 0, so the refusal counter did not fire and the user was told nothing.
//
// Meanwhile src/flow/fences.mjs already did this correctly, for the board scanners, with the
// character and run-length tracking CommonMark actually requires. Two fence parsers in one
// codebase, one right and one exploitable, is the same duplication failure as the redactor that
// drifted nine credential shapes behind its original. So this one is deleted rather than repaired.

// Full scan: the directives to honour, plus a tally of the directive-shaped lines that were
// refused and why. `parseDirectives` below is the plain-array form kept for callers that only
// want the notes.
//
// Returns { directives, ignored: { fenced, indented, malformed } }.
export function scanDirectives(text) {
  const ignored = { fenced: 0, indented: 0, malformed: 0 };
  if (!text || typeof text !== 'string') return { directives: [], ignored };
  const out = [];
  // `/\r\n|\n|\r/`, matching src/flow/derive-gsd.mjs and src/flow/writeback.mjs — the other two
  // consumers of the shared fence scanner — and matching CommonMark, which treats a bare CR as a
  // line ending.
  //
  // While these disagreed, a bare CR did not end a line HERE but did everywhere else, so the
  // scanner was handed a "line" no other component would recognise. That was not cosmetic: a
  // hostile README using an old-style CR could glue a fence marker onto the previous line (so no
  // fence was ever detected) or glue its own text onto the fence-open line (so a backtick in that
  // text tripped the info-string guard and the fence refused to open). Either way the block that
  // every Markdown renderer shows as a code block was invisible here, and a `!!sticky … global ::`
  // line the model was only QUOTING got written as a note visible in every project on the machine —
  // reported to the user as "captured 1 sticky", never as a refusal. Verified against the reference
  // CommonMark parser, and in repo-mode the same note was git-committed into the user's own repo.
  //
  // U+2028/U+2029 are deliberately NOT added here. They are not CommonMark line endings, adding
  // them opened two new divergences on fence-CLOSE lines, and fences.mjs already absorbs them into
  // the info string. The rule is "agree with the other consumers and with CommonMark", not "split
  // on everything that looks blank".
  const lines = text.split(/\r\n|\n|\r/);
  // One pass over the whole document, by the shared scanner, before any line is judged. A fence
  // is a property of the document, not of the line — which is exactly what the toggle this
  // replaced got wrong.
  const fenced = fencedLineFlags(lines);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (fenced[i]) {
      if (DIRECTIVE_SHAPED.test(rawLine)) ignored.fenced++;
      continue;
    }

    const m = rawLine.match(DIRECTIVE);
    if (!m) {
      if (INDENTED_DIRECTIVE.test(rawLine)) ignored.indented++;
      else if (DIRECTIVE_SHAPED.test(rawLine)) ignored.malformed++;
      continue;
    }

    const category = m[1].toLowerCase();
    const modifiers = (m[2] || '').split(/\s+/).filter(Boolean);

    const importance = (modifiers.find((t) => /^\[?P[123]\]?$/i.test(t)) || 'P2').replace(/[[\]]/g, '').toUpperCase();
    const global = modifiers.some((t) => /^global$/i.test(t));
    const tags = modifiers.filter((t) => t.startsWith('#')).map((t) => t.slice(1).trim()).filter(Boolean);
    // Raw due token (e.g. "1h", "2026-07-20"); resolved to an instant at capture time by
    // the store, so the offset is measured from when the note is actually written.
    const dueTok = modifiers.find((t) => /^due:/i.test(t));
    const due = dueTok ? dueTok.slice(4) : null;

    const content = m[3].trim();
    if (!content) {
      ignored.malformed++;
      continue;
    }

    out.push({ category, importance, tags, global, content, due });
  }

  return { directives: out, ignored };
}

// Returns an array of { category, importance, tags, global, content, due } parsed from `text`.
// Lines that don't match are ignored. Invalid/empty content is skipped.
export function parseDirectives(text) {
  return scanDirectives(text).directives;
}
