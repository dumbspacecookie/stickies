// A leading `---` is a horizontal rule as often as it is a frontmatter fence.
//
// The parser treated any document starting with `---` as frontmatter and consumed everything up
// to the next `---`. A doc that opens with a thematic break therefore lost its title and opening
// paragraph from the rendered output — silently, with no error, because the swallowed lines did
// not parse into any key either. They just stopped existing.
//
// The rule now: the first non-blank line inside the fence must be a `key:` line. That is the only
// shape this parser supports, so requiring it costs nothing real and makes the failure impossible.
import { parseFrontmatter } from '../src/flow/frontmatter.mjs';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// --- the bug: a horizontal rule is not frontmatter --------------------------------------------

const RULE_DOC = ['---', '', '# My Title', '', 'An opening paragraph.', '', '---', '', 'More body.', ''].join('\n');
const ruled = parseFrontmatter(RULE_DOC);
check(Object.keys(ruled.frontmatter).length === 0, 'a doc opening with a rule yields no frontmatter');
check(ruled.body === RULE_DOC, 'and its body is the document, unchanged and complete');
check(ruled.body.includes('# My Title'), '...the title survives');
check(ruled.body.includes('An opening paragraph.'), '...and so does the opening paragraph');

// Other non-frontmatter openings.
for (const [label, first] of [
  ['a bullet', '- just a list'],
  ['a sentence', 'Some prose that happens to sit between two rules.'],
  ['a heading', '## Section'],
  ['a fenced block', '```'],
]) {
  const doc = ['---', first, '---', '', 'body'].join('\n');
  const r = parseFrontmatter(doc);
  check(Object.keys(r.frontmatter).length === 0 && r.body === doc,
    `${label} inside the fence means it was a rule, not frontmatter`);
}

// --- the control: real frontmatter still parses exactly as before ------------------------------

const REAL = ['---', 'title: A Plan', 'phase: 3', 'tags: [a, b]', '---', '', '# Body heading', 'text', ''].join('\n');
const real = parseFrontmatter(REAL);
check(real.frontmatter.title === 'A Plan', 'control: real frontmatter still parses its scalars');
check(real.frontmatter.phase === '3' || real.frontmatter.phase === 3, 'control: ...and numbers');
check(Array.isArray(real.frontmatter.tags) && real.frontmatter.tags.length === 2, 'control: ...and inline arrays');
check(!real.body.includes('title: A Plan'), 'control: the fence is consumed, not left in the body');
check(real.body.includes('# Body heading'), 'control: and the body survives');

// A blank line before the first key is still frontmatter — leading whitespace is not a signal.
const PADDED = ['---', '', 'title: Padded', '---', 'body'].join('\n');
check(parseFrontmatter(PADDED).frontmatter.title === 'Padded', 'a blank line before the first key is fine');

// An INDENTED first key is left alone, and that is deliberate. The key matcher has never
// accepted leading whitespace, so admitting such a block here would consume the document into an
// empty `frontmatter` — the same disappearance, reached a different way. The gate and the parser
// use the same rule so that cannot happen.
const INDENTED = ['---', '  title: Indented', '---', 'body'].join('\n');
const ind = parseFrontmatter(INDENTED);
check(Object.keys(ind.frontmatter).length === 0 && ind.body === INDENTED,
  'an indented first key is NOT eaten: the parser could not read it, so the text is preserved');

// An unterminated fence is body, as before.
const UNTERM = ['---', 'title: Never closed', 'more text'].join('\n');
check(parseFrontmatter(UNTERM).body === UNTERM, 'an unterminated fence is still returned as body');

// Empty and degenerate inputs do not throw.
for (const v of ['', '---', '---\n---', null, undefined]) {
  let threw = false;
  try { parseFrontmatter(v); } catch { threw = true; }
  check(!threw, `does not throw on ${JSON.stringify(v)}`);
}

console.log(fail === 0 ? '\nOK — frontmatter vs horizontal rule' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
