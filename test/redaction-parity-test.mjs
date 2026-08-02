// Secret redaction exists twice, and the two copies had drifted.
//
// src/redact.js is what the MCP server, the CLI, the hooks and sync all use. repo-mode/engine.mjs
// carries an inlined copy, because that file must be self-contained — it is dropped into someone
// else's repository and runs there with no node_modules and no relative imports to lean on. That
// is a legitimate reason to duplicate, and duplication of a SECURITY rule is exactly the thing
// that rots quietly: the engine had a Discord-webhook pattern that the main copy did not, so the
// path every ordinary user takes stored and synced a webhook URL in plaintext while the path
// almost nobody takes redacted it. Nothing failed. Nothing warned. It was found by diffing.
//
// So: the two must stay behaviourally identical, and this proves it against one corpus rather
// than by comparing source text, which would pass on regexes that merely LOOK alike.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets, redactAndCap } from '../src/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// engine.mjs deliberately exports nothing of its internals, so lift the redaction block out of the
// source and evaluate it. Brittle by design: if someone restructures that section, this test says
// so rather than silently testing nothing.
const engineSrc = readFileSync(join(ROOT, 'src', 'repo-mode', 'engine.mjs'), 'utf8');
const start = engineSrc.indexOf('const CONNECTION_URI');
const end = engineSrc.indexOf('\n}', engineSrc.indexOf('function redactSecrets'));
check(start !== -1 && end !== -1, 'the inlined redaction block can still be located in engine.mjs');
const block = engineSrc.slice(start, end + 2);
const engineRedact = new Function(`${block}; return redactSecrets;`)();

