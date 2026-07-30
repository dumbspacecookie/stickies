// Every module must actually load.
//
// This exists because a CSS comment inside a template literal used backticks around a CSS
// keyword, which terminated the literal — a SyntaxError in project-switcher.mjs that took
// board-page.js and dashboard.js down with it, so the dashboard would not start at all. Twice.
//
// `node --check` on an entry point cannot see that: the parse error is in a DEPENDENCY, and the
// suites that would have caught it reported a confusing symptom instead ("started" for a server
// that was crashing on import). Importing every file is the cheap, direct check — and it runs
// first, so a broken module fails here with its own name rather than somewhere downstream.

import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratchDir, cleanup } from './_env.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ROOT = scratchDir('imports');

// Importing the store opens a database; point it somewhere disposable and keep sync off, so this
// check can never touch the developer's real notes.
Object.assign(process.env, {
  STICKIES_DB: join(ROOT, 'imports.db'),
  STICKIES_HOME: join(ROOT, 'home'),
  STICKIES_AUTO_SYNC: '',
  STICKIES_SYNC_REPO: '',
  STICKIES_SYNC_FILE: '',
  STICKIES_DISCORD_WEBHOOK: '',
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

// These run something on import rather than just defining it, so importing them here would start
// a server or write to stdout. Their own suites cover them; a parse error in either still shows
// up through the modules they import.
const ENTRYPOINTS = new Set(['dashboard.js', 'cli.js', 'server.js', 'server-main.js', 'statusline.js', 'session-start.js',
  'session-end.js', 'session-report.js', 'auto-capture.js', 'stop.js', 'engine.mjs', 'install.js']);

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const files = walk(SRC).filter((p) => !ENTRYPOINTS.has(p.split(/[\\/]/).pop()));
for (const file of files) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  try {
    await import(pathToFileURL(file).href);
    check(true, `src/${rel} imports`);
  } catch (err) {
    check(false, `src/${rel} imports — ${String(err.message).split('\n')[0]}`);
  }
}

check(files.length > 20, `and the walk actually found the source tree (${files.length} modules)`);

console.log(fail ? `\nimports: ${fail} FAILED` : '\nimports: all passed');
try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
cleanup(ROOT);
process.exit(fail ? 1 : 0);
