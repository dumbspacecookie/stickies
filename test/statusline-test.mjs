// Statusline renderer tests: the compact-by-default contract (counts only, and — load-bearing —
// NEVER the note body text) plus the verbose opt-in that restores the newest P1's text. This is
// the surface a user stares at on every prompt, so "no note content leaks into the compact line"
// is a real privacy contract, not a cosmetic one.

import { buildStatusline } from '../src/statusline.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const opts = (extra = {}) => ({ color: false, ...extra });
const P1 = { importance: 'P1', content: 'SENSITIVE note body that must never reach the compact line' };
const P2 = { importance: 'P2', content: 'a second note body' };

// --- empty: nothing renders, in either mode (an always-on zero trains the eye to ignore it) ---
ok(buildStatusline([], opts()) === '', 'no stickies => empty output (compact)');
ok(buildStatusline([], opts({ verbose: true })) === '', 'no stickies => empty output (verbose)');

// --- compact default: counts only, and never any note text ---
const cP1 = buildStatusline([P1, P2], opts());
ok(cP1 === '\u{1F7E8} 1!·2', `compact w/ P1 => "icon N!·total" (got ${JSON.stringify(cP1)})`);
ok(!cP1.includes('SENSITIVE'), 'compact line never contains note text (P1 present)');

const cNo = buildStatusline([P2], opts());
ok(cNo === '\u{1F7E8} 1', `compact no-P1 => bare count (got ${JSON.stringify(cNo)})`);
ok(!cNo.includes('second note'), 'compact line never contains note text (no P1)');

// --- verbose opt-in: restores the newest P1's text, or "N pending" when nothing is hot ---
const vP1 = buildStatusline([P1, P2], opts({ verbose: true }));
ok(vP1.includes('SENSITIVE'), 'verbose restores the newest P1 note text');
const vNo = buildStatusline([P2], opts({ verbose: true }));
ok(/\bpending\b/.test(vNo), 'verbose no-P1 => "N pending"');

console.log(fail ? `\nstatusline: ${fail} FAILED` : `\nstatusline: all ${pass} passed`);
process.exit(fail ? 1 : 0);
