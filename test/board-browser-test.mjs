// The board, in a real browser, against a real dashboard, writing a real ROADMAP.md.
//
// board-client-test.mjs runs the same code against a DOM stub and proves the LOGIC. This proves
// the things a stub cannot see: that the CSS clips the end of a path it is supposed to keep,
// that the header does not push its own controls off-screen, that a drag actually lands, and
// that the file on disk changed. Two bugs that reached a user were pure layout — invisible to
// every logic test we had.
//
// Skips cleanly when no Chromium is installed.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, scratchDir, cleanup, killAndWait } from './_env.mjs';
import { launchBrowser, findBrowser } from './_cdp.mjs';

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

if (!findBrowser()) {
  console.log('  SKIP  no Chromium found — install Chrome or Edge to run the browser tests');
  console.log('\nboard-browser: skipped');
  process.exit(0);
}

const ROOT = scratchDir('browser');
const HOME = join(ROOT, 'home');
// Two projects under a long shared prefix: the case where a label that clips its END renders
// them identically, which is how a card gets dragged into the wrong file.
const LONG = join(ROOT, 'a-really-quite-long-shared-parent-directory-name');
const PROJ_A = join(LONG, 'alpha-service');
const PROJ_B = join(LONG, 'alpha-service-worker');
for (const p of [PROJ_A, PROJ_B]) mkdirSync(join(p, '.planning'), { recursive: true });
mkdirSync(HOME, { recursive: true });

const ROADMAP = [
  '# Roadmap', '',
  '### Phase 1: Movable', '**Status:** Planned', '',
  '### Phase 2: Partly done', '**Status:** In progress',
  '- [x] 02-01', '- [ ] 02-02', '',
  '### Phase 3: Finished', '**Status:** Complete', '',
].join('\n');
writeFileSync(join(PROJ_A, '.planning', 'ROADMAP.md'), ROADMAP);
writeFileSync(join(PROJ_B, '.planning', 'ROADMAP.md'), ROADMAP);

const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_DISCORD_WEBHOOK: '' };
const env = { ...process.env, STICKIES_DB: join(ROOT, 'b.db'), STICKIES_HOME: HOME, STICKIES_BOARD_WRITEBACK: '1', ...NO_SYNC };
Object.assign(process.env, { STICKIES_DB: join(ROOT, 'b.db'), STICKIES_HOME: HOME, ...NO_SYNC });

// Register both projects so the switcher has something to disambiguate.
const { createSticky } = await import('../src/store.js');
createSticky({ content: 'note in alpha-service', category: 'context', importance: 'P3', project_path: PROJ_A });
createSticky({ content: 'note in alpha-service-worker', category: 'context', importance: 'P3', project_path: PROJ_B });

const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dashboard.js',
  '--port', String(PORT), '--project', PROJ_A], { env });
srv.stderr.on('data', (d) => process.stdout.write('  srv: ' + d));

