// Tests for the gate itself — the thing that decides whether anything ships.
//
// This file exists because of a specific, embarrassing pattern in scripts/gate.mjs: two of its
// checks spent their entire first life PASSING while blind (one was a copy-paste of another
// check's body and never mentioned the thing it claimed to guard), and a third passed on the very
// fix it was written for. A gate is the one place where a green tick is taken as proof, so a
// green tick from a check nobody has watched go red is worse than having no check.
//
// So every assertion below runs the WHOLE gate against a throwaway tree — via the GATE_ROOT seam
// — in which exactly one thing is wrong. Asserting on an exported helper would prove the helper
// works, which is a different claim from "the gate refuses".
//
// Covered here: the four holes an adversarial review of the gate found and left open.
//   * the agent-review stamp recorded `git rev-parse HEAD` while the checks read the WORKING
//     TREE, so you could stamp, edit without committing, and still pass `--release`
//   * `.githooks/pre-push` inspected the working tree rather than the commits being pushed, so
//     stale committed code plus an uncommitted fix read as green
//   * a fresh clone had no enforcement at all (core.hooksPath is not a tracked setting)
//   * the hook was committed mode 100644, which POSIX git will not execute
//   * check 7 verified that the two manifests AGREE, not that the version was BUMPED

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir, cleanup } from './_env.mjs';
import { REGIONS } from '../scripts/build-engine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO, 'scripts', 'gate.mjs');
const ROOT = scratchDir('gate');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// Run the real gate against a fixture tree. --no-tests always: check 1 would run the FIXTURE's
// `npm test`, which is not what any assertion here is about.
function gate(root, extra = []) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', GATE, '--no-tests', ...extra], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GATE_ROOT: root },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const said = (out, icon, name) => out.split('\n').some((l) => l.trim().startsWith(`${icon} ${name}`));
const failed = (r, name) => said(r.out, '✗', name);
const passed = (r, name) => said(r.out, '✓', name);
const warned = (r, name) => said(r.out, '!', name);

// A minimal tree that the gate is happy with, so that a later assertion about ONE broken thing is
// about that thing and nothing else.
function makeFixture(dir, { version = '1.0.0', manifestVersion = version } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, 'src', 'dashboard-port.js'), 'export const DEFAULT_PORT = 7317;\n');
  writeFileSync(join(dir, 'src', 'thing.js'), 'export const thing = 1;\n');
  writeFileSync(join(dir, 'test', 'sample-test.mjs'), 'if (1 !== 1) throw new Error("no");\nprocess.exit(0);\n');
  writeFileSync(join(dir, 'hooks', 'hooks.json'), '{}\n');
  writeFileSync(join(dir, 'README.md'), 'Open http://127.0.0.1:7317/ to see the board.\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version, scripts: { test: 'node test/sample-test.mjs' },
  }, null, 2));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: manifestVersion }, null, 2));
  cpSync(join(REPO, '.githooks', 'pre-push'), join(dir, '.githooks', 'pre-push'));
}

const git = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
function gitInit(dir) {
  spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}
function gitCommitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').stdout.trim();
}

