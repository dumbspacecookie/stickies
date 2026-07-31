// The release gate. Nothing goes to a repo or to npm without this passing.
//
// WHY THIS FILE EXISTS. Every bug this project has shipped was found later by reading code, not
// by a test going red — the dev README documented a port the code had already moved off, three
// call sites hand-rolled a redaction ordering that leaked, a hook-side fix sat inert for days
// because the plugin cache is keyed by version, and a corrupt sync file silently became an empty
// board. In every case the suite was green. Green was never the problem; green was the problem's
// disguise.
//
// So this is not another test file. Each check below encodes a mistake that actually happened,
// phrased so the same mistake cannot be made quietly again. A check that has never caught
// anything and could not catch anything should be deleted, not kept for the look of it.
//
// The gate runs in two halves:
//   1. STATIC — the checks in this file. Fast, deterministic, no excuses.
//   2. AGENTS — the review swarm. Cannot be automated from here; see GATE.md. `--agents-done`
//      records that it happened, and `npm run gate:release` requires it.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// GATE_ROOT is a test seam, and it exists because of the two checks in this file that spent their
// whole first life passing while blind. The only way to know a check goes red is to run the WHOLE
// gate against a tree where the thing it guards is broken — asserting on a helper function proves
// the helper works, which is not the same claim. test/gate-test.mjs builds such trees.
const ROOT = process.env.GATE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

