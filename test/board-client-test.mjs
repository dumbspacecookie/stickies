// Behavioural tests for the board page's CLIENT javascript.
//
// Everything else about the drag UI was asserted by string-matching the served HTML — checking
// that `if (PENDING) return;` appears somewhere in the page source. That proves the characters
// shipped and nothing else: it cannot see ordering, scope, reachability, or whether an exception
// leaves the lock latched. A regression that silently killed every drag on the page (a phase id
// containing a quote threw out of a selector build, outside the try) shipped with those
// assertions green.
//
// So: extract the inline script, run it against a small DOM stub with fetch faked, and drive the
// real functions. No jsdom — this project ships zero dependencies and the surface needed is small.

import { renderBoardPage } from '../src/flow/board-page.js';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

// --- the smallest DOM that the board's script actually touches ----------------------------
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attrs: {},
    _text: '',
    hidden: false,
    classes: new Set(),
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return ''; },
    set innerHTML(_) { this.children = []; },
    get className() { return [...this.classes].join(' '); },
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: {
      add: (...c) => c.forEach((x) => el.classes.add(x)),
      remove: (...c) => c.forEach((x) => el.classes.delete(x)),
      contains: (c) => el.classes.has(c),
      toggle: (c, on) => { if (on === undefined) { el.classes.has(c) ? el.classes.delete(c) : el.classes.add(c); } else if (on) el.classes.add(c); else el.classes.delete(c); },
    },
    append: (...kids) => { for (const k of kids) el.children.push(k); return el; },
    appendChild: (k) => { el.children.push(k); return k; },
    remove() { const i = DOC._all.indexOf(el); if (i >= 0) DOC._all.splice(i, 1); el._connected = false; },
    id: '',
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 }),
    get isConnected() { return el._connected !== false; },
  };
  return el;
}

// Text of a toast element, walking the children the code appends (glyph span + text span).
function textOf(el) {
  if (!el) return '';
  let out = el._text || '';
  for (const k of el.children) out += textOf(k);
  return out;
}

let DOC;
function makeDoc(cards) {
  const byId = {};
  for (const id of ['board', 'src', 'rollup', 'rollupFill', 'rollupTxt', 'drawer', 'drawerTitle',
    'drawerMeta', 'moveBar', 'tabs', 'docBody', 'backdrop', 'drawerClose', 'filter', 'projLabel',
    'tColumns', 'tSwimlanes', 'themeToggle']) byId[id] = makeEl();
  const doc = {
    _all: [],
    body: makeEl('body'),
    documentElement: makeEl('html'),
    readyState: 'complete',
    getElementById: (id) => byId[id] || null,
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ _text: String(t), children: [], textContent: String(t) }),
    addEventListener() {},
    querySelector: (sel) => (sel === '#toast' ? doc._all.find((e) => e.id === 'toast') || null : null),
    querySelectorAll: (sel) => {
      if (sel === '.card') return cards;
      if (sel === '.col') return doc._cols || [];
      return [];
    },
  };
  doc.body.append = (...kids) => { for (const k of kids) { doc._all.push(k); k._connected = true; } return doc.body; };
  DOC = doc;
  return doc;
}

// --- boot the page script under the stub --------------------------------------------------
function bootBoard({ writeback = true, fetchImpl } = {}) {
  const html = renderBoardPage({ project: 'C:/tmp/proj', writeback, token: 'a'.repeat(32) });
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  // The page's own script is the long one; the others are the theme/switcher boot shims.
  const src = blocks.sort((a, b) => b.length - a.length)[0];

  const cards = [
    Object.assign(makeEl(), { dataset: { phase: 'phase-1', column: 'todo' } }),
    Object.assign(makeEl(), { dataset: { phase: 'phase-2', column: 'doing' } }),
  ];
  const doc = makeDoc(cards);
  const cols = ['todo', 'doing', 'done'].map((k) => { const c = makeEl(); c.classes.add('col'); c.classes.add(k); return c; });
  doc._cols = cols;

  const calls = [];
  const fetchFn = fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, changed: true, warnings: [] }) }));
  const wrapped = async (url, opts) => { calls.push({ url: String(url), opts }); return fetchFn(url, opts); };

  // Expose the internals the tests drive. They are function-scoped inside the block, so the
  // epilogue is the only way to reach them — and it also proves they are all genuinely in scope.
  const epilogue = '\n;globalThis.__board = { moveCard, toast, setPending, render, load, COL_LABEL, get PENDING(){return PENDING;} };';
  const fn = new Function('document', 'window', 'fetch', 'setTimeout', 'setInterval', 'location', 'globalThis_', src + epilogue);
  // withProj is defined by the switcher's own <script> block, which this harness does not run.
  globalThis.withProj = (path) => path + (path.indexOf('?') === -1 ? '?' : '&') + 'project=X';
  const timers = [];
  fn(
    doc,
    { CSS: undefined, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    wrapped,
    (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
    () => 0,
    { search: '?project=C%3A%2Ftmp%2Fproj', href: 'http://127.0.0.1:4317/board' },
    globalThis
  );
  return { api: globalThis.__board, doc, cards, cols, calls, timers };
}

// --- one move at a time -------------------------------------------------------------------
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, calls, doc } = bootBoard({
    fetchImpl: async () => { await gate; return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, warnings: [] }) }; },
  });
  const first = api.moveCard('Phase 1', 'phase-1', 'done');
  const second = api.moveCard('Phase 1', 'phase-1', 'doing'); // while the first is in flight
  await second;
  check(calls.filter((c) => c.url.includes('/api/board/status')).length === 1,
    `a second drop while one is in flight sends ONE request (got ${calls.filter((c) => c.url.includes('/api/board/status')).length})`);
  const busy = doc._all.find((e) => e.id === 'toast');
  check(/one at a time/i.test(textOf(busy)), `and says so rather than doing nothing silently (got "${textOf(busy)}")`);
  release();
  await first;
  check(api.PENDING === null, 'the lock is released once the move completes');
}

