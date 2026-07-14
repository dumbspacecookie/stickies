// Regression test for the schema migration path: a DB created by a PRE-project_key
// version must upgrade cleanly and keep working. This is the gap that let a showstopper
// ship (every test used a fresh full-schema DB, so the upgrade path was never exercised).
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(tmpdir(), 'stickies_migration_test.db');
for (const s of ['', '-wal', '-shm']) { try { rmSync(db + s); } catch {} }

// 1. Build a DB with the OLD (pre-0.5.0) schema — no project_key column — and seed a row.
{
  const old = new DatabaseSync(db);
  old.exec(`CREATE TABLE stickies (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, importance TEXT NOT NULL,
    project_path TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    expires_at TEXT, source TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'active', dismiss_reason TEXT)`);
  old.exec(`INSERT INTO stickies (id, content, category, importance, project_path, tags, created_at, updated_at, expires_at, source, status)
    VALUES ('old-1','legacy note','decision','P1','/legacy','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','manual','active')`);
  old.close();
}

process.env.STICKIES_DB = db;
let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

// 2. Open with current code — this must run the migration, not throw.
const { readStickies, createSticky, getSticky } = await import('../src/store.js');
const { getDb } = await import('../src/db.js');

let threw = null;
let legacy;
try {
  legacy = readStickies({ project_path: '/legacy' });
} catch (e) {
  threw = e.message;
}
check(threw === null, `reading a legacy DB does not throw (${threw || 'ok'})`);

const cols = getDb().prepare('PRAGMA table_info(stickies)').all().map((c) => c.name);
check(cols.includes('project_key'), 'project_key column was added by migration');

check(legacy && legacy.some((s) => s.id === 'old-1'), 'legacy row is still readable (matches by project_path)');

// 3. Writing into the migrated DB works and populates project_key.
const fresh = createSticky({ content: 'post-migration note', category: 'todo', project_path: '/legacy' });
check(!!getSticky(fresh.id), 'can write after migration');
check(getSticky('old-1').project_key === null, 'legacy row keeps project_key NULL (matches by path)');

console.log('\n' + (fail === 0 ? 'MIGRATION OK' : fail + ' FAILURES'));
process.exitCode = fail === 0 ? 0 : 1;
