// Stickies showcase — a narrated two-machine story driving the REAL deployed entry
// points (session-start hook, Stop/auto-capture hook, CLI, git auto-sync). Everything
// is offline: a local bare repo stands in for the shared private repo, and two clones
// at different paths are "laptop" and "desktop". Run: npm run demo
import { spawnSync, spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const NODE = process.execPath;
const FLAG = '--disable-warning=ExperimentalWarning';

const ROOT = join(tmpdir(), 'stickies_showcase');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const REMOTE = join(ROOT, 'stickies-data.git');     // the "private repo you own"
const LAPTOP = join(ROOT, 'work', 'acme-api');       // checkout path on laptop
const DESKTOP = join(ROOT, 'home', 'projects', 'api'); // DIFFERENT path on desktop
const dbLaptop = join(ROOT, 'laptop.db');
const dbDesktop = join(ROOT, 'desktop.db');

const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
function setupRepos() {
  spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { encoding: 'utf8' });
  spawnSync('git', ['clone', '--quiet', REMOTE, LAPTOP], { encoding: 'utf8' });
  for (const r of [LAPTOP]) { g(r, 'config', 'user.email', 'you@local'); g(r, 'config', 'user.name', 'You'); }
  g(LAPTOP, 'commit', '--allow-empty', '-m', 'init');
  g(LAPTOP, 'branch', '-M', 'main');
  g(LAPTOP, 'push', '-q', '-u', 'origin', 'main');
  spawnSync('git', ['clone', '--quiet', REMOTE, DESKTOP], { encoding: 'utf8' });
  for (const r of [DESKTOP]) { g(r, 'config', 'user.email', 'you@local'); g(r, 'config', 'user.name', 'You'); }
}

// Run an entry point with a machine's env (db + sync repo + auto-sync on).
function run(script, { db, repo, cwd, input, args = [] } = {}) {
  const env = { ...process.env, STICKIES_DB: db, STICKIES_AUTO_SYNC: '1' };
  if (repo) env.STICKIES_SYNC_REPO = repo;
  // cwd matters: the CLI scopes to process.cwd() by default, mirroring how Claude Code
  // runs inside a project directory.
  return spawnSync(NODE, [FLAG, join(SRC, script), ...args], { input, env, cwd: cwd || ROOT, encoding: 'utf8' });
}
const cli = (a, opts) => run('cli.js', { ...opts, args: a });

function banner(t) { console.log('\n\x1b[1m' + '─'.repeat(70) + '\n  ' + t + '\n' + '─'.repeat(70) + '\x1b[0m'); }
function sub(t) { console.log('\n\x1b[2m• ' + t + '\x1b[0m'); }

function sessionStart(machine, db, cwd) {
  const event = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd });
  const r = run('session-start.js', { db, repo: machine.repo, cwd, input: event });
  if (r.stderr.trim()) console.log('  \x1b[2m(hook: ' + r.stderr.trim().replace(/\n/g, ' / ') + ')\x1b[0m');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  return ctx;
}

function stopTurn(machine, db, cwd, assistantText) {
  const tpath = join(ROOT, `${machine.name}-transcript.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'help me with the api work' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  ];
  writeFileSync(tpath, lines.map((l) => JSON.stringify(l)).join('\n'));
  const event = JSON.stringify({ hook_event_name: 'Stop', transcript_path: tpath, cwd, stop_hook_active: false });
  const r = run('auto-capture.js', { db, repo: machine.repo, cwd, input: event });
  if (r.stderr.trim()) console.log('  \x1b[2m(hook: ' + r.stderr.trim().replace(/\n/g, ' / ') + ')\x1b[0m');
}

// ─────────────────────────────────────────────────────────────────────────────
setupRepos();
const laptop = { name: 'laptop', repo: LAPTOP };
const desktop = { name: 'desktop', repo: DESKTOP };

banner('1. LAPTOP — new session starts (store is empty)');
console.log(sessionStart(laptop, dbLaptop, LAPTOP));

banner('2. LAPTOP — Claude works, captures durable facts inline (!!sticky)');
sub('Claude\'s reply contained these directives — the Stop hook persists + auto-pushes them:');
const reply = [
  'Done. I refactored the auth module and made a couple of calls worth remembering:',
  '!!sticky decision P1 #auth #arch :: switched API auth from sessions to short-lived JWTs',
  '!!sticky blocker P1 #ci :: e2e suite is red until STAGING_DB_URL is added to CI secrets',
  '!!sticky todo P2 #cleanup :: delete the legacy /login cookie path once mobile ships',
  'Let me know if you want me to tackle the CI secret next.',
].join('\n');
stopTurn(laptop, dbLaptop, LAPTOP, reply);

sub('Laptop also adds a manual preference via the CLI:');
const add = cli(['add', 'keep PR descriptions short and skip the boilerplate', '-c', 'preference', '-i', 'P3'], { db: dbLaptop, repo: LAPTOP, cwd: LAPTOP });
console.log('  ' + add.stdout.trim().split('\n')[0]);

sub('Current stickies on the laptop:');
console.log(cli(['list'], { db: dbLaptop, repo: LAPTOP, cwd: LAPTOP }).stdout.trim());

banner('3. DESKTOP — different machine, SAME repo cloned to a DIFFERENT path');
console.log('  laptop checkout : ' + LAPTOP);
console.log('  desktop checkout: ' + DESKTOP + '   \x1b[2m(paths differ!)\x1b[0m');
sub('Desktop session starts → auto-pulls → digest shows the laptop\'s notes, matched by git remote:');
console.log(sessionStart(desktop, dbDesktop, DESKTOP));

banner('4. DESKTOP — resolves the blocker, dismisses it');
const list = cli(['list'], { db: dbDesktop, repo: DESKTOP, cwd: DESKTOP }).stdout;
const blockerId = (list.match(/id: ([0-9a-f-]+)/g) || [])
  .map((s) => s.slice(4))
  .find((id) => list.includes(id)); // first id; we just need any — pick the blocker by content
const idForBlocker = (() => {
  const lines = list.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].includes('STAGING_DB_URL')) {
    const m = (lines[i + 1] || '').match(/id: ([0-9a-f-]+)/); if (m) return m[1];
  }
  return blockerId;
})();
sub('Dismiss the CI blocker (auto-pushes the dismissal):');
console.log('  ' + cli(['dismiss', idForBlocker, '-r', 'added the secret'], { db: dbDesktop, repo: DESKTOP, cwd: DESKTOP }).stdout.trim());

banner('5. LAPTOP — next session auto-pulls; the dismissed blocker is gone');
console.log(sessionStart(laptop, dbLaptop, LAPTOP));

banner('6. DASHBOARD — launching the live web view on the desktop store');
const port = 4318;
const dash = spawn(NODE, [FLAG, join(SRC, 'dashboard.js'), '--port', String(port), '--project', DESKTOP],
  { env: { ...process.env, STICKIES_DB: dbDesktop }, detached: true, stdio: 'ignore' });
dash.unref();
setTimeout(() => {
  console.log(`  ▶ open  http://127.0.0.1:${port}/   (showing the desktop's synced stickies)`);
  console.log('\n\x1b[1mShowcase complete.\x1b[0m The dashboard stays up until you stop it.');
  process.exit(0);
}, 900);
