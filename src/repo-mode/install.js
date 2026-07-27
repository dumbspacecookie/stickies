// Installs stickies repo-mode into a target project repo so notes work inside
// cloud/mobile sessions. Copies the self-contained engine, seeds the store, and
// wires the two hooks into the repo's .claude/settings.json (non-destructively).

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
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
  // Things the caller must SAY OUT LOUD rather than list as done. An install that quietly skipped
  // the hooks looks identical to one that worked, and the user finds out weeks later when nothing
  // was ever captured.
  const warnings = [];

  // Everything this function writes must land INSIDE the repo it was pointed at.
  //
  // It did no containment check at all, and `mkdirSync`/`writeFileSync` follow a directory link
  // without complaint. With `.claude`, `.github` or `.stickies` present as a junction — which
  // needs no privilege on Windows and is a symlink anywhere else — install wrote through it:
  // reproduced writing into a sibling repository and into a directory outside the root entirely,
  // including overwriting another project's workflow file. A hardlinked CLAUDE.md mutated the
  // file on the other end. Nothing about a repo layout is trustworthy just because the user
  // pointed at it; a hostile or merely careless one should not be able to steer a write.
  const realRoot = realpathSync(root);
  const contained = (p) => {
    // Resolve the deepest part that exists — the target itself may not yet — and check that.
    let probe = p;
    while (!existsSync(probe)) {
      const up = dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
    const real = realpathSync(probe);
    return real === realRoot || real.startsWith(realRoot + sep);
  };
  const insist = (p, what) => {
    if (!contained(p)) {
      throw new Error(
        `refusing to write ${what}: it resolves outside ${root}. ` +
        'A directory in this repo is a symlink or junction pointing elsewhere — remove it and re-run.'
      );
    }
    return p;
  };

  mkdirSync(insist(join(root, '.stickies'), '.stickies/'), { recursive: true });
  mkdirSync(insist(join(root, '.claude'), '.claude/'), { recursive: true });
  // Re-check AFTER creating: a link could have been in place all along, or planted in between.
  insist(join(root, '.stickies'), '.stickies/');
  insist(join(root, '.claude'), '.claude/');

  // 1. Engine (always refresh to the latest version).
  copyFileSync(ENGINE_SRC, insist(join(root, '.stickies', 'engine.mjs'), '.stickies/engine.mjs'));
  steps.push('.stickies/engine.mjs (self-contained, no deps)');

  // 2. Seed store only if absent (never overwrite real notes).
  const store = insist(join(root, '.stickies', 'notes.json'), '.stickies/notes.json');
  if (!existsSync(store)) {
    writeFileSync(store, JSON.stringify({ notes: [] }, null, 2) + '\n');
    steps.push('.stickies/notes.json (empty store)');
  } else {
    steps.push('.stickies/notes.json (kept existing)');
  }

  // 3. Mirror.
  const mirror = insist(join(root, '.stickies', 'NOTES.md'), '.stickies/NOTES.md');
  if (!existsSync(mirror)) {
    writeFileSync(mirror, '# Stickies\n\n_No open notes._\n');
    steps.push('.stickies/NOTES.md (mirror)');
  }

  // 4. Teach the convention via CLAUDE.md. In a cloud session the plugin's MCP
  //    instructions are absent, so without this Claude never emits !!sticky lines
  //    and the Stop hook has nothing to capture. Append once, marker-guarded.
  const claudeMd = insist(join(root, 'CLAUDE.md'), 'CLAUDE.md');
  // Two managed blocks can exist in one CLAUDE.md: this one (the !!sticky convention, written
  // into someone's repository by `stickies init-repo`) and the digest section the desktop path
  // used to inject. They had DIFFERENT opening markers — `stickies:begin` here, `stickies:start`
  // there — and the SAME closing marker. Sharing a terminator between two block types means the
  // wrong pair can be matched: a file whose begin-block lost its end line has its refresh run on
  // to the next `stickies:end` in the file, deleting the digest section and every line of the
  // user's own text in between. That is the same failure that made removeManagedSection eat
  // people's CLAUDE.md, so it gets the same treatment rather than being left as a latent one.
  //
  // New blocks use an unambiguous pair. The legacy shape is still recognised for replacement, so
  // an existing install is refreshed in place instead of gaining a second block.
  const BEGIN = '<!-- stickies:repo-start -->';
  const END = '<!-- stickies:repo-end -->';
  const LEGACY_BEGIN = '<!-- stickies:begin -->';
  const LEGACY_END = '<!-- stickies:end -->';
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
    `${END}\n`;
  let md = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';

  // Markers must be alone on their line — that is how they are written, and it is not how anyone
  // mentions them in a sentence about this tool. A legacy span additionally may not swallow a
  // digest section: if it would, the file is malformed and appending is the safe answer.
  // Markers are matched at COLUMN ZERO, and the span is the LAST opening before the first closing
  // — the same two rules digest.js needed, for the same reasons. Allowing leading whitespace
  // matched an indented documentation example; taking the FIRST opening let a stray marker begin a
  // span that ran to our terminator and deleted everything between. Both were reproduced here.
  const spanOf = (begin, end) => {
    const at = (marker) => {
      const re = new RegExp(`^${marker}[ \\t]*$`, 'gm');
      const out = [];
      let m;
      while ((m = re.exec(md)) !== null) { out.push(m.index); if (re.lastIndex === m.index) re.lastIndex++; }
      return out;
    };
    const closes = at(end);
    if (!closes.length) return null;
    const opens = at(begin).filter((o) => o < closes[0]);
    if (!opens.length) return null;
    const span = md.slice(opens[opens.length - 1], closes[0] + end.length);
    if (span.includes('<!-- stickies:start -->')) return null; // would eat the digest block
    return span;
  };

  const existing = spanOf(BEGIN, END) || spanOf(LEGACY_BEGIN, LEGACY_END);
  if (existing) {
    // Refresh the managed block in place, leaving the rest of CLAUDE.md untouched.
    md = md.replace(existing, block);
    writeFileSync(claudeMd, md);
    steps.push('CLAUDE.md (refreshed convention)');
  } else {
    md = md.trim() ? md.replace(/\s*$/, '\n\n') + block : block;
    writeFileSync(claudeMd, md);
    steps.push('CLAUDE.md (+ !!sticky convention)');
  }

  // 5. Hooks (merge into existing settings.json).
  //
  // A file that does not parse is REFUSED, not replaced. The old code fell back to `{}` on a parse
  // error and then wrote that — so a settings.json in any broken state lost the user's
  // permissions, env, their own hooks and their statusline, silently, leaving only ours. The
  // likeliest broken state is a git merge conflict, and a repo-shared settings.json is precisely
  // what repo-mode is pointed at, so this was not a remote possibility. Measured: a conflicted
  // file went in carrying four sections of the user's configuration and came out with none.
  //
  // Refusing costs a re-run after they fix the file. Writing cost them their settings.
  const settingsPath = insist(join(root, '.claude', 'settings.json'), '.claude/settings.json');
  let settings = {};
  let refusal = null;
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') {
      settings = {}; // an empty file is not configuration; nothing to lose
    } else {
      try {
        const parsed = JSON.parse(raw);
        // Only a plain object can hold hooks. An array or a bare value would otherwise have hook
        // keys stapled onto it and be written back as something Claude Code cannot read.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
        else refusal = 'it does not contain a JSON object';
      } catch (err) {
        refusal = `it is not valid JSON (${err.message})`;
      }
    }
  }
  if (refusal) {
    warnings.push(
      `.claude/settings.json was left ALONE because ${refusal}. ` +
      'The SessionStart and Stop hooks are NOT installed, so nothing will be captured in this repo. ' +
      'Fix that file (a merge conflict, most likely) and run `stickies init-repo` again.'
    );
  } else {
    // A settings.json can PARSE and still be shaped in a way ensureHook cannot walk: `"hooks": 5`,
    // `hooks.SessionStart` as a string, a null entry in the array. Those threw an uncaught
    // TypeError, which reached the user as a stack trace AFTER CLAUDE.md had been rewritten and
    // .stickies/ seeded — a half-installed repo with no explanation. It is the same situation as
    // unparseable (a file we do not understand well enough to edit), so it gets the same refusal.
    try {
      ensureHook(settings, 'SessionStart', DIGEST_CMD);
      ensureHook(settings, 'Stop', CAPTURE_CMD);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      steps.push('.claude/settings.json (SessionStart + Stop hooks)');
    } catch (err) {
      warnings.push(
        '.claude/settings.json was left ALONE: its structure is not one this can safely edit ' +
        `(${err.message}). The SessionStart and Stop hooks are NOT installed, so nothing will be ` +
        'captured in this repo. Fix that file and run `stickies init-repo` again.'
      );
    }
  }

  // 6. Reconciliation workflow — converges cloud session branches into main.
  //    Always refresh to the latest version.
  mkdirSync(insist(join(root, '.github'), '.github/'), { recursive: true });
  mkdirSync(insist(join(root, '.github', 'workflows'), '.github/workflows/'), { recursive: true });
  insist(join(root, '.github'), '.github/');
  copyFileSync(WORKFLOW_SRC, insist(join(root, '.github', 'workflows', 'stickies-sync.yml'), 'the sync workflow'));
  steps.push('.github/workflows/stickies-sync.yml (auto-converge to main)');

  return { root, steps, warnings };
}
