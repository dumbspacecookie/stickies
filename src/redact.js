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

// Line terminators, spelled out. Two of these matter and neither is `\n`:
//   - a paste that came off a classic Mac / a CR-only editor separates lines with `\r` ALONE, and
//     `\r?\n` cannot match that at all;
//   - U+2028 and U+0085 are line terminators to the JS *parser* and to most editors, so a key
//     pasted through a tool that normalises to them still LOOKS like a key block on screen.
// Written as escapes because a literal U+2028 in this file would end the line mid-regex — the
// same reason the gate refuses invisible characters in source.
const EOL = '(?:\\r\\n|[\\n\\r\\u0085\\u2028\\u2029])';
// Horizontal whitespace: everything `\s` covers EXCEPT a line terminator. `[^\S\n]` — the obvious
// spelling — is wrong here, because \r and U+2028 are whitespace that is "not \n", so that class
// eats the very break the next group is waiting for and the match dies one character too late.
const HWS = '[^\\S\\n\\r\\u0085\\u2028\\u2029]*';
// The header lines an ASCII-armored block carries between `-----BEGIN …-----` and the key data:
// RFC 4880's armor headers and RFC 1421's PEM ones. A real PGP export almost always opens with
// `Version:` or `Comment:`, and that single line was enough to defeat the unpaired-header
// fallback below (which demanded base64 IMMEDIATELY after the header) — so the most common
// paste of all, a whole armored private key, went into the store byte-for-byte whenever its
// `-----END-----` was out of reach. The list is deliberately closed rather than "any Word:",
// because "TODO: rotate this" is a line people write under a header they are TALKING about, and
// eating their note is the worse bug of the two.
const ARMOR_HEADER = '(?:Version|Comment|MessageID|Hash|Charset|Proc-Type|DEK-Info)';
// The two branches are an ALTERNATION, not "optional header followed by optional spaces", and the
// difference is six minutes of CPU. Written the obvious way —
//   (?:EOL (?:HEADER:[^term]*)? HWS){0,8}
// — the header tail and the trailing HWS BOTH match horizontal whitespace, so a header line padded
// with W spaces has W+1 equally valid splits between them. `{0,8}` nests that up to eight deep, and
// the base64 group that follows fails whenever the next line is not key data, which forces the
// engine to enumerate all W^N of them. Measured on the shipped build: a 294-char note took 2.6s, a
// 444-char note took 125s, and both are UNDER the 500-character limit that `createSticky` checks
// BEFORE redaction runs — so the cap is not a defence. `upsertFromSync` has no length gate at all.
// As an alternation the branches cannot both claim the same space, each backtrack step dies against
// the next EOL immediately, and the cost is linear. Matching behaviour is unchanged: branch 1 eats a
// header line including its trailing spaces, branch 2 eats a blank-or-whitespace line, and an
// INDENTED header matched neither before and matches neither now.
// Do NOT "simplify" HWS to `[^\S\n]` or `\s*` — see the note on HWS above; that reintroduces a
// leak, not a slowdown. Re-run the timing assertions in test/redaction-parity-test.mjs after any
// edit here.
const ARMOR_PREAMBLE =
  `(?:${EOL}(?:${ARMOR_HEADER}:[^\\n\\r\\u0085\\u2028\\u2029]*|${HWS})){0,8}`;

