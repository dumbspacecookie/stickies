// Derives a machine-independent identity for a project, so project-scoped stickies match
// the same logical project across machines (different filesystem paths).
//
// Key = the project's git remote, canonicalized: `git:<host>/<owner>/<repo>`. SSH and
// HTTPS remotes for the same repo canonicalize identically. If the directory isn't a git
// repo (or has no remote), we fall back to `path:<normalized path>` — stable on one
// machine, which is the best we can do without a remote.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { normalizeProjectPath, projectIdentity } from './store-path.js';

// A cache, not a ledger. Every write goes through here, and the path comes from whoever is
// calling — the MCP tool takes it from the agent, the dashboard from the request, the hooks
// from cwd. An unbounded Map keyed on caller-supplied strings is a memory leak with a friendly
// face: a dashboard left running for a week accumulates one entry per path anyone ever named,
// including the misspelled ones. Bounded, least-recently-used first out.
const CACHE_MAX = 512;
const cache = new Map(); // normalized path -> key, in least-recently-used order

// How many times we have actually had to start a `git` process. Exported through _stats() for
// the tests, because the property that matters here — "the hot path does not spawn" — cannot be
// asserted by timing without the test becoming a coin toss on a loaded machine.
let spawns = 0;

// Least-recently-used bookkeeping. A Map iterates in insertion order, so re-inserting on read
// is all the recency tracking this needs.
function cacheGet(np) {
  if (!cache.has(np)) return undefined;
  const key = cache.get(np);
  cache.delete(np);
  cache.set(np, key);
  return key;
}

function cacheSet(np, key) {
  cache.delete(np);
  cache.set(np, key);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return key;
}

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

// The last resort: ask git itself. Kept for the cases the cheap path below deliberately refuses
// to guess at (an `[include]` directive, a value we cannot parse, a worktree whose config we
// cannot find). Measured at ~30 ms per call on Windows — a process launch, and this runs on the
// single-threaded event loop that also serves the dashboard and the MCP server, so 30 ms is 30 ms
// during which nothing else happens. A write costs 0.6 ms without it.
function spawnGitRemote(projectPath) {
  spawns++;
  try {
    const r = spawnSync('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true, // no console flash on Windows
    });
    if (r.status === 0) return r.stdout.trim();
  } catch {
    // git missing or path invalid
  }
  return null;
}

// Find the git directory for a path by walking up, exactly as git does. `existsSync` on a handful
// of parents costs microseconds; a process launch costs tens of milliseconds. The common case
// this kills outright is a project that is NOT a repo at all — every note written for it used to
// pay for a `git` process that was only ever going to say "not a repository".
function findGitDir(startPath) {
  let dir = startPath;
  // Depth guard rather than a while(true): a path whose parent chain does not terminate (a
  // symlink cycle, a malformed UNC path) must not hang the process that is trying to save a note.
  for (let depth = 0; depth < 64; depth++) {
    const dot = join(dir, '.git');
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isDirectory()) return dot;
        // A linked worktree or a submodule: `.git` is a FILE holding `gitdir: <path>`.
        const m = readFileSync(dot, 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/m);
        if (!m) return null;
        return isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
      } catch {
        return null; // unreadable — hand it back to git
      }
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

// A git config value, unescaped the way git writes it. Returns null for anything we are not
// willing to interpret — the caller then pays for a real `git config --get` rather than guessing.
//
// This is not pedantry: `git clone C:\repos\notes.git` stores the url as `C:\\repos\\notes.git`,
// so a parser that treats a backslash as literal produces a DIFFERENT project key from the one
// git would report, and a note written before this change becomes invisible after it.
function parseConfigValue(raw) {
  const ESCAPES = { '\\': '\\', '"': '"', n: '\n', t: '\t', b: '\b' };
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      // A trailing backslash continues the value onto the next line. We read line by line, so
      // that is git's job, not ours.
      if (next === undefined || !(next in ESCAPES)) return null;
      out += ESCAPES[next];
      i++;
      continue;
    }
    if (ch === '"') { quoted = !quoted; continue; }
    // Outside quotes, `#` and `;` start a comment.
    if (!quoted && (ch === '#' || ch === ';')) break;
    out += ch;
  }
  if (quoted) return null; // unterminated quote: not our business to repair
  // git strips trailing whitespace from unquoted values. A remote URL with meaningful trailing
  // spaces does not exist, so trimming unconditionally costs nothing and avoids tracking where
  // the quotes were.
  return out.trim();
}

// Read remote.origin.url straight out of the repo's config file.
//
// Returns { parsed: false } whenever the answer might not be the whole story, and the caller then
// pays for the real `git config --get`. Being wrong here is not a performance problem, it is a
// correctness problem: the key derived from a remote is what makes a note written on one machine
// visible on another, so a guess that misses a remote silently splits one project into two.
function originUrlFromConfig(gitDir) {
  let text;
  try {
    text = readFileSync(join(gitDir, 'config'), 'utf8');
  } catch {
    return { parsed: false }; // e.g. a worktree whose config lives in the common dir
  }
  // `[include]` / `[includeIf …]` can pull a remote in from another file. We do not follow them.
  if (/^\s*\[\s*include(if)?\b/im.test(text)) return { parsed: false };

  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([^\]]*)\]/);
    if (header) { section = header[1].trim().toLowerCase().replace(/\s+/g, ' '); continue; }
    if (section !== 'remote "origin"') continue;
    const kv = line.match(/^url\s*=\s*(.*)$/i);
    if (!kv) continue;
    const value = parseConfigValue(kv[1]);
    if (value === null) return { parsed: false };
    return { parsed: true, url: value || null };
  }
  return { parsed: true, url: null }; // a real repo that simply has no origin remote
}

function gitRemote(projectPath) {
  const gitDir = findGitDir(projectPath);
  if (!gitDir) return null; // not a repo: there was never anything for git to tell us
  const fromConfig = originUrlFromConfig(gitDir);
  if (fromConfig.parsed) return fromConfig.url;
  return spawnGitRemote(projectPath);
}

// Returns the project key for a path, or null for a global (no path).
export function deriveProjectKey(projectPath) {
  const np = normalizeProjectPath(projectPath);
  if (!np) return null;
  const cached = cacheGet(np);
  if (cached !== undefined) return cached;

  const remote = gitRemote(np);
  // The path fallback keys on projectIdentity, not the stored path: on Windows two spellings of
  // one directory must produce ONE key, or a note written from a shell that capitalised the path
  // differently is invisible from the other. A git remote already has this property.
  const key = (remote && canonicalizeRemote(remote)) || `path:${projectIdentity(np)}`;
  return cacheSet(np, key);
}

export function _clearCache() {
  cache.clear();
  spawns = 0;
}

// Test seam. `spawns` is the number that matters: the fix is "stop launching a process per
// never-seen path", and a timing assertion for that would be flaky by construction.
export function _stats() {
  return { size: cache.size, max: CACHE_MAX, spawns };
}
