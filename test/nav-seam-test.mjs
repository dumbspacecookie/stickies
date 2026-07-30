// The header can be extended by the SERVER, not by hardcoding links in the renderers.
//
// This exists because the dev tree carries a feature the published package does not, and these
// renderers are ported wholesale. A hardcoded link would ship a 404 to strangers or force a
// hand-merge on every release; a server-supplied list keeps one file working in both trees.
//
// Deliberately uses a neutral href, so this suite is itself portable — naming the dev-only
// feature here would put its name in the public tree, which is the thing being avoided.
import { renderPage } from '../src/dashboard-page.js';
import { renderBoardPage } from '../src/flow/board-page.js';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const base = { token: 't', project: 'C:/p', categories: ['todo'], importances: ['P1'] };
const LINK = [{ href: '/extra', label: 'Extra' }];

const notesWith = renderPage({ ...base, extraNav: LINK });
const notesWithout = renderPage(base);
check(/href="\/extra"/.test(notesWith), 'the notes page renders a server-supplied link');
check(!/\/extra/.test(notesWithout), 'and omits it entirely when none is supplied');
check(!/undefined/.test(notesWithout), 'a page with no extraNav renders no "undefined"');

const boardWith = renderBoardPage({ project: 'C:/p', extraNav: LINK });
check(/href="\/extra"/.test(boardWith), 'the board page renders one too');
check(!/\/extra/.test(renderBoardPage({ project: 'C:/p' })), 'and omits it by default');

// A label reaches the DOM as markup, so it must not be able to close the tag it sits in. The
// server controls this list today, but "the caller is trusted" is how injection bugs are written.
const hostile = renderPage({
  ...base,
  extraNav: [{ href: '/x"><script>alert(1)</script>', label: '<img src=x onerror=alert(1)>' }],
});
check(!/<script>alert\(1\)<\/script>/.test(hostile), 'a hostile href cannot break out of the attribute');
check(!/<img src=x/.test(hostile), 'and a hostile label is escaped, not rendered');

// Junk must be skipped rather than rendered as "undefined" links.
const junk = renderPage({ ...base, extraNav: [null, 'nope', {}, { href: '/ok', label: 'OK' }, { href: 5, label: 6 }] });
check(/href="\/ok"/.test(junk), 'a valid entry among junk still renders');
check((junk.match(/class="nav"/g) || []).length >= 1, 'and the junk entries produced no links');
check(!/undefined/.test(junk.split('<main')[0]), 'no "undefined" leaks into the header');

// Not an array at all — a caller passing a single object or null must not throw.
for (const bad of [null, undefined, 'x', 42, { href: '/a', label: 'A' }]) {
  let threw = false;
  try { renderPage({ ...base, extraNav: bad }); } catch { threw = true; }
  check(!threw, `extraNav=${JSON.stringify(bad)} does not throw`);
}

console.log(fail ? `\nnav-seam: ${fail} FAILED` : '\nnav-seam: all passed');
process.exitCode = fail ? 1 : 0;