// 2. Known token shapes — the whole match is a secret, replaced wholesale.
const TOKEN_PATTERNS = [
  // PEM private key blocks. `(?: BLOCK)?` because a PGP block is
  // `-----BEGIN PGP PRIVATE KEY BLOCK-----`, which the bare form cannot match — so PGP keys, the
  // ones people most often paste whole, were stored verbatim.
  /-----BEGIN[^-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[^-]*PRIVATE KEY(?: BLOCK)?-----/g,
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
  // Discord incoming-webhook URL. Anyone holding one can post into that channel as you. This is
  // the credential a Stickies user is MOST likely to paste into a note, because Stickies itself
  // asks for one (STICKIES_DISCORD_WEBHOOK) — "webhook for the team channel is https://…" is a
  // note somebody writes while setting the tool up. repo-mode's inlined copy of this file had it;
  // the copy every other path uses did not, so the main path stored and synced it in plaintext.
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  /AIza[0-9A-Za-z_-]{35}/g,                        // Google API key
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT

  // Shapes added after an audit found eleven live credential formats passing through this
  // function byte-for-byte. Each length floor is set just above what ordinary prose puts after
  // the same prefix — `hf_hub_download`, `glpat-tokens are per-user`, "the ASIAPAC rollout",
  // "GOCSPX-prefixed secrets" — so the pattern catches the credential without eating the
  // sentence that merely names it. Every one of them has a paired test on both sides.
  /hf_[A-Za-z0-9]{20,}/g,                          // Hugging Face user access token
  /glpat-[A-Za-z0-9_-]{20,}/g,                     // GitLab personal access token
  /ASIA[0-9A-Z]{16}/g,                             // AWS TEMPORARY (STS) key id — as live as AKIA
  /xapp-[A-Za-z0-9-]{10,}/g,                       // Slack app-level token
  /xoxe(?:\.xox[bp])?-[A-Za-z0-9-]{10,}/g,         // Slack refresh / rotation token
  /GOCSPX-[A-Za-z0-9_-]{16,}/g,                    // Google OAuth client secret
  /fm[12][ar]?_[A-Za-z0-9+/=_-]{40,}/g,            // Fly.io API / deploy token (FlyV1 fm2_…)
  // An opaque `Authorization: Bearer <token>`. The `bearer` keyword in the assignment layer below
  // only ever matched as a KEY (`bearer_token=…`), never as the value of an Authorization header —
  // which is the form a person actually pastes, straight out of curl or the network tab.
  // Lookbehind so the label survives: `Bearer [REDACTED]` still reads as an auth header, where a
  // bare `[REDACTED]` would leave the reader guessing what was cut. The floor of 20 is what keeps
  // "Bearer authentication is described in RFC 6750" intact.
  //
  // `[ \t]{1,4}`, not `\s+`, and the difference is not cosmetic. A lookbehind of unbounded length
  // is re-evaluated at EVERY position in the string, so `(?<=\bBearer\s+)` turned a 100 KB note
  // into 4.7 seconds of backtracking on the write path — measured, against 0 ms before. Bounding
  // the gap makes each position constant-time. One space is what a real header has anyway.
  /(?<=\bBearer[ \t]{1,4})[A-Za-z0-9._~+/=-]{20,}/g,
  // An UNPAIRED private-key header, which the complete-block pattern above cannot see: a paste
  // that lost its footer is still a private key.
  //
  // It must be followed by at least one line of actual key material. The first version of this
  // ran to the end of the string on the header ALONE, which meant a note that merely MENTIONED a
  // header — "the deploy key starts with -----BEGIN OPENSSH PRIVATE KEY----- and ends with the
  // matching END line; ask Dana for access" — had everything after the header silently deleted.
  // Redaction happens at write time, so that loss was permanent, and on the auto-capture path
  // the user was not even told. Requiring a base64-looking line keeps the leak closed and stops
  // the tool eating prose about key formats, which is a thing people write.
  //
  // Two things it originally could not see, both found by audit and both a live key in the clear:
  //   - the armor headers. `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\n<key>` put
  //     a non-base64 line between the header and the data, and this pattern demanded the data
  //     come next. One `Version:` line and the whole block walked through. ARMOR_PREAMBLE now
  //     allows up to eight header-or-blank lines, and only header names that really are armor
  //     headers, so prose under a header is still safe.
  //   - the line break itself. `\r?\n` cannot match a CR-only paste, U+2028, or U+0085, so a key
  //     separated by any of those was intact in the store while looking, on screen, exactly like
  //     the ones that got redacted.
  new RegExp(
    `-----BEGIN[^-]*PRIVATE KEY(?: BLOCK)?-----${HWS}` +
    ARMOR_PREAMBLE +
    `(?:${EOL}[A-Za-z0-9+/=]{16,}${HWS})+`,
    'g'
  ),
];

// 3. "key = value" / "key: value" assignments, covering SCREAMING_SNAKE env-var names,
// camelCase, and quoted-JSON keys. The lookahead requires the key to contain a sensitive
// word as a WHOLE segment (delimited by _ . - or the key boundary), so `tokenizer_config`
// does NOT match while `AWS_SECRET_ACCESS_KEY`, `DB_PASSWORD`, and `apiKey` do. A separator
// (`:` or `=`) is required, so ordinary prose ("my secret santa list") is left alone.
//
// `account[_-]?key` is here for Azure. A storage connection string is
// `…;AccountName=x;AccountKey=<base64>;…` — the key half is a full-access credential, and no
// layer-2 shape matched it because the value is plain base64 with nothing distinctive in front of
// it. Handling it as an assignment is better than a token shape anyway: the `;`-delimited bare
// value stops exactly where the next connection-string field starts, and the reader keeps
// `AccountKey=[REDACTED]` rather than a naked marker.
const SENSITIVE =
  'password|passwd|passphrase|pwd|secret|token|apikey|api[_-]?key|access[_-]?key|' +
  'account[_-]?key|' +
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

    // This function's own output has to be a FIXED POINT, because redaction is no longer a single
    // pass: the store scrubs on the way in and notify.js scrubs again on the way out. A bare value
    // runs to the end of the line, so on the SECOND pass `SECRET_TOKEN=[REDACTED] · Phase 2 · …`
    // read as one enormous value and everything after the marker was replaced by another marker.
    // Nothing leaked — a board card simply arrived with 1 of its 60 phases and no sign that 59
    // had gone. That is the eat-the-note failure this file has been bitten by twice already, one
    // layer along. So: a value that ALREADY begins with the marker is left exactly as it is, and
    // is not counted as a new redaction either, since nothing new was found.
    //
    // The cost, stated plainly: someone who types `password=[REDACTED] hunter2` themselves keeps
    // `hunter2` in the clear. The layer-2 shapes above have already run over that tail, so a
    // recognisable credential is still caught; what survives is an unlabelled string that the user
    // deliberately prefixed with our marker. That is a worse trade only in the abstract.
    const value = dq ?? sq ?? bq ?? bare;
    if (String(value).trimStart().startsWith('[REDACTED]')) return m;

    hit();
    if (dq !== undefined) return `${q}${key}${q}${sep}"[REDACTED]"`;
    if (sq !== undefined) return `${q}${key}${q}${sep}'[REDACTED]'`;
    if (bq !== undefined) return `${q}${key}${q}${sep}\`[REDACTED]\``;
    return `${q}${key}${q}${sep}[REDACTED]`;
  });

  return { text, redacted };
}

