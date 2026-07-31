// `stickies doctor` — one command that answers "why isn't this working".
//
// Written after a session where four separate things were silently broken at once: the
// statusline's Ctrl+click pointed at a port nobody was serving, `--detach` reported success
// for a server that had died, the dashboard was welded to one project, and — the nastiest —
// hook-side code changes never ran because the plugin cache held a stale copy at the SAME
// version number, so no update would refresh it. Every one of those was invisible. Each check
// below exists because it would have caught one of them in a second.
//
// Contract: read-only. Never writes, never starts anything, never fetches, never throws — a check
// that can't run reports 'unknown' and the rest still complete.
//
// "Read-only" is enforced here, not assumed: the store is opened with readOnly:true rather than
// through store.js (whose read path sweeps expired rows, which is an UPDATE), and the sync check
// reads local git refs only. The rule earns its keep twice — a diagnostic that mutates the thing
// it is diagnosing cannot be trusted about it, and a diagnostic that needs write access reports
// the wrong fault on exactly the broken machine you ran it for.

import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from './db.js';
import { engineStamp, declaredStamp } from './engine-stamp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..'); // the copy of Stickies actually executing

// ok = working, warn = works but you should know, bad = broken, unknown = couldn't determine.
const STATUS_ICON = { ok: '✓', warn: '!', bad: '✗', unknown: '?' };

function check(name, status, detail, fix) {
  return { name, status, detail, ...(fix ? { fix } : {}) };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Can we write here? Asked, never attempted: a doctor that "checks" writability by writing a
// probe file has stopped being read-only, which is the whole complaint this answers. accessSync
// is an ask, and on Windows it reflects the read-only attribute.
function isWritable(path) {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

// --- 1. is a dashboard listening, and is it ours? ------------------------------------------
async function checkDashboard() {
  const { probeHealth, dashboardPort, autostartEnabled } = await import('./dashboard-autostart.js');
  const port = dashboardPort();
  let health;
  try { health = await probeHealth(port, 900); } catch { health = null; }

  if (health && health !== 'foreign') {
    // The URL is the single most useful token at 2am, and the line used to omit it. It stays the
    // BARE url on purpose: doctor output is meant to be paste-safe, and the authorized link
    // carries a secret that gates every note on this machine. Point at `--link` instead — the
    // one command that prints it, to a person who asked for it.
    const { authEnabled, readAuthKey } = await import('./dashboard-auth.js');
    const how = !authEnabled()
      ? ' — reads are UNAUTHENTICATED (STICKIES_DASHBOARD_AUTH=0)'
      : readAuthKey()
        ? ' — reads need an authorized link: `stickies dashboard --link`'
        : ' — no read key on disk yet; restart the dashboard to write one';
    return check('dashboard', 'ok',
      `http://127.0.0.1:${port}/ — pid ${health.pid}, launched from ${health.project || '(global view)'}` +
      ` (stop it with \`stickies dashboard --stop\`)${how}`);
  }
  if (health === 'foreign') {
    return check('dashboard', 'bad', `port ${port} is held by something that isn't Stickies`,
      `free the port, or set STICKIES_DASHBOARD_PORT to another one`);
  }
  return check('dashboard', 'bad', `nothing listening on 127.0.0.1:${port} — the statusline's Ctrl+click has nowhere to land`,
    autostartEnabled()
      ? 'start one now with `stickies dashboard --detach` (a new Claude session would also start it)'
      : 'autostart is off by default — run `stickies dashboard --detach`, or set STICKIES_DASHBOARD_AUTOSTART=1 to have sessions start one');
}

// --- 2. the trap: is the installed plugin copy stale? -------------------------------------
// Hooks run from ${CLAUDE_PLUGIN_ROOT} (the plugin cache), NOT from wherever you edit. If the
// cache holds different bytes at the same version, no plugin update will refresh it and every
// hook-side change you make is a no-op — with nothing on screen to say so.
function hashTree(dir) {
  const files = new Map();
  const walk = (d, base) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, base);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
        try {
          files.set(relative(base, full).replace(/\\/g, '/'),
            createHash('sha1').update(readFileSync(full)).digest('hex'));
        } catch { /* unreadable file — skip */ }
      }
    }
  };
  walk(dir, dir);
  return files;
}

// Which files the HOOKS actually execute. Read straight out of hooks/hooks.json rather than
// hardcoded, so this keeps up as hooks change. Returns repo-relative posix paths.
function hookEntrypoints(root) {
  const cfg = readJson(join(root, 'hooks', 'hooks.json'));
  const found = new Set();
  const scan = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+\.m?js)/g)) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  if (cfg) scan(cfg);
  return [...found];
}

