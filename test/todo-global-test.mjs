// Two guarantees for using stickies as a build task list:
//   1. todos never expire — an unfinished task must not vanish on a timer
//   2. `global` on a directive files the note across every project, not just this one
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDirectives } from '../src/directives.js';

const db = join(tmpdir(), 'stickies_todoglobal_test.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
const env = { ...process.env, STICKIES_DB: db };

const projA = join(tmpdir(), 'todoglobal_projA');
const projB = join(tmpdir(), 'todoglobal_projB');
const transcript = join(tmpdir(), 'todoglobal_transcript.jsonl');

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

// --- grammar: modifiers in any order -----------------------------------------
const g = parseDirectives('!!sticky todo global P1 #ship :: cut the npm release')[0];
check('`global` parsed regardless of modifier order', g?.global === true);
check('importance still parsed alongside global', g?.importance === 'P1');
check('tags still parsed alongside global', g?.tags?.join() === 'ship');
check('content excludes the modifiers', g?.content === 'cut the npm release');

const p = parseDirectives('!!sticky todo P2 #x :: project-scoped task')[0];
check('a directive without `global` is project-scoped', p?.global === false);
check('the word global in prose does not leak in', parseDirectives('!!sticky todo :: make it global')[0]?.global === false);

// --- capture: run the real Stop hook from project A ---------------------------
writeFileSync(transcript, [
  { type: 'user', message: { role: 'user', content: 'work' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text:
      '!!sticky todo P1 global :: GLOBAL_TASK cut the npm release\n' +
      '!!sticky todo P2 :: LOCAL_TASK wire up the dashboard' }] } },
].map((l) => JSON.stringify(l)).join('\n'));

spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/auto-capture.js'], {
  input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd: projA, stop_hook_active: false }),
  env, encoding: 'utf8',
});

process.env.STICKIES_DB = db;
const { readStickies } = await import('../src/store.js');

const fromA = readStickies({ project_path: projA, include_global: true });
const fromB = readStickies({ project_path: projB, include_global: true });

const globalNote = fromA.find((s) => s.content.includes('GLOBAL_TASK'));
const localNote = fromA.find((s) => s.content.includes('LOCAL_TASK'));

check('global todo is stored unscoped (project_path null)', globalNote?.project_path === null);
check('global todo surfaces in a DIFFERENT project', fromB.some((s) => s.content.includes('GLOBAL_TASK')));
check('local todo does NOT surface in a different project', !fromB.some((s) => s.content.includes('LOCAL_TASK')));
check('local todo is scoped to its project', !!localNote && localNote.project_path !== null);

// --- TTL: todos never expire --------------------------------------------------
check('global todo has no expiry', globalNote?.expires_at === null);
check('local todo has no expiry', localNote?.expires_at === null);

// other categories keep their TTL
writeFileSync(transcript, [
  { type: 'user', message: { role: 'user', content: 'more' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text:
      '!!sticky decision P1 :: DECISION_NOTE still expires on the normal TTL' }] } },
].map((l) => JSON.stringify(l)).join('\n'));
spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/auto-capture.js'], {
  input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd: projA, stop_hook_active: false }),
  env, encoding: 'utf8',
});
const decision = readStickies({ project_path: projA, include_global: true }).find((s) => s.content.includes('DECISION_NOTE'));
check('non-todo categories still expire (TTL not broken globally)', typeof decision?.expires_at === 'string');

for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
const allOk = checks.every(([, ok]) => ok);
console.log('\n' + (allOk ? 'TODO/GLOBAL OK' : 'TODO/GLOBAL FAILED'));
process.exit(allOk ? 0 : 1);
