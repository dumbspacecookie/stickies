// Hand-rolled, dependency-free markdown block tokenizer (RESEARCH §4 option 2). Imports
// NOTHING (no node:*, no vendored markdown lib) so it inlines into repo-mode and — more
// importantly — it returns STRUCTURED Block[] tokens, never an HTML string.
//
// That token-not-HTML shape is the deliberate XSS mitigation: the browser (00-02) builds
// DOM from these tokens with textContent only, so there is no innerHTML/sanitizer path to
// get wrong. Two rules enforce it here:
//   1. Angle brackets are never markup — `<img onerror=…>` becomes literal text-span content.
//   2. Link hrefs are accepted ONLY for safe schemes (http/https, #anchor, scheme-less
//      relative path). Unsafe schemes (e.g. javascript:, data:, vbscript:) are rejected in
//      safeHref() below and the link degrades to a plain text span with no href.

export function tokenize(markdown) {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    // Fenced code ``` optional-lang … ```
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // consume closing fence (or step past EOF if unterminated — never throws)
      blocks.push({ type: 'code', lang, text: code.join('\n') });
      continue;
    }

    // Horizontal rule: a line of only ---, ***, or ___ (>=3).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // ATX heading (# … ######).
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, spans: parseInline(h[2].trim()) });
      i++; continue;
    }

    // Pipe table: header row with `|`, next line a `---` separator row that also has a `|`.
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|')
        && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // List: unordered (-,*,+) or ordered (1.), with optional `[ ]`/`[x]` checkbox.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let content = lines[i].match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/)[1];
        let checked = null;
        const cb = content.match(/^\[([ xX])\]\s*(.*)$/);
        if (cb) { checked = cb[1].toLowerCase() === 'x'; content = cb[2]; }
        items.push({ checked, spans: parseInline(content) });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a structural line.
    const para = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !/^\s*```/.test(lines[i])
           && !/^\s{0,3}#{1,6}\s+/.test(lines[i])
           && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
           && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'para', spans: parseInline(para.join(' ')) });
  }

  return blocks;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// Inline scanner -> Span[]. Angle brackets are NEVER interpreted (they accumulate as text),
// so raw HTML can only ever surface as inert t:'text' content. Unmatched markup falls back
// to literal text — this function never throws.
function parseInline(text) {
  const spans = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { spans.push({ t: 'text', text: buf }); buf = ''; } };

  while (i < text.length) {
    const c = text[i];

    // [label](href)
    if (c === '[') {
      const close = text.indexOf(']', i + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const pclose = text.indexOf(')', close + 2);
        if (pclose !== -1) {
          const label = text.slice(i + 1, close);
          const href = safeHref(text.slice(close + 2, pclose));
          flush();
          if (href) spans.push({ t: 'link', text: label, href });
          else spans.push({ t: 'text', text: label }); // unsafe scheme -> plain text, NO href
          i = pclose + 1;
          continue;
        }
      }
      buf += c; i++; continue;
    }

    // `code`
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close !== -1) { flush(); spans.push({ t: 'code', text: text.slice(i + 1, close) }); i = close + 1; continue; }
      buf += c; i++; continue;
    }

    // **strong**
    if (c === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) { flush(); spans.push({ t: 'strong', text: text.slice(i + 2, close) }); i = close + 2; continue; }
      buf += c; i++; continue;
    }

    // *em* or _em_
    if (c === '*' || c === '_') {
      const close = text.indexOf(c, i + 1);
      if (close !== -1 && close > i + 1) { flush(); spans.push({ t: 'em', text: text.slice(i + 1, close) }); i = close + 1; continue; }
      buf += c; i++; continue;
    }

    buf += c; i++;
  }
  flush();
  if (spans.length === 0) spans.push({ t: 'text', text: '' });
  return spans;
}

// Accept a link target ONLY if it is safe to hand to an <a href> later:
//   http:// or https://, a #fragment, or a scheme-less relative path.
// Any explicit scheme other than http/https (e.g. javascript:, data:, vbscript:, file:)
// is rejected -> caller drops the href and the link becomes plain text.
function safeHref(raw) {
  const h = String(raw).trim();
  if (h === '') return null;
  // Reject any control character (tab/newline/CR/etc). Browsers strip \t\r\n out of a URL
  // during parsing, so an interior control char like "java\tscript:" would slip past the
  // scheme check below as a "relative path" and then resolve back to "javascript:" and
  // execute on click. No legitimate href contains control chars, so drop the whole thing.
  if (/[\x00-\x1F\x7F]/.test(h)) return null;
  if (h.startsWith('#')) return h;
  const scheme = h.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    return (s === 'http' || s === 'https') ? h : null;
  }
  return h; // no scheme => relative path, safe
}