// Resolve a relative import against a repo-relative dir, posix-style, collapsing '..'.
function relJoin(baseDir, spec) {
  const out = [];
  for (const p of (baseDir ? baseDir.split('/') : []).concat(spec.split('/'))) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

// Transitive closure of relative imports (static and dynamic) from the hook entrypoints. This is
// what separates "hooks are silently not running your changes" from "only the dashboard/CLI side
// differs" — a distinction that matters, because during normal development the installed copy is
// behind almost constantly and a check that shouts every time gets ignored.
function hookReachable(root, entrypoints) {
  const seen = new Set();
  const queue = entrypoints ? entrypoints.slice() : hookEntrypoints(root);
  while (queue.length) {
    const rel = queue.shift().replace(/^\.\//, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(relJoin(dir, m[1] || m[2]));
    }
  }
  return seen;
}

function versionOf(root) {
  const pkg = readJson(join(root, 'package.json'));
  const plug = readJson(join(root, '.claude-plugin', 'plugin.json'));
  return { pkg: pkg?.version ?? null, plugin: plug?.version ?? null };
}

function checkPluginCache() {
  const installed = readJson(join(claudeDir(), 'plugins', 'installed_plugins.json'));
  if (!installed) {
    return check('plugin install', 'unknown', 'no ~/.claude/plugins/installed_plugins.json — Stickies may not be installed as a plugin');
  }
  const entry = Object.entries(installed.plugins || {}).find(([name]) => /^stickies@/.test(name));
  if (!entry) {
    return check('plugin install', 'warn', 'Stickies is not installed as a Claude Code plugin (no hooks: no session digest, no auto-capture)',
      'install it from your marketplace, or wire the hooks by hand in settings.json');
  }
  const [pluginName, installs] = entry;
  const installPath = installs?.[0]?.installPath;
  if (!installPath || !existsSync(installPath)) {
    return check('plugin install', 'bad', `${pluginName} points at a missing install path (${installPath || 'none'})`,
      'reinstall the plugin');
  }

  // Normalizing both sides means "am I the installed copy?" is a real comparison, not a
  // slash-direction accident.
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(installPath) === norm(ROOT)) {
    return check('plugin install', 'ok', `hooks run from this very copy (${installPath})`);
  }

  const ours = hashTree(join(ROOT, 'src'));
  const theirs = hashTree(join(installPath, 'src'));
  const missing = [...ours.keys()].filter((f) => !theirs.has(f));
  const differing = [...ours.keys()].filter((f) => theirs.has(f) && theirs.get(f) !== ours.get(f));
  const vOurs = versionOf(ROOT);
  const vTheirs = versionOf(installPath);
  const sameVersion = vOurs.plugin === vTheirs.plugin;

  if (!missing.length && !differing.length) {
    return check('plugin install', 'ok', `installed copy matches this one (v${vTheirs.plugin ?? '?'} at ${installPath})`);
  }

  // Severity turns on whether the drift touches code the hooks execute. Anything else (the
  // dashboard, the CLI, the board pages) is served from wherever you launch it, so a stale
  // installed copy is a note, not a fault.
  const hookFiles = hookReachable(ROOT);
  // The dashboard is not IMPORTED by a hook — it is SPAWNED by one, from the plugin cache's own
  // src/. So a stale install means the autostarted board serves old code (old writeback, old
  // board page) even though no hook imports any of it. That is a real staleness, but a milder
  // one than "your SessionStart hook is running last week's logic": you can always launch your
  // own dashboard from the working tree. Third category, said out loud rather than conflated.
  const spawnedFiles = hookReachable(ROOT, ['src/dashboard.js']);
  const drifted = [...new Set([...differing, ...missing])].sort();
  const reaches = (set) => (f) => set.has('src/' + f) || set.has(f);
  const hookDrift = drifted.filter(reaches(hookFiles));
  const spawnDrift = drifted.filter((f) => !reaches(hookFiles)(f) && reaches(spawnedFiles)(f));
  const sample = (list) => list.slice(0, 4).join(', ') + (list.length > 4 ? `, +${list.length - 4} more` : '');
  const drift = `${differing.length} file(s) differ, ${missing.length} missing`;

  if (!sameVersion) {
    return check('plugin install', 'warn',
      `installed copy is v${vTheirs.plugin ?? '?'}, this one is v${vOurs.plugin ?? '?'} — ${drift}`,
      `reinstall the plugin (/plugin, or \`claude plugin update stickies@<marketplace>\`) to pick up v${vOurs.plugin ?? '?'}`);
  }
  if (hookDrift.length) {
    return check('plugin install', 'bad',
      `installed copy is STALE at the SAME version (v${vTheirs.plugin}) — ${drift}, so no plugin update will refresh it. ` +
      `${hookDrift.length} of those run inside the hooks (${sample(hookDrift)}), so SessionStart/auto-capture are NOT running your current code.`,
      `bump "version" in package.json AND .claude-plugin/plugin.json, then reinstall the plugin`);
  }
  if (spawnDrift.length) {
    return check('plugin install', 'warn',
      `installed copy is behind at the same version (v${vTheirs.plugin}) — ${drift}. No hook IMPORTS the drifted files, ` +
      `but ${spawnDrift.length} of them (${sample(spawnDrift)}) belong to the dashboard, which SessionStart spawns from the ` +
      `installed copy — so an autostarted board is serving this older code. One you launch yourself runs your current code.`,
      `bump the version and reinstall, or use a dashboard you started from this folder (\`stickies dashboard --stop\` first)`);
  }
  return check('plugin install', 'warn',
    `installed copy is behind at the same version (v${vTheirs.plugin}) — ${drift} (${sample(drifted)}), but none of it runs inside the hooks. ` +
    `The dashboard and CLI run from wherever you launch them, so this only matters for a fresh install.`,
    `bump the version and reinstall when you want the installed copy to match`);
}

