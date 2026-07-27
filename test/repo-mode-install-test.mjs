// `stickies init-repo` writes into somebody else's repository.
//
// It had no tests, which is a strange gap for the one command in this project that edits files in
// a repo it does not own, commits a workflow that runs on their pushes, and merges their
// settings.json. The specific bug that prompted these: its CLAUDE.md block used the opening
// marker `stickies:begin` while the digest section used `stickies:start`, and BOTH closed with
// `stickies:end`. Sharing a terminator between two block types means the wrong pair can match —
// a begin-block whose end line is gone lets the refresh run on to the next `stickies:end` in the
// file, deleting the digest section and every line of the user's own prose in between. Measured
// against the real code: 120 bytes in, user content and digest section both gone.

import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, cleanup } from './_env.mjs';
import { installRepoMode } from '../src/repo-mode/install.js';

const ROOT = scratchDir('repomode');
let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

let n = 0;
function install(initialClaudeMd) {
  const root = join(ROOT, `case-${++n}`);
  mkdirSync(root, { recursive: true });
  if (initialClaudeMd !== null) writeFileSync(join(root, 'CLAUDE.md'), initialClaudeMd);
  installRepoMode(root);
  return { root, md: readFileSync(join(root, 'CLAUDE.md'), 'utf8') };
}

// --- the block it writes ----------------------------------------------------------------------
const fresh = install(null);
check(fresh.md.includes('!!sticky'), 'a fresh repo gets the convention block');
check(fresh.md.includes('<!-- stickies:repo-start -->') && fresh.md.includes('<!-- stickies:repo-end -->'),
  'delimited by a pair of its own, not one shared with the digest section');
check(!fresh.md.includes('<!-- stickies:end -->'),
  'and no longer closes with the digest section\'s terminator');
check(existsSync(join(fresh.root, '.stickies')) || existsSync(join(fresh.root, '.github')),
  'and the repo-mode scaffolding is installed');

// --- it never destroys what is already there ---------------------------------------------------
const plain = install('# Mine\n\nDO NOT LOSE ME\n');
check(plain.md.includes('DO NOT LOSE ME'), 'an existing CLAUDE.md keeps its content');
check((plain.md.match(/!!sticky decision/g) || []).length === 1, 'and gains exactly one convention block');

// --- refreshing replaces in place, rather than stacking ----------------------------------------
const again = install('# Mine\n\nDO NOT LOSE ME\n\n<!-- stickies:repo-start -->\nSTALE TEXT\n<!-- stickies:repo-end -->\n');
check(again.md.includes('DO NOT LOSE ME'), 'a refresh keeps the user\'s content');
check(!again.md.includes('STALE TEXT'), 'replaces the old block body');
check((again.md.match(/stickies:repo-start/g) || []).length === 1, 'and leaves exactly one block');

// A pre-existing LEGACY block is migrated in place rather than duplicated.
const legacy = install('# Mine\n\nDO NOT LOSE ME\n\n<!-- stickies:begin -->\nSTALE TEXT\n<!-- stickies:end -->\n');
check(legacy.md.includes('DO NOT LOSE ME'), 'a legacy install keeps the user\'s content');
check(!legacy.md.includes('STALE TEXT'), 'and its old body is replaced');
check((legacy.md.match(/!!sticky decision/g) || []).length === 1, 'leaving one convention block, not two');

// --- the case that ate someone's file ----------------------------------------------------------
// A legacy opening marker whose closing line is gone, with a digest section further down. The old
// code matched from that orphan marker to the DIGEST's terminator and replaced the lot.
const malformed = install(
  '# Mine\n\n<!-- stickies:begin -->\nconvention\n\nDO NOT LOSE ME\n\n<!-- stickies:start -->\na digest note\n<!-- stickies:end -->\n'
);
check(malformed.md.includes('DO NOT LOSE ME'), 'a malformed file does not lose the user\'s prose');
check(malformed.md.includes('a digest note'), 'nor the digest section belonging to the other block type');
check(malformed.md.includes('!!sticky'), 'and the convention is still installed (appended, since nothing safe matched)');

