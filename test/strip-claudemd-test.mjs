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

console.log('\n' + (fail === 0 ? 'STRIP OK' : fail + ' FAILURES'));
process.exit(fail === 0 ? 0 : 1);