// Strip line comments so a `--project` written in prose is not read as configuration. Crude on
// purpose: it only has to stop a comment from being mistaken for an argument.
function withoutComments(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// True when the flow (board) segment itself is invoked with --project. Looks only at the text
// between that segment's path and the end of its own invocation — the next newline, the next
// statusline script mentioned, or a closing bracket/paren.
export function pinsFlowSegment(text) {
  const src = withoutComments(text);
  const re = /flow[\\/]statusline\.js/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(m.index + m[0].length);
    // The invocation ends where this segment's argument list does — its closing bracket/paren,
    // or wherever another statusline script is named. NOT at the first newline: a real composer
    // puts each argument on its own line, so a genuine `--project` usually sits several lines
    // below the path it belongs to.
    // A later segment is always path-qualified (`b/src/statusline.js`), so the boundary search
    // must NOT require a non-path character before it — `/` is a path character, so requiring
    // one meant the scan never stopped and ran to the end of the whole composer.
    const stop = Math.min(
      ...[rest.search(/statusline\.js/), rest.indexOf(']'), rest.indexOf(')')]
        .map((i) => (i === -1 ? rest.length : i))
    );
    if (/--project\b/.test(rest.slice(0, stop))) return true;
  }
  return false;
}

// --- 3. is the statusline wired, and is it pinned to one project? -------------------------
function checkStatusline() {
  const settings = readJson(join(claudeDir(), 'settings.json'));
  const command = settings?.statusLine?.command;
  if (!command) {
    return [check('statusline', 'warn', 'no statusLine configured in ~/.claude/settings.json',
      'point statusLine.command at src/statusline.js (see README)')];
  }
  // The command may call Stickies directly, or a composer script that calls it. Follow one hop —
  // ALWAYS, and append rather than replace. Following only when the command didn't already
  // mention "stickies" meant a composer whose own path contained that word (a folder named
  // whose own name contains "stickies") was never opened, so anything configured inside it — a --project pin
  // — went unreported. Appending also keeps whatever the raw command itself said.
  let text = String(command);
  let via = null;
  const m = text.match(/"([^"]+\.(?:mjs|js|cjs))"|(\S+\.(?:mjs|js|cjs))/);
  const scriptPath = m && (m[1] || m[2]);
  if (scriptPath && existsSync(scriptPath)) {
    try { text += '\n' + readFileSync(scriptPath, 'utf8'); via = scriptPath; } catch { /* keep the raw command */ }
  }
  if (!/stickies/i.test(text)) {
    return [check('statusline', 'warn', `statusLine is configured but does not reference Stickies${via ? ` (checked ${via})` : ''}`,
      'add the Stickies segment (see README)')];
  }

  const out = [check('statusline', 'ok', `wired${via ? ` via ${via}` : ''}`)];

  // A --project pin makes a segment ignore your current folder. That's a legitimate choice,
  // but it is invisible in the rendered line, so say it out loud.
  //
  // Scan the flow segment's own invocation, not "anything within 400 characters": a `--project`
  // belonging to a LATER segment, or merely mentioned in a comment, used to be reported as a pin
  // on the board segment — telling the user to remove an argument that was not there.
  //
  // Reported as `ok`, not `warn`. A pin is a configuration someone had to type on purpose, and
  // there is no way from here to tell a deliberate one from a mistake — so warning on it means
  // warning forever at the person who meant it. A permanent alarm on a working setup is how a
  // check trains you to skim past the ones that matter. State the consequence, name both
  // directions, and let the reader decide which one they wanted.
  if (pinsFlowSegment(text)) {
    out.push(check('statusline pin', 'ok',
      'the board (📋) segment is pinned with --project, so it always shows ONE project regardless of your folder',
      `intentional? nothing to do. Otherwise drop the --project argument in ${via || 'your statusline command'} and the segment will follow the active folder`));
  }

  if (process.platform === 'win32' && !process.env.FORCE_HYPERLINK) {
    out.push(check('statusline link', 'warn',
      'FORCE_HYPERLINK is not set — on Windows the segment renders but is not Ctrl+clickable',
      'setx FORCE_HYPERLINK 1, then restart Claude Code'));
  }
  if (process.env.TMUX) {
    out.push(check('statusline link', 'warn', 'running under tmux, which mangles OSC-8 — the link is deliberately skipped'));
  }
  return out;
}

