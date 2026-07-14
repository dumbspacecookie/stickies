// Adversarial hardening tests for the real-store / upgrade paths:
// corrupt DB, corrupt row data, concurrent access, and a concurrent migration race.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from '../src/db.js';
import { createSticky, readStickies } from '../src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };
const wipe = (p) => { for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} } };

// ── 1. A corrupt DB file is quarantined and the tool keeps working ──────────
{
  const p = join(tmpdir(), 'stickies_corrupt.db');
  // remove any prior quarantine files too
  for (const f of readdirSync(tmpdir())) if (f.startsWith('stickies_corrupt.db')) { try { rmSync(join(tmpdir(), f)); } catch {} }
  writeFileSync(p, 'this is definitely not a sqlite database, just junk bytes');
  closeDb();
  process.env.STICKIES_DB = p;
  let threw = null;
  let rows;
  try { rows = readStickies({ project_path: '/x' }); } catch (e) { threw = e.message; }
  check(threw === null, `corrupt DB does not throw on open (${threw || 'ok'})`);
  check(Array.isArray(rows) && rows.length === 0, 'fresh store usable after quarantine');
  const quarantined = readdirSync(tmpdir()).some((f) => f.startsWith('stickies_corrupt.db.corrupt-'));
  check(quarantined, 'corrupt file preserved (renamed to .corrupt-*)');
  // and the fresh DB actually works for writes
  const s = createSticky({ content: 'after corruption recovery', category: 'todo', project_path: '/x' });
  check(!!s.id && readStickies({ project_path: '/x' }).length === 1, 'can write/read the fresh store');
}

// ── 2. A row with corrupt tags JSON must not break reads ────────────────────
{
  const p = join(tmpdir(), 'stickies_badtags.db');
  wipe(p);
  closeDb();
  process.env.STICKIES_DB = p;
  createSticky({ content: 'good row', category: 'context', project_path: '/t' });
  closeDb(); // release store's connection
  const raw = new DatabaseSync(p);
  raw.exec(`UPDATE stickies SET tags = '{ this is not valid json'`);
  raw.close();
  closeDb();
  let threw = null;
  let rows;
  try { rows = readStickies({ project_path: '/t' }); } catch (e) { threw = e.message; }
  check(threw === null, `corrupt tags do not throw (${threw || 'ok'})`);
  check(rows && rows.length === 1 && Array.isArray(rows[0].tags) && rows[0].tags.length === 0, 'corrupt tags degrade to []');
}

// ── 3. busy_timeout is set so concurrent access waits instead of failing ────
{
  const p = join(tmpdir(), 'stickies_busy.db');
  wipe(p);
  closeDb();
  process.env.STICKIES_DB = p;
  readStickies({ project_path: '/x' }); // opens
  const { getDb } = await import('../src/db.js');
  const t = getDb().prepare('PRAGMA busy_timeout').get();
  check(t && Number(t.timeout) >= 5000, `busy_timeout configured (${t && t.timeout}ms)`);
}

// ── 4. Two processes migrating the SAME old-schema DB at once both succeed ───
await (async () => {
  const p = join(tmpdir(), 'stickies_race.db');
  wipe(p);
  // Build an OLD-schema DB (no project_key) so both children try to migrate.
  const old = new DatabaseSync(p);
  old.exec(`CREATE TABLE stickies (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, importance TEXT NOT NULL,
    project_path TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    expires_at TEXT, source TEXT, status TEXT, dismiss_reason TEXT)`);
  old.close();

  const helper = join(HERE, '_open-and-read.mjs');
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', helper],
      { env: { ...process.env, STICKIES_DB: p }, encoding: 'utf8' });
    let out = '', errOut = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (errOut += d));
    c.on('close', (code) => resolve({ code, out: out.trim(), err: errOut.trim() }));
  });
  const [a, b] = await Promise.all([run(), run()]); // launched concurrently
  const okBoth = a.code === 0 && b.code === 0 && a.out === 'ok' && b.out === 'ok';
  check(okBoth, `concurrent migration: both processes succeed (a=${a.code}/${a.out||a.err}, b=${b.code}/${b.out||b.err})`);
})();

console.log('\n' + (fail === 0 ? 'RESILIENCE OK' : fail + ' FAILURES'));
closeDb();
process.exitCode = fail === 0 ? 0 : 1;
