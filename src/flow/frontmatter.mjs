// Dependency-free YAML-subset frontmatter parser. Pure string work — imports NOTHING
// (no node:*, no npm) — so it inlines cleanly into repo-mode's self-contained engine
// later, exactly like the note at the top of derive-gsd.mjs.
//
// Handles the shape GSD PLAN.md files actually use: a leading `---` … `---` fence whose
// body is `key: value` lines where a value is a scalar, an inline `[a, b]` array, or a
// following block of `- item` lines. Everything after the closing fence is returned
// verbatim as `body`. No leading fence => { frontmatter: {}, body: text-unchanged }.

export function parseFrontmatter(text) {
  const src = String(text ?? '');
  // CRLF-safe split, same rule as derive-gsd.mjs (Windows-authored docs are CRLF).
  const lines = src.split(/\r?\n/);

  if (lines[0] !== '---') return { frontmatter: {}, body: src };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  // Unterminated fence: don't throw — treat the whole thing as body.
  if (end === -1) return { frontmatter: {}, body: src };

  const frontmatter = {};
  let curKey = null; // the key a following "- item" block list attaches to

  for (let i = 1; i < end; i++) {
    const line = lines[i];

    // Block-list item under the most recent key.
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && curKey !== null) {
      if (!Array.isArray(frontmatter[curKey])) frontmatter[curKey] = [];
      frontmatter[curKey].push(stripQuotes(li[1].trim()));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    curKey = key;

    if (val === '') {
      // Empty for now; a subsequent "- item" line converts it into an array.
      frontmatter[key] = '';
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      frontmatter[key] = inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()));
      curKey = null; // inline array is complete; no block items attach to it
      continue;
    }
    frontmatter[key] = stripQuotes(val);
    curKey = null;
  }

  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}