// --- 4. the store ------------------------------------------------------------------------
// "Read-only" at the top of this file is a contract, not a mood, and this check used to break it.
// Counting the notes the obvious way — `readStickies()` — runs `sweepExpired()` first, an UPDATE
// that flips every past-TTL row to 'stale' AND rewrites its `updated_at`. That column is the one
// sync resolves last-writer-wins on, so merely ASKING doctor how many notes you had re-dated rows
// on the diagnosing machine and made them win the next merge. A diagnostic that changes the thing
// it is diagnosing has no business being trusted about it.
//
// The second consequence was worse, because it pointed at the wrong suspect. On a store that
// cannot be written — a file gone read-only, a directory the user no longer owns, a notes folder
// restored from a backup with its permissions intact — that UPDATE throws, and the old code
// reported `store: bad — cannot read <path>: attempt to write a readonly database`. It blamed the
// READ for a WRITE failure, in the one command whose entire job is to say what is actually wrong.
//
// So doctor opens its own connection with readOnly:true and counts the rows itself, applying by
// hand the same expiry rule sweepExpired would have applied. Same number, no write. Then it says
// out loud whether the store can be written, because on a read-only store nothing else works
// either: no new note, no dismissal, no sweep.
async function checkStore() {
  const dbPath = resolveDbPath();
  const out = [];
  if (!existsSync(dbPath)) {
    // Not a fault. The store is created by the first write, and doctor is not allowed to be that
    // write — saying "no store yet" is both true and the answer the reader needs.
    out.push(check('store', 'ok', `no store yet at ${dbPath} — it is created when the first note is written`));
  } else {
    let db = null;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbPath, { readOnly: true });
      const now = new Date().toISOString();
      // `due` = rows sweepExpired would flip on the next real read/write. Subtracting them gives
      // exactly the count readStickies would have returned, without becoming that write.
      const row = db.prepare(
        `SELECT COUNT(*) AS active,
                SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS due
           FROM stickies
          WHERE status = 'active'`
      ).get(now);
      const active = Number(row?.active ?? 0);
      const due = Number(row?.due ?? 0);
      const size = statSync(dbPath).size;
      out.push(check('store', 'ok',
        `${active - due} active note(s), ${(size / 1024).toFixed(0)} KB at ${dbPath}` +
        (due ? ` (${due} past their TTL — they go stale on the next read or write, not on this one: doctor never writes)` : '')));
    } catch (err) {
      const msg = String(err?.message || err);
      if (/no such table/i.test(msg)) {
        out.push(check('store', 'warn', `${dbPath} exists but holds no stickies table yet — nothing has been written to it`,
          'write a note (or start the dashboard) and the schema is created'));
      } else {
        out.push(check('store', 'bad', `cannot read ${dbPath}: ${msg}`,
          'if the file is corrupt, move it aside — Stickies starts a fresh store and keeps the old one'));
      }
      return out;
    } finally {
      try { db?.close(); } catch { /* nothing left to release */ }
    }

    // Readable and un-writable is a real and confusing state: everything LOOKS fine until the
    // first note vanishes with a SQLite error nobody sees, because writes happen inside hooks.
    // Name it here, with the message the user would otherwise meet with no context.
    const unwritable = [];
    if (!isWritable(dbPath)) unwritable.push(`the store file ${dbPath}`);
    else if (!isWritable(dirname(dbPath))) unwritable.push(`the directory ${dirname(dbPath)} (SQLite needs it to create the -wal sidecar)`);
    if (unwritable.length) {
      out.push(check('store', 'bad',
        `READ-ONLY store: reads work, but nothing can be written — ${unwritable[0]} is not writable, so new notes, ` +
        `dismissals and TTL sweeps all fail with "attempt to write a readonly database"`,
        process.platform === 'win32'
          ? `clear the read-only flag (\`attrib -R "${dbPath}"\`) or point STICKIES_DB at a path you can write`
          : `restore write permission (\`chmod u+w "${dbPath}"\`) or point STICKIES_DB at a path you can write`));
    }
  }
  try {
    const { isScratchDb } = await import('./git-sync.js');
    if (isScratchDb(dbPath)) {
      out.push(check('store', 'warn', 'the active store is under the OS temp dir — a scratch/test DB, and sync refuses to publish it',
        'unset STICKIES_DB to go back to ~/.stickies/stickies.db'));
    }
  } catch { /* guard unavailable; not fatal */ }
  return out;
}

