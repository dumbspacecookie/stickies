// Things that must never appear in the PUBLIC tree.
//
// The dev -> public port is a wholesale `cp -r src/. test/.`, chosen deliberately: it makes the
// trees byte-identical and provable by hash, which is how the 0.12.1 and 0.13.0 ports were
// verified. The cost is that it copies EVERYTHING, including work that was never meant to ship.
//
// Apprentice mode is the first such feature. It analyses how the owner actually works — closure
// rates, what they write and never do, which projects churn — and it is being dogfooded privately
// before any decision about whether it belongs in a published package at all. A `cp -r` would put
// it on npm without anyone choosing that, and nothing else would notice.
//
// So the guard lives HERE, in the tree that must stay clean, and fails loudly rather than relying
// on remembering an exclusion at port time. If a file below is genuinely being released, delete
// its line in the same commit that releases it — that deletion is the decision, made on purpose.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Paths that are dev-only, and why.
const DEV_ONLY = [
  ['src/apprentice.js', 'apprentice mode — private dogfood, not a released feature'],
  ['src/apprentice-page.js', 'apprentice dashboard page'],
  ['src/apprentice-report.js', 'apprentice mode reporting'],
  ['test/apprentice-test.mjs', 'apprentice mode tests'],
];

// `src/dashboard.js` deliberately DOES mention apprentice: it optional-imports the page module in
// a try/catch so the file can stay byte-identical between the trees, and the route is registered
// only when the module resolves. That seam is why the token is not banned outright — the check
// that matters is that the modules themselves are absent, which is what makes the route absent.

// Strings that must not appear in the public package manifest either — a feature can leak by
// being wired into `npm test` or a bin even if its file was excluded.
const DEV_ONLY_TOKENS = ['apprentice'];

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

for (const [rel, why] of DEV_ONLY) {
  check(!existsSync(join(ROOT, rel)), `${rel} is absent (${why})`);
}

const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
for (const token of DEV_ONLY_TOKENS) {
  check(!pkg.toLowerCase().includes(token), `package.json does not reference "${token}"`);
}

// The guard is only worth having if it can actually see a violation, so prove the check works
// against a path that DOES exist rather than trusting a list of absences.
check(existsSync(join(ROOT, 'src', 'store.js')), 'the probe can see a file that is present (guard is not vacuous)');

console.log(fail ? `\ndevonly-guard: ${fail} FAILED` : '\ndevonly-guard: all passed');
process.exit(fail ? 1 : 0);
