// No stray backticks inside the big HTML/CSS template literals.
//
// The page renderers are one enormous template literal each. A backtick anywhere inside — most
// naturally in a comment, quoting a CSS keyword or an attribute name — ends the literal early
// and the rest of the file becomes a syntax error. It happened four times in one session, and
// every time the symptom appeared somewhere else: a dashboard that would not start, an autostart
// test reporting "starting" for a process crashing on import.
//
// imports-test.mjs catches the consequence. This catches the cause, and points at the line.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// Files whose whole job is to return a big template literal of markup.
const FILES = [
  'flow/board-page.js', 'flow/project-switcher.mjs', 'flow/graph-page.js',
  'dashboard-page.js', 'command-page.js', 'flow/theme.mjs',
];

for (const rel of FILES) {
  const text = readFileSync(join(SRC, rel), 'utf8');
  const lines = text.split(/\r?\n/);
  const offenders = [];
  let depth = 0; // template-literal nesting, tracked crudely but well enough for this shape

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Count unescaped backticks to know whether we are inside a literal on the NEXT line.
    const ticks = (line.match(/(?<!\\)`/g) || []).length;
    const insideAtLineStart = depth % 2 === 1;
    if (insideAtLineStart) {
      // Inside a template literal, a comment marker is just text — so a `-quoted word in what
      // looks like a comment is a live backtick.
      const isCommentish = /^\s*(\/\/|\/\*|\*)/.test(line);
      if (isCommentish && ticks > 0) offenders.push(`${i + 1}: ${line.trim().slice(0, 78)}`);
    }
    depth += ticks;
  }

  check(offenders.length === 0,
    offenders.length
      ? `src/${rel} has a backtick inside a template literal comment — ${offenders[0]}`
      : `src/${rel} keeps its template literals intact`);
}

console.log(fail ? `\ntemplate-literal: ${fail} FAILED` : '\ntemplate-literal: all passed');
process.exit(fail ? 1 : 0);