// --- 5. sync ------------------------------------------------------------------------------
// This check used to ask a configuration question — "is STICKIES_SYNC_REPO a git repo?" — and
// then report `✓ sync <repo> (auto-sync ON)` on a repo that was four commits ahead and one
// behind its remote. In that state `pull --ff-only` refuses and the push is rejected, on every
// cycle, forever, with no recovery path that sync itself will ever take. The notes had not left
// the machine in days and doctor's last line said `Nothing broken`.
//
// It has to be doctor that says this, because everything else is deliberately quiet: sync
// failures are swallowed so that a broken backup can never break a session (maybeAutoSync
// returns `{ error }` and the hook drops it). That is the right call, and it is exactly why the
// only place the failure can surface is the command you run when you suspect something.
//
// Two rules the implementation follows:
//   * Local refs only. No fetch, no network — doctor must not do work behind your back, and it
//     must not hang on an unreachable host. So ahead/behind is measured against the last time
//     something fetched, and the report says so instead of implying it is live.
//   * The remote URL is never printed. It is routinely `https://user:<token>@host/repo`, and
//     this output exists to be pasted into a bug report.
function gitIn(repo, args) {
  try {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  } catch {
    return { code: -1, out: '', err: 'git could not be run' };
  }
}

// Returns { status, detail, fix? } describing whether this repo can still sync. Exported so the
// states can be driven directly against throwaway repos; runDoctor wires it into `sync`.
export function syncHealth(repo, git = gitIn) {
  // A merge or rebase left half-finished stops every future cycle before it starts, and sync's
  // own output ("commit: failed") never explains why.
  const gitDir = git(repo, ['rev-parse', '--git-dir']).out;
  if (gitDir) {
    const abs = gitDir === '.git' || !gitDir.includes('/') ? join(repo, gitDir) : gitDir;
    for (const [marker, what] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase']]) {
      if (existsSync(join(abs, marker))) {
        return {
          status: 'bad',
          detail: `an unfinished ${what} is in progress in the sync repo — every sync cycle fails until it is resolved`,
          fix: `in ${repo}: finish it (\`git ${what} --continue\`) or abandon it (\`git ${what} --abort\`)`,
        };
      }
    }
  }

  const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.out;
  if (head.code !== 0) {
    return { status: 'unknown', detail: `could not read the sync repo's HEAD (${head.err.split('\n')[0] || 'git failed'})` };
  }
  if (branch === 'HEAD') {
    return {
      status: 'bad',
      detail: 'the sync repo has a DETACHED HEAD — sync commits your notes onto no branch, and nothing will ever push them',
      fix: `in ${repo}: \`git checkout main\` (or whichever branch holds your notes)`,
    };
  }

  if (!git(repo, ['remote']).out) {
    // Legitimate and common: a local-only notes repo is a versioned backup on this machine.
    // Nothing is broken, and saying so is not the same as saying it is synced anywhere.
    return { status: 'ok', detail: `local-only on branch ${branch} — no git remote, so nothing leaves this machine` };
  }

  const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.code !== 0) {
    return {
      status: 'bad',
      detail: `branch ${branch} has no upstream — sync commits locally and then skips the push every single time, ` +
        `so nothing has ever reached the remote from this machine`,
      fix: `in ${repo}: \`git push -u origin ${branch}\` once, by hand (sync deliberately will not invent an upstream for you)`,
    };
  }
  const up = upstream.out;

  // `--left-right --count A...B` gives "<commits only in A>\t<commits only in B>" — here,
  // behind and ahead.
  const counts = git(repo, ['rev-list', '--left-right', '--count', `${up}...HEAD`]);
  const [behind, ahead] = counts.out.split(/\s+/).map((n) => parseInt(n, 10));
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return { status: 'unknown', detail: `could not compare ${branch} with ${up} (${counts.err.split('\n')[0] || 'git failed'})` };
  }

  const asOf = 'measured against the last fetch — doctor does not touch the network';
  if (ahead > 0 && behind > 0) {
    return {
      status: 'bad',
      detail: `sync is STUCK: ${branch} is ${ahead} ahead and ${behind} behind ${up}, so the histories have DIVERGED. ` +
        `\`pull --ff-only\` refuses to merge and the push is rejected — every sync cycle fails from here on, and ` +
        `no note has left this machine since. ${asOf}`,
      fix: `in ${repo}: \`git pull --rebase\` (or merge by hand), resolve any conflict in stickies.json, then \`git push\``,
    };
  }
  if (ahead > 0) {
    return {
      status: 'warn',
      detail: `${branch} has ${ahead} commit(s) that have never reached ${up} — sync committed them and the push did not ` +
        `land (rejected, offline, or credentials). ${asOf}`,
      fix: `in ${repo}: run \`git push\` yourself and read what it says — sync swallows that error by design`,
    };
  }
  if (behind > 0) {
    return {
      status: 'warn',
      detail: `${branch} is ${behind} commit(s) behind ${up} — notes from another machine are on the remote and not merged ` +
        `here yet. ${asOf}`,
      fix: `run \`stickies sync\` (or \`git pull --ff-only\` in ${repo}) to take them`,
    };
  }
  return { status: 'ok', detail: `${branch} is in step with ${up} (${asOf})` };
}