// Redact, then cap — in that order, with a bounded scan window. Use this ANYWHERE a value is both
// length-limited and persisted; doing the two steps by hand is how the same bug keeps coming back.
//
// The two hand-rolled orderings are each wrong in a different direction:
//
//   cap(redact(x))  — the leak. Cutting first can slice a credential in half, and these patterns
//                     are anchored: `postgres://user:pw@host` without its `@` matches nothing, so
//                     the fragment is stored verbatim and then published by the sync export.
//   redact(x)       — the stall. The ASSIGNMENT lookahead is catastrophic on `_`-segmented input:
//                     14 KB measured 818 ms and 130 KB measured 17 s, on the post-turn hook, on
//                     every turn, over whatever text is in the transcript.
//
// Doing both safely needs a third thing: bound the input BEFORE the regexes run, but bound it
// wider than the cap, so a secret straddling the cap is still whole when it is matched. Only then
// cut to the cap — which can now only ever truncate a `[REDACTED]` marker, never a live value.
//
// Known limit: a PGP block longer than the scan window straddling the cap won't match as a block —
// its `-----END-----` is past the window, so the paired pattern never sees it. What is left inside
// the window is caught by the unpaired-header pattern instead, and the rest is cut by the cap, so
// what survives is a header, not key material. That sentence was ASPIRATIONAL until the armor
// headers were handled: a `Version:` line after the BEGIN defeated the unpaired pattern too, and
// then neither pattern matched and the window's worth of key data was stored verbatim. The claim
// is now load-bearing on ARMOR_PREAMBLE above, and on the test that pastes a long armored block.
const SCAN_SLACK = 1024;

export function redactAndCap(input, cap) {
  // A missing or nonsensical cap used to silently return '' — `undefined + 1024` is NaN and
  // `slice(0, NaN)` is the empty string, so a typo'd call would erase the value it was handed
  // and report success. Refuse loudly: this is a programmer error, and every caller is internal.
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error(`redactAndCap: cap must be a positive integer (got ${JSON.stringify(cap)})`);
  }
  const s = String(input ?? '');
  const { text, redacted } = redactSecrets(s.slice(0, cap + SCAN_SLACK));
  return { text: text.slice(0, cap), redacted };
}