try {
  // --- the fixture itself passes, or nothing below means anything --------------------------
  const F = join(ROOT, 'plain');
  makeFixture(F);
  {
    const r = gate(F);
    check(r.code === 0 && /GATE PASSED/.test(r.out), `a clean fixture passes the gate (exit ${r.code})`);
    check(warned(r, 'push enforcement is armed'), 'a tree that is not a git repo warns about enforcement rather than failing');
  }

  // --- THE STAMP: it must describe what was reviewed, not what was committed ---------------
  // The hole, exactly: `--agents-done` recorded HEAD, every check reads the working tree, so
  // stamping and then editing without committing sailed through `--release`. This fixture is not
  // a git repo at all, which is the purest form of the same problem — there is no HEAD to lean
  // on, and the old code's `if (head && ...)` guard made that an automatic pass.
  {
    let r = gate(F, ['--agents-done']);
    check(r.code === 0 && /agent review recorded over \d+ files/.test(r.out),
      'recording a review names how many files it covered');
    r = gate(F, ['--release']);
    check(passed(r, 'agent review') && r.code === 0, 'an unchanged tree passes --release');

    writeFileSync(join(F, 'src', 'thing.js'), 'export const thing = 2; // edited, never committed\n');
    r = gate(F, ['--release']);
    check(failed(r, 'agent review') && r.code !== 0, 'editing a reviewed file without committing FAILS --release');
    check(/changed src\/thing\.js/.test(r.out), 'and the failure names the file that changed');

    writeFileSync(join(F, 'src', 'thing.js'), 'export const thing = 1;\n'); // put it back
    r = gate(F, ['--release']);
    check(r.code === 0, 'restoring the file byte-for-byte passes again (the stamp is about content)');

    writeFileSync(join(F, 'src', 'smuggled.js'), 'export const surprise = true;\n');
    r = gate(F, ['--release']);
    check(failed(r, 'agent review') && /added\s+src\/smuggled\.js/.test(r.out),
      'a NEW file that no agent read also fails, and is named');
    rmSync(join(F, 'src', 'smuggled.js'));

    // The docs are part of the reviewed set: this gate's entire premise is that a document making
    // a false claim is a defect, so a doc edited after the review is unreviewed code.
    const gateDoc = join(F, 'GATE.md');
    writeFileSync(gateDoc, '# fixture doc\n');
    r = gate(F, ['--agents-done']);
    writeFileSync(gateDoc, '# fixture doc, quietly rewritten after the review\n');
    r = gate(F, ['--release']);
    check(failed(r, 'agent review') && /changed GATE\.md/.test(r.out), 'a document rewritten after the review fails too');
    rmSync(gateDoc);

    // A stamp in the old shape — the one that recorded only a commit — must not be honoured.
    // Silently accepting it would mean the fix does nothing on any machine that already has one.
    gate(F, ['--agents-done']);
    const stampPath = join(F, '.flow', 'gate-agents.json');
    writeFileSync(stampPath, JSON.stringify({ head: 'a'.repeat(40), at: new Date().toISOString() }));
    r = gate(F, ['--release']);
    check(failed(r, 'agent review') && /which files/.test(r.out),
      'a stamp that predates this check is refused, not trusted');
    writeFileSync(stampPath, '{ not json');
    r = gate(F, ['--release']);
    check(failed(r, 'agent review'), 'and so is a corrupt one');
    rmSync(join(F, '.flow'), { recursive: true, force: true });
  }

  // --- ENFORCEMENT: armed in this clone, and executable ------------------------------------
  // core.hooksPath lives in .git/config and is never committed, so a fresh clone has no hook and
  // no gate. And a hook committed 100644 is not executed by POSIX git at all — invisible on
  // Windows, where this project is developed, and total on everyone else's machine.
  {
    const G = join(ROOT, 'repo');
    makeFixture(G);
    gitInit(G);
    gitCommitAll(G, 'first');

    let r = gate(G);
    check(failed(r, 'push enforcement is armed') && r.code !== 0,
      'a git clone with no core.hooksPath FAILS — a fresh clone is not protected by an unarmed hook');
    check(/git config core\.hooksPath \.githooks/.test(r.out), 'and the failure is a command you can paste');

    git(G, 'config', 'core.hooksPath', '.githooks');
    r = gate(G);
    check(failed(r, 'push enforcement is armed') && /mode 100644/.test(r.out),
      'armed but committed 100644 still fails: POSIX git will not run a non-executable hook');
    check(/update-index --chmod=\+x/.test(r.out), 'and again the fix is pasteable');

    git(G, 'update-index', '--chmod=+x', '.githooks/pre-push');
    gitCommitAll(G, 'chmod');
    r = gate(G);
    check(passed(r, 'push enforcement is armed'), 'armed + executable passes');

    // CRLF is the same hole wearing a different hat, and it is the one a Windows checkout walks
    // into by accident: /bin/sh reads the shebang as "/bin/sh\r", cannot find that interpreter,
    // and the hook silently does not run.
    const hookPath = join(G, '.githooks', 'pre-push');
    const hookText = readFileSync(hookPath, 'utf8');
    writeFileSync(hookPath, hookText.replace(/\n/g, '\r\n'));
    r = gate(G);
    check(failed(r, 'push enforcement is armed') && /CRLF/.test(r.out),
      'a hook with CRLF line endings fails: /bin/sh cannot execute it');
    check(/eol=lf/.test(r.out), 'and the fix names the .gitattributes line that prevents it');
    writeFileSync(hookPath, hookText);

    // The hook file itself going missing must not read as "armed".
    rmSync(join(G, '.githooks', 'pre-push'));
    r = gate(G);
    check(failed(r, 'push enforcement is armed'), 'a missing hook file fails even when core.hooksPath points at it');
    git(G, 'checkout', '--', '.githooks/pre-push');
  }

  // --- VERSION: bumped, not merely agreed --------------------------------------------------
  // Two stale-but-equal manifests passed this check, which is the exact state the project shipped
  // in when a hook fix reached nobody: the plugin cache is keyed by version, both files said
  // 0.9.0, and they agreed perfectly.
  {
    const V = join(ROOT, 'versioned');
    makeFixture(V, { version: '1.0.0' });
    gitInit(V);
    git(V, 'config', 'core.hooksPath', '.githooks');
    gitCommitAll(V, 'first');
    git(V, 'update-index', '--chmod=+x', '.githooks/pre-push');
    gitCommitAll(V, 'chmod');

    let r = gate(V);
    check(warned(r, 'version bumped since the last release') && /no v\* git tags/.test(r.out),
      'with no tags the check says it could not run, instead of passing quietly');

    git(V, 'tag', 'v1.0.0');
    r = gate(V);
    check(warned(r, 'version bumped since the last release') && /nothing that ships has changed/.test(r.out),
      'a tagged version with no changes since is a warn — there is nothing to publish');

    writeFileSync(join(V, 'src', 'thing.js'), 'export const thing = 99; // a hook-side fix\n');
    r = gate(V);
    check(failed(r, 'version bumped since the last release') && r.code !== 0,
      'shipping code changed since the tag while the version stands still FAILS');
    check(/src\/thing\.js/.test(r.out), 'and names what changed');
    check(/cached by version/.test(r.out) || /reach nobody/.test(r.out),
      'and says why it matters: an installed plugin is cached by version');

    // Bumping both manifests is the way out.
    writeFileSync(join(V, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.1', scripts: { test: 'node test/sample-test.mjs' },
    }, null, 2));
    writeFileSync(join(V, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.1' }, null, 2));
    r = gate(V);
    check(passed(r, 'version bumped since the last release'), 'bumping the version clears it');
    check(passed(r, 'version agreement'), 'and the two manifests still have to agree');

    // The original check, still doing its job.
    writeFileSync(join(V, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
    r = gate(V);
    check(failed(r, 'version agreement'), 'a manifest that disagrees with package.json still fails');
  }

  // --- THE HOOK ITSELF ---------------------------------------------------------------------
  // The hook can only be tested by running it. `npm` is stubbed so that "did the gate run?" is an
  // observable: the stub writes a marker file, and a hook that blocks before running the gate
  // leaves no marker. Asserting on the marker rather than only on the exit code is what
  // distinguishes "refused for the right reason" from "refused because npm was missing".
  const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (sh.status !== 0) {
    console.log('  SKIP  no POSIX sh on PATH — the pre-push hook assertions need one');
  } else {
    const H = join(ROOT, 'hooked');
    makeFixture(H);
    gitInit(H);
    const first = gitCommitAll(H, 'first');
    writeFileSync(join(H, 'src', 'thing.js'), 'export const thing = 2;\n');
    const head = gitCommitAll(H, 'second');

    const bin = join(ROOT, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const MARKER = join(ROOT, 'gate-ran.marker');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" > "${MARKER.replace(/\\/g, '/')}"\nexit 0\n`);
    spawnSync('chmod', ['+x', join(bin, 'npm')], { encoding: 'utf8' });

    const ZERO = '0'.repeat(40);
    const runHook = (stdin, env = {}) => {
      rmSync(MARKER, { force: true });
      const r = spawnSync('sh', [join(H, '.githooks', 'pre-push'), 'origin', 'git@example.invalid:x/y.git'], {
        cwd: H, input: stdin, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
      });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, gateRan: existsSync(MARKER) };
    };

    let r = runHook(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    check(r.code === 0 && r.gateRan, `pushing HEAD from a clean tree runs the gate and allows the push (exit ${r.code})`);

    // THE BUG: stale committed code plus an uncommitted local fix. The gate would read the fix;
    // the remote would receive the staleness. Both halves honest, the conclusion wrong.
    writeFileSync(join(H, 'src', 'thing.js'), 'export const thing = 3; // fixed locally, not committed\n');
    r = runHook(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    check(r.code !== 0, 'a dirty working tree BLOCKS the push');
    check(/working tree differs from HEAD/.test(r.out), 'and says the gate would be describing different code');
    check(/thing\.js/.test(r.out), 'naming the file that differs');
    check(!r.gateRan, 'and it refuses before running the gate, rather than passing on the wrong code');
    git(H, 'checkout', '--', 'src/thing.js');

    // Pushing something that is not HEAD: same problem, other direction.
    r = runHook(`refs/heads/main ${first} refs/heads/main ${ZERO}\n`);
    check(r.code !== 0 && /not HEAD/.test(r.out), 'pushing a commit that is not HEAD is blocked');
    check(!r.gateRan, 'again without pretending the gate said anything about it');

    // A branch DELETION carries no code. Blocking it would be theatre.
    r = runHook(`(delete) ${ZERO} refs/heads/old ${first}\n`);
    check(r.code === 0 && !r.gateRan, 'deleting a remote branch is allowed without running the gate');

    // An untracked source file is read by the gate and is not in the commit.
    writeFileSync(join(H, 'src', 'scratch.js'), 'export const wip = true;\n');
    r = runHook(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    check(r.code !== 0 && /untracked source files/.test(r.out), 'an untracked source file blocks the push');
    check(/scratch\.js/.test(r.out), 'and is named');
    rmSync(join(H, 'src', 'scratch.js'));

    // The documented override still works, and still says so out loud.
    r = runHook(`refs/heads/main ${first} refs/heads/main ${ZERO}\n`, { STICKIES_SKIP_GATE: '1' });
    check(r.code === 0 && /SKIPPED/.test(r.out), 'STICKIES_SKIP_GATE=1 remains the one documented override');

    // A failing gate must still block — the point of all the above is to make the gate's verdict
    // MEAN something, not to replace it.
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "npm $*" > "${MARKER.replace(/\\/g, '/')}"\nexit 1\n`);
    spawnSync('chmod', ['+x', join(bin, 'npm')], { encoding: 'utf8' });
    r = runHook(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    check(r.code !== 0 && /the gate failed/.test(r.out) && r.gateRan, 'a failing gate still blocks the push');
  }

  // --- the arming instruction has to exist where a person will meet it ----------------------
  // A fix nobody can find is not a fix. This asserts the two places that carry it in the real
  // repo, because the hole was never "there is no command" — it was "nothing tells you".
  {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    check(/core\.hooksPath\s+\.githooks/.test(pkg.scripts?.prepare || ''),
      'package.json has a `prepare` script that arms the hook on npm install');
    const doc = readFileSync(join(REPO, 'GATE.md'), 'utf8');
    check(/git config core\.hooksPath \.githooks/.test(doc), 'GATE.md states the manual arming command');
    check(/npm install/i.test(doc) && /prepare|arm/i.test(doc), 'and says that installing arms it for you');
  }

  // --- the inlined repo-mode engine must match the modules it was generated from -------------
  // engine.mjs is committed into a USER's repository, so a redactor fix that does not reach it
  // does not reach them. Hand-maintained, that copy fell nine credential patterns behind and the
  // parity test printed the drift into a green suite for three releases. It is generated now, and
  // this is the assertion that the generation is load-bearing rather than decorative.
  {
    const fixture = join(ROOT, 'engine-drift');
    makeFixture(fixture);

    // No engine in this tree at all: a skip, never a green tick. "Up to date" said over a file
    // that does not exist is the same lie as a check that passes while blind.
    const absent = gate(fixture);
    check(warned(absent, 'inlined engine is up to date') && !passed(absent, 'inlined engine is up to date'),
      'a tree with no repo-mode engine reports a skip, not a pass');

    // Now give the fixture a real, correctly-generated engine, then drift it.
    // Every REGION source, not a hardcoded pair — the list grew when directives.js was made to
    // import the shared fence scanner instead of carrying its own, and a fixture that misses one
    // fails as "engine out of date" for a reason that has nothing to do with what is being tested.
    mkdirSync(join(fixture, 'src', 'repo-mode'), { recursive: true });
    mkdirSync(join(fixture, 'src', 'flow'), { recursive: true });
    for (const { source } of REGIONS) cpSync(join(REPO, source), join(fixture, source));
    cpSync(join(REPO, 'src', 'repo-mode', 'engine.mjs'), join(fixture, 'src', 'repo-mode', 'engine.mjs'));
    check(passed(gate(fixture), 'inlined engine is up to date'),
      'a freshly generated engine passes');

    // Drift it the way it really drifted: weaken the inlined copy of a credential pattern while
    // leaving the canonical one alone. This is the exact shape of the bug that shipped.
    const enginePath = join(fixture, 'src', 'repo-mode', 'engine.mjs');
    const before = readFileSync(enginePath, 'utf8');
    const drifted = before.replace('/hf_[A-Za-z0-9]{20,}/g', '/hf_NEVERMATCHES{20,}/g');
    check(drifted !== before, 'control: the drift mutation actually applied');
    writeFileSync(enginePath, drifted);
    const r = gate(fixture);
    check(failed(r, 'inlined engine is up to date'), 'a weakened inlined redactor FAILS the gate');
    check(/build-engine\.mjs/.test(r.out), 'and the failure names the command that fixes it');

    // The other direction, which is the one that happens in practice: nobody edits the engine, they
    // edit the canonical file and forget it has a copy.
    writeFileSync(enginePath, before);
    const canon = join(fixture, 'src', 'redact.js');
    writeFileSync(canon, readFileSync(canon, 'utf8').replace('/AKIA[0-9A-Z]{16}/g', '/AKIA[0-9A-Z]{15,16}/g'));
    check(failed(gate(fixture), 'inlined engine is up to date'),
      'changing src/redact.js without regenerating FAILS the gate');
  }
} catch (err) {
  console.log('  FAIL  ' + (err?.stack || err));
  fail++;
}

console.log(fail ? `\ngate: ${fail} FAILED` : '\ngate: all passed');
cleanup(ROOT);
process.exit(fail ? 1 : 0);
