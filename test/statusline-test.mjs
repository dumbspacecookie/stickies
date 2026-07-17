// Statusline renderer tests: the compact-by-default contract (counts only, and — load-bearing —
// NEVER the note body text) plus the verbose opt-in that restores the newest P1's text. This is
// the surface a user stares at on every prompt, so "no note content leaks into the compact line"
// is a real privacy contract, not a cosmetic one.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { buildStatusline, resolveStatuslineTheme, statuslinePalette } from '../src/statusline.js';
import { closeDb } from '../src/db.js';
import { createSticky } from '../src/store.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const opts = (extra = {}) => ({ color: false, ...extra });
const P1 = { importance: 'P1', content: 'SENSITIVE note body that must never reach the compact line' };
const P2 = { importance: 'P2', content: 'a second note body' };

// --- empty: nothing renders, in either mode (an always-on zero trains the eye to ignore it) ---
ok(buildStatusline([], opts()) === '', 'no stickies => empty output (compact)');
ok(buildStatusline([], opts({ verbose: true })) === '', 'no stickies => empty output (verbose)');

// --- compact default: counts only, and never any note text ---
const cP1 = buildStatusline([P1, P2], opts());
ok(cP1 === '\u{1F7E8} 1!·2', `compact w/ P1 => "icon N!·total" (got ${JSON.stringify(cP1)})`);
ok(!cP1.includes('SENSITIVE'), 'compact line never contains note text (P1 present)');

const cNo = buildStatusline([P2], opts());
ok(cNo === '\u{1F7E8} 1', `compact no-P1 => bare count (got ${JSON.stringify(cNo)})`);
ok(!cNo.includes('second note'), 'compact line never contains note text (no P1)');

// --- verbose opt-in: restores the newest P1's text, or "N pending" when nothing is hot ---
const vP1 = buildStatusline([P1, P2], opts({ verbose: true }));
ok(vP1.includes('SENSITIVE'), 'verbose restores the newest P1 note text');
const vNo = buildStatusline([P2], opts({ verbose: true }));
ok(/\bpending\b/.test(vNo), 'verbose no-P1 => "N pending"');

// --- theme palette: light must NOT use bare ANSI yellow (33m), which vanishes on a light
// terminal; it uses truecolour (38;2;...) instead. Dark keeps the compact ANSI codes. ---
const ESC = '';
const cLightP1 = buildStatusline([P1, P2], { color: true, theme: 'light' });
const cDarkP1 = buildStatusline([P1, P2], { color: true, theme: 'dark' });
ok(cLightP1.includes(ESC + '[38;2;'), 'light theme paints with truecolour');
ok(!cLightP1.includes(ESC + '[33m'), 'light theme never emits bare ANSI yellow (invisible on light bg)');
ok(cDarkP1.includes(ESC + '[31m'), 'dark theme keeps standard ANSI red');
// resolveStatuslineTheme precedence: explicit > env > COLORFGBG > default dark
const savedTheme = process.env.STICKIES_THEME, savedFgbg = process.env.COLORFGBG;
delete process.env.STICKIES_THEME; delete process.env.COLORFGBG;
ok(resolveStatuslineTheme() === 'dark', 'defaults to dark when nothing set');
ok(resolveStatuslineTheme('light') === 'light', 'explicit arg wins');
process.env.STICKIES_THEME = 'light';
ok(resolveStatuslineTheme() === 'light', '$STICKIES_THEME honoured');
delete process.env.STICKIES_THEME;
process.env.COLORFGBG = '0;15';
ok(resolveStatuslineTheme() === 'light', 'COLORFGBG light background (bg 15) => light');
process.env.COLORFGBG = '15;0';
ok(resolveStatuslineTheme() === 'dark', 'COLORFGBG dark background (bg 0) => dark');
if (savedTheme === undefined) delete process.env.STICKIES_THEME; else process.env.STICKIES_THEME = savedTheme;
if (savedFgbg === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = savedFgbg;
ok(statuslinePalette('light') !== statuslinePalette('dark'), 'the two palettes are distinct');

// --- light palette must clear WCAG AA text contrast (4.5:1) on a light terminal bg. The
// light colours render as TEXT (count / ⏰ pip / verbose note), so the text bar applies.
// Parse the truecolour RGB straight out of the palette escapes and compute the ratio. ---
const _lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const _lum = ([r, g, b]) => 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b);
const _ratio = (a, b) => { const la = _lum(a), lb = _lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
const LIGHT_TERM_BG = [245, 246, 248];
const lp = statuslinePalette('light');
for (const key of ['dim', 'red', 'yellow']) {
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(lp[key]);
  ok(m, `light palette '${key}' is truecolour`);
  const r = m ? _ratio([+m[1], +m[2], +m[3]], LIGHT_TERM_BG) : 0;
  ok(r >= 4.5, `light '${key}' clears AA text 4.5:1 on a light bg (got ${r.toFixed(2)})`);
}

// --- regression: importing statusline.js must NOT run its main(). The flow statusline
// imports statuslinePalette/resolveStatuslineTheme from here; when main() ran on import it
// dragged a whole stickies render into the flow segment's stdout (double-count + stdin race).
// Run the flow statusline against a store that HAS a hot P1 and assert its line carries the
// board icon (📋) but NOT the stickies icon (🟨) — the latter would only appear if the
// import re-triggered the stickies renderer.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const regDb = join(tmpdir(), 'stickies_statusline_regression.db');
// Hermetic board fixture — a temp project with its own .planning/ROADMAP.md, so the test does
// not depend on THIS repo tracking .planning (the public repo gitignores it, so repoRoot has no
// board there). The flow statusline code still comes from repoRoot/src.
const regProj = mkdtempSync(join(tmpdir(), 'stickies-sl-reg-'));
mkdirSync(join(regProj, '.planning'), { recursive: true });
writeFileSync(join(regProj, '.planning', 'ROADMAP.md'),
  '### Phase 0: Test\n**Status:** ⏳ in progress\n- [x] 00-01-PLAN.md\n- [ ] 00-02-PLAN.md\n');
for (const s of ['', '-wal', '-shm']) { try { rmSync(regDb + s); } catch {} }
closeDb();
process.env.STICKIES_DB = regDb;
createSticky({ content: 'hot global note', category: 'blocker', importance: 'P1', project_path: null });
closeDb();
const flow = join(repoRoot, 'src', 'flow', 'statusline.js');
const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', flow, '--project', regProj], {
  input: '{}', encoding: 'utf8', env: { ...process.env, STICKIES_DB: regDb },
});
const flowOut = (res.stdout || '').split('\n')[0];
ok(flowOut.includes('\u{1F4CB}'), 'flow statusline renders the board segment (sanity)');
ok(!flowOut.includes('\u{1F7E8}'), 'flow statusline does NOT leak a stickies render (main() guarded on import)');
rmSync(regProj, { recursive: true, force: true });
for (const s of ['', '-wal', '-shm']) { try { rmSync(regDb + s); } catch {} }

console.log(fail ? `\nstatusline: ${fail} FAILED` : `\nstatusline: all ${pass} passed`);
process.exit(fail ? 1 : 0);