// --- an unreadable settings.json is left ALONE ------------------------------------------------
// It fell back to `{}` on a parse error and then WROTE that, so a settings.json in any broken
// state lost the user's permissions, env, their own hooks and their statusline — leaving only
// ours. The likeliest broken state is a git merge conflict, and a repo-shared settings.json is
// exactly what repo-mode is pointed at. Measured against the real code: four sections of
// configuration in, none out.
function installWithSettings(settingsText) {
  const root = join(ROOT, `settings-${++n}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), settingsText);
  const res = installRepoMode(root);
  return { ...res, settings: readFileSync(join(root, '.claude', 'settings.json'), 'utf8') };
}

const userSettings = JSON.stringify({
  permissions: { allow: ['Bash(npm test)'] },
  env: { MY_API_BASE: 'https://internal.example' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
  statusLine: { type: 'command', command: 'my-statusline.sh' },
}, null, 2);

const conflicted = installWithSettings('<<<<<<< HEAD\n' + userSettings + '\n=======\n{}\n>>>>>>> theirs\n');
check(conflicted.settings.includes('Bash(npm test)'), 'a merge-conflicted settings.json keeps the permissions');
check(conflicted.settings.includes('MY_API_BASE'), 'and the env');
check(conflicted.settings.includes('guard.sh'), "and the user's own hook");
check(conflicted.settings.includes('my-statusline.sh'), 'and their statusline');
check((conflicted.warnings || []).length === 1, 'and the skip is reported as a warning, not listed as done');
check(!(conflicted.steps || []).some((s) => s.includes('settings.json')), 'so it never claims to have installed hooks');

const notObject = installWithSettings('[1, 2, 3]\n');
check(notObject.settings.trim() === '[1, 2, 3]', 'a settings.json that is not an object is left alone too');
check((notObject.warnings || []).length === 1, 'and reported');

// A file with nothing in it is not configuration, so writing it loses nothing.
const empty = installWithSettings('   \n');
check(empty.settings.includes('SessionStart'), 'an empty settings.json is safe to write into');
check((empty.warnings || []).length === 0, 'and needs no warning');

// The normal case still merges rather than replacing.
const good = installWithSettings(userSettings);
check(good.settings.includes('guard.sh') && good.settings.includes('SessionStart'),
  'a valid settings.json keeps the user\'s hooks AND gains ours');
check(good.settings.includes('Bash(npm test)') && good.settings.includes('my-statusline.sh'),
  'with everything else intact');

// --- it must not write outside the repo it was pointed at --------------------------------------
// There was no containment check at all, and mkdir/writeFile follow a directory link without
// complaint. A junction needs no privilege on Windows; a symlink is universal. Reproduced writing
// into a sibling repo and overwriting another project's workflow file.
{
  const outside = join(ROOT, 'outside-target');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'canary.txt'), 'must not be touched');
  const root = join(ROOT, 'linked-repo');
  mkdirSync(root, { recursive: true });
  let linked = false;
  try {
    symlinkSync(outside, join(root, '.claude'), 'junction');
    linked = true;
  } catch { /* no privilege on this platform — the assertion below is skipped honestly */ }
  if (linked) {
    let threw = null;
    try { installRepoMode(root); } catch (err) { threw = err.message; }
    check(threw !== null && /outside/.test(threw), `a .claude junction is refused (${threw ? threw.slice(0, 60) : 'NOT refused'})`);
    check(readFileSync(join(outside, 'canary.txt'), 'utf8') === 'must not be touched',
      'and nothing outside the repo was written');
  } else {
    console.log('  SKIP  could not create a junction on this platform');
  }
}

// --- a settings.json that PARSES but cannot be walked must not crash mid-install ---------------
// `"hooks": 5` threw an uncaught TypeError after CLAUDE.md had already been rewritten: a
// half-installed repo, a stack trace, and no warning.
for (const [label, hooks] of [
  ['hooks is a number', '5'],
  ['hooks.SessionStart is a string', '{"SessionStart":"nope"}'],
  ['a null entry in the array', '{"SessionStart":[null]}'],
]) {
  const root = join(ROOT, `hostile-${++n}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  const before = `{"permissions":{"allow":["Bash(npm test)"]},"hooks":${hooks}}`;
  writeFileSync(join(root, '.claude', 'settings.json'), before);
  let threw = null;
  let res = null;
  try { res = installRepoMode(root); } catch (err) { threw = err.message; }
  check(threw === null, `${label}: does not throw (${threw || 'clean'})`);
  check(res && (res.warnings || []).length === 1, `${label}: is reported as a warning`);
  check(readFileSync(join(root, '.claude', 'settings.json'), 'utf8') === before,
    `${label}: leaves the file byte-identical`);
}

// --- the marker rules install.js shares with digest.js -----------------------------------------
{
  const root = join(ROOT, `markers-${++n}`);
  mkdirSync(root, { recursive: true });
  // An indented example plus a real block: the example must not be mistaken for ours.
  writeFileSync(join(root, 'CLAUDE.md'),
    '# P\n\nshown as:\n\n    <!-- stickies:repo-start -->\n    ...\n    <!-- stickies:repo-end -->\n\n' +
    '## Keep\nthis line\n\n<!-- stickies:repo-start -->\nOLD BODY\n<!-- stickies:repo-end -->\n');
  installRepoMode(root);
  const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  check(md.includes('    <!-- stickies:repo-start -->'), 'an indented example is left alone');
  check(md.includes('this line'), 'and the prose between it and the real block survives');
  check(!md.includes('OLD BODY'), 'while the real block is the one refreshed');
}

console.log(fail ? `\nrepo-mode-install: ${fail} FAILED` : '\nrepo-mode-install: all passed');
cleanup(ROOT);
process.exit(fail ? 1 : 0);