async function checkSync() {
  try {
    const { resolveSyncRepo, autoSyncEnabled, isGitRepo } = await import('./git-sync.js');
    const repo = resolveSyncRepo();
    if (!repo) return check('sync', 'ok', 'not configured (nothing syncs on its own)');
    if (!isGitRepo(repo)) {
      return check('sync', 'bad', `STICKIES_SYNC_REPO points at ${repo}, which is not a git repo`, 'clone your notes repo there');
    }
    const mode = autoSyncEnabled() ? 'auto-sync ON' : 'auto-sync off — run `stickies sync`';
    const health = syncHealth(repo);
    return check('sync', health.status, `${repo} (${mode}) — ${health.detail}`, health.fix);
  } catch (err) {
    return check('sync', 'unknown', `could not evaluate sync config: ${err?.message || err}`);
  }
}

// --- 6. does this folder have a board? ---------------------------------------------------
function checkBoard(projectPath) {
  if (!projectPath) return check('flow board', 'unknown', 'no project path given');
  const roadmap = join(projectPath, '.planning', 'ROADMAP.md');
  const snapshot = join(projectPath, '.flow', 'board.json');
  if (existsSync(roadmap)) return check('flow board', 'ok', `derived live from ${roadmap}`);
  if (existsSync(snapshot)) return check('flow board', 'ok', `from the committed snapshot ${snapshot}`);
  return check('flow board', 'warn', `no .planning/ROADMAP.md in ${projectPath} — the 📋 segment stays hidden here`,
    'this is normal for a project that does not use GSD planning');
}

// --- 7. is the engine COMMITTED IN THIS REPO out of date? ---------------------------------
// `stickies init-repo` copies src/repo-mode/engine.mjs into the target repo at
// .stickies/engine.mjs and the user commits it. From that moment the repo runs its own frozen
// copy, in cloud/mobile sessions where nothing else of Stickies exists. install.js refreshes that
// copy on every run — but only if somebody re-runs it, and nothing ever told them to. So a fix to
// the engine lands in the package and never reaches the repos actually executing the code.
//
// That is not a hygiene point, because engine.mjs carries the secret redactor and the directive
// parser. The copy that shipped for three releases was missing nine credential shapes (hf_,
// glpat-, ASIA, xapp-, xoxe, GOCSPX-, fm2_, opaque Bearer, Azure AccountKey) and the armor-header
// fix, and its directive parser was still anchored `^\s*` — the hole a quoted directive in a
// hostile README uses to drive a note write into another project. A repo whose committed engine
// predates those fixes keeps running the old ones forever, and nothing on screen says so.
//
// The handle is `const ENGINE_STAMP = '<12 hex>'`, written by scripts/build-engine.mjs as a
// fingerprint of the inlined security-relevant regions. Same stamp, same redactor and parser.
//
// SCOPE: the repo doctor was pointed at, and only that one. Session markers would hand us every
// project this machine has had a session in, and checking them was rejected twice over — it turns
// a project-scoped command into an unbounded stat of a thousand paths on an interactive run, and
// it prints a list of every repo you work in into output whose entire purpose is being pasted
// into a bug report. `stickies doctor --project <path>` already covers the other repos, one
// deliberate answer at a time.
//
// SEVERITY: warn, not bad. `bad` sets a non-zero exit, and a stale engine is not "Stickies is
// broken" — the notes work, they are being scrubbed by older rules. It is also drift that begins
// the instant the package updates, so `bad` would be a near-permanent red on a working install,
// which is exactly the failure the statusline-pin check above is written to avoid. The words
// carry the weight instead.
const ENGINE_MAX_BYTES = 4 * 1024 * 1024;

