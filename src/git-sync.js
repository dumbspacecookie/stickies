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
import { join } from 'node:path';
import { importFromFile, exportToFile } from './sync.js';

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function resolveSyncRepo() {
  return process.env.STICKIES_SYNC_REPO || null;
}

// Auto-sync is opt-in: it only runs when STICKIES_AUTO_SYNC is truthy AND a sync repo is
// configured. This keeps git operations from happening behind the user's back.
export function autoSyncEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.STICKIES_AUTO_SYNC || '') && !!resolveSyncRepo();
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
