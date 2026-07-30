// `stickies doctor` — one command that answers "why isn't this working".
//
// Written after a session where four separate things were silently broken at once: the
// statusline's Ctrl+click pointed at a port nobody was serving, `--detach` reported success
// for a server that had died, the dashboard was welded to one project, and — the nastiest —
// hook-side code changes never ran because the plugin cache held a stale copy at the SAME
// version number, so no update would refresh it. Every one of those was invisible. Each check
// below exists because it would have caught one of them in a second.
//
// Contract: read-only. Never writes, never starts anything, never throws — a check that can't
// run reports 'unknown' and the rest still complete.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from './db.js';

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
  if (pinsFlowSegment(text)) {
    out.push(check('statusline pin', 'warn',
      'the board (📋) segment is pinned with --project, so it always shows ONE project regardless of your folder',
      `remove the --project argument in ${via || 'your statusline command'} to make it follow the active folder`));
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
async function checkStore() {
  const dbPath = resolveDbPath();
  const out = [];
  try {
    const { readStickies } = await import('./store.js');
    const notes = readStickies({ project_path: null, include_global: true, limit: 1000 });
    const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
    out.push(check('store', 'ok', `${notes.length} active note(s), ${(size / 1024).toFixed(0)} KB at ${dbPath}`));
  } catch (err) {
    out.push(check('store', 'bad', `cannot read ${dbPath}: ${err?.message || err}`));
    return out;
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
async function checkSync() {
  try {
    const { resolveSyncRepo, autoSyncEnabled, isGitRepo } = await import('./git-sync.js');
    const repo = resolveSyncRepo();
    if (!repo) return check('sync', 'ok', 'not configured (nothing syncs on its own)');
    if (!isGitRepo(repo)) {
      return check('sync', 'bad', `STICKIES_SYNC_REPO points at ${repo}, which is not a git repo`, 'clone your notes repo there');
    }
    return check('sync', 'ok', `${repo}${autoSyncEnabled() ? ' (auto-sync ON)' : ' (auto-sync off — run `stickies sync`)'}`);
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