// Read the stamp out of an engine copy while trusting nothing about the file. `.stickies/engine.mjs`
// is whatever happens to sit at that path: a directory, a dangling link, a permission-denied file,
// or 50MB of something else. The real engine is ~38 KB, so anything past the cap is answered from
// stat alone rather than read — a diagnostic must not stall on a file that was never ours.
function engineStampAt(path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', why: String(err?.message || err) };
  }
  if (!st.isFile()) return { state: 'not-a-file', what: st.isDirectory() ? 'a directory' : 'not a regular file' };
  if (st.size > ENGINE_MAX_BYTES) return { state: 'oversize', size: st.size };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { state: 'unreadable', why: String(err?.message || err) };
  }
  // COMPUTED from the bytes, not read from the `ENGINE_STAMP` line. That line is the file's own
  // claim about itself, and a claim survives an edit: an installed engine with the containment
  // guard cut out by hand still declared the current stamp, and this check reported "matches the
  // engine this copy installs" over it. Reproduced before this was changed, not theorised.
  //
  // The declared literal is still read, for one thing only — a file with no stamp line at all was
  // generated before stamping existed, which is a distinct and much older state than "generated by
  // a different build", and it earns its own message.
  if (declaredStamp(text) === null) return { state: 'unstamped' };
  return { state: 'stamped', stamp: engineStamp(text) };
}

// Returns { status, detail, fix? }, or null when this project has nothing to say about repo-mode.
// Exported so every state can be driven directly against throwaway directories; runDoctor wires
// it in as `repo engine`. `ourEngine` is injectable for the same reason `syncHealth` takes `git`.
export function repoEngineHealth(projectPath, ourEngine = join(ROOT, 'src', 'repo-mode', 'engine.mjs')) {
  if (!projectPath) return null;
  const installed = join(projectPath, '.stickies', 'engine.mjs');
  const theirs = engineStampAt(installed);

  // Repo-mode is opt-in and most projects never run init-repo. Printing "no engine here" in all
  // of them is a line that always appears and is never actionable — the reliable way to teach a
  // reader to skim the whole report. No .stickies/ at all means there is nothing to report.
  if (theirs.state === 'absent') {
    if (!existsSync(join(projectPath, '.stickies'))) return null;
    return {
      status: 'warn',
      detail: `${projectPath} has a .stickies/ directory but no engine.mjs in it — the repo's own SessionStart and Stop ` +
        `hooks run \`node .stickies/engine.mjs\`, so in this repo nothing is captured and no digest is injected`,
      fix: `in ${projectPath}: re-run \`stickies init-repo\` and commit the restored .stickies/engine.mjs`,
    };
  }

  const refresh = `in ${projectPath}: re-run \`stickies init-repo\` and commit the refreshed .stickies/engine.mjs ` +
    `(doctor only checks the repo it is pointed at — run it in each repo that has one)`;

  if (theirs.state === 'not-a-file') {
    return {
      status: 'warn',
      detail: `${installed} is ${theirs.what}, not the repo-mode engine — the repo's hooks will fail to run it`,
      fix: `remove it, then ${refresh}`,
    };
  }
  if (theirs.state === 'oversize') {
    return {
      status: 'warn',
      detail: `${installed} is ${(theirs.size / (1024 * 1024)).toFixed(1)} MB — the repo-mode engine is ~40 KB, so ` +
        `whatever that file is, it is not the engine and was not left there by \`stickies init-repo\``,
      fix: `check what it is, then ${refresh}`,
    };
  }
  if (theirs.state === 'unreadable') {
    return { status: 'unknown', detail: `cannot read ${installed}: ${theirs.why}` };
  }

  // Nothing to compare against. Only reachable on a damaged install of Stickies itself, but a
  // diagnostic that reports 'ok' because it could not find its own reference is worse than one
  // that says it does not know.
  const ours = engineStampAt(ourEngine);
  if (ours.state !== 'stamped') {
    return {
      status: 'unknown',
      detail: `this repo has ${installed}, but the engine this copy of Stickies would install (${ourEngine}) ` +
        `carries no stamp to compare it with (${ours.state})`,
    };
  }

  // No stamp line at all. This is not "unknown": stamping is what the current engine does, so a
  // copy without it was installed before stamping existed and is by definition older than every
  // stamped release — including the one that fixed the redactor and the parser.
  if (theirs.state === 'unstamped') {
    return {
      status: 'warn',
      detail: `${installed} carries NO ENGINE_STAMP line, so it predates stamping entirely — it is older than every ` +
        `stamped release, including the one that added nine missing credential patterns to its inlined redactor and ` +
        `closed the quoted-directive injection in its parser. Notes captured in this repo are being scrubbed by that ` +
        `older code, and will be until the file is replaced`,
      fix: refresh,
    };
  }

  if (theirs.stamp !== ours.stamp) {
    // A hash cannot say which side is newer — a downgrade of Stickies produces the same mismatch.
    // "Does not match" is the claim the evidence supports; "older" is the likely cause, said as one.
    return {
      status: 'warn',
      detail: `${installed} does NOT match the engine this copy of Stickies installs (repo has stamp ${theirs.stamp}, ` +
        `this copy ships ${ours.stamp}) — almost always an engine committed by an older Stickies, though a local ` +
        `edit to that file looks the same from here. It runs verbatim inside the repo, so its redactor, its ` +
        `directive parser and its write-path guards are the ones from whenever it was installed, not the ones in ` +
        `this package`,
      fix: refresh,
    };
  }

  return { status: 'ok', detail: `${installed} matches the engine this copy installs (stamp ${ours.stamp})` };
}

