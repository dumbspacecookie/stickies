// Installs stickies repo-mode into a target project repo so notes work inside
// cloud/mobile sessions. Copies the self-contained engine, seeds the store, and
// wires the two hooks into the repo's .claude/settings.json (non-destructively).

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = join(HERE, 'engine.mjs');
const WORKFLOW_SRC = join(HERE, 'stickies-sync.yml');

const DIGEST_CMD = 'node "$CLAUDE_PROJECT_DIR/.stickies/engine.mjs" digest';
const CAPTURE_CMD = 'node "$CLAUDE_PROJECT_DIR/.stickies/engine.mjs" capture';

// Merge a single command hook into a settings.json hooks[event] array without
// clobbering unrelated hooks, and without adding a duplicate of our own.
function ensureHook(settings, event, command) {
  settings.hooks ||= {};
  settings.hooks[event] ||= [];
  const already = settings.hooks[event].some((g) =>
    (g.hooks || []).some((h) => h.command === command));
  if (!already) settings.hooks[event].push({ hooks: [{ type: 'command', command }] });
}

export function installRepoMode(targetDir) {
  const root = resolve(targetDir);
  if (!existsSync(root)) throw new Error(`target does not exist: ${root}`);

  const steps = [];
  mkdirSync(join(root, '.stickies'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });

  // 1. Engine (always refresh to the latest version).
  copyFileSync(ENGINE_SRC, join(root, '.stickies', 'engine.mjs'));
  steps.push('.stickies/engine.mjs (self-contained, no deps)');

  // 2. Seed store only if absent (never overwrite real notes).
  const store = join(root, '.stickies', 'notes.json');
  if (!existsSync(store)) {
    writeFileSync(store, JSON.stringify({ notes: [] }, null, 2) + '\n');
    steps.push('.stickies/notes.json (empty store)');
  } else {
    steps.push('.stickies/notes.json (kept existing)');
  }

  // 3. Mirror.
  const mirror = join(root, '.stickies', 'NOTES.md');
  if (!existsSync(mirror)) {
    writeFileSync(mirror, '# Stickies\n\n_No open notes._\n');
    steps.push('.stickies/NOTES.md (mirror)');
  }

  // 4. Teach the convention via CLAUDE.md. In a cloud session the plugin's MCP
  //    instructions are absent, so without this Claude never emits !!sticky lines
  //    and the Stop hook has nothing to capture. Append once, marker-guarded.
  const claudeMd = join(root, 'CLAUDE.md');
  const BEGIN = '<!-- stickies:begin -->';
  const END = '<!-- stickies:end -->';
  const block =
    `${BEGIN}\n` +
    '## Stickies (persistent notes)\n\n' +
    'To remember a durable fact across sessions, include a line like this in your reply:\n\n' +
    '`!!sticky decision P1 #tag :: We chose X over Y because Z`\n\n' +
    'Grammar: `!!sticky <category> <importance> [#tags] :: <content>`\n' +
    '- category (required): decision | blocker | preference | context | todo\n' +
    '- importance (optional): write it bare as `P1`, `P2`, or `P3` — NOT `[P1]`. Defaults to P2.\n' +
    '- A Stop hook captures these into `.stickies/notes.json` and shows them at the next\n' +
    '  session start. Secrets are auto-redacted; do not duplicate an existing note.\n' +
    '<!-- stickies:end -->\n';
  let md = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
  if (md.includes(BEGIN) && md.includes(END)) {
    // Refresh the managed block in place, leaving the rest of CLAUDE.md untouched.
    md = md.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), block);
    writeFileSync(claudeMd, md);
    steps.push('CLAUDE.md (refreshed convention)');
  } else {
    md = md.trim() ? md.replace(/\s*$/, '\n\n') + block : block;
    writeFileSync(claudeMd, md);
    steps.push('CLAUDE.md (+ !!sticky convention)');
  }

  // 5. Hooks (merge into existing settings.json).
  const settingsPath = join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
  }
  ensureHook(settings, 'SessionStart', DIGEST_CMD);
  ensureHook(settings, 'Stop', CAPTURE_CMD);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  steps.push('.claude/settings.json (SessionStart + Stop hooks)');

  // 6. Reconciliation workflow — converges cloud session branches into main.
  //    Always refresh to the latest version.
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  copyFileSync(WORKFLOW_SRC, join(root, '.github', 'workflows', 'stickies-sync.yml'));
  steps.push('.github/workflows/stickies-sync.yml (auto-converge to main)');

  return { root, steps };
}
