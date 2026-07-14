// Database layer: connection, schema, and category TTL configuration.
// Phase 1 storage is a single local SQLite file shared across all projects.
// Location precedence: $STICKIES_DB env var, else ~/.stickies/stickies.db.
//
// Uses Node's built-in SQLite (node:sqlite) rather than a native addon, so the
// plugin has zero compiled dependencies and survives Claude Code's plugin-cache
// copy on any machine. API is a drop-in subset of better-sqlite3.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, renameSync } from 'node:fs';

// Default time-to-live per category, in days. expires_at is derived from these.
// Days until a sticky goes stale. `null` = never expires; it lives until dismissed.
// A todo is done when you finish it, not when a timer runs out — an unfinished task that
// silently vanishes is worse than a stale list, so todos are dismissal-only.
export const CATEGORY_TTL_DAYS = {
  decision: 30,
  blocker: 7,
  preference: 90,
  context: 14,
  todo: null,
};

export const CATEGORIES = Object.keys(CATEGORY_TTL_DAYS);
export const IMPORTANCES = ['P1', 'P2', 'P3'];
export const STATUSES = ['active', 'stale', 'dismissed'];
export const SOURCES = ['auto', 'manual'];

export const MAX_CONTENT_LENGTH = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

export function resolveDbPath() {
  if (process.env.STICKIES_DB) return process.env.STICKIES_DB;
  return join(homedir(), '.stickies', 'stickies.db');
}

let _db = null;

// SQLite errors that mean the file is genuinely corrupt (not a transient lock).
function isCorruption(err) {
  return /not a database|malformed|disk image|file is encrypted/i.test(err?.message || '');
}

function openAndInit(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    // Set busy_timeout FIRST: switching journal_mode to WAL needs a lock, and two
    // processes starting together (e.g. the session hook + MCP server) would otherwise
    // race and one would get "database is locked" before any timeout was in effect.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema(db);
    return db;
  } catch (err) {
    // Release the file handle so a corrupt file can be renamed (Windows holds it open).
    try { db.close(); } catch {}
    throw err;
  }
}

// Move a corrupt DB (and its WAL sidecars) aside so a fresh one can be created. The file
// is preserved (renamed, never deleted) for manual recovery.
function quarantineCorruptDb(dbPath) {
  const stamp = `corrupt-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    try {
      if (existsSync(p)) renameSync(p, `${p}.${stamp}`);
    } catch {
      // best effort; if we can't move it, the reopen below will surface the error
    }
  }
  process.stderr.write(
    `stickies: ${dbPath} was unreadable (corrupt); moved aside as ${dbPath}.${stamp} and started a fresh store\n`
  );
}

// Opens (and lazily caches) the SQLite connection, creating the schema if needed.
// On genuine corruption, quarantines the bad file and starts fresh so the tool keeps
// working; transient lock/permission errors propagate.
export function getDb() {
  if (_db) return _db;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  try {
    _db = openAndInit(dbPath);
  } catch (err) {
    if (isCorruption(err) && existsSync(dbPath)) {
      quarantineCorruptDb(dbPath);
      _db = openAndInit(dbPath);
    } else {
      throw err;
    }
  }
  return _db;
}

function initSchema(db) {
  // Base table + indexes that don't reference migration-added columns. For an existing
  // pre-migration DB the CREATE TABLE is a no-op, so we must NOT index project_key here
  // (it may not exist yet) — that index is created after the migration below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stickies (
      id           TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      category     TEXT NOT NULL,
      importance   TEXT NOT NULL,
      project_path TEXT,                       -- NULL means global (machine-specific path)
      project_key  TEXT,                       -- machine-independent project identity (git remote)
      tags         TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
      created_at   TEXT NOT NULL,              -- ISO 8601 UTC
      updated_at   TEXT NOT NULL,
      expires_at   TEXT,                       -- computed from category TTL
      source       TEXT NOT NULL DEFAULT 'auto',
      status       TEXT NOT NULL DEFAULT 'active',
      dismiss_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_stickies_project ON stickies(project_path);
    CREATE INDEX IF NOT EXISTS idx_stickies_status  ON stickies(status);
    CREATE INDEX IF NOT EXISTS idx_stickies_expires ON stickies(expires_at);
  `);

  // Migration: add project_key to DBs created before it existed. Old rows keep
  // project_key NULL and continue to match by project_path (handled in reads).
  const cols = db.prepare(`PRAGMA table_info(stickies)`).all();
  if (!cols.some((c) => c.name === 'project_key')) {
    try {
      db.exec(`ALTER TABLE stickies ADD COLUMN project_key TEXT`);
    } catch (err) {
      // Concurrent first-run: another process added the column between our check and
      // the ALTER. Anything other than that is a real error.
      if (!/duplicate column name/i.test(err?.message || '')) throw err;
    }
  }

  // Safe now that project_key is guaranteed to exist (fresh schema or just migrated).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stickies_key ON stickies(project_key)`);
}

// Test/maintenance helper: close the cached connection.
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