function checkRepoEngine(project) {
  const health = repoEngineHealth(project);
  return health ? [check('repo engine', health.status, health.detail, health.fix)] : [];
}

export async function runDoctor({ project = process.cwd() } = {}) {
  const checks = [];
  const push = (r) => { Array.isArray(r) ? checks.push(...r) : checks.push(r); };

  // Each check is independently guarded: one throwing must not cost you the other answers.
  const safe = async (fn, name) => {
    try { push(await fn()); } catch (err) { push(check(name, 'unknown', `check failed: ${err?.message || err}`)); }
  };
  await safe(checkDashboard, 'dashboard');
  await safe(checkPluginCache, 'plugin install');
  await safe(checkStatusline, 'statusline');
  await safe(checkStore, 'store');
  await safe(checkSync, 'sync');
  await safe(() => checkBoard(project), 'flow board');
  await safe(() => checkRepoEngine(project), 'repo engine');

  const counts = checks.reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, {});
  return { project, root: ROOT, checks, counts, ok: !counts.bad };
}

// Doctor output exists to be pasted into a bug report — that is the whole point of the command.
// Unredacted it hands over the OS username, the home layout, private repo folder names and the
// location of the notes backup repo. `~` says everything the reader needs and nothing else.
// `--raw` opts back into full paths for someone debugging their own machine.
export function tildify(text, home = homedir()) {
  const s = String(text);
  // A home of "/" or "C:\" would turn every separator into a tilde. Require something with real
  // structure before touching anything.
  if (!home || home.replace(/[\\/]+$/, '').length < 4) return s;
  const bare = home.replace(/[\\/]+$/, '');
  // Both slash directions, the JSON-escaped form (`C:\\Users\\me`, so a serialized report
  // redacts too), and the Git-Bash form (`/c/Users/me`) which this project's own dev shell
  // produces and which used to sail straight through.
  const variants = new Set([
    bare,
    bare.replace(/\\/g, '/'),
    bare.replace(/\//g, '\\'),
    bare.replace(/\\/g, '\\\\'),
    bare.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/'),
  ]);
  let out = s;
  for (const v of variants) {
    if (!v) continue;
    // Escape for a literal match, fold case (Windows hands us both C:\ and c:/), and require the
    // match to END at a separator or a non-path character. Without that boundary,
    // `C:\Users\alexandra` became `~andra` when home was `C:\Users\alex` — a wrong claim about
  // where a file lives, in a report
    // whose whole job is to be accurate.
    const rx = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\\\/]|$|[^\\w.-])', 'gi');
    out = out.replace(rx, '~');
  }
  return out;
}

// Same redaction for the JSON form. The help text used to say "--json is not redacted", which is
// a fine thing to document and a bad default: "run doctor and paste the JSON" is the natural
// thing to ask in an issue, and that output carries the username, the home layout and private
// folder names. Safe by default in both forms; --raw is the single opt-out.
export function redactReport(report, home = homedir()) {
  return JSON.parse(tildify(JSON.stringify(report), home));
}

export function renderDoctor(report, { raw = false, home = homedir() } = {}) {
  const lines = [`Stickies doctor — running from ${report.root}`, ''];
  for (const c of report.checks) {
    lines.push(`  ${STATUS_ICON[c.status] || '?'} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`      → ${c.fix}`);
  }
  lines.push('');
  const bits = ['ok', 'warn', 'bad', 'unknown'].filter((k) => report.counts[k]).map((k) => `${report.counts[k]} ${k}`);
  lines.push(report.ok ? `Nothing broken (${bits.join(', ')}).` : `Problems found (${bits.join(', ')}).`);
  const text = lines.join('\n');
  return raw ? text : tildify(text, home);
}
