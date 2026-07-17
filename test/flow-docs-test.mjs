// Flow doc-layer tests: the dependency-free frontmatter parser + the hand-rolled markdown
// tokenizer. Pure/offline (no fs, no network) — safe to run in any order. The adversarial
// cases lock the XSS mitigation: the tokenizer emits inert Block[] tokens, treats `<...>`
// as literal text, and drops unsafe link schemes.

import { parseFrontmatter } from '../src/flow/frontmatter.mjs';
import { tokenize } from '../src/flow/md-tokenize.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --- parseFrontmatter ---
const fm1 = parseFrontmatter('---\nwave: 2\ndepends_on: [00-01]\nrequirements: [FR-01, FR-04]\n---\nbody');
ok(fm1.frontmatter.wave === '2', 'scalar value parsed as string ("2")');
ok(Array.isArray(fm1.frontmatter.depends_on) && fm1.frontmatter.depends_on.length === 1 && fm1.frontmatter.depends_on[0] === '00-01', 'inline single-element array');
ok(Array.isArray(fm1.frontmatter.requirements) && fm1.frontmatter.requirements.length === 2 && fm1.frontmatter.requirements[1] === 'FR-04', 'inline multi-element array');
ok(fm1.body === 'body', 'body is the text after the closing fence');

const fm2 = parseFrontmatter('no fence here\nline2');
ok(Object.keys(fm2.frontmatter).length === 0 && fm2.body === 'no fence here\nline2', 'no fence => empty frontmatter, body unchanged');

const fm3 = parseFrontmatter('---\r\nwave: 3\r\n---\r\nhello');
ok(fm3.frontmatter.wave === '3' && fm3.body === 'hello', 'CRLF frontmatter handled like derive-gsd');

const fm4 = parseFrontmatter('---\ntags:\n  - a\n  - b\n---\nx');
ok(Array.isArray(fm4.frontmatter.tags) && fm4.frontmatter.tags.length === 2 && fm4.frontmatter.tags[0] === 'a', 'block "- item" list becomes an array');

// --- tokenize: block + inline coverage ---
const doc = [
  '# Title', '',
  'A para with **strong**, *em*, `code` and [ok](https://a.b).', '',
  '- [ ] todo', '- [x] done', '',
  '1. one', '2. two', '',
  '```js', 'const x=1;', '```', '',
  '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
  '---',
].join('\n');
const b = tokenize(doc);

ok(b[0].type === 'heading' && b[0].level === 1, 'heading level 1');
const para = b.find((x) => x.type === 'para');
ok(para && para.spans.some((s) => s.t === 'strong') && para.spans.some((s) => s.t === 'em') && para.spans.some((s) => s.t === 'code'), 'inline strong/em/code spans');
const link = para && para.spans.find((s) => s.t === 'link');
ok(link && link.href === 'https://a.b', 'safe https link keeps its href with t:link');
const cbList = b.find((x) => x.type === 'list' && x.items.some((it) => it.checked !== null));
ok(cbList && cbList.items[0].checked === false && cbList.items[1].checked === true, 'checkbox items => checked false then true');
const olist = b.find((x) => x.type === 'list' && x.ordered);
ok(olist && olist.items.length === 2, 'ordered list with two items');
const code = b.find((x) => x.type === 'code');
ok(code && code.lang === 'js' && /const x=1/.test(code.text), 'fenced code carries lang + verbatim text');
const table = b.find((x) => x.type === 'table');
ok(table && table.headers[0] === 'A' && table.headers[1] === 'B' && table.rows[0][1] === '2', 'pipe table headers + rows');
ok(b.some((x) => x.type === 'hr'), 'hr rule emitted');

const rel = tokenize('[rel](./x.md)')[0];
ok(rel.spans.find((s) => s.t === 'link')?.href === './x.md', 'relative link keeps href (no scheme)');

// --- ADVERSARIAL: locks the XSS mitigation ---
const adv1 = tokenize('A <img src=x onerror=alert(1)>');
const p1 = adv1.find((x) => x.type === 'para');
ok(!!p1, 'adversarial input still produces a paragraph block');
const ALLOWED = new Set(['text', 'strong', 'em', 'code', 'link']);
ok(p1.spans.every((s) => ALLOWED.has(s.t)), 'only inert span tokens exist — no html/element token type');
const imgSpan = p1.spans.find((s) => s.t === 'text' && /<img src=x onerror=alert\(1\)>/.test(s.text));
ok(!!imgSpan, 'raw <img ...> lives verbatim inside a t:text span (never parsed to markup)');

const adv2 = tokenize('[x](javascript:alert(1))');
const p2 = adv2.find((x) => x.type === 'para');
ok(p2 && !p2.spans.some((s) => s.t === 'link'), 'javascript: link produces NO t:link span');
ok(p2 && !p2.spans.some((s) => s.href !== undefined), 'no href emitted anywhere for unsafe scheme');

// A control char inside the scheme (java<TAB>script:) must not slip through as a "relative"
// href: browsers strip \t\r\n from URLs, so it would resolve back to javascript: and execute.
const adv3 = tokenize('[x](java\tscript:alert(1))');
const p3 = adv3.find((x) => x.type === 'para');
ok(p3 && !p3.spans.some((s) => s.t === 'link' && s.href !== undefined), 'control-char scheme (java<TAB>script:) drops the href — no live link');

// --- robustness: never throws on ragged/large input ---
let unclosed;
try { unclosed = tokenize('```\nno closing fence\nstill going'); } catch { unclosed = null; }
ok(Array.isArray(unclosed), 'unclosed fence does not throw');
let big = '';
for (let k = 0; k < 2000; k++) big += `para line ${k} with **bold** and a <tag> here.\n\n`;
let bigOut;
try { bigOut = tokenize(big); } catch { bigOut = null; }
ok(Array.isArray(bigOut) && bigOut.length > 0, '40KB+ doc tokenizes to a non-empty Block[] without throwing');

console.log(fail ? `\nFLOW-DOCS ${fail} FAILURES` : '\nFLOW-DOCS OK');
process.exit(fail ? 1 : 0);
