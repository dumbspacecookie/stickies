// Sync engine (offline core). Serializes all stickies to a single JSON "sync document"
// that a git repo can version, and merges a sync document back into the local DB with
// last-writer-wins per record. The actual `git pull/push` wiring is layered on top of
// this in a later step — this module never touches the network.
//
// Merge model: identity is the sticky uuid; conflicts resolve by `updated_at` (newest
// wins). This is conflict-free for our data (whole-record LWW), so two machines that
// both edit then sync converge deterministically regardless of order.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { exportAllRows, upsertFromSync } from './store.js';

export const SYNC_SCHEMA_VERSION = 1;

// Where the versioned sync document lives. Override with $STICKIES_SYNC_FILE (this is the
// file inside your git repo once sync is wired up).
export function resolveSyncPath() {
  if (process.env.STICKIES_SYNC_FILE) return process.env.STICKIES_SYNC_FILE;
  return join(homedir(), '.stickies', 'sync', 'stickies.json');
}

// Build the sync document from the local DB. Deterministic for a given DB state — no
// volatile fields (e.g. an export timestamp) so that re-exporting unchanged data yields
// byte-identical output and git records no spurious commit. exportAllRows() is already
// ordered by created_at.
export function buildExport() {
  return {
    meta: {
      schema_version: SYNC_SCHEMA_VERSION,
      generator: 'stickies',
    },
    stickies: exportAllRows(),
  };
}

// Merge a parsed sync document into the local DB. Returns a tally.
export function applyImport(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.stickies)) {
    throw new Error('invalid sync document: expected { stickies: [...] }');
  }
  if (doc.meta && doc.meta.schema_version > SYNC_SCHEMA_VERSION) {
    throw new Error(
      `sync document schema ${doc.meta.schema_version} is newer than supported ${SYNC_SCHEMA_VERSION}; update stickies`
    );
  }

  const tally = { added: 0, updated: 0, skipped: 0, total: doc.stickies.length };
  for (const rec of doc.stickies) {
    tally[upsertFromSync(rec)]++;
  }
  return tally;
}

export function exportToFile(path = resolveSyncPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const doc = buildExport();
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { path, count: doc.stickies.length };
}

export function importFromFile(path = resolveSyncPath()) {
  if (!existsSync(path)) {
    return { added: 0, updated: 0, skipped: 0, total: 0, missing: true };
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return applyImport(doc);
}