// One credential of each shape the tool claims to catch, plus the shapes that must NOT trip it.
//
// Some of these are assembled from pieces rather than written as one literal. They are all fake,
// but a fixture that LOOKS like a live Slack webhook or Stripe key is one GitHub push protection
// rejects — and the fix for that must never be to click "allow the secret", because that is the
// same click you would make on a real one. Splitting the literal keeps the runtime value
// identical, so the redactor is tested on exactly the string it would meet in the wild.
// Do not "tidy" these back into single literals; the push will start failing again.
const SECRETS = [
  ['discord webhook', 'hook: https://discord.com/api/webhooks/1234567890/AbCdEfGhIjKlMnOpQrStUvWxYz-123456'],
  ['discord webhook (canary host)', 'https://canary.discordapp.com/api/webhooks/99/aB_cD-eFgHiJkLmNoPqRsTuVwXyZ01'],
  ['slack webhook', 'https://hooks.slack.com/' + 'services/T00000000/B00000000/' + 'X'.repeat(24)],
  ['anthropic/openai key', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'],
  ['stripe live key', 'sk_' + 'live_' + 'A'.repeat(24)],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['github pat', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['github fine-grained pat', 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAA'],
  ['npm token', 'npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['digitalocean token', 'dop_v1_' + 'a'.repeat(64)],
  ['sendgrid key', 'SG.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB'],
  ['slack token', 'xoxb-1234567890-abcdefghij'],
  ['google api key', 'AIza' + 'A'.repeat(35)],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['complete PEM block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'],
  ['TRUNCATED PEM (paste that lost its footer)', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Zk9pQ2vN3mB1cF8dW'],
  ['connection string', 'postgres://admin:hunter2@db.internal:5432/app'],
  ['labelled assignment', 'DB_PASSWORD=correct-horse-battery'],
  ['quoted json assignment', '"apiKey": "abcdef123456"'],
];
const BENIGN = [
  ['ordinary prose', 'remember to buy a secret santa gift'],
  ['a config key name with no value', 'the tokenizer_config file lives in ./conf'],
  ['a plain url', 'docs are at https://example.com/api/webhooks-guide'],
];

for (const [label, input] of SECRETS) {
  const main = redactSecrets(input);
  const engine = engineRedact(input);
  check(main.redacted, `main copy redacts: ${label}`);
  check(engine.redacted, `inlined copy redacts: ${label}`);
  check(main.text === engine.text, `and both produce the same text for: ${label}`);
}
for (const [label, input] of BENIGN) {
  const main = redactSecrets(input);
  const engine = engineRedact(input);
  check(!main.redacted, `main copy leaves alone: ${label}`);
  check(!engine.redacted, `inlined copy leaves alone: ${label}`);
  check(main.text === engine.text, `and both agree on: ${label}`);
}

// --- redaction must not DESTROY prose --------------------------------------------------------
// The first version of the unpaired-PEM pattern ran to the end of the string on the header alone,
// so a note that merely MENTIONED a key header lost everything after it — silently, permanently,
// and with no notice at all on the auto-capture path. A pattern that eats a user's note is a
// worse bug than the leak it was added to close.
for (const [label, prose] of [
  ['prose about key formats', 'The deploy key starts with -----BEGIN OPENSSH PRIVATE KEY----- and ends with the matching END line. Ask Dana for access.'],
  ['an openssl explanation', 'openssl emits -----BEGIN ENCRYPTED PRIVATE KEY----- for pkcs8; the passphrase is in 1Password'],
  ['a header followed by a checklist', 'header is -----BEGIN EC PRIVATE KEY-----\n\nTODO: rotate on 2026-08-01\nTODO: tell the platform team'],
]) {
  const main = redactSecrets(prose);
  const engine = engineRedact(prose);
  check(!main.redacted && main.text === prose, `main copy does not eat: ${label}`);
  check(!engine.redacted && engine.text === prose, `inlined copy does not eat: ${label}`);
}
// …while a header FOLLOWED BY KEY MATERIAL is still a leak and must go.
for (const [label, secret] of [
  ['truncated PEM with key material', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Zk9pQ2vN3mB1cF8dWq\nZm9pQ2vN3mB1cF8dWqZm9pQ2vN'],
  ['PGP block, paired', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGa1AAEBCADQ8s1QwEyRk9pQ2vN3mB1c\n-----END PGP PRIVATE KEY BLOCK-----'],
  ['PGP block, unpaired', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGa1AAEBCADQ8s1QwEyRk9pQ2vN3mB1c'],
]) {
  check(redactSecrets(secret).redacted, `main copy still redacts: ${label}`);
  check(engineRedact(secret).redacted, `inlined copy still redacts: ${label}`);
}

// A truncated key must not survive by hiding behind the length cap either.
const long = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'b3BlbnNzaC1rZXk'.repeat(20);
check(!redactSecrets(long).text.includes('b3BlbnNzaC1rZXk'), 'no key material survives an unpaired header');

// --- the armored block, which is what people actually paste ---------------------------------
//
// A real `gpg --export-secret-keys --armor` starts with a `Version:` or `Comment:` line, and the
// unpaired-header pattern used to demand base64 IMMEDIATELY after the BEGIN line. So the single
// most likely paste in the whole corpus — an entire private key, headers and all, too long for
// its `-----END-----` to be inside the scan window — matched neither pattern and was stored
// byte-for-byte. The control assertions below are the point: they pin what the OLD pattern did,
// so these cannot quietly go vacuous if the pattern is loosened again.
const OLD_UNPAIRED = /-----BEGIN[^-]*PRIVATE KEY(?: BLOCK)?-----[^\S\n]*(?:\r?\n[A-Za-z0-9+/=]{16,}[^\S\n]*)+/;
// Built, not typed. A literal U+2028 in this file IS a line terminator to the JS parser and
// renders as nothing in a diff — which is exactly why a key separated by one slipped past the
// redactor in the first place. The gate refuses these characters in src/; the same reasoning
// applies to a fixture that has to contain one.
const LS = String.fromCodePoint(0x2028); // LINE SEPARATOR
const NEL = String.fromCodePoint(0x0085); // NEXT LINE
const KEYDATA = 'lQOYBGa1AAEBCADQ8s1QwEyRk9pQ2vN3mB1cF8dWqZm9pQ2vN3mB1cF8dWq';
for (const [label, secret] of [
  ['PGP block with a Version: header', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n${KEYDATA}\n${KEYDATA}`],
  ['PGP block with a Comment: header', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: ash@getcontext.info\n\n${KEYDATA}`],
  ['PEM with Proc-Type/DEK-Info headers', `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,1E4A\n\n${KEYDATA}`],
  ['a key separated by CR alone', `-----BEGIN RSA PRIVATE KEY-----\r${KEYDATA}`],
  // Escapes, not literals: written literally, U+2028 IS a line terminator to the JS parser and
  // to a diff viewer, which is exactly how it hides. Same reason the gate refuses them in src/.
  ['a key separated by U+2028 (LINE SEPARATOR)', `-----BEGIN RSA PRIVATE KEY-----${LS}${KEYDATA}`],
  ['a key separated by U+0085 (NEL)', `-----BEGIN RSA PRIVATE KEY-----${NEL}${KEYDATA}`],
  ['CRLF armored block', `-----BEGIN PGP PRIVATE KEY BLOCK-----\r\nVersion: GnuPG v2\r\n\r\n${KEYDATA}\r\n`],
]) {
  const out = redactSecrets(secret);
  check(out.redacted && !out.text.includes(KEYDATA), `main copy redacts: ${label}`);
  check(!OLD_UNPAIRED.test(secret), `control: the old pattern did NOT match: ${label}`);
}

// …and the reason it matters: an armored key longer than the scan window, capped for storage.
// Everything inside the window has to be gone, because everything inside the window is what gets
// written to disk and synced.
{
  const armored =
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n' + `${KEYDATA}\n`.repeat(120);
  const stored = redactAndCap(armored, 2000);
  check(!stored.text.includes(KEYDATA), 'no key material survives an armored block that outruns the scan window');
  check(stored.redacted, 'and the store is told that something was redacted');
}

// The header-only prose case must STILL survive all of that: the closed list of armor header
// names is what keeps "TODO:" from reading as one.
for (const [label, prose] of [
  ['a header followed by TODO: lines', '-----BEGIN EC PRIVATE KEY-----\nTODO: paste the key here\nTODO: rotate it after'],
  ['a header followed by a Note: line', 'see -----BEGIN OPENSSH PRIVATE KEY-----\nNote: ask Dana, she has the real one'],
]) {
  const out = redactSecrets(prose);
  check(!out.redacted && out.text === prose, `main copy does not eat: ${label}`);
}

// --- credential shapes that used to pass through byte-for-byte --------------------------------
//
// Eleven of them, found by audit. Each is paired with a plausible NON-secret carrying the same
// prefix, because a redactor that eats `hf_hub_download` out of a note about huggingface is a
// worse tool than one that misses a token — the note is gone permanently and the user is not told.
//
// MAIN ONLY, and that is a known, deliberate divergence rather than an oversight: adding these to
// src/repo-mode/engine.mjs is a change to a file this work does not own. The inlined copy is
// listed as behind, loudly, below — which is the whole job of this file.
//
// Fourth column is the credential MATERIAL — the part that must be absent from the output. Not
// `redacted === true`: a pattern that fires on the label and leaves the token beside it reports
// exactly the same boolean as one that works.
const AZURE_KEY = 'b'.repeat(86) + '==';
const NEW_SHAPES = [
  ['huggingface token', 'hf_' + 'A'.repeat(34), 'use hf_hub_download from huggingface_hub', 'hf_' + 'A'.repeat(34)],
  ['gitlab pat', 'glpat-' + 'x'.repeat(20), 'glpat-tokens are per-user; see the wiki', 'x'.repeat(20)],
  ['aws temporary (STS) key id', 'ASIAIOSFODNN7EXAMPLE', 'the ASIAPAC rollout ships in Q3', 'ASIAIOSFODNN7EXAMPLE'],
  // Split, for the reason stated at the top of this file: written as one literal, GitHub push
  // protection rejects the push, and the only way through is the "allow the secret" button —
  // which is the identical click you would make on a real leaked token. The runtime value is
  // unchanged, so the redactor is still tested on exactly the string it would meet in the wild.
  ['slack app-level token', 'xapp-' + '1-A0123456789-1234567890123-abcdef', 'xapp-lite is our internal name for it', '1234567890123-abcdef'],
  ['slack refresh token', 'xoxe-' + '1-My0xLTk5OTk5OTk5OTk5', 'xoxe rotation is documented in the runbook', 'My0xLTk5OTk5OTk5OTk5'],
  ['google oauth client secret', 'GOCSPX-' + 'a'.repeat(28), 'GOCSPX-prefixed secrets live in the vault', 'a'.repeat(28)],
  ['fly.io token', 'fm2_' + 'b'.repeat(80), 'fm2_ tokens come from `flyctl auth token`', 'b'.repeat(80)],
  ['bearer authorization header', 'Authorization: Bearer a1B2c3D4e5F6g7H8i9J0kL', 'Bearer authentication is described in RFC 6750', 'a1B2c3D4e5F6g7H8i9J0kL'],
  ['azure storage account key', `AccountName=acct;AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`, 'the account_key rotation runbook is in Notion', AZURE_KEY],
];
const engineBehind = [];
for (const [label, secret, benign, material] of NEW_SHAPES) {
  const hit = redactSecrets(secret);
  check(hit.redacted, `main copy redacts: ${label}`);
  check(!hit.text.includes(material), `and the credential material itself is gone: ${label}`);
  const miss = redactSecrets(benign);
  check(!miss.redacted && miss.text === benign, `and prose with the same prefix is untouched: ${label}`);
  if (!engineRedact(secret).redacted) engineBehind.push(label);
}
// The two shapes that keep their label are worth pinning as text, not as a boolean: the point of
// handling them where they are handled is that the reader still sees WHICH credential went.
check(redactSecrets('Authorization: Bearer a1B2c3D4e5F6g7H8i9J0kL').text === 'Authorization: Bearer [REDACTED]',
  'a bearer header keeps its label and loses only the token');
check(redactSecrets(`AccountKey=${AZURE_KEY};EndpointSuffix=core.windows.net`).text ===
  'AccountKey=[REDACTED];EndpointSuffix=core.windows.net',
  'an azure connection string loses the key and keeps the rest of the string');
// This was a soft report for its whole first life — it printed the drift and let the suite pass,
// on the reasoning that the inlined copy was a file the change did not own and a red suite nobody
// could fix was worse than a loud line. What that actually bought was three releases in which the
// engine was missing nine token shapes, the armor-header fix and the idempotence guard, while this
// test printed all nine of them on every single run and `npm test` said PASS. Nobody reads a
// report inside a green suite. A warning that never fails is a warning that never lands.
//
// It is now a hard failure, which it can afford to be: the inlined copy is GENERATED from
// src/redact.js by scripts/build-engine.mjs, so "nobody can fix it from where they are standing"
// is no longer true — the fix is one command, and engine-generated-test.mjs names it.
check(engineBehind.length === 0,
  engineBehind.length
    ? `the inlined engine redactor is BEHIND src/redact.js on: ${engineBehind.join(', ')} — run \`node scripts/build-engine.mjs\``
    : 'the inlined engine redactor catches every shape the canonical one does');

// --- a new pattern must not make the write path slow -------------------------------------------
//
// This function runs on every write and inside a post-turn hook, so its cost is a product
// property, not a detail: the header above already records 14 KB at 818 ms and 130 KB at 17 s from
// the assignment layer. The bearer pattern reintroduced exactly that. A lookbehind of UNBOUNDED
// length — `(?<=\bBearer\s+)` — is re-evaluated at every position in the string, and 100 KB of
// line breaks after a key header measured 4.7 seconds against 1 ms before it existed. Bounding the
// gap to `[ \t]{1,4}` made each position constant-time. The threshold is deliberately loose: this
// is here to catch a quadratic, not to police a slow laptop.
{
  const hostile = '-----BEGIN RSA PRIVATE KEY-----' + '\n'.repeat(100000);
  const t0 = Date.now();
  redactSecrets(hostile);
  const ms = Date.now() - t0;
  check(ms < 1000, `100 KB of line breaks after a key header scans in well under a second (${ms} ms)`);

  const prose = 'the quick brown fox Bearer authentication '.repeat(2500);
  const t1 = Date.now();
  redactSecrets(prose);
  const ms2 = Date.now() - t1;
  check(ms2 < 1000, `100 KB of prose repeatedly saying "Bearer" scans in well under a second (${ms2} ms)`);

  // A SHORT input, because both assertions above are long ones and length was never the trigger.
  //
  // ARMOR_PREAMBLE's header tail and its trailing HWS both matched horizontal whitespace, so a
  // header line padded with W spaces had W+1 equivalent splits, nested `{0,8}` deep, enumerated in
  // full whenever the following line is not base64. Measured on the shipped build: 294 chars ->
  // 2.6 s, 444 chars -> 125 s. Both are UNDER the 500-character limit `createSticky` enforces
  // BEFORE redaction, so the cap never stood between a user and a two-minute stall — and
  // `upsertFromSync` applies no length gate at all, which puts it in reach of a shared sync file.
  //
  // The two long assertions above pass at full speed against this input class because neither
  // contains horizontal whitespace after an armor header, which is the entire trigger. That is why
  // this one is here, and why it is deliberately SMALL: a timing check that only fires on large
  // inputs cannot see an exponential that peaks inside the size limit.
  const armored = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
    + Array.from({ length: 5 }, () => 'Comment:' + ' '.repeat(70)).join('\n')
    + '\nnot-base64-!!';
  // The bound here is 200 ms, not the 1000 ms the two assertions above use, and the difference is
  // deliberate. Those two guard inputs whose honest cost is milliseconds; this one guards an input
  // whose honest cost is ~0.5 ms against a regression that measured 69–125 SECONDS. A 1000 ms bound
  // would still catch the full regression, but it would wave through a partial one — a change that
  // made this 100× slower and still "passed" — which is exactly the kind of silent erosion this
  // file exists to stop. 200 ms keeps roughly 400× headroom over the measured truth, which is ample
  // for a loaded laptop, while refusing anything that has started to grow again.
  check(armored.length <= 500, `the payload is a legal note (${armored.length} chars, cap 500)`);
  const t2 = Date.now();
  redactSecrets(armored);
  const ms3 = Date.now() - t2;
  check(ms3 < 200, `armor headers padded with spaces and no key data scan in ~no time (${ms3} ms, bound 200)`);
}

// --- an armored key is redacted however many header lines it carries ------------------------
//
// The repetition bound used to be {0,8}, so a key with NINE armor headers fell off the end of the
// pattern and the whole thing was stored in clear -- redacted=false, key material intact. Present in
// 0.13.0 too, so this is an old hole rather than a new one, and it is a credential written to a
// plaintext store and then published to whatever sync repo the user configured. The bound was low
// because each iteration was once exponentially expensive; the alternation made it linear, so the
// ceiling could be raised. Both ends are asserted: the key must be caught, and the bound must still
// be a bound.
{
  const armored = (n) => '-----BEGIN RSA PRIVATE KEY-----\n'
    + Array.from({ length: n }, (_, i) => `Comment: header line ${i}`).join('\n')
    + '\nMIIEpAIBAAKCAQEAx0123456789abcdefGHIJKLMNOPqrst';
  for (const n of [1, 8, 9, 12, 40]) {
    const r = redactSecrets(armored(n));
    check(r.redacted, `an armored key with ${n} header line(s) is redacted`);
    check(!r.text.includes('MIIEpAIBAAKCAQEA'), `and no key material survives it (${n} headers)`);
  }
  // Still linear, and still bounded. The terminator here is CRLF, not LF, and that is the entire
  // value of this assertion: the first version joined with LF and passed at 0 ms against a
  // deliberately sabotaged bound, because LF has only one parse. A Windows line break had two --
  // the pair, or a lone CR with the next repetition taking the LF -- so every boundary doubled the
  // paths once the ceiling was raised from 8 to 64. Measured before the fix: 108 characters in
  // 3.5 seconds, 118 in over three minutes, while the same shapes in LF stayed under a
  // millisecond. ROADMAP.md is natively CRLF on Windows, so this is the common case, not an
  // exotic one. A timing test that only exercises the unambiguous terminator is theatre.
  for (const [label, eol] of [['CRLF', '\r\n'], ['LF', '\n'], ['lone CR', '\r']]) {
    // 32, not 40, and the number is load-bearing. The cost of the defect is exponential in this
    // count, so a large value does not fail the assertion -- it HANGS the suite, which reads as a
    // stuck CI job rather than a red test. Measured against the ambiguous terminator: 30 lines
    // cost 220ms, 34 cost 3.5s, 40 never finished. 32 sits comfortably over the 200ms bound while
    // still returning in about a second, so a regression here goes RED instead of going quiet.
    const pathological = '-----BEGIN PGP PRIVATE KEY BLOCK-----' + eol.repeat(32) + '!!!';
    check(pathological.length <= 500, `the ${label} payload is a legal note (${pathological.length} chars)`);
    const t0 = Date.now();
    redactSecrets(pathological);
    const el = Date.now() - t0;
    check(el < 200, `32 ${label} blank lines after a key header scan in ~no time (${el} ms)`);
  }
  const t = Date.now();
  redactSecrets(armored(200));
  const ms = Date.now() - t;
  check(ms < 200, `200 header lines still scan in ~no time (${ms} ms)`);
}

// --- redacting twice must not eat the text between the markers -------------------------------
//
// Redaction is not a single pass any more: store.js scrubs on the way in, notify.js scrubs again
// on the way out. Layer 3's bare value runs to the end of the line, so on the second pass
// `SECRET_TOKEN=[REDACTED] · Phase 2 · Phase 3` read as ONE value and everything after the first
// marker was replaced by another marker — a board card that arrived with 1 of its 60 phases and
// nothing to say the other 59 had been eaten. Found by a test asserting the field's own length
// accounting, not by anything going red on content.
{
  const twice = (s) => redactSecrets(redactSecrets(s).text).text;
  for (const [label, input] of [
    ['a joined list of labelled phases', 'Phase 1 SECRET_TOKEN=abc · Phase 2 SECRET_TOKEN=def · Phase 3 done'],
    ['a note whose tail follows a redacted value', 'DB_PASSWORD=hunter2 then restart the box'],
    ['a quoted json assignment', '"apiKey": "abcdef123456", "region": "eu-west-1"'],
    ['a connection string', 'postgres://admin:hunter2@db.internal:5432/app and then run the migration'],
  ]) {
    const once = redactSecrets(input).text;
    check(twice(input) === once, `redacting twice changes nothing further: ${label}`, once);
    check(!redactSecrets(once).redacted, `and a second pass reports nothing new to redact: ${label}`);
  }
  // The board path exactly: scrub each phase token FIRST (so one bad label cannot eat its
  // neighbours — a bare value runs to the end of the LINE, and the joined field is one line),
  // then join. It is that joined string the outbound scrub sees again, and every phase after the
  // first is what used to vanish from it.
  const joined = ['Phase 1 SECRET_TOKEN=abc', 'Phase 2 SECRET_TOKEN=def', 'Phase 3 done']
    .map((t) => redactSecrets(t).text)
    .join(' · ');
  const rescanned = redactSecrets(joined).text;
  check(rescanned === joined, 'a pre-scrubbed, joined board line survives the outbound scrub intact', rescanned);
  check(/Phase 2/.test(rescanned) && /Phase 3 done$/.test(rescanned),
    'control: the phases after the first are still there afterwards');
}

// --- redactAndCap: the ordering that kept getting written by hand ---------------------------
//
// Three call sites had `redactSecrets(x.slice(0, cap))` — cut first, then redact. That ordering
// slices a credential in half, and these patterns are anchored, so the fragment matches nothing
// and is stored verbatim. Two more capped BEFORE redacting and stored a value over the cap,
// because `[REDACTED]` is longer than much of what it replaces. One helper now owns all three
// steps; these assertions are what stop the hand-rolled versions coming back.
{
  const CAP = 500;

  // A credential that STRADDLES the cap: it starts before, its anchor lands after.
  const straddling =
    'x'.repeat(CAP - 30) + ' postgres://admin:' + 'S3cretPw'.repeat(4) + '@db.internal/x';
  const capped = redactAndCap(straddling, CAP);
  check(!capped.text.includes('S3cretPw'),
    'redactAndCap: a credential straddling the cap is redacted, not sliced into a live fragment');
  check(capped.redacted, 'redactAndCap: and it reports that it redacted something');
  check(capped.text.length <= CAP, 'redactAndCap: the result still respects the cap');

  // Proof the ordering is what does it: cut-then-redact leaks the same input.
  const naive = redactSecrets(straddling.slice(0, CAP)).text;
  check(naive.includes('S3cretPw'),
    'control: the old cut-then-redact ordering DOES leak this fragment (so the test is not vacuous)');

  // Growth past the cap: many short assignments each expand when redacted.
  let dense = '';
  for (let i = 0; dense.length < CAP - 14; i++) dense += `token_${i}=abc,`;
  dense = dense.replace(/,$/, '');
  const grown = redactAndCap(dense, CAP);
  check(redactSecrets(dense).text.length > CAP,
    `control: redaction really does grow this input past the cap (${redactSecrets(dense).text.length} > ${CAP})`);
  check(grown.text.length <= CAP,
    `redactAndCap: the stored value is capped after redaction (${grown.text.length} <= ${CAP})`);

  // Nothing surprising for ordinary short text.
  const plain = redactAndCap('just an ordinary note', CAP);
  check(plain.text === 'just an ordinary note' && !plain.redacted,
    'redactAndCap: ordinary text passes through untouched');
  check(redactAndCap(null, CAP).text === '' && redactAndCap(undefined, CAP).text === '',
    'redactAndCap: null and undefined become empty, not the strings "null"/"undefined"');
}

console.log(fail ? `\nredaction-parity: ${fail} FAILED` : '\nredaction-parity: all passed');
process.exit(fail ? 1 : 0);
