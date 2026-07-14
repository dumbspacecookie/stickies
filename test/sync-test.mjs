// Offline sync-engine tests: two DBs = two machines, one process (switch via closeDb).
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../src/db.js';
import { createSticky, readStickies, dismissSticky, getSticky, exportAllRows, upsertFromSync } from '../src/store.js';
import { buildExport, applyImport, exportToFile, importFromFile } from '../src/sync.js';

const A = join(tmpdir(), 'stickies_sync_A.db');
const B = join(tmpdir(), 'stickies_sync_B.db');
const SYNCFILE = join(tmpdir(), 'stickies_sync_doc.json');
for (const p of [A, B, SYNCFILE]) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} }

function machine(path) {
  closeDb();
  process.env.STICKIES_DB = path;
}

let fail = 0;
const check = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

// ── Machine A: create two notes, export ──────────────────────────────────────
machine(A);
const a1 = createSticky({ content: 'A decision: use git sync', category: 'decision', importance: 'P1', project_path: '/proj' });
const a2 = createSticky({ content: 'A global preference', category: 'preference', importance: 'P3', project_path: null });
exportToFile(SYNCFILE);

// ── Machine B: has its own note, then imports A's doc ─────────────────────────
machine(B);
createSticky({ content: 'B local todo', category: 'todo', importance: 'P2', project_path: '/proj' });
const imp1 = importFromFile(SYNCFILE);
check(imp1.added === 2 && imp1.updated === 0, `B imports A: +2 added (${JSON.stringify(imp1)})`);
const bAll = exportAllRows();
check(bAll.length === 3, `B now has 3 stickies (its own + A's two)`);
check(!!getSticky(a1.id) && !!getSticky(a2.id), 'A1 and A2 present on B with same ids');

// ── Idempotency: re-import same doc -> all skipped ───────────────────────────
const imp2 = importFromFile(SYNCFILE);
// A's export holds A's 2 records (not B's local todo), so re-import skips exactly those 2.
check(imp2.added === 0 && imp2.updated === 0 && imp2.skipped === 2 && imp2.total === 2, `re-import is idempotent (${JSON.stringify(imp2)})`);

// ── Dismiss propagation: A dismisses a1, re-export, B imports ────────────────
machine(A);
dismissSticky(a1.id, 'superseded');
exportToFile(SYNCFILE);
machine(B);
const imp3 = importFromFile(SYNCFILE);
check(imp3.updated === 1, `B picks up A's dismissal as an update (${JSON.stringify(imp3)})`);
check(getSticky(a1.id).status === 'dismissed', 'a1 is now dismissed on B');
check(readStickies({ project_path: '/proj' }).every((s) => s.id !== a1.id), 'dismissed a1 no longer read-active on B');

// ── Last-writer-wins, deterministic regardless of arrival order ──────────────
machine(B); // reuse B's DB for a controlled-id LWW test
const X = 'fixed-id-0000';
check(upsertFromSync({ id: X, content: 'v1', category: 'context', importance: 'P2', updated_at: '2026-01-01T00:00:00.000Z' }) === 'added', 'X v1 added');
check(upsertFromSync({ id: X, content: 'v2', category: 'context', importance: 'P2', updated_at: '2026-02-01T00:00:00.000Z' }) === 'updated', 'X v2 (newer) updates');
check(upsertFromSync({ id: X, content: 'v0', category: 'context', importance: 'P2', updated_at: '2025-01-01T00:00:00.000Z' }) === 'skipped', 'X v0 (older) skipped');
check(getSticky(X).content === 'v2', 'newest write wins regardless of order');

// ── Bad input is rejected, not fatal ─────────────────────────────────────────
let threw = false;
try { applyImport({ nope: true }); } catch { threw = true; }
check(threw, 'invalid sync document throws');
check(upsertFromSync({ id: 'z', category: 'bogus', importance: 'P1', updated_at: '2026-01-01T00:00:00.000Z' }) === 'skipped', 'invalid category skipped');

console.log('\n' + (fail === 0 ? 'SYNC ENGINE OK' : fail + ' FAILURES'));
closeDb();
process.exitCode = fail === 0 ? 0 : 1;
