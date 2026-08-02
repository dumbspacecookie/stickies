// Which lines of a markdown document are inside a fenced code block.
//
// WHY THIS IS SHARED, AND WHY THAT IS THE WHOLE POINT. Two separate scanners read ROADMAP.md: the
// board builder (`derive-gsd.mjs`) decides what cards exist, and the writer (`writeback.mjs`)
// decides which heading to edit when you drag one. Both matched `^### Phase N` line by line with
// no idea that a heading might be sitting inside a ```-fence.
//
// A fenced example heading therefore became a REAL, DRAGGABLE CARD. Dragging it made writeback
// go looking for that phase, find a different one, and rewrite ITS `**Status:**` on disk —
// silently, reporting success, `warnings: []`. A second shape of the same bug: a fenced heading
// truncated the section the writer measured, so it took the insert branch and added a SECOND
// `**Status:**` line to a phase that already had one, which is the contradictory-status outcome
// the lone-`\r` fix exists to prevent.
//
// The deeper rule is that the two scanners must never disagree about what a heading is. Two
// copies of "skip fences" would drift, and a disagreement between the reader and the writer is
// precisely how you edit the wrong phase. So there is one implementation and both import it.
//
// Deliberately CommonMark-shaped rather than clever:
//   - a fence opens with 3+ backticks or 3+ tildes, indented at most 3 spaces
//   - it closes on a line of the SAME character, at least as long, with nothing after it
//   - a backtick fence cannot be closed by tildes, or vice versa
//   - an info string (```js) is allowed on the opening fence only
//   - an UNCLOSED fence runs to end of document — the safe reading, because the alternative is
//     treating someone's half-written example as live structure

// `[\s\S]*` for the info string, not `.*`, and it is a security boundary rather than a nicety.
//
// JS `.` does not match U+2028 or U+2029. Callers do not all agree on what a line is —
// src/directives.js splits on /\r?\n/, while derive-gsd.mjs and writeback.mjs split on
// /\r\n|\n|\r/ — so a "line" handed to this scanner can still contain one of those characters. When
// it sat on a fence-OPEN line, `(.*)$` failed to match, `marker` was never set, and every following
// line read as UNFENCED. That turned the capture rule inside out: a `!!sticky … global ::` line the
// model had merely QUOTED inside a code fence was executed, filed as a global note visible in every
// project on the machine, with `ignored.fenced` still 0 so nothing was reported. Reproduced through
// the real scanner.
//
// With `[\s\S]*` the info string absorbs the terminator, the fence opens, and the directive — on
// that line or the next — is correctly inside it. Where callers DO split on every terminator this
// is identical to `.*`, because no line can then contain one. The close test below is unaffected:
// `m[2].trim()` treats U+2028/U+2029 as whitespace, so a close line carrying one still closes.
//
// The underlying disagreement between the two line splitters is the root cause and is NOT fixed
// here — this closes the bypass without changing how content is split. Same blind spot still exists
// in the `### Phase N` heading regexes (derive-gsd.mjs, writeback.mjs), where it degrades into a
// refused drag rather than a write, and their sibling STATUS regexes already use [\s\S] for exactly
// this reason.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;

// Returns a boolean per line: true when that line is inside (or is a delimiter of) a fenced block.
// The delimiters themselves count as fenced — nothing structural is ever declared on them.
export function fencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let marker = null; // the opening run, e.g. '```' or '~~~~'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_OPEN);
    if (!marker) {
      // An opening fence: a run of 3+ of one character. An info string may follow, but it must
      // not itself contain a backtick when the fence is backticks (CommonMark forbids it, and it
      // is how ``` `code` ``` inline spans get misread as fences).
      //
      // The test scans the WHOLE info string, and an attempt to narrow it to the first word was
      // REVERTED — it is recorded here because the narrowed version looked obviously right.
      //
      // The reasoning was: an info string means its first word (```js is `js`), so testing further
      // along was over-strict and let a U+2028-plus-backtick line block a fence from opening. True,
      // but it made this scanner MORE EAGER to open than any real renderer: ```js `x has a clean
      // first word, so a fence opened where commonmark, markdown-it and marked all open none. The
      // genuine ``` three lines later was then consumed as that fence's CLOSE rather than its open,
      // and every following line — text a reader plainly sees as quoted code — read as unfenced. A
      // `!!sticky ... global ::` line from a hostile README was executed and filed into every
      // project on the machine, reporting nothing refused. Reproduced end to end through the real
      // hook; the previous release refused the identical document.
      //
      // CommonMark is explicit that a backtick fence's info string may not contain a backtick
      // anywhere, so the whole-string test IS the specification. Being more eager to open is not the
      // safe direction after all: over-opening flips the open/close parity of everything downstream,
      // which turns quoted text into spoken text — the precise inversion this scanner exists to
      // stop. It also empties the board, because a ROADMAP.md with a stray backtick on a fence line
      // swallows every later phase heading.
      //
      // The shape that prompted the change is a U+2028 sitting inside the info string, and the real
      // fix is upstream of here: normalise U+2028/U+2029 to a newline before anything is called a
      // "line", so the scanner never meets one. That is a larger change than a release should carry.
      // so the scanner never meets one. That is a larger change than a release should carry.
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        marker = m[1];
        flags[i] = true;
      }
      continue;
    }
    flags[i] = true; // inside a fence
    // A closing fence: same character, at least as long, and nothing but whitespace after it.
    if (m && m[1][0] === marker[0] && m[1].length >= marker.length && m[2].trim() === '') {
      marker = null;
    }
  }
  return flags;
}

// Convenience for the common case: "should this line be read as document structure?"
export function outsideFences(lines) {
  const flags = fencedLineFlags(lines);
  return (i) => !flags[i];
}
