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

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

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
