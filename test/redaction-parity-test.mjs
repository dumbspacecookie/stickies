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
import { redactSecrets } from '../src/redact.js';

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

console.log(fail ? `\nredaction-parity: ${fail} FAILED` : '\nredaction-parity: all passed');
process.exit(fail ? 1 : 0);
