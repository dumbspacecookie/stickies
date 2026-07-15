#!/usr/bin/env node
// Command-line interface for stickies, used by the /stickies slash commands and
// available directly in a shell. All output goes to stdout as human-readable text.

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSticky, readStickies, dismissSticky } from './store.js';
import { notify, notifyDigest, isEnabled as notifyEnabled } from './notify.js';
import { CATEGORIES, IMPORTANCES } from './db.js';
import { maybeAutoSync } from './git-sync.js';

// After a manual mutation, push it if auto-sync is enabled (opt-in, best-effort).
function autoSyncAfterMutation() {
  const r = maybeAutoSync();
  if (r && !r.error) console.log('  (auto-synced)');
}

const HERE = dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
  .name('stickies')
  .description('Persistent sticky notes for Claude Code (local SQLite, opt-in git sync).')
  .version('0.7.0');

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
    });
    console.log(`Added sticky ${sticky.id}`);
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
  .description('Sync stickies through a git repo you own (pull, merge, push).')
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
  .option('-p, --port <n>', 'Port (default 4317).')
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('-d, --detach', 'Run in the background and return immediately.')
  .option('--open', 'Open the dashboard in your browser.')
  .action((opts) => {
    const dash = join(HERE, 'dashboard.js');
    const args = ['--disable-warning=ExperimentalWarning', dash];
    const port = opts.port || '4317';
    args.push('--port', port);
    args.push('--project', opts.project || process.cwd());
    if (opts.open) args.push('--open');

    if (opts.detach) {
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`Stickies dashboard started in background → http://127.0.0.1:${port}/`);
      return;
    }
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
  });

// stickies status — one-line summary for a shell prompt or any statusline.
// Same renderer Claude Code's statusLine uses, so the terminal and the TUI agree.
program
  .command('status')
  .description('One-line summary of pending stickies (for a shell prompt / statusline).')
  .option('--project <path>', 'Project to scope to (defaults to cwd).')
  .option('--json', 'Emit counts as JSON instead of a rendered line.')
  .option('--no-color', 'Disable ANSI color.')
  .option('--width <n>', 'Max width of the rendered line.', '60')
  .action((opts) => {
    const args = ['--disable-warning=ExperimentalWarning', join(HERE, 'statusline.js')];
    args.push('--project', opts.project || process.cwd());
    args.push('--width', String(opts.width));
    if (opts.json) args.push('--json');
    if (!opts.color) args.push('--no-color');

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

// stickies init-repo — install repo-mode (committed store + hooks) into a project
// repo so notes work inside cloud/mobile sessions where the plugin is absent.
program
  .command('init-repo')
  .description('Install repo-mode into a project so stickies works in cloud/mobile sessions.')
  .argument('[path]', 'Target repo directory (defaults to cwd).', '.')
  .action(async (path) => {
    const { installRepoMode } = await import('./repo-mode/install.js');
    const { root, steps } = installRepoMode(path);
    console.log(`Installed stickies repo-mode into ${root}:`);
    for (const s of steps) console.log(`  + ${s}`);
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
