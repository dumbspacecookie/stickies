// Tests the Stop hook end-to-end against a synthetic transcript, incl. dedup.
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(tmpdir(), 'stickies_autocap_test.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
const env = { ...process.env, STICKIES_DB: db };

const cwd = join(tmpdir(), 'autocap_proj');
const transcript = join(tmpdir(), 'autocap_transcript.jsonl');

// A realistic transcript: user msg, an assistant tool-use turn, then final assistant text.
const lines = [
  { type: 'user', message: { role: 'user', content: 'do the thing' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', name: 'Edit', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'Done. A couple of notes:\n!!sticky decision P1 #storage :: chose node:sqlite to avoid native deps\n!!sticky todo :: hook the dashboard to dismiss\nThat colon :: in prose should not match.' },
  ] } },
];
writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));

function runHook() {
  const event = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, cwd, stop_hook_active: false });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/auto-capture.js'], { input: event, env, encoding: 'utf8' });
  if (r.stderr) process.stdout.write('  hook stderr: ' + r.stderr.trim() + '\n');
  return r;
}

console.log('First run (should capture 2):');
runHook();
console.log('Second run (should capture 0 — dedup):');
runHook();

// Verify via the store.
process.env.STICKIES_DB = db;
const { readStickies } = await import('../src/store.js');
const got = readStickies({ project_path: cwd, include_global: true });
console.log(`\nStored stickies for project: ${got.length}`);
for (const s of got) console.log(`  [${s.importance} ${s.category}] ${s.content} (source=${s.source})`);

const ok = got.length === 2 && got.some((s) => s.category === 'decision') && got.some((s) => s.category === 'todo');
console.log('\n' + (ok ? 'AUTO-CAPTURE OK' : 'AUTO-CAPTURE FAILED'));
