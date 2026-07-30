// Project identity vs stored path.
//
// On Windows one directory has many spellings. Two of them must be ONE project, or a note written
// from a shell that capitalised the path differently is invisible from the other and the
// dashboard answers "Unknown project" for the folder you are standing in.
//
// On POSIX the opposite is true — /home/A and /home/a are genuinely two directories — so this
// suite asserts the platform-conditional behaviour rather than a single answer, and says which
// platform it is actually testing.
import { normalizeProjectPath, projectIdentity } from '../src/store-path.js';

const WIN = process.platform === 'win32';
let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
console.log(`  (platform: ${process.platform} — case folding ${WIN ? 'ON' : 'OFF'})`);

const A = 'C:/Users/Ash/Documents/proj';
const B = 'C:/Users/ash/documents/proj';

// What we STORE keeps the caller's spelling: it is what the dashboard and every report display,
// and shouting a path back in the wrong case to win an internal comparison is a bad trade.
check(normalizeProjectPath(A) === A, 'normalizeProjectPath preserves the spelling it was given');
check(normalizeProjectPath(A) !== normalizeProjectPath(B), 'so two spellings remain distinct as stored values');

// What we COMPARE folds, on Windows only.
if (WIN) {
  check(projectIdentity(A) === projectIdentity(B), 'the two spellings share one identity on Windows');
  check(projectIdentity(A) === A.toLowerCase(), 'identity is the lower-cased path');
} else {
  check(projectIdentity(A) !== projectIdentity(B), 'the two spellings are DIFFERENT identities on POSIX');
  check(projectIdentity(A) === normalizeProjectPath(A), 'identity is just the normalized path there');
}

// Identity inherits every normalization the stored form does, or the folding would be the only
// thing two spellings had in common.
check(projectIdentity('C:/x/y/') === projectIdentity('C:/x/y'), 'trailing slash does not change identity');
check(projectIdentity('C:\\x\\y') === projectIdentity('C:/x/y'), 'slash direction does not change identity');
check(projectIdentity('c:/x/y') === projectIdentity('C:/x/y'), 'drive-letter case does not change identity');

// Null in, null out — and the unsafe-path refusal still applies, because identity must never
// silently become the global scope.
check(projectIdentity(null) === null, 'null has no identity');
check(projectIdentity('') === null, 'empty string has no identity');
check(projectIdentity('   ') === null, 'whitespace has no identity');
check(projectIdentity('C:/x<script>') === null, 'a path with markup characters is refused, not folded');

console.log(fail ? `\npath-identity: ${fail} FAILED` : '\npath-identity: all passed');
process.exitCode = fail ? 1 : 0;
