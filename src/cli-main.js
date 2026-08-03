// Command-line interface for stickies, used by the /stickies slash commands and
// available directly in a shell. All output goes to stdout as human-readable text.
//
// NB: loaded via a dynamic import from cli.js (the bin), which first installs the
// node:sqlite warning suppressor — so this module's node:sqlite load stays quiet.
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSticky, readStickies, dismissSticky } from './store.js';
import { notify, notifyDigest, notifyBoard, isEnabled as notifyEnabled } from './notify.js';
import { exportBoardMd } from './flow/board.mjs';
import { CATEGORIES, IMPORTANCES } from './db.js';
import { maybeAutoSync } from './git-sync.js';
import { normalizeProjectPath } from './store-path.js';
import { DEFAULT_PORT as DEFAULT_DASHBOARD_PORT } from './dashboard-port.js';

// After a manual mutation, push it if auto-sync is enabled (opt-in, best-effort).
function autoSyncAfterMutation() {
  const r = maybeAutoSync();
  if (r && !r.error) {
    const held = (r.steps || []).some((x) => x.startsWith('push: skipped (commit only'));
    console.log(held ? '  (committed locally — not pushed; set STICKIES_SYNC_PUSH=1)' : '  (auto-synced)');
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

// Read from package.json so `stickies --version` cannot drift from what was published. It was
// hardcoded at 0.7.0 across four releases, so every version a user reported back was wrong.
const { version: PKG_VERSION } = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const program = new Command();

program
  .name('stickies')
  .description('Persistent sticky notes for Claude Code (local SQLite, opt-in git sync).')
  .version(PKG_VERSION);

function formatSticky(s) {
  const scope = s.project_path ? '' : ' (global)';
  const tags = s.tags.length ? ` [${s.tags.join(', ')}]` : '';
  const expires = s.expires_at ?? 'never (until dismissed)';
  return `  ${s.importance} ${s.category.padEnd(10)} ${s.content}${tags}${scope}\n      id: ${s.id}  expires: ${expires}`;
}

function printList(stickies, header) {
  console.log(header);
  if (stickies.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const s of stickies) console.log(formatSticky(s));
}

// /stickies  and  /stickies all
program
  .command('list', { isDefault: true })
  .description('List active stickies for the current project.')
  .option('-a, --all', 'Include stickies from every project (and globals).')
  .option('-p, --project <path>', 'Project path to scope to (defaults to cwd).')
  .option('-l, --limit <n>', 'Max number to show.', (v) => parseInt(v, 10), 100)
  .option('--min-importance <P1|P2|P3>', 'Lowest importance to include.', 'P3')
  .action((opts) => {
    if (opts.all) {
      const stickies = readStickies({
        project_path: null,
        include_global: true,
        limit: opts.limit,
        min_importance: opts.minImportance,
      });
      printList(stickies, 'Active stickies (all projects + global):');
    } else {
      const project = opts.project || process.cwd();
      const stickies = readStickies({
        project_path: project,
        include_global: true,
        limit: opts.limit,
        min_importance: opts.minImportance,
      });
      printList(stickies, `Active stickies for ${project} (+ global):`);
    }
  });

// /stickies add [text]
program
  .command('add <text...>')
  .description('Create a sticky manually.')
  .option('-c, --category <category>', `One of: ${CATEGORIES.join(', ')}`, 'context')
  .option('-i, --importance <P1|P2|P3>', 'Importance.', 'P2')
  .option('-t, --tags <tags>', 'Comma-separated tags.', '')
  .option('-d, --due <when>', 'Optional deadline: 30m, 2h, 1d, 1w, tomorrow, today, or YYYY-MM-DD.')
  .option('-p, --project <path>', 'Project path (defaults to cwd; use "global" for none).')
  .action(async (textParts, opts) => {
    if (!CATEGORIES.includes(opts.category)) {
      console.error(`Invalid category "${opts.category}". Use one of: ${CATEGORIES.join(', ')}`);
      process.exit(1);
    }
    if (!IMPORTANCES.includes(opts.importance)) {
      console.error(`Invalid importance "${opts.importance}". Use one of: ${IMPORTANCES.join(', ')}`);
      process.exit(1);
    }
    let project = opts.project ?? process.cwd();
    if (project === 'global') project = null;

    const tags = opts.tags
      ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    const sticky = createSticky({
      content: textParts.join(' '),
      category: opts.category,
      importance: opts.importance,
      tags,
      project_path: project,
      source: 'manual',
      origin: 'terminal', // the CLI is only ever run from a terminal
      due_at: opts.due ?? null, // raw token; createSticky resolves it (unparseable => no due)
    });
    console.log(`Added sticky ${sticky.id}`);
    if (opts.due && !sticky.due_at) console.log(`  ⚠ could not parse due "${opts.due}" — saved without a deadline`);
    if (sticky.redacted) console.log('  ⚠ a suspected secret was redacted from the content before saving');
    console.log(formatSticky(sticky));
    autoSyncAfterMutation();
    await notify(sticky, 'created');
  });

// /stickies dismiss [id]
program
  .command('dismiss <id>')
  .description('Soft-delete a sticky by id.')
  .option('-r, --reason <reason>', 'Reason for dismissal.')
  .action(async (id, opts) => {
    const result = dismissSticky(id, opts.reason ?? null);
    if (!result.ok) {
      console.error(`Could not dismiss: ${result.error}`);
      process.exit(1);
    }
    console.log(`Dismissed sticky ${id}.`);
    autoSyncAfterMutation();
    await notify(result.sticky, 'dismissed');
  });

// stickies export — write all stickies to a sync document (JSON)
program
  .command('export')
  .description('Export all stickies to a sync document (for backup or git sync).')
  .option('-f, --file <path>', 'Output path (default ~/.stickies/sync/stickies.json).')
  .action(async (opts) => {
    const { exportToFile } = await import('./sync.js');
    const { path, count } = exportToFile(opts.file);
    console.log(`Exported ${count} stickies → ${path}`);
  });

// stickies import — merge a sync document into the local DB (last-writer-wins)
program
  .command('import')
  .description('Merge a sync document into the local DB (last-writer-wins by updated_at).')
  .option('-f, --file <path>', 'Input path (default ~/.stickies/sync/stickies.json).')
  .action(async (opts) => {
    const { importFromFile } = await import('./sync.js');
    const r = importFromFile(opts.file);
    if (r.missing) {
      console.log('No sync document found — nothing to import.');
      return;
    }
    console.log(`Imported: ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged (of ${r.total}).`);
  });

// stickies sync — git pull -> merge -> export -> commit -> push
program
  .command('sync')
  .description('Sync stickies through a git repo you own (pull, merge, commit; push only with STICKIES_SYNC_PUSH=1).')
  .option('--repo <path>', 'Git working copy holding the sync file (or set $STICKIES_SYNC_REPO).')
  .action(async (opts) => {
    const { sync } = await import('./git-sync.js');
    try {
      const r = sync({ repo: opts.repo });
      console.log(`Synced via ${r.repo}`);
      for (const s of r.steps) console.log(`  - ${s}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// /stickies dashboard — launch the local web dashboard
program
  .command('dashboard')
  .description('Launch the local web dashboard (loopback only).')
  .option('-p, --port <n>', `Port (default ${DEFAULT_DASHBOARD_PORT}).`)
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('-d, --detach', 'Run in the background and return immediately.')
  .option('--open', 'Open the dashboard in your browser.')
  .option('--stop', 'Stop the running dashboard (only ever kills one that answers as Stickies).')
  .option('--link', 'Print an authorized URL for your browser (reads are not open to anything else).')
  .action(async (opts) => {
    if (opts.link) {
      const { dashboardPort } = await import('./dashboard-autostart.js');
      const { authorizedUrl, authEnabled, readAuthKey } = await import('./dashboard-auth.js');
      const port = Number(opts.port) || dashboardPort();
      if (!authEnabled()) {
        console.log(`http://127.0.0.1:${port}/`);
        console.error('(STICKIES_DASHBOARD_AUTH=0 — reads are unauthenticated, so no key is needed.)');
        return;
      }
      // No key file means no dashboard has ever run under this STICKIES_HOME. Minting one here
      // would hand back a link that the server then refuses, because it reads the key once at
      // startup — so say what to do instead of printing something that looks right and is not.
      if (!readAuthKey()) {
        console.error('No dashboard key yet — start one first (`stickies dashboard --detach`), then ask again.');
        process.exitCode = 1;
        return;
      }
      console.log(authorizedUrl(port, '/'));
      console.error('Valid for a few minutes. Opening it sets a cookie, which is what lasts; the token then leaves the address bar.');
      return;
    }
    if (opts.stop) {
      const { stopDashboard, dashboardPort } = await import('./dashboard-autostart.js');
      // dashboardPort(), not a hardcoded 4317: STICKIES_DASHBOARD_PORT is documented, and the
      // autostart hook, doctor and the statusline link all honour it — so hardcoding here meant
      // that setting the variable as documented left `--stop` unable to find your own dashboard.
      const port = Number(opts.port) || dashboardPort();
      const r = await stopDashboard({ port });
      const say = {
        stopped: `Stopped the Stickies dashboard on port ${port} (pid ${r.pid}).`,
        'not-running': `Nothing is listening on port ${port} — no dashboard to stop.`,
        foreign: `Port ${port} is held by something that isn't Stickies. Left it alone.`,
        'unknown-pid': `The dashboard on port ${port} didn't report a pid, so it wasn't safe to kill.`,
        unverified: `Something on port ${port} answers as Stickies, but ${r.reason}. Not killing it — check with \`stickies doctor\`, or stop it yourself (pid ${r.pid}).`,
        'still-running': `Asked the dashboard on port ${port} (pid ${r.pid}) to stop, but it's still answering.`,
        failed: `Could not stop the dashboard on port ${port}: ${r.error}`,
      }[r.status] || `Unexpected result: ${r.status}`;
      if (r.status === 'stopped' || r.status === 'not-running') console.log(say);
      else { console.error(say); process.exitCode = 1; }
      return;
    }
    const dash = join(HERE, 'dashboard.js');
    const args = ['--disable-warning=ExperimentalWarning', dash];
    const { dashboardPort } = await import('./dashboard-autostart.js');
    const port = String(opts.port || dashboardPort());
    // Normalized so the ?project= we print is byte-identical to the path the dashboard stores
    // and matches against — a raw Windows cwd would print %5C-escaped backslashes.
    const project = normalizeProjectPath(opts.project || process.cwd());
    args.push('--port', port);
    args.push('--project', project);
    if (opts.open) args.push('--open');

    if (opts.detach) {
      // A detached child has stdio ignored, so if it dies on EADDRINUSE nobody ever sees it.
      // This used to print "started in background" regardless, while the port kept serving a
      // DIFFERENT project — the click landed on someone else's board and looked like a bug in
      // the board. So: check who owns the port first, and confirm we're really up after.
      const { probeHealth, ensureDashboard } = await import('./dashboard-autostart.js');
      const existing = await probeHealth(Number(port));
      if (existing === 'foreign') {
        console.error(`Port ${port} is in use by something that isn't Stickies. Pick another with --port <n>.`);
        process.exit(1);
      }
      if (existing) {
        // One dashboard serves every project, so an existing instance is a success, not a clash.
        console.log(
          `Stickies dashboard already running → http://127.0.0.1:${port}/board?project=${encodeURIComponent(project)}\n` +
          `  (launched from ${existing.project || '(global view)'}; it serves any project via ?project=)`
        );
        return;
      }
      const r = await ensureDashboard({ project, port: Number(port), confirmMs: 4000, force: true });
      if (r.status === 'started') {
        console.log(`Stickies dashboard started in background → http://127.0.0.1:${port}/board?project=${encodeURIComponent(project)}`);
      } else if (r.status === 'starting') {
        console.log(`Stickies dashboard starting in background (not answering yet) → http://127.0.0.1:${port}/`);
      } else {
        console.error(`Could not start the dashboard (${r.status}${r.error ? ': ' + r.error : ''}).`);
        process.exit(1);
      }
      return;
    }
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
  });

// stickies doctor — "why isn't this working". Read-only; see src/doctor.js for why each
// check exists (each one maps to something that was once silently broken).
program
  .command('doctor')
  .description('Diagnose the local setup: dashboard, plugin install, statusline, store, sync.')
  .option('--project <path>', 'Project to evaluate (defaults to cwd).')
  .option('--json', 'Emit the report as JSON.')
  .option('--raw', 'Show full paths instead of abbreviating your home directory to ~.')
  .action(async (opts) => {
    const { runDoctor, renderDoctor, redactReport } = await import('./doctor.js');
    const report = await runDoctor({ project: opts.project || process.cwd() });
    // Both forms are safe to paste into an issue by default — pasting the JSON is the natural
    // thing to do when a maintainer asks. --raw is the one opt-out, for debugging your own box.
    console.log(opts.json
      ? JSON.stringify(opts.raw ? report : redactReport(report), null, 2)
      : renderDoctor(report, { raw: opts.raw }));
    // Non-zero only for outright breakage, so warnings stay usable in scripts.
    if (!report.ok) process.exitCode = 1;
  });

// stickies status — one-line summary for a shell prompt or any statusline.
// Same renderer Claude Code's statusLine uses, so the terminal and the TUI agree.
program
  .command('status')
  .description('One-line summary of pending stickies (for a shell prompt / statusline).')
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('--json', 'Emit counts as JSON instead of a rendered line.')
  .option('--no-color', 'Disable ANSI color.')
  .option('--theme <t>', 'Palette: light | dark (default: $STICKIES_THEME, else autodetect, else dark).')
  .option('--light', 'Shorthand for --theme light (readable on a light terminal background).')
  .option('--width <n>', 'Max width of the rendered line.', '60')
  .action((opts) => {
    const args = ['--disable-warning=ExperimentalWarning', join(HERE, 'statusline.js')];
    args.push('--project', opts.project || process.cwd());
    args.push('--width', String(opts.width));
    if (opts.json) args.push('--json');
    if (!opts.color) args.push('--no-color');
    // Forward the theme so `stickies status --light` works from any shell, not only the env var.
    if (opts.light) args.push('--light');
    else if (opts.theme) args.push('--theme', opts.theme);

    // stdio 'inherit' on stdout would let the child print straight through, but the child
    // also reads stdin (for the Claude Code event) — close it so a TTY prompt never hangs.
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => process.exit(code || 0));
  });

// stickies notify — push the open list to Discord, or verify the webhook is wired up.
program
  .command('notify')
  .description('Push open stickies to the configured Discord webhook ($STICKIES_DISCORD_WEBHOOK).')
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('-a, --all', 'Include every project, not just this one.')
  .option('--test', 'Send a single test message to prove the webhook works.')
  .action(async (opts) => {
    if (!notifyEnabled()) {
      console.error(
        'No webhook configured. Set $STICKIES_DISCORD_WEBHOOK to a Discord webhook URL\n' +
          '(Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL).'
      );
      process.exit(1);
    }

    if (opts.test) {
      const r = await notifyDigest(
        [
          {
            content: 'Webhook test — if you can read this in Discord, stickies is wired up.',
            category: 'context',
            importance: 'P2',
          },
        ],
        opts.project || process.cwd()
      );
      console.log(r.ok ? 'Test message sent → check your Discord channel.' : `Failed: ${r.error}`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }

    const project = opts.all ? null : opts.project || process.cwd();
    const stickies = readStickies({ project_path: project, include_global: true, limit: 100 });
    const r = await notifyDigest(stickies, project);
    console.log(
      r.ok ? `Pushed ${stickies.length} open sticky(ies) to Discord.` : `Failed: ${r.error}`
    );
    process.exitCode = r.ok ? 0 : 1;
  });

// stickies board — write a GitHub-viewable BOARD.md (renders natively on github.com, so the
// board is reachable from any phone browser), or post the board as a Discord card.
program
  .command('board')
  .description('Export the flow board to a committable BOARD.md, or post it to Discord (--discord).')
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('-o, --out <file>', 'Markdown output path (default: BOARD.md in the project).')
  .option('--discord', 'Post the board as a Discord card instead of writing a file.')
  .action(async (opts) => {
    const project = opts.project || process.cwd();
    if (opts.discord) {
      if (!notifyEnabled()) {
        console.error('No webhook configured. Set $STICKIES_DISCORD_WEBHOOK to a Discord webhook URL.');
        process.exit(1);
      }
      const r = await notifyBoard(project);
      console.log(r.ok ? 'Board posted → check your Discord channel.' : `Not posted: ${r.skipped || r.error}`);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    const r = exportBoardMd(project, opts.out || join(project, 'BOARD.md'));
    if (!r.ok) {
      console.error(`No flow board for ${project} (needs .planning/ROADMAP.md or a .flow/ snapshot).`);
      process.exit(1);
    }
    console.log(`Wrote ${r.outPath} (${r.source}). Commit it to view the board on GitHub.`);
  });

// stickies init-repo — install repo-mode (committed store + hooks) into a project
// repo so notes work inside cloud/mobile sessions where the plugin is absent.
program
  .command('init-repo')
  .description('Install repo-mode into a project so stickies works in cloud/mobile sessions.')
  .argument('[path]', 'Target repo directory (defaults to cwd).', '.')
  .action(async (path) => {
    const { installRepoMode } = await import('./repo-mode/install.js');
    const { root, steps, warnings = [] } = installRepoMode(path);
    console.log(`Installed stickies repo-mode into ${root}:`);
    for (const s of steps) console.log(`  + ${s}`);
    // On stderr and with a non-zero exit: a skipped step must not read as a successful install,
    // or the user discovers weeks later that nothing was ever captured.
    for (const w of warnings) console.error(`  ! ${w}`);
    if (warnings.length) process.exitCode = 1;
    console.log(
      '\nCommit the .stickies/ and .claude/settings.json files. In any session on this\n' +
        'repo, Claude captures `!!sticky …` lines into .stickies/notes.json and shows them\n' +
        'at the next start. For Discord in cloud sessions, set STICKIES_DISCORD_WEBHOOK there.'
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
