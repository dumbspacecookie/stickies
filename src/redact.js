// Conservative secret scrubbing applied to sticky content (and tags) before they are
// persisted. Stickies are stored in plaintext and sync across machines via a git repo,
// so a secret captured into a note would leak widely. We redact obvious credentials.
//
// Three layers, applied in order:
//   1. Credentialed URIs        scheme://user:pass@host   -> scheme://[REDACTED]@host
//   2. Known token shapes       sk-…, ghp_…, AKIA…, sk_live_…  -> [REDACTED]
//   3. key = value assignments  DB_PASSWORD=…, "apiKey":"…"     -> keep key, redact value
//
// Tuned to catch the common leak vectors (pasted .env files, connection strings, JSON
// config) while keeping false positives low. Not a guarantee — it reduces accidental
// capture, not a vault; a high-entropy bare token with no label or known shape can pass.

// 1. Credential embedded in a connection/service URI. Redacts the `user:password`
// userinfo (user optional, e.g. redis://:pass@host), leaving scheme + host intact.
const CONNECTION_URI = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s@/]+@/gi;

// 2. Known token shapes — the whole match is a secret, replaced wholesale.
const TOKEN_PATTERNS = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, // PEM private key blocks
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,               // Anthropic / OpenAI (hyphen style)
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,  // Stripe (underscore style)
  /AKIA[0-9A-Z]{16}/g,                             // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                   // GitHub PAT/OAuth/app/refresh
  /github_pat_[A-Za-z0-9_]{20,}/g,                 // GitHub fine-grained PAT
  /npm_[A-Za-z0-9]{36}/g,                          // npm token
  /dop_v1_[a-f0-9]{64}/g,                          // DigitalOcean token
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,   // SendGrid
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                 // Slack token
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, // Slack incoming-webhook URL
  /AIza[0-9A-Za-z_-]{35}/g,                        // Google API key
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

// 3. "key = value" / "key: value" assignments, covering SCREAMING_SNAKE env-var names,
// camelCase, and quoted-JSON keys. The lookahead requires the key to contain a sensitive
// word as a WHOLE segment (delimited by _ . - or the key boundary), so `tokenizer_config`
// does NOT match while `AWS_SECRET_ACCESS_KEY`, `DB_PASSWORD`, and `apiKey` do. A separator
// (`:` or `=`) is required, so ordinary prose ("my secret santa list") is left alone.
const SENSITIVE =
  'password|passwd|passphrase|pwd|secret|token|apikey|api[_-]?key|access[_-]?key|' +
  'access[_-]?token|client[_-]?secret|bearer|auth[_-]?token|credential|private[_-]?key';
const ASSIGNMENT = new RegExp(
  '(["\'`]?)' + // 1: optional opening quote around the key
  '((?=(?:[A-Za-z0-9]+[_.-])*(?:' + SENSITIVE + ')(?:[_.-]|["\'`:=\\s]|$))' + // key holds a sensitive segment
  '[A-Za-z0-9_.-]+)' + // 2: the key itself
  '\\1' + // closing quote must match the opening one (or both empty)
  '(\\s*[:=]\\s*)' + // 3: separator
  '(?:"([^"\\r\\n]{3,})"|\'([^\'\\r\\n]{3,})\'|`([^`\\r\\n]{3,})`|([^\\r\\n,;]{3,}))', // 4/5/6: quoted value | 7: bare value
  'gi'
);

// Returns { text, redacted } where text has secrets replaced with [REDACTED].
export function redactSecrets(input) {
  let text = String(input);
  let redacted = false;
  const hit = () => { redacted = true; };

  // 1. Connection-string credentials.
  text = text.replace(CONNECTION_URI, (_m, scheme) => { hit(); return `${scheme}[REDACTED]@`; });

  // 2. Known token shapes.
  for (const re of TOKEN_PATTERNS) {
    text = text.replace(re, () => { hit(); return '[REDACTED]'; });
  }

  // 3. Labelled assignments — keep the key + separator, redact the value only.
  text = text.replace(ASSIGNMENT, (m, q, key, sep, dq, sq, bq, bare) => {
    if (dq === undefined && sq === undefined && bq === undefined && bare === undefined) return m;
    hit();
    if (dq !== undefined) return `${q}${key}${q}${sep}"[REDACTED]"`;
    if (sq !== undefined) return `${q}${key}${q}${sep}'[REDACTED]'`;
    if (bq !== undefined) return `${q}${key}${q}${sep}\`[REDACTED]\``;
    return `${q}${key}${q}${sep}[REDACTED]`;
  });

  return { text, redacted };
}
