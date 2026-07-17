// Git-backed sync: pull → merge → export → commit → push against a git working copy
// that holds the sync document. This is the only part of Stickies that can reach the
// network, and only if the configured repo has a remote — pull/push are skipped for a
// purely local repo, so the whole flow is testable offline.
//
// Config: $STICKIES_SYNC_REPO = path to a git working copy you own (e.g. a clone of a
// private repo). The sync file defaults to <repo>/stickies.json.
//
// All git calls use argument arrays (never a shell string), so repo paths and messages
// cannot inject shell commands.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { importFromFile, exportToFile } from './sync.js';
import { resolveDbPath } from './db.js';

// windowsHide stops each git call flashing a console window on Windows. A sync fires
// several of these back to back, so without it a single dismiss strobes the desktop.
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function resolveSyncRepo() {
  return process.env.STICKIES_SYNC_REPO || null;
}

// A store under the OS temp dir is a scratch/test database, never the operator's corpus.
// Publishing one is always wrong: a test that points STICKIES_DB at a temp file but
// inherits the real STICKIES_AUTO_SYNC + STICKIES_SYNC_REPO would export its fixtures into
// the shared sync file, commit them, and push — after which every machine that syncs pulls
// the fixtures in as real notes. That is exactly how ~40% of a live corpus became
// GLOBAL_TASK/LOCAL_TASK rows, one pair per `npm test` run.
//
// Guarding here rather than in each test kills the whole class: a test cannot leak by
// forgetting to blank the sync vars. Real stores live in ~/.stickies or a user-chosen
// path; nobody keeps the notes they care about in %TEMP%, so this has no false positives.
// The sync machinery's own end-to-end tests must sync a temp DB on purpose (two temp DBs
// standing in for two machines). STICKIES_ALLOW_SCRATCH_SYNC=1 opts a temp store back in.
// This is safe against the leak it guards: the leak needs the REAL session to carry sync
// vars that reach a temp DB, and a real session never sets this flag — only the sync tests
// do. The inheritance only ever runs test→real for AUTO_SYNC/SYNC_REPO, never this.
export function isScratchDb(dbPath = resolveDbPath()) {
  if (/^(1|true|yes|on)$/i.test(process.env.STICKIES_ALLOW_SCRATCH_SYNC || '')) return false;
  try {
    const norm = (p) => resolve(String(p)).replace(/\\/g, '/').toLowerCase();
    const tmp = norm(tmpdir()).replace(/\/$/, '');
    return norm(dbPath).startsWith(tmp + '/');
  } catch {
    return false; // unreadable path: fall back to the existing opt-in gate
  }
}

// Auto-sync is opt-in: it only runs when STICKIES_AUTO_SYNC is truthy AND a sync repo is
// configured AND the store is a real one (not a temp/test DB — see isScratchDb).
// This keeps git operations from happening behind the user's back.
export function autoSyncEnabled() {
  if (!/^(1|true|yes|on)$/i.test(process.env.STICKIES_AUTO_SYNC || '')) return false;
  if (!resolveSyncRepo()) return false;
  if (isScratchDb()) return false;
  return true;
}

// Best-effort sync used by the session hooks. Never throws — returns null when disabled
// and { error } on failure, so a sync problem can't break a session.
export function maybeAutoSync() {
  if (!autoSyncEnabled()) return null;
  try {
    const repo = resolveSyncRepo();
    if (!isGitRepo(repo)) return null;
    return sync({ repo });
  } catch (err) {
    return { error: err.message };
  }
}

export function isGitRepo(repo) {
  return existsSync(repo) && git(repo, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

function hasRemote(repo) {
  return git(repo, ['remote']).out.length > 0;
}

// Run a full sync cycle. Returns { repo, file, steps[], counts }.
export function sync({ repo = resolveSyncRepo(), file } = {}) {
  if (!repo) {
    throw new Error('Set $STICKIES_SYNC_REPO to a git working copy that holds the sync file.');
  }
  if (!isGitRepo(repo)) {
    throw new Error(`${repo} is not a git repository. Clone your stickies-data repo there first.`);
  }
  const syncFile = file || join(repo, 'stickies.json');
  const remote = hasRemote(repo);
  const steps = [];

  // 1. Pull remote state (fast-forward only; non-fatal on conflict/no-upstream).
  if (remote) {
    const pull = git(repo, ['pull', '--ff-only']);
    steps.push(pull.code === 0 ? 'pull: ok' : `pull: skipped (${(pull.err || pull.out).split('\n')[0]})`);
  } else {
    steps.push('pull: no remote (local-only)');
  }

  // 2. Merge whatever the file holds into the local DB (last-writer-wins).
  const imp = importFromFile(syncFile);
  steps.push(imp.missing ? 'import: no file yet' : `import: +${imp.added} added, ${imp.updated} updated`);

  // 3. Write merged local state back out.
  const exp = exportToFile(syncFile);
  steps.push(`export: ${exp.count} stickies`);

  // 4. Commit only if the sync file actually changed (scoped so unrelated repo files
  //    don't trigger a commit, and a clean tree reports "nothing changed" not a failure).
  git(repo, ['add', syncFile]);
  const dirty = git(repo, ['status', '--porcelain', '--', syncFile]).out.length > 0;
  if (dirty) {
    const commit = git(repo, ['commit', '-m', `stickies sync ${new Date().toISOString()}`]);
    steps.push(commit.code === 0 ? 'commit: ok' : `commit: failed (${commit.err.split('\n')[0]})`);
    // 5. Push if there is a remote.
    if (remote) {
      const push = git(repo, ['push', '-u', 'origin', 'HEAD']);
      steps.push(push.code === 0 ? 'push: ok' : `push: failed (${(push.err || push.out).split('\n')[0]})`);
    }
  } else {
    steps.push('commit: nothing changed');
  }

  return { repo, file: syncFile, steps, counts: { added: imp.added || 0, updated: imp.updated || 0, total: exp.count } };
}