// --- the lock survives a throw ------------------------------------------------------------
{
  const { api } = bootBoard({ fetchImpl: async () => { throw new Error('network gone'); } });
  await api.moveCard('Phase 1', 'phase-1', 'done');
  check(api.PENDING === null, 'a failed fetch still releases the lock');
  const { api: api2 } = bootBoard({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  await api2.moveCard('Phase 1', 'phase-1', 'done');
  check(api2.PENDING === null, 'and so does a response that will not parse');
}

// --- which 403 is which -------------------------------------------------------------------
// The reload message must be reserved for a dead token. An unregistered project and a disabled
// feature are also 403s, and telling those users to reload sends them in a circle.
const cases = [
  ['forbidden', { status: 403, body: { error: 'forbidden' } }, /out of date|restarted/i, 'a dead token says the page is stale'],
  ['unknown project', { status: 403, body: { error: 'unknown project', requested: 'C:/x' } }, /unknown project/i, 'an unregistered project says so, not "reload"'],
  ['writeback disabled', { status: 403, body: { error: 'writeback disabled', detail: 'Set STICKIES_BOARD_WRITEBACK=1 to let the board edit .planning/ROADMAP.md.' } }, /STICKIES_BOARD_WRITEBACK/, 'a disabled feature names the switch that enables it'],
  ['refusal', { status: 409, body: { ok: false, reason: '2 of 4 plan checkboxes are ticked' } }, /checkboxes/, 'a refusal shows the reason writeback gave'],
  ['server error', { status: 500, body: { error: 'internal error' } }, /internal error/, 'a 500 is reported as a fault'],
];
for (const [label, res, want, msg] of cases) {
  const { api, doc } = bootBoard({
    fetchImpl: async () => ({ ok: res.status < 400, status: res.status, json: async () => res.body }),
  });
  await api.moveCard('Phase 1', 'phase-1', 'done');
  const t = doc._all.find((e) => e.id === 'toast');
  const text = textOf(t);
  check(want.test(text), `${msg} (${label} → "${text.slice(0, 90)}")`);
  if (label !== 'forbidden') {
    check(!/out of date|restarted/i.test(text), `  …and does NOT claim the dashboard restarted (${label})`);
  }
}

// --- a warning never replaces the outcome -------------------------------------------------
{
  const { api, doc } = bootBoard({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, changed: true, warnings: ['The annotation "(4/4 plans)" was carried over.'] }) }),
  });
  await api.moveCard('Phase 4', 'phase-4', 'todo');
  const text = textOf(doc._all.find((e) => e.id === 'toast'));
  check(/written to ROADMAP\.md/.test(text), `a warned move still says the write happened (got "${text.slice(0, 80)}…")`);
  check(/4\/4 plans/.test(text), 'and still carries the warning');
  check(/—\s*but:/.test(text), 'joined so the caveat reads as an addition, not a replacement');
}

// --- the pending cue ----------------------------------------------------------------------
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, cards, cols } = bootBoard({
    fetchImpl: async () => { await gate; return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, warnings: [] }) }; },
  });
  const p = api.moveCard('Phase 1', 'phase-1', 'done');
  check(cards[0].classList.contains('pending'), 'the dragged card is marked pending immediately');
  check(!cards[1].classList.contains('pending'), 'and only that card');
  check(cols.find((c) => c.classList.contains('done')).classList.contains('awaiting'),
    'the DESTINATION column is cued too — that is where the eyes are after a drop');
  release();
  await p;
  check(!cards[0].classList.contains('pending'), 'and the cue clears when the move lands');
  check(!cols.some((c) => c.classList.contains('awaiting')), 'as does the column cue');
}

// --- a phase id containing a quote must not break anything --------------------------------
// This is the regression that shipped green: setPending built a CSS selector from the id, and a
// quote made it a SyntaxError thrown OUTSIDE the try — latching the lock forever.
{
  const { api } = bootBoard();
  await api.moveCard('Phase "X"', 'phase-"x"', 'done');
  check(api.PENDING === null, 'a quoted phase id does not latch the lock');
  await api.moveCard('Phase 1', 'phase-1', 'done');
  check(api.PENDING === null, 'and a later move still works');
}

// --- writeback off: no drag affordances, no move bar --------------------------------------
{
  const { api } = bootBoard({ writeback: false });
  check(typeof api.moveCard === 'function', 'the page still parses with writeback off');
}

console.log(fail ? `\nboard-client: ${fail} FAILED` : '\nboard-client: all passed');
process.exit(fail ? 1 : 0);