let browser = null;
// `process.exit()` does not run a `finally`, so bailing out that way from inside the block below
// left the dashboard child alive and its scratch directory on disk — once per run, which is how
// ten of them accumulated in %TEMP%. A skip leaves through the same catch/finally as everything
// else, and the exit happens after the cleanup.
class Skip extends Error {}
let skipped = false;
try {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  browser = await launchBrowser();
  if (!browser) throw new Skip('browser failed to launch');

  // Reads need a credential now. A browser gets one exactly as a human does: follow a link
  // carrying the key, which redeems it for a cookie and bounces to the clean URL. Doing it here
  // rather than injecting a cookie means this test also proves the redemption works in a real
  // browser — the statusline click is the only route most people ever use.
  const { linkToken } = await import('../src/dashboard-auth.js');
  const token = linkToken();
  check(!!token, 'the dashboard wrote a read key the browser can derive a link token from');
  const boardUrl = `${base}/board?project=${encodeURIComponent(PROJ_A.replace(/\\/g, '/'))}`;
  await browser.goto(`${boardUrl}&k=${token}`);
  check(await browser.eval('location.search.includes("k=") === false'),
    'redeeming the link leaves the key out of the address bar');

  // --- the page is actually alive ---------------------------------------------------------
  // The board fetches then renders, so readyState=complete is not "the cards are there".
  const cards = await browser.eval(`(async () => {
    for (let i = 0; i < 100; i++) {
      const n = document.querySelectorAll('.card').length;
      if (n) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    return 0;
  })()`);
  check(cards === 3, `the board renders its three phases in a real browser (got ${cards})`);

  // --- the project label must be READABLE, not merely present ----------------------------
  // The first attempt at left-clipping used `unicode-bidi: plaintext`, which derives direction
  // from the first strong character and silently cancelled the rtl — so it still clipped the
  // end. Only a browser can tell you that; the stub cannot.
  const label = await browser.eval(`(() => {
    const btn = document.getElementById('projLabel');
    const base = btn.querySelector('.base'), par = btn.querySelector('.parent');
    return {
      baseText: base ? base.textContent : null,
      baseVisible: base ? base.getBoundingClientRect().width > 0 : false,
      baseFullyVisible: base ? base.scrollWidth <= base.clientWidth + 1 : false,
      parentClipped: par ? par.scrollWidth > par.clientWidth : false,
      title: btn.getAttribute('title'),
      spillsOutOfButton: base ? (base.getBoundingClientRect().right - btn.getBoundingClientRect().right) : 0,
    };
  })()`);
  check(label.baseText === 'alpha-service', `the basename is shown in full, not clipped away (got ${JSON.stringify(label.baseText)})`);
  check(label.baseVisible && label.baseFullyVisible, 'and it is entirely visible');
  check(label.title.endsWith('alpha-service'), 'the full path is in the tooltip');
  check(label.spillsOutOfButton <= 1, `the label does not spill outside its own button (overhang ${Math.round(label.spillsOutOfButton)}px)`);

  // --- the two projects must be distinguishable in the SWITCHER --------------------------
  const menu = await browser.eval(`(async () => {
    document.getElementById('projLabel').click();
    for (let i = 0; i < 50 && !document.querySelector('.projmenu'); i++) await new Promise(r => setTimeout(r, 100));
    const rows = [...document.querySelectorAll('.projmenu .row')];
    const menuEl = document.querySelector('.projmenu');
    const r = menuEl.getBoundingClientRect();
    return {
      count: rows.length,
      bases: rows.map(x => (x.querySelector('.pbase') || {}).textContent),
      onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0,
      focusable: rows.every(x => x.tagName === 'BUTTON'),
    };
  })()`);
  check(menu.count >= 2, `the switcher lists both projects (got ${menu.count})`);
  check(new Set(menu.bases.filter(Boolean)).size === menu.bases.filter(Boolean).length,
    `and each row is visually distinct: ${JSON.stringify(menu.bases)}`);
  check(menu.onScreen, 'the menu opens inside the viewport');
  check(menu.focusable, 'and its rows are real buttons, so a keyboard can reach them');
  await browser.eval('document.body.click()');

  // --- the header must not push its own controls off-screen ------------------------------
  for (const [w, h] of [[1280, 900], [1100, 900], [900, 900]]) {
    await browser.setViewport(w, h);
    await browser.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const hdr = await browser.eval(`(() => {
      const header = document.querySelector('header');
      const items = [...header.children];
      const off = items.filter(el => el.getBoundingClientRect().right > innerWidth + 1).length;
      return { overflow: header.scrollWidth - header.clientWidth, offscreen: off };
    })()`);
    check(hdr.offscreen === 0, `at ${w}px no header control is pushed off-screen (${hdr.offscreen} were)`);
  }
  await browser.setViewport(1280, 900);

  // --- a real drag, and the file on disk ---------------------------------------------------
  const before = readFileSync(join(PROJ_A, '.planning', 'ROADMAP.md'), 'utf8');
  const dragged = await browser.eval(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.dataset.phase === 'phase-1');
    const target = document.querySelector('.col.done');
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const hadDropzone = target.classList.contains('dropzone');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (let i = 0; i < 60; i++) {
      const t = document.getElementById('toast');
      if (t) return { hadDropzone, toast: t.textContent };
      await new Promise(r => setTimeout(r, 100));
    }
    return { hadDropzone, toast: null };
  })()`);
  check(dragged.hadDropzone, 'dragging over a different column lights the drop zone');
  check(!!dragged.toast && /written to ROADMAP\.md/.test(dragged.toast),
    `the drop reports the write (got ${JSON.stringify(dragged.toast)})`);
  const after = readFileSync(join(PROJ_A, '.planning', 'ROADMAP.md'), 'utf8');
  check(after !== before, 'and the file on disk actually changed');
  check(/### Phase 1: Movable\r?\n\*\*Status:\*\* Complete/.test(after), 'the right phase got the right status');
  check(after.split(/\r?\n/).filter((l, i) => l !== before.split(/\r?\n/)[i]).length === 1,
    'exactly one line differs, in a real end-to-end write');

  // --- a refusal reaches the user, in a browser -------------------------------------------
  // Phase 2 has 1 of 2 boxes ticked, so the board classifies it 'doing' whatever the text says.
  const refusal = await browser.eval(`(async () => {
    const t0 = document.getElementById('toast'); if (t0) t0.remove();
    const card = [...document.querySelectorAll('.card')].find(c => c.dataset.phase === 'phase-2');
    const target = document.querySelector('.col.done');
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (let i = 0; i < 60; i++) {
      const t = document.getElementById('toast');
      if (t) return { text: t.textContent, kind: t.className };
      await new Promise(r => setTimeout(r, 100));
    }
    return { text: null, kind: null };
  })()`);
  check(/checkbox/i.test(refusal.text || ''), `a refusal explains itself in the browser (got ${JSON.stringify(refusal.text)})`);
  check(/refused/.test(refusal.kind || ''), `and is styled as a refusal, not a transport error (class ${refusal.kind})`);
  const afterRefusal = readFileSync(join(PROJ_A, '.planning', 'ROADMAP.md'), 'utf8');
  check(afterRefusal === after, 'and the refused move wrote nothing');

  // --- the keyboard route must actually be reachable ---------------------------------------
  // Cards were focusable and the drawer had Move-to buttons, but focus never entered the
  // drawer — so reaching them cost one Tab per remaining card, and closing stranded focus on a
  // hidden button. "Keyboard reachable" was true only on paper.
  const kb = await browser.eval(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.dataset.phase === 'phase-3');
    card.focus();
    const openerWas = document.activeElement === card;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const drawer = document.getElementById('drawer');
    const inDrawer = drawer.contains(document.activeElement);
    const bar = [...document.querySelectorAll('#moveBar button')];
    const current = bar.find(b => b.getAttribute('aria-current') === 'true');
    const currentFocusable = current ? !current.disabled : false;
    document.getElementById('drawerClose').click();
    await new Promise(r => setTimeout(r, 200));
    return {
      openerWas, inDrawer, buttons: bar.length,
      currentLabel: current ? current.textContent : null,
      currentFocusable,
      focusRestored: document.activeElement === card,
    };
  })()`);
  check(kb.openerWas, 'a card takes focus');
  check(kb.inDrawer, 'opening the drawer moves focus into it');
  check(kb.buttons === 3, `the drawer offers a Move-to button per column (got ${kb.buttons})`);
  check(/✓/.test(kb.currentLabel || ''), `the current column is marked, not just greyed (got ${JSON.stringify(kb.currentLabel)})`);
  check(kb.currentFocusable, 'and it stays in the tab order, so a keyboard user learns where they are');
  check(kb.focusRestored, 'closing the drawer returns focus to the card that opened it');

  // --- the toast must be usable on a phone -------------------------------------------------
  await browser.setViewport(390, 844);
  await browser.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const phone = await browser.eval(`(() => {
    const t = document.getElementById('toast');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), fitsWidth: r.left >= 0 && r.right <= innerWidth + 1, heightRatio: r.height / innerHeight };
  })()`);
  if (phone) {
    check(phone.fitsWidth, `the toast fits the viewport width on a phone (${phone.w}px wide)`);
    // Fitting is not enough: with left:50% + translateX the shrink-to-fit width capped at 50vw,
    // so a long warning became a narrow, very tall column. It must USE the width it has.
    check(phone.w > 390 * 0.6, `and uses the width available rather than becoming a column (${phone.w}px of 390px)`);
    check(phone.heightRatio < 0.5, `so it does not swallow the screen (${Math.round(phone.heightRatio * 100)}% of viewport height)`);
  } else {
    console.log('  SKIP  no toast present for the mobile measurement');
  }
} catch (err) {
  if (err instanceof Skip) {
    console.log(`  SKIP  ${err.message}`);
    skipped = true;
  } else {
    console.log(`  FAIL  browser test threw: ${err.message}`);
    fail++;
  }
} finally {
  if (browser) await browser.close();
  // Wait for the dashboard to actually exit: it holds a sqlite file inside ROOT, and deleting
  // the tree in the same tick as the kill is why these directories piled up in %TEMP%.
  await killAndWait(srv);
  try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
  cleanup(ROOT);
}

console.log(skipped ? '\nboard-browser: skipped' : fail ? `\nboard-browser: ${fail} FAILED` : '\nboard-browser: all passed');
process.exit(fail ? 1 : 0);
