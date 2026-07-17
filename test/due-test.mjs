// Due-date parsing, resolution, capture, and the statusline pip.
import { resolveDueDate, dueStatus } from '../src/due.js';
import { parseDirectives } from '../src/directives.js';
import { buildStatusline } from '../src/statusline.js';

const checks = [];
const check = (ok, m) => checks.push([ok, m]);

// Fixed reference instant so everything is deterministic: 2026-07-17T12:00:00Z.
const NOW = Date.parse('2026-07-17T12:00:00.000Z');
const H = 3600e3, D = 24 * H;

// --- resolveDueDate: relative offsets -----------------------------------------
check(resolveDueDate('1h', NOW) === new Date(NOW + H).toISOString(), '1h -> now + 1h');
check(resolveDueDate('30m', NOW) === new Date(NOW + 30 * 60e3).toISOString(), '30m -> now + 30min');
check(resolveDueDate('2d', NOW) === new Date(NOW + 2 * D).toISOString(), '2d -> now + 2 days');
check(resolveDueDate('1w', NOW) === new Date(NOW + 7 * D).toISOString(), '1w -> now + 1 week');
check(resolveDueDate('tomorrow', NOW) === new Date(NOW + D).toISOString(), 'tomorrow -> now + 24h');

// --- resolveDueDate: absolute + garbage ---------------------------------------
// End of the LOCAL 20th — assert on local components, since toISOString() renders UTC and
// the day can roll depending on the machine's timezone.
const due20 = new Date(resolveDueDate('2026-07-20', NOW));
check(due20.getFullYear() === 2026 && due20.getMonth() === 6 && due20.getDate() === 20 && due20.getHours() === 23,
  'YYYY-MM-DD resolves to end of that local day');
check(resolveDueDate('2026-07-20T14:30', NOW) !== null, 'YYYY-MM-DDTHH:MM resolves');
check(resolveDueDate('whenever', NOW) === null, 'unparseable token -> null (note still captured)');
check(resolveDueDate('0h', NOW) === null, 'zero offset -> null');
check(resolveDueDate('', NOW) === null && resolveDueDate(null, NOW) === null, 'empty/null -> null');

// --- dueStatus buckets --------------------------------------------------------
check(dueStatus(new Date(NOW - H).toISOString(), NOW) === 'overdue', 'past deadline -> overdue');
check(dueStatus(new Date(NOW + 2 * H).toISOString(), NOW) === 'soon', 'within 24h -> soon');
check(dueStatus(new Date(NOW + 3 * D).toISOString(), NOW) === 'later', 'beyond window -> later');
check(dueStatus(null, NOW) === null, 'no due date -> null');

// --- parseDirectives: due: modifier, any order --------------------------------
const a = parseDirectives('!!sticky todo P1 due:1h :: cut the release')[0];
check(a && a.due === '1h', 'due:1h parsed off the directive');
check(a && a.importance === 'P1', 'importance still parsed alongside due:');
const b = parseDirectives('!!sticky todo due:2026-07-20 global #ship :: publish')[0];
check(b && b.due === '2026-07-20' && b.global === true && b.tags.join() === 'ship', 'due: coexists with global + tags');
const c = parseDirectives('!!sticky todo :: no deadline here')[0];
check(c && c.due === null, 'a directive without due: has due === null');
check(parseDirectives('!!sticky todo :: ship it by due: tomorrow')[0].due === null, 'the word due in prose does not leak in');

// --- capture end to end (real store, temp DB) ---------------------------------
process.env.STICKIES_DB = (await import('node:path')).join((await import('node:os')).tmpdir(), 'stickies_due_test.db');
for (const s of ['', '-wal', '-shm']) { try { (await import('node:fs')).rmSync(process.env.STICKIES_DB + s); } catch {} }
const { createSticky, readStickies } = await import('../src/store.js');

const made = createSticky({ content: 'cut the release', category: 'todo', importance: 'P1', project_path: null, due_at: '1h' });
check(made.due_at !== null && new Date(made.due_at) > new Date(), 'createSticky resolves a raw due token to a future instant');
const readback = readStickies({ project_path: null, include_global: true }).find((s) => s.id === made.id);
check(readback && readback.due_at === made.due_at, 'due_at survives write + read');

const noDue = createSticky({ content: 'someday maybe', category: 'todo', project_path: null });
check(noDue.due_at === null, 'no due token -> due_at null');
const badDue = createSticky({ content: 'bad deadline', category: 'todo', project_path: null, due_at: 'whenever' });
check(badDue.due_at === null, 'unparseable due token is dropped, note still created');

// --- statusline pip -----------------------------------------------------------
const overdueNote = { importance: 'P2', category: 'todo', content: 'x', due_at: new Date(Date.now() - H).toISOString() };
const soonNote = { importance: 'P3', category: 'todo', content: 'y', due_at: new Date(Date.now() + 2 * H).toISOString() };
const noneNote = { importance: 'P3', category: 'todo', content: 'z', due_at: null };
check(buildStatusline([overdueNote, noneNote], { color: false }).includes('⏰1!'), 'overdue shows ⏰N! pip');
check(buildStatusline([soonNote, noneNote], { color: false }).includes('⏰1'), 'due-soon shows ⏰N pip');
check(!buildStatusline([noneNote], { color: false }).includes('⏰'), 'no clock pip when nothing is due');
// overdue outranks soon in the single pip
check(buildStatusline([overdueNote, soonNote], { color: false }).includes('⏰1!'), 'overdue outranks soon');

for (const [ok, m] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m}`);
const allOk = checks.every(([ok]) => ok);
console.log('\n' + (allOk ? 'DUE OK' : 'DUE FAILED'));
process.exit(allOk ? 0 : 1);
