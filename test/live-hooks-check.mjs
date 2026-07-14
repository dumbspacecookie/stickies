// Drives the INSTALLED (cached) Stop + SessionStart hooks exactly as Claude Code does.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point at an installed plugin cache to smoke-test the real hooks; override per machine.
const CACHE = process.env.STICKIES_CACHE_DIR || join(process.env.HOME || process.env.USERPROFILE || '.', '.claude/plugins/cache/stickies-local/stickies/src');
const proj = join(tmpdir(), 'live_hook_proj');
mkdirSync(proj, { recursive: true });
const db = join(tmpdir(), 'live_hook.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }
const env = { ...process.env, STICKIES_DB: db };

const tr = join(proj, 't.jsonl');
writeFileSync(tr, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok\n!!sticky decision P1 #live :: the installed Stop hook works end to end' }] } }),
].join('\n'));

const stop = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(CACHE, 'auto-capture.js')],
  { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: tr, cwd: proj }), env, encoding: 'utf8' });
console.log('Stop hook:', (stop.stderr || '').trim() || '(no capture)');

const ss = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(CACHE, 'session-start.js')],
  { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: proj }), env, encoding: 'utf8' });
const ctx = JSON.parse(ss.stdout).hookSpecificOutput.additionalContext;
console.log('SessionStart injected digest:\n');
console.log(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'));