let failures = 0;
let warnings = 0;
const fail = (name, detail) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`); };
const warn = (name, detail) => { warnings++; console.log(`  ! ${name}\n      ${detail}`); };
const pass = (name) => console.log(`  ✓ ${name}`);

// Every .js/.mjs under src/, plus the docs we make claims in.
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SRC = walk(join(ROOT, 'src'));
const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

console.log('\nSTATIC CHECKS\n');

// --- 1. the suite ---------------------------------------------------------------------------
// First, because everything after it is meaningless if the product is broken.
if (args.has('--no-tests')) {
  warn('test suite', 'SKIPPED via --no-tests (never skip this before a release)');
} else {
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
    pass('test suite');
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const failed = out.split('\n').filter((l) => /^\s*FAIL|FAILED/.test(l)).slice(0, 5);
    fail('test suite', failed.length ? failed.join('\n      ') : 'npm test exited non-zero');
  }
}

// --- 2. documented facts must match the code -------------------------------------------------
// The README told users to open port 4317 for weeks after the code moved to 7317, and nothing
// noticed because nothing compares prose to behaviour. Anything the docs state as a literal that
// the code owns as a constant gets checked here.
{
  const portSrc = read(join(ROOT, 'src', 'dashboard-port.js'));
  const m = portSrc.match(/DEFAULT_PORT\s*=\s*(\d+)/);
  if (!m) fail('dashboard port', 'could not find DEFAULT_PORT in src/dashboard-port.js');
  else {
    const port = m[1];
    const docs = ['README.md', 'USAGE.md', 'PHONE.md', 'SECURITY.md'].filter((f) => existsSync(join(ROOT, f)));
    const stale = [];
    for (const d of docs) {
      const text = read(join(ROOT, d));
      // Any 4-digit 127.0.0.1 port or `--port NNNN` that is not the real default.
      // Three shapes, and the prose one matters most: "the old server is probably still holding
      // port 4317" is exactly how a doc goes stale, and the address-only form never saw it.
      // `--port NNNN` is deliberately EXCLUDED — an example showing a non-default port is correct
      // documentation, not drift.
      for (const hit of text.matchAll(/(?:127\.0\.0\.1:|localhost:)(\d{4,5})/g)) {
        if (hit[1] !== port) stale.push(`${d}: ${hit[0]}`);
      }
      // The preceding character must not be `-`: `\bport` matches inside `--port` (a hyphen is a
      // word boundary), so the flag example `--port 7318` — correct documentation of a
      // non-default port — was reported as drift.
      for (const hit of text.matchAll(/(^|[^-\w])port\s+(\d{4,5})\b/gi)) {
        if (hit[2] !== port) stale.push(`${d}: "port ${hit[2]}"`);
      }
    }
    if (stale.length) fail('docs match the dashboard port', `code says ${port}; docs say:\n      ${stale.join('\n      ')}`);
    else pass(`docs match the dashboard port (${port})`);
  }
}

// --- 3. the redaction ordering that keeps coming back ----------------------------------------
// `redactSecrets(x.slice(0, n))` cuts a credential in half before the anchored patterns can match
// it, so the fragment is stored verbatim and the sync export republishes it. It was hand-written
// five separate times. One helper — `redactAndCap` — owns the ordering; anything else is the bug.
//
// This check was itself a copy-paste of check 5 for its whole first life: the body was an
// invisible-character regex, the word "redact" never appeared, and it reported a green tick over
// the only credential-disclosure guard in the file. Which is the argument for mutating a check
// before believing it, not for writing more checks.
{
  const offenders = [];

  // A GENERATED region is a verbatim copy of a file that was already checked at its source, so
  // checking it twice can only produce a false positive — and it did: `redactAndCap`'s own
  // internals are `redactSecrets(s.slice(0, cap + SCAN_SLACK))`, which is the exact shape this
  // check hunts, exempted in src/redact.js because that IS the helper. Inlined into engine.mjs the
  // exemption did not travel and the gate failed on correct code.
  //
  // Blanked line-by-line rather than cut, so the line numbers in any offender report below still
  // point at the right line of the real file. Only the marked region goes; engine.mjs's own
  // hand-written code is scanned exactly as before, because that code has nothing generating it.
  const blankGenerated = (text) => {
    const lines = text.split('\n');
    let inside = false;
    return lines.map((line) => {
      if (/^\/\/ <<<GENERATED:/.test(line)) { inside = true; return ''; }
      if (/^\/\/ <<<END GENERATED:/.test(line)) { inside = false; return ''; }
      return inside ? '' : line;
    }).join('\n');
  };

  for (const f of SRC) {
    const text = blankGenerated(read(f));
    const isHelper = /src[/\\]redact\.js$/.test(f.replace(/\\/g, '/'));

    // (a) the direct form, tolerant of line breaks inside the call.
    if (!isHelper) {
      for (const m of text.matchAll(/redactSecrets\s*\(/g)) {
        // Balanced-paren scan, not indexOf(')'). The first `)` after `redactSecrets(` in
        // `redactSecrets(String(x).slice(0, n))` belongs to `String(...)`, so an indexOf-based
        // reader saw the argument as `redactSecrets(String(x)` — no `.slice` in it — and passed.
        // This check survived a mutation reverting the exact bug it exists to catch.
        let depth = 0, end = -1;
        for (let i = m.index + m[0].length - 1; i < text.length && i < m.index + 600; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        const arg = text.slice(m.index, end === -1 ? m.index + 600 : end + 1);
        if (/\.(?:slice|substring|substr)\s*\(/.test(arg)) {
          offenders.push(`${rel(f)}:${text.slice(0, m.index).split('\n').length}  direct: ${arg.replace(/\s+/g, ' ').slice(0, 70)}`);
        }
      }
      // (b) the variable form: `const s = x.slice(...)` then `redactSecrets(s)` nearby.
      for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*\.(?:slice|substring|substr)\s*\(/g)) {
        const name = m[1];
        const after = text.slice(m.index, m.index + 400);
        if (new RegExp(`redactSecrets\\s*\\(\\s*${name}\\b`).test(after)) {
          offenders.push(`${rel(f)}:${text.slice(0, m.index).split('\n').length}  via \`${name}\``);
        }
      }
    }

    // (c) a SECOND definition of the redactor outside the helper. repo-mode/engine.mjs carries an
    // inlined copy by necessity (it runs in someone else's repo with no imports), but that copy is
    // GENERATED and has already been blanked out of `text` above — and check 10 fails if it has
    // drifted from its source. So what reaches here is a redactor somebody TYPED, with nothing
    // keeping it in step, which is precisely the arrangement that shipped three releases missing
    // nine token shapes. That is a failure, not a warning.
    //
    // Note this deliberately does not exempt engine.mjs as a FILE. A hand-written redactor added
    // to it outside the markers is exactly the bug coming back, and would be invisible to check 10.
    if (!isHelper && /function\s+redactSecrets\s*\(/.test(text)) {
      offenders.push(`${rel(f)}  defines its own redactSecrets — import it from src/redact.js, or generate it (see scripts/build-engine.mjs)`);
    }
  }
  if (offenders.length) {
    fail('no hand-rolled redact-then-cap', `use redactAndCap(value, cap) instead:\n      ${offenders.join('\n      ')}`);
  } else pass('no hand-rolled redact-then-cap');
}

