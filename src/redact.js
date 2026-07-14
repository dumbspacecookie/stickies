// Conservative secret scrubbing applied to sticky content before it is persisted.
// Stickies are stored in plaintext and (in later phases) sync across machines, so a
// secret captured into a note would leak widely. We redact obvious credentials.
//
// Tuned for low false positives: known token shapes + explicit "key = <value>"
// assignments. Not a guarantee — it reduces accidental capture, not a vault.

const PATTERNS = [
  // PEM private key blocks (DSA/RSA/EC/OPENSSH/generic).
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  // Anthropic / OpenAI style keys.
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  // AWS access key id.
  /AKIA[0-9A-Z]{16}/g,
  // GitHub tokens (PAT, OAuth, app, refresh) and fine-grained PATs.
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /AIza[0-9A-Za-z_-]{35}/g,
  // JWTs.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Explicit "secret/token/password/api_key = <value>" assignments — redact the value only.
  /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|bearer)\b(\s*[:=]\s*|\s+)['"]?([^\s'"]{6,})/gi,
];

// Returns { text, redacted } where text has secrets replaced with [REDACTED].
export function redactSecrets(input) {
  let text = String(input);
  let redacted = false;

  for (const re of PATTERNS) {
    text = text.replace(re, (match, label, sep, value) => {
      redacted = true;
      // Assignment pattern: keep the label + separator, redact the value.
      if (label && typeof value === 'string') {
        return `${label}${sep}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }

  return { text, redacted };
}
