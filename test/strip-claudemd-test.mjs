// Verifies the CLAUDE.md managed section is stripped (the deprecated injection is undone)
// and that surrounding user content is preserved.
import { removeManagedSection, upsertManagedSection, START_MARKER, END_MARKER } from '../src/digest.js';

let fail = 0;
const check = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// round-trip: insert then remove returns the original (modulo trailing newline)
const user = '# My project\n\nSome real instructions here.';
const withSection = upsertManagedSection(user, 'P1 — critical\n- do the thing');
check(withSection.includes(START_MARKER), 'section inserted');
const stripped = removeManagedSection(withSection);
check(!stripped.includes(START_MARKER) && !stripped.includes(END_MARKER), 'markers gone after strip');
check(stripped.includes('Some real instructions here.'), 'user content preserved');

// section-only file collapses to empty
const only = upsertManagedSection('', 'x');
check(removeManagedSection(only).trim() === '', 'section-only file empties out');

// no section → untouched
const plain = '# Just a readme\nnothing managed here';
check(removeManagedSection(plain) === plain, 'no-op when no section present');

// section in the middle preserves both sides
const mid = `${START_MARKER}\nstuff\n${END_MARKER}\n\n# After`;
check(removeManagedSection(mid).includes('# After'), 'content after section preserved');

// --- a file that merely MENTIONS the markers must not be edited ------------------------------
// This ran on every session start, against a git-tracked file, in the shipped package. The search
// was indexOf(START) … indexOf(END) over the raw text, which is not a search for our section — it
// is a search for two strings in any context. A CLAUDE.md with a sentence explaining what Stickies
// does to it supplied the opening index and the real section supplied the closing one, so
// everything between was deleted. Measured on a plausible file: 346 bytes in, 67 out, taking the
// project's architecture and on-call notes with it.
const documented = `# My project

We use Stickies; it manages a block that begins with ${START_MARKER} below.

## Architecture
The ingest service writes to Postgres.

## On-call
Page Dana first, then Sam.

${START_MARKER}
## Stickies
- (todo) ship the thing  \`abc-123\`
${END_MARKER}
`;
const cleaned = removeManagedSection(documented);
check(cleaned.includes('writes to Postgres'), 'prose between a marker MENTION and the real section survives');
check(cleaned.includes('Page Dana first'), 'and so does everything else in between');
check(cleaned.includes('manages a block that begins with'), "the user's own sentence is left intact");
check(!cleaned.includes('ship the thing'), 'while the real managed section is still removed');

// A fenced example of the markers is documentation, not our section.
const fenced = `# Docs

\`\`\`markdown
${START_MARKER}
example of what gets written here
${END_MARKER}
\`\`\`

Keep this line.

${START_MARKER}
real section
${END_MARKER}
`;
const fencedOut = removeManagedSection(fenced);
check(fencedOut.includes('example of what gets written here'), 'a fenced example of the markers is not treated as our section');
check(fencedOut.includes('Keep this line.'), 'and the content after the fence survives');
check(!fencedOut.includes('real section'), 'while the real one is still removed');

// The same rule has to hold for the writer, or the next upsert re-creates the damage.
const upserted = upsertManagedSection(documented, 'replaced body');
check(upserted.includes('writes to Postgres') && upserted.includes('Page Dana first'),
  'upsert replaces in place without eating the content above it');
check(upserted.includes('replaced body') && !upserted.includes('ship the thing'), 'and the body is actually replaced');
check((upserted.match(new RegExp(END_MARKER, 'g')) || []).length === 1, 'leaving exactly one managed block');

// --- the shapes the first version of this fix still ate ---------------------------------------
// Found by a red-team pass AFTER the fix shipped green. All three share one root cause: the
// finder took the FIRST opening marker it saw instead of identifying our block. It now requires
// column zero (an example is indented), skips fenced regions with a real scanner, and takes the
// LAST opening before the first closing — so a stray marker can never begin a span.
const real = `${START_MARKER}\n## Stickies\n- (todo) real note\n${END_MARKER}\n`;

// 1. An UNPAIRED marker above the real section. Measured before the fix: 301 bytes -> 63.
const unpaired = `# P\n\nthe block starts with\n${START_MARKER}\nin this file.\n\n## Arch\nPostgres.\n\n## Oncall\nDana.\n\n${real}`;
let out = removeManagedSection(unpaired);
check(out.includes('Postgres.') && out.includes('Dana.'), 'an unpaired marker above the section destroys nothing');
check(!out.includes('real note'), 'and the real section is still removed');

// 2. An INDENTED four-space example — as ordinary as a fenced one, and it was being matched.
const indented = `# P\n\nshown as:\n\n    ${START_MARKER}\n    ...\n    ${END_MARKER}\n\n## Build\nmake ship\n\n${real}`;
out = removeManagedSection(indented);
check(out.includes('    ' + START_MARKER), 'an indented example is not mistaken for our section');
check(out.includes('make ship'), 'so the prose after it survives');
check(!out.includes('real note'), 'and the real section is the one removed');

// 3. A ~~~ line INSIDE a ``` fence. Counting delimiters in separate pools scored this as an
//    unclosed tilde fence, hid the real section, and the cleanup silently stopped happening.
const mixedFence = '# P\n\n```\n~~~\n```\n\n## Keep\nthis\n\n' + real;
out = removeManagedSection(mixedFence);
check(out.includes('## Keep'), 'a ~~~ inside a ``` fence leaves surrounding content alone');
check(!out.includes('real note'), 'and does not hide the real section from the cleanup');

// 4. Repeated upserts must converge on one section, not stack duplicates.
let doc = `# P\n\n## Keep\nx\n\n${START_MARKER}\nold\n${END_MARKER}\n`;
for (let i = 0; i < 4; i++) doc = upsertManagedSection(doc, `body ${i}`);
check((doc.match(new RegExp(START_MARKER, 'g')) || []).length === 1, 'four upserts leave exactly one section');
check(doc.includes('## Keep'), 'and never touch the user content above it');

// 5. Pathological input must not stall session start (this runs on every one).
const huge = (START_MARKER + '\nfiller\n').repeat(20000);
const t0 = process.hrtime.bigint();
removeManagedSection(huge);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
check(ms < 300, `a 700KB file of unterminated markers is not quadratic (${ms.toFixed(0)}ms)`);

console.log('\n' + (fail === 0 ? 'STRIP OK' : fail + ' FAILURES'));
process.exit(fail === 0 ? 0 : 1);