// --- 4. git commands that commit or push more than they were asked to -------------------------
// `git commit` with no pathspec commits the whole index — it published a staged .env.local in
// testing. Any commit this project makes on a user's repo must name its own file.
//
// The first version of this check was line-based and PASSED ON THE VERY FIX IT WAS WRITTEN FOR:
// the corrected call spreads its argv over three lines, so the line holding `'commit'` had no
// `[` and was skipped entirely. It reported a green tick for a file it had never examined. Now it
// scans the whole file text and reads the argument list around each `'commit'`, so line breaks
// are irrelevant — and a check that cannot be satisfied by reformatting is the only kind worth
// having.
{
  const offenders = [];
  for (const f of SRC) {
    const text = read(f);
    // Every quoted 'commit' that looks like a git argv entry.
    for (const m of text.matchAll(/['"]commit['"]/g)) {
      // The argv it belongs to: back to the opening bracket, forward to the closing one.
      const open = text.lastIndexOf('[', m.index);
      const close = text.indexOf(']', m.index);
      if (open === -1 || close === -1) continue; // not an array literal — not a spawn argv
      const argv = text.slice(open, close + 1);
      // Only care about git invocations: the argv must not span half the file.
      if (argv.length > 400) continue;
      if (!/['"]--['"]/.test(argv)) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        offenders.push(`${rel(f)}:${lineNo}  ${argv.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
  }
  if (offenders.length) {
    fail('git commit is pathspec-scoped', `add \`'--', <file>\` so unrelated staged files are not committed:\n      ${offenders.join('\n      ')}`);
  } else pass('git commit is pathspec-scoped');
}

// --- 5. invisible characters in source --------------------------------------------------------
// A literal U+2028 in a character class is correct and completely unreadable; the next edit drops
// it and nobody sees why. Same family as the stray backtick that has cost this project hours.
{
  const offenders = [];
  for (const f of SRC) {
    const text = read(f);
    text.split('\n').forEach((line, i) => {
      // Escapes, necessarily: written literally, U+2028 IS a line terminator to the JS parser,
      // so the regex split across two lines and this file would not load. The check broke in
      // precisely the way it exists to describe.
      // Four characters was not a set, it was a sample. The bidi overrides are the dangerous
      // ones — Trojan Source: they reorder how a line RENDERS without changing what it MEANS, so
      // a reviewer reads one thing and the parser compiles another.
      if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\ufeff\u00ad\u2028\u2029]/.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  if (offenders.length) fail('no invisible characters in source', `use \\u escapes:\n      ${offenders.join('\n      ')}`);
  else pass('no invisible characters in source');
}

// --- 6. every test file is actually wired into `npm test` -------------------------------------
// A test nobody runs is worse than no test: it reads as coverage. sync-safety-test.mjs sat
// unregistered and the suite total never moved.
{
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const script = pkg.scripts?.test || '';
  const files = readdirSync(join(ROOT, 'test'))
    .filter((f) => /-test\.mjs$/.test(f));
  // Word-boundary match, not `includes`: `sync-test.mjs` is a substring of
  // `git-sync-test.mjs`, so de-registering the former passed while it never ran again.
  // Token match, not `includes`: `sync-test.mjs` is a substring of `git-sync-test.mjs`, so
  // de-registering the former passed while it silently never ran again. Splitting the script on
  // whitespace and comparing whole path tokens avoids regex-escaping the filename entirely —
  // the first attempt at this built a RegExp and its `$&` was eaten as a backreference, which
  // flagged every test file in the suite as unregistered.
  const tokens = new Set(
    script.split(/\s+/).map((t) => t.replace(/\\/g, '/').split('/').pop())
  );
  const missing = files.filter((f) => !tokens.has(f));
  // A test that CANNOT FAIL is worse than no test: it reads as coverage and `npm test` walks
  // straight past it. `autocapture-test.mjs` carries a comment about exactly that happening —
  // it printed "AUTO-CAPTURE FAILED" and exited 0.
  //
  // So the property is the exit, not the vocabulary. Matching assertion-helper names by spelling
  // was hopeless: this suite variously calls it `check`, `ok`, or a bare boolean, and every
  // guess flagged a pile of perfectly good files — the noise that teaches people to skim a
  // warning list. A file must have some route to a non-zero exit.
  const canFail = /process\.exit\s*\(\s*(?!0\s*\))|process\.exitCode\s*=|throw\s+new\s+/;
  const hollow = files.filter((f) => !canFail.test(read(join(ROOT, 'test', f))));
  if (hollow.length) {
    warn('every test can actually fail',
      `no path to a non-zero exit — these cannot report failure:\n      ${hollow.join('\n      ')}`);
  }
  if (missing.length) fail('every *-test.mjs runs in `npm test`', `unregistered:\n      ${missing.join('\n      ')}`);
  else pass(`every *-test.mjs runs in \`npm test\` (${files.length})`);
}

// --- 7. version agreement, because the plugin cache is keyed by it ----------------------------
// A hook-side change does nothing until the version changes: the cache is keyed by it. This
// project ran pre-fix hook code for days because the manifest still said 0.9.0.
{
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const manifestPath = join(ROOT, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) warn('version agreement', 'no .claude-plugin/plugin.json');
  else {
    const manifest = JSON.parse(read(manifestPath));
    if (manifest.version !== pkg.version) {
      fail('version agreement', `package.json ${pkg.version} != plugin.json ${manifest.version} — hook changes will not reach an installed copy`);
    } else {
      pass(`version agreement (${pkg.version})`);
      // Agreement alone passes two stale-but-equal manifests, which is the exact state this
      // project shipped in: both manifests said 0.9.0, they agreed perfectly, and the hook fix
      // reached nobody because the plugin cache is keyed by the version. The question is whether
      // the version MOVED, not whether the two files match — and the only local record of what
      // was last released is the tags.
      //
      // It was a warn. A warn is the wrong shape here: it is indistinguishable from the twelve
      // other warns nobody reads, and the thing it guards is silent by construction.
      const tags = (() => {
        try {
          return execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').map((s) => s.trim().replace(/^v/, '')).filter(Boolean);
        } catch { return null; }
      })();
      if (!tags || !tags.length) {
        // Said out loud rather than passing in silence. "No tags" is not "the version is fine";
        // it is "this check could not run", and a green tick that means the latter is how a gate
        // teaches you to trust it too much.
        warn('version bumped since the last release',
          'no v* git tags here, so there is nothing to compare against — this check proved only that the two manifests agree');
      } else if (!tags.includes(pkg.version)) {
        pass(`version bumped since the last release (v${pkg.version} is not tagged yet)`);
      } else {
        // The version is already released. That is only a problem if the code that ships has
        // changed since — which is precisely the shipped-a-stale-cache bug, and precisely what a
        // tag lets us test.
        const changed = (() => {
          try {
            return execFileSync('git',
              ['diff', '--name-only', `v${pkg.version}`, '--', 'src', 'hooks', 'commands', '.claude-plugin', 'package.json'],
              { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
              .split('\n').map((s) => s.trim()).filter(Boolean);
          } catch { return []; }
        })();
        if (changed.length) {
          fail('version bumped since the last release',
            `v${pkg.version} is already tagged, yet ${changed.length} file(s) that ship have changed since it:\n      ` +
            `${changed.slice(0, 6).join('\n      ')}${changed.length > 6 ? `\n      +${changed.length - 6} more` : ''}\n      ` +
            `bump "version" in package.json AND .claude-plugin/plugin.json — an installed plugin is cached by version, ` +
            `so at v${pkg.version} your changes reach nobody`);
        } else {
          warn('version bumped since the last release',
            `v${pkg.version} is tagged and nothing that ships has changed since — bump before publishing anything new`);
        }
      }
    }
  }
}

// --- 8. dev-only code must not be about to ship ----------------------------------------------
// Not an inventory — a refusal. This was warn-only, so it could never fail, while
// `npm pack --dry-run` showed all three DEV-ONLY apprentice files inside the tarball: publishing
// from this tree would have put the whole dev-only feature on npm under the real package name.
// The public tree's guard test catches a bad PORT; nothing caught a bad PUBLISH.
{
  // The marker must be in the file HEADER, which is where the convention puts it. Scanning the
  // whole file flagged `cli-main.js`, which mentions DEV-ONLY at line 421 to label one command —
  // and excluding that file from the package would ship a CLI with no entry point. A check whose
  // remedy breaks the product is worse than the bug it was guarding.
  const devOnly = SRC.filter((f) => /DEV-ONLY/.test(read(f).split('\n').slice(0, 15).join('\n')));
  if (!devOnly.length) {
    warn('dev-only files stay out of the package', 'no files marked DEV-ONLY — is the marker still used?');
  } else {
    // BOTH streams, and this is not incidental: `npm pack --dry-run` prints the tarball NAME to
    // stdout and the FILE MANIFEST to stderr. Reading stdout alone returns a non-empty string
    // that never contains a single file path, so the check passed while three DEV-ONLY files sat
    // in the tarball. It reported the exact green tick it exists to prevent.
    const r = spawnSync('npm', ['pack', '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
    });
    const packed = `${r.stdout || ''}${r.stderr || ''}`;
    const shipping = devOnly.filter((f) => packed.includes(rel(f)));
    if (!packed) {
      warn('dev-only files stay out of the package', 'could not run npm pack --dry-run to verify');
    } else if (shipping.length) {
      fail('dev-only files stay out of the package',
        `these are marked DEV-ONLY and are inside the npm tarball — add them to .npmignore or narrow "files":\n      ${shipping.map(rel).join('\n      ')}`);
    } else {
      pass(`dev-only files stay out of the package (${devOnly.length} checked)`);
    }
  }
}

// --- 9. enforcement is actually armed in this clone -------------------------------------------
// `core.hooksPath` lives in `.git/config`, which is not a tracked file, so it does not travel: a
// fresh clone of this repo has NO pre-push hook and therefore no gate at all until somebody
// remembers a command nobody remembers. The low-friction fix is package.json's `prepare` script,
// which npm runs after `npm install` in a git checkout — so arming is a side effect of setting the
// project up. This check exists because "there is a prepare script" and "this clone is armed" are
// different claims, and only the second one protects anything.
{
  const inRepo = (() => {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  })();
  if (!inRepo) {
    warn('push enforcement is armed', 'not a git working tree — there is no hook to arm here');
  } else {
    const configured = (() => {
      const r = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' });
      return r.status === 0 ? String(r.stdout).trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
    })();
    if (configured !== '.githooks') {
      fail('push enforcement is armed',
        `core.hooksPath is ${configured ? `"${configured}"` : 'unset'}, so .githooks/pre-push never runs and a push bypasses ` +
        `this gate entirely.\n      arm it with: git config core.hooksPath .githooks`);
    } else if (!existsSync(join(ROOT, '.githooks', 'pre-push'))) {
      fail('push enforcement is armed', 'core.hooksPath is .githooks but there is no pre-push hook in it');
    } else {
      // The mode bit, which git tracks and which POSIX git requires: a hook committed 100644 is
      // silently NOT RUN on macOS and Linux. On Windows it works anyway, which is exactly how a
      // repo developed on Windows ships an enforcement path that protects nobody else.
      const entry = (() => {
        const r = spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-push'], { cwd: ROOT, encoding: 'utf8' });
        return r.status === 0 ? String(r.stdout).trim() : '';
      })();
      const mode = entry.split(/\s+/)[0] || '';
      if (!entry) {
        fail('push enforcement is armed', '.githooks/pre-push is not tracked by git, so no clone will ever get it');
      } else if (mode !== '100755') {
        fail('push enforcement is armed',
          `.githooks/pre-push is committed mode ${mode}, not 100755 — POSIX git refuses to execute a hook that is not ` +
          `executable, so every clone on macOS/Linux pushes with no gate at all.\n      ` +
          `fix it with: git update-index --chmod=+x .githooks/pre-push && git commit -m "chmod +x pre-push" -- .githooks/pre-push`);
      } else if (read(join(ROOT, '.githooks', 'pre-push')).includes('\r')) {
        // Same failure, different cause, and just as invisible from Windows: a shell script with
        // CRLF line endings makes `/bin/sh` read the shebang as `#!/bin/sh\r` and every command as
        // `<cmd>\r`. It does not run, and the push goes through ungated.
        fail('push enforcement is armed',
          '.githooks/pre-push has CRLF line endings — /bin/sh cannot execute it (it reads the interpreter as "/bin/sh\\r"), ' +
          'so the hook is silently absent on macOS/Linux.\n      ' +
          'fix it by adding `.githooks/** text eol=lf` to .gitattributes and re-checking the file out with LF endings');
      } else {
        pass('push enforcement is armed (core.hooksPath=.githooks, hook is executable)');
      }
    }
  }
}

// --- 10. the inlined engine matches the modules it was copied from ----------------------------
// src/repo-mode/engine.mjs is committed into the USER's repository and runs there with no
// node_modules, so it cannot import src/redact.js — it inlines a copy. Hand-maintained, that copy
// fell nine token shapes, an armor-header fix and a redaction-idempotence guard behind the
// canonical one, and its directive parser kept the `^\s*` anchor that let a hostile repo's README
// drive a cross-project write. Three releases. Both copies "reviewed" each time.
//
// The copy is generated now. This is the check that makes generation mean something — and it is
// here as well as in the suite because this is the file that leaves the building.
{
  let mod = null;
  let err = null;
  try {
    mod = await import('./build-engine.mjs');
  } catch (e) { err = e; }
  if (err || typeof mod?.generateEngine !== 'function') {
    fail('inlined engine is up to date', `scripts/build-engine.mjs could not be loaded (${err?.message || 'no generateEngine export'})`);
  } else {
    try {
      // ROOT, not the real repo — see the note in build-engine.mjs. Passing the gate's own root is
      // what makes this check answer the same question as every other check in this file.
      const { changed, stamp } = mod.generateEngine({ root: ROOT });
      if (changed) {
        fail('inlined engine is up to date',
          'src/repo-mode/engine.mjs no longer matches src/redact.js / src/directives.js.\n      ' +
          'repo-mode would ship weaker redaction and a weaker directive parser than every other path.\n      ' +
          'fix: node scripts/build-engine.mjs');
      } else {
        pass(`inlined engine is up to date (stamp ${stamp})`);
      }
    } catch (e) {
      // A tree with no repo-mode engine has nothing to be stale — that is the fixture case, and it
      // is reported as a skip rather than a green tick so it can never read as evidence.
      if (e instanceof mod.NoEngineHere) warn('inlined engine is up to date', 'this tree has no src/repo-mode/engine.mjs — nothing to check');
      else fail('inlined engine is up to date', `the generator threw: ${e.message}`);
    }
  }
}

// --- 11. the agent review actually happened ---------------------------------------------------
// The half that cannot be automated. `--agents-done` records what was reviewed; gate:release
// refuses if that record is missing or describes different code.
//
// It used to record `git rev-parse HEAD`, and every check in this file reads the WORKING TREE.
// Those are different things, so the stamp was proof of the wrong fact: stamp, then edit without
// committing, and `--release` still passed on code no agent had ever read. Worse, `--agents-done`
// with a dirty tree stamped a commit that did not contain what was reviewed EITHER.
//
// So the stamp now records a content fingerprint of the files a review actually covers — tracked
// or not, committed or not — and `--release` recomputes it and names what moved. HEAD is still
// recorded, as a label for humans; nothing is decided by it.
//
// What this still cannot do: the stamp is a plain JSON file, forgeable by anyone willing to type
// out the hashes, and `.flow/` is gitignored so it never travels between clones. It is a record,
// not a credential. See GATE.md, "Honest limits".
const STAMP = join(ROOT, '.flow', 'gate-agents.json');

function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

// Everything an area-by-area review in GATE.md is asked to read, plus the manifests and the docs
// that make claims about them. Not just `src/`: the review covers the hook wiring, the gate
// itself, and the documents whose accuracy this whole file exists to defend.
function reviewedFiles(root) {
  const out = [];
  const walkAll = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walkAll(p);
      else out.push(p);
    }
  };
  for (const d of ['src', 'scripts', 'test', 'hooks', 'commands', '.githooks']) {
    if (existsSync(join(root, d))) walkAll(join(root, d));
  }
  for (const f of ['package.json', '.npmignore', '.claude-plugin/plugin.json', 'GATE.md',
    'README.md', 'USAGE.md', 'PHONE.md', 'SECURITY.md']) {
    if (existsSync(join(root, f))) out.push(join(root, f));
  }
  return out.sort();
}

function fingerprint(root) {
  const files = {};
  for (const f of reviewedFiles(root)) {
    files[rel(f)] = createHash('sha1').update(readFileSync(f)).digest('hex');
  }
  return files;
}

// What moved between two fingerprints, phrased so the failure names files rather than a hash the
// reader can do nothing with.
function fingerprintDelta(before = {}, after = {}) {
  const moved = [];
  for (const f of Object.keys(after)) {
    if (!(f in before)) moved.push(`added   ${f}`);
    else if (before[f] !== after[f]) moved.push(`changed ${f}`);
  }
  for (const f of Object.keys(before)) if (!(f in after)) moved.push(`removed ${f}`);
  return moved.sort();
}

if (args.has('--agents-done')) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dirname(STAMP), { recursive: true });
  const files = fingerprint(ROOT);
  writeFileSync(STAMP, JSON.stringify({ head: headSha(), at: new Date().toISOString(), files }, null, 2));
  console.log(`\n  agent review recorded over ${Object.keys(files).length} files (HEAD ${headSha()?.slice(0, 8) || 'n/a'})`);
}
if (args.has('--release')) {
  if (!existsSync(STAMP)) {
    fail('agent review', 'no record of a review — run the swarm in GATE.md, then `npm run gate:agents-done`');
  } else {
    let stamp = null;
    try { stamp = JSON.parse(read(STAMP)); } catch { stamp = null; }
    if (!stamp || !stamp.files || typeof stamp.files !== 'object') {
      // A stamp from before this check, or a corrupt one. Refusing is the only safe reading:
      // a record that cannot say WHAT was reviewed is not evidence that anything was.
      fail('agent review', 'the review record does not say which files were reviewed (it predates this check, or it is corrupt) — re-run `npm run gate:agents-done`');
    } else {
      const moved = fingerprintDelta(stamp.files, fingerprint(ROOT));
      if (moved.length) {
        fail('agent review',
          `${moved.length} reviewed file(s) have changed since the review — committed or not:\n      ` +
          `${moved.slice(0, 8).join('\n      ')}${moved.length > 8 ? `\n      +${moved.length - 8} more` : ''}\n      ` +
          `review again, then \`npm run gate:agents-done\``);
      } else {
        pass(`agent review recorded (${Object.keys(stamp.files).length} files unchanged since ${stamp.at})`);
      }
    }
  }
}

console.log(
  failures
    ? `\nGATE FAILED — ${failures} blocking, ${warnings} warning(s)\n`
    : `\nGATE PASSED${warnings ? ` — ${warnings} warning(s)` : ''}\n`
);
process.exit(failures ? 1 : 0);
