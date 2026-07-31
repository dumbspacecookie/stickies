#!/usr/bin/env node
// Regenerates the inlined regions of src/repo-mode/engine.mjs from their canonical sources.
//
// WHY THIS EXISTS. engine.mjs is committed into somebody else's repository and runs there with no
// node_modules and no package around it, so it cannot import src/redact.js — it has to carry a
// copy. For three releases that copy was maintained by hand, and it did what hand-maintained
// copies do: by the time anyone looked, the inlined redactor was missing NINE token shapes the
// canonical one had (hf_, glpat-, ASIA, xapp-, xoxe, GOCSPX-, fm2_, opaque Bearer, Azure
// AccountKey), the armor-header fix, and the idempotence guard. The inlined directive parser was
// still anchored `^\s*`, so every quoted-directive injection closed in src/directives.js was wide
// open in repo-mode. Both copies were "reviewed" each time. Neither review caught it.
//
// A parity TEST cannot fix this either, and the one in this repo is the proof: it printed a loud
// DRIFT line naming all nine missing shapes, on every single run, and the suite stayed green
// because it reports rather than fails. Reporting drift to a passing test run is how you get
// three releases of drift.
//
// So the duplication is no longer maintained. It is DERIVED: the region between the markers below
// is a byte-for-byte copy of the canonical file with `export ` stripped, and `npm test` fails if
// what is on disk is not what this script would write. You cannot edit one copy and forget the
// other, because there is only one copy that anybody edits.
//
//   node scripts/build-engine.mjs           regenerate engine.mjs in place
//   node scripts/build-engine.mjs --check   exit 1 if it is out of date (what CI/gate calls)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineStamp, STAMP_LINE } from '../src/engine-stamp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_PATH = join(ROOT, 'src', 'repo-mode', 'engine.mjs');

// Every check in scripts/gate.mjs reads a tree given by GATE_ROOT, so that gate-test.mjs can point
// it at a throwaway fixture with exactly one thing wrong. This generator was originally hardwired
// to the real repo, which meant the gate check built on it silently ignored GATE_ROOT and reported
// on THIS repository while every check beside it reported on the fixture. A check that answers a
// different question than the one the harness asked is the same failure mode as a check that
// passes while blind. So the root is a parameter, and the caller says which tree it means.
export class NoEngineHere extends Error {}

// Each region: the marker name, and the canonical file it mirrors.
//
// ORDER IS LOAD ORDER. These are spliced in as plain top-level statements, so a region that another
// region calls at module scope must come first. `fences` is before `directives` because
// directives.js imports `fencedLineFlags` from it — see ALLOWED_INLINE_IMPORTS below.
export const REGIONS = [
  { name: 'redact', source: join('src', 'redact.js') },
  { name: 'fences', source: join('src', 'flow', 'fences.mjs') },
  { name: 'directives', source: join('src', 'directives.js') },
];

// An import is normally fatal here (see inlineSource) because engine.mjs has no node_modules and no
// relative paths to resolve. There is one exception, and it has to be an exception rather than a
// relaxation: a module that is ITSELF inlined into the same file is already present by the time the
// importing code runs, so its import line is redundant rather than broken and is dropped.
//
// This exists because src/directives.js was made to import src/flow/fences.mjs — deleting its own
// second, exploitable fence parser in favour of the correct shared one. Without this the choice
// would have been between fixing the bypass and keeping repo-mode buildable.
const ALLOWED_INLINE_IMPORTS = new Set(REGIONS.map(({ source }) => source.replace(/\\/g, '/')));

// Does `spec` (an import specifier as written, e.g. './flow/fences.mjs') resolve to a region source
// when read from `fromSource` (e.g. 'src/directives.js')?
function resolvesToRegion(spec, fromSource) {
  if (!spec.startsWith('.')) return false;
  const fromDir = fromSource.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = spec.split('/');
  const out = [...fromDir];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    else if (p === '..') out.pop();
    else out.push(p);
  }
  return ALLOWED_INLINE_IMPORTS.has(out.join('/'));
}

const beginMarker = (name, source) =>
  `// <<<GENERATED:${name} — copied from ${source.replace(/\\/g, '/')} by scripts/build-engine.mjs. DO NOT EDIT HERE.>>>`;
const endMarker = (name) => `// <<<END GENERATED:${name}>>>`;

