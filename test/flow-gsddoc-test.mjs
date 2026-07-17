// GSD-doc humanizer tests: sectionizeBlocks (lone section tags -> headings) and
// summarizeFrontmatter (frontmatter -> readable line). Pure/offline — no fs, no network.

import { sectionizeBlocks, summarizeFrontmatter } from '../src/flow/gsd-doc.mjs';
import { tokenize } from '../src/flow/md-tokenize.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const para = (text) => ({ type: 'para', spans: [{ t: 'text', text }] });
const headingText = (b) => (b && b.type === 'heading' ? (b.spans || []).map((s) => s.text).join('') : null);

// --- sectionizeBlocks: opening known tag -> humanized heading ---
const out1 = sectionizeBlocks([para('<objective>')]);
ok(out1.length === 1 && out1[0].type === 'heading' && out1[0].level === 2, 'opening known tag -> level-2 heading');
ok(headingText(out1[0]) === 'Objective', 'objective -> "Objective"');

ok(headingText(sectionizeBlocks([para('<execution_context>')])[0]) === 'Execution Context', 'execution_context -> "Execution Context"');
ok(headingText(sectionizeBlocks([para('<success_criteria>')])[0]) === 'Success Criteria', 'success_criteria -> "Success Criteria"');

// Attributes are stripped from the humanized title.
ok(headingText(sectionizeBlocks([para('<task type="auto" tdd="true">')])[0]) === 'Task', 'opening tag with attributes -> title without attrs');

// snake_case tag whose middle underscores the tokenizer parses into an em span still recovers.
const fromTok = sectionizeBlocks(tokenize('<files_to_read>'));
ok(fromTok.length === 1 && headingText(fromTok[0]) === 'Files To Read', 'tokenized <files_to_read> -> "Files To Read" (em delimiters recovered)');

// --- closing tag dropped ---
const out2 = sectionizeBlocks([para('<objective>'), para('body text'), para('</objective>')]);
ok(out2.length === 2 && out2[0].type === 'heading' && out2[1].type === 'para', 'closing known tag dropped, body preserved');
ok(!out2.some((b) => headingText(b) === null && b.type === 'heading'), 'no stray heading from the closing tag');

// --- inline tag (not lone on a line) untouched ---
const inlineBlock = { type: 'para', spans: [{ t: 'text', text: 'See <objective> for details' }] };
const out3 = sectionizeBlocks([inlineBlock]);
ok(out3.length === 1 && out3[0].type === 'para' && out3[0].spans[0].text === 'See <objective> for details', 'inline tag inside prose left as literal text');

// --- unknown lone tag left as text ---
const unknown = para('<threat_model>');
const out4 = sectionizeBlocks([unknown]);
ok(out4.length === 1 && out4[0].type === 'para' && out4[0].spans[0].text === '<threat_model>', 'unknown lone tag left as a literal para');

// --- input array + blocks are not mutated ---
const input = [para('<objective>'), para('keep')];
const before = JSON.stringify(input);
const result = sectionizeBlocks(input);
ok(result !== input, 'returns a new array (not the same reference)');
ok(JSON.stringify(input) === before, 'input array + blocks unchanged after sectionize');
ok(input[0].type === 'para', 'original opening-tag block still a para (not mutated in place)');

// --- non-tag blocks pass through unchanged ---
const heading = { type: 'heading', level: 1, spans: [{ t: 'text', text: 'Title' }] };
const list = { type: 'list', ordered: false, items: [] };
const passthrough = sectionizeBlocks([heading, list]);
ok(passthrough.length === 2 && passthrough[0] === heading && passthrough[1] === list, 'non-tag blocks pass through by reference');

// --- summarizeFrontmatter ---
ok(summarizeFrontmatter({ wave: '1' }) === 'Wave 1', 'wave key -> "Wave 1"');
ok(summarizeFrontmatter({ depends_on: [] }) === 'no dependencies', 'empty depends_on -> "no dependencies"');
ok(summarizeFrontmatter({ depends_on: ['00-01', '00-02'] }) === 'depends on 00-01, 00-02', 'depends_on list -> "depends on …"');
ok(summarizeFrontmatter({ files_modified: ['a.js', 'b.js', 'c.js'] }) === 'touches 3 files', 'files_modified (3) -> "touches 3 files"');
ok(summarizeFrontmatter({ files_modified: ['only.js'] }) === 'touches 1 file', 'files_modified (1) -> singular "touches 1 file"');
ok(summarizeFrontmatter({ requirements: ['FR-01', 'FR-02'] }) === 'FR-01, FR-02', 'requirements ids joined');
ok(summarizeFrontmatter({ req_ids: ['FR-09'] }) === 'FR-09', 'req_ids alias recognized');
ok(summarizeFrontmatter({ requirementIds: ['FR-07'] }) === 'FR-07', 'requirementIds alias recognized');
ok(summarizeFrontmatter({ type: 'execute' }) === 'execute', 'type shown as-is');

// combined order: wave · depends_on · files_modified · requirements · type
ok(
  summarizeFrontmatter({ wave: '2', depends_on: [], files_modified: ['a', 'b'], requirements: ['FR-01'], type: 'execute' })
    === 'Wave 2 · no dependencies · touches 2 files · FR-01 · execute',
  'combined summary joins known keys with " · " in order',
);

// empty / missing cases
ok(summarizeFrontmatter({}) === '', 'no known keys -> empty string');
ok(summarizeFrontmatter(null) === '', 'null frontmatter -> empty string');
ok(summarizeFrontmatter({ unknown_key: 'x' }) === '', 'unknown-only keys omitted -> empty string');
ok(summarizeFrontmatter({ wave: '3', unrelated: 'y' }) === 'Wave 3', 'unknown keys omitted, known key kept');

console.log(fail ? `\nFLOW-GSDDOC ${fail} FAILURES` : '\nFLOW-GSDDOC OK');
process.exit(fail ? 1 : 0);
