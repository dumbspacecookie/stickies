// Regression: the turn boundary must be the *human's* message, not the last transcript
// entry of type 'user'. Claude Code logs tool results as type 'user' too, so keying off
// the type alone drops any directive written before the turn's final tool use — the
// common case when the model captures a fact mid-work and then keeps going.
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(tmpdir(), 'stickies_turnboundary_test.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
const env = { ...process.env, STICKIES_DB: db };

const cwd = join(tmpdir(), 'turnboundary_proj');
const transcript = join(tmpdir(), 'turnboundary_transcript.jsonl');

const human = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const useTool = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const subagentSay = (text) => ({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text }] } });

function runHook() {
  const event = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd, stop_hook_active: false });
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/auto-capture.js'], { input: event, env, encoding: 'utf8' });
}

function capture(lines) {
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
  runHook();
}

// The turn under test: the model states a fact, THEN keeps working (more tool calls), and
// a background subagent reports back. Every one of those lands after the directive.
capture([
  human('investigate the thing'),
  useTool(),
  toolResult(),
  say('Found it.\n!!sticky decision P1 #boundary :: directive written before the turn kept working'),
  useTool(),
  toolResult(),
  subagentSay('!!sticky todo :: a subagent must not be able to write stickies'),
  say('All done.'),
]);

process.env.STICKIES_DB = db;
const { readStickies } = await import('../src/store.js');
const got = readStickies({ project_path: cwd, include_global: true });

const kept = got.find((s) => s.content.includes('directive written before the turn kept working'));
const leaked = got.find((s) => s.content.includes('subagent must not be able'));

const checks = [
  ['directive survives later tool use in the same turn', !!kept],
  ['it keeps its declared importance (P1)', kept?.importance === 'P1'],
  ['subagent text is not captured', !leaked],
];

// A prior human message must not be re-scanned once a new turn begins.
capture([
  human('first'),
  say('!!sticky context :: from the previous turn'),
  human('second'),
  useTool(),
  toolResult(),
  say('No directive this turn.'),
]);
const after = readStickies({ project_path: cwd, include_global: true });
checks.push(['earlier turns are not re-scanned', !after.some((s) => s.content.includes('from the previous turn'))]);

for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
const allOk = checks.every(([, ok]) => ok);
console.log('\n' + (allOk ? 'TURN BOUNDARY OK' : 'TURN BOUNDARY FAILED'));
process.exit(allOk ? 0 : 1);
