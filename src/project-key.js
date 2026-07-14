// Derives a machine-independent identity for a project, so project-scoped stickies match
// the same logical project across machines (different filesystem paths).
//
// Key = the project's git remote, canonicalized: `git:<host>/<owner>/<repo>`. SSH and
// HTTPS remotes for the same repo canonicalize identically. If the directory isn't a git
// repo (or has no remote), we fall back to `path:<normalized path>` — stable on one
// machine, which is the best we can do without a remote.

import { spawnSync } from 'node:child_process';
import { normalizeProjectPath } from './store-path.js';

const cache = new Map(); // normalized path -> key

function cleanPath(p) {
  return String(p).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

// Canonicalize a git remote to a stable identity. Network remotes (GitHub, GitLab, …)
// collapse SSH/HTTPS to `git:host/owner/repo`. Local/file remotes key off the remote
// path (shared by every clone of it) as `git:local/<normalized remote path>`.
export function canonicalizeRemote(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;

  // scp-like: git@github.com:owner/repo.git
  const scp = s.match(/^[^/@]+@([^:/]+):(.+)$/);
  if (scp) {
    const host = scp[1].toLowerCase();
    const path = cleanPath(scp[2]);
    return host && path ? `git:${host}/${path}` : null;
  }

  try {
    const u = new URL(s);
    if (u.protocol === 'file:') {
      const local = normalizeProjectPath(decodeURIComponent(u.pathname));
      return local ? `git:local/${cleanPath(local)}` : null;
    }
    if (u.host) {
      const path = cleanPath(u.pathname);
      return path ? `git:${u.host.toLowerCase()}/${path}` : null;
    }
  } catch {
    // not a URL — treat as a local filesystem path below
  }

  // Local filesystem remote (e.g. C:\repos\x.git or /srv/git/x.git): key off the path,
  // which is identical for every working copy cloned from it.
  const local = normalizeProjectPath(s);
  return local ? `git:local/${cleanPath(local)}` : null;
}

function gitRemote(projectPath) {
  try {
    const r = spawnSync('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (r.status === 0) return r.stdout.trim();
  } catch {
    // git missing or path invalid
  }
  return null;
}

// Returns the project key for a path, or null for a global (no path).
export function deriveProjectKey(projectPath) {
  const np = normalizeProjectPath(projectPath);
  if (!np) return null;
  if (cache.has(np)) return cache.get(np);

  const remote = gitRemote(np);
  const key = (remote && canonicalizeRemote(remote)) || `path:${np}`;
  cache.set(np, key);
  return key;
}

export function _clearCache() {
  cache.clear();
}