// The only transform applied to canonical source. `export ` is the one thing that cannot survive
// the trip, because engine.mjs is executed directly rather than imported. Everything else —
// including every comment — is carried across verbatim, so a diff of engine.mjs shows exactly what
// changed in the original and a reviewer can compare the two regions by eye.
//
// Deliberately NOT a general ES-module stripper: if a canonical file ever grows an `import`, that
// import would silently vanish here and the engine would throw at runtime in a user's repo. Refuse
// instead. The same goes for `export default` and re-exports, which have no meaning inlined.
export function inlineSource(text, sourceLabel) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*import\s/.test(line) || /^\s*export\s+(?:\*|\{|default\b)/.test(line)) {
      // An import of a module that is itself inlined into this same file is dropped: the code it
      // names is already there. Anything else is fatal — silently stripping a real dependency would
      // produce an engine that throws at runtime inside somebody else's repository.
      const spec = line.match(/from\s+['"]([^'"]+)['"]/)?.[1];
      if (spec && resolvesToRegion(spec, sourceLabel)) {
        out.push(`// (import of ${spec} dropped — that module is inlined above)`);
        continue;
      }
      throw new Error(
        `${sourceLabel}:${i + 1} cannot be inlined into engine.mjs: "${line.trim()}". ` +
        'engine.mjs runs standalone in a user repo with no node_modules, so it can carry no ' +
        'imports and no re-exports. Move the dependency into the file, add it to REGIONS so it is ' +
        'inlined too, or exclude this file from REGIONS.'
      );
    }
    out.push(line.replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/, ''));
  }
  return out.join('\n').replace(/\s+$/, '');
}

// The stamp is defined in src/engine-stamp.js and imported above, not written twice here. It
// covers the WHOLE engine file, and the first version of it did not — it hashed only the inlined
// regions, on the reasoning that those were the security-relevant part. That was wrong within a
// day: the engine then gained path containment, reconcile import guards, a digest cap, an
// https-only webhook and a ReDoS bound, six security fixes, none of them inside a generated region,
// every one of them leaving the stamp byte-identical. A user whose committed engine predated all
// six would have been told their copy MATCHED. A staleness check that reports "up to date" over six
// missing security fixes is worse than no check, because it gets believed.
export { engineStamp };

export function generateEngine({ root = ROOT } = {}) {
  const enginePath = join(root, 'src', 'repo-mode', 'engine.mjs');
  let current;
  try {
    current = readFileSync(enginePath, 'utf8').replace(/\r\n/g, '\n');
  } catch (err) {
    // A tree with no repo-mode engine is not a tree with a STALE one, and the caller has to be able
    // to tell those apart — reporting "up to date" for a file that does not exist is how a check
    // passes while looking at nothing.
    if (err && err.code === 'ENOENT') throw new NoEngineHere(`no engine at ${enginePath}`);
    throw err;
  }
  let next = current;

  for (const { name, source } of REGIONS) {
    const begin = beginMarker(name, source);
    const end = endMarker(name);
    const startAt = next.indexOf(begin);
    const endAt = next.indexOf(end);
    if (startAt === -1 || endAt === -1 || endAt < startAt) {
      throw new Error(
        `engine.mjs is missing the ${name} region markers. Expected a line:\n  ${begin}\n` +
        `...and a closing:\n  ${end}`
      );
    }
    const body = inlineSource(readFileSync(join(root, source), 'utf8'), source);
    next = next.slice(0, startAt) + begin + '\n' + body + '\n' + end + next.slice(endAt + end.length);
  }

  if (!STAMP_LINE.test(next)) {
    throw new Error("engine.mjs is missing its `const ENGINE_STAMP = '…';` line");
  }
  // Hash the spliced text, then write the digest into it. `engineStamp` blanks the stamp line
  // before hashing, so this is stable: hashing the finished file again yields the same value.
  const stamp = engineStamp(next);
  next = next.replace(STAMP_LINE, `const ENGINE_STAMP = '${stamp}';`);

  return { text: next, stamp, changed: next !== current };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  let result;
  try {
    result = generateEngine();
  } catch (err) {
    process.stderr.write(`build-engine: ${err.message}\n`);
    process.exit(1);
  }
  if (check) {
    if (result.changed) {
      process.stderr.write(
        'build-engine: src/repo-mode/engine.mjs is OUT OF DATE with its canonical sources.\n' +
        '  Its inlined redactor/parser no longer match src/redact.js and src/directives.js, which\n' +
        '  means repo-mode is shipping weaker security controls than every other path.\n' +
        '  Fix: node scripts/build-engine.mjs\n'
      );
      process.exit(1);
    }
    process.stdout.write(`build-engine: engine.mjs is up to date (stamp ${result.stamp})\n`);
  } else {
    if (result.changed) {
      writeFileSync(ENGINE_PATH, result.text);
      process.stdout.write(`build-engine: regenerated engine.mjs (stamp ${result.stamp})\n`);
    } else {
      process.stdout.write(`build-engine: already up to date (stamp ${result.stamp})\n`);
    }
  }
}
