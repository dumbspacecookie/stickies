// Renders the cross-project Command Center: one screen showing every project you've used
// Stickies in — its Flow-board progress + hot notes — sorted by what needs attention. Read-
// only overview (the server is pinned to one --project, so cross-project drill-in would need
// a parameterized, path-allowlisted board route; that's a follow-up). Self-contained: all
// card content goes in via textContent in the client script, never innerHTML.

import { themeStyle, themeBoot, themeToggleButton } from './flow/theme.mjs';

export function renderCommandPage({ project } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stickies — Command Center</title>
<style>
  :root {
    --bg: #1d2027; --panel: #262a33; --ink: #e7e9ee; --muted: #9aa3b2; --line: #353b47;
    --decision: #f6c453; --blocker: #ef6f6c; --preference: #8bd450; --context: #6cb6ff; --todo: #6cb6ff;
    --doing: #f6c453; --done: #8bd450;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
  header .sub { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header .spacer { flex: 1; }
  a.nav { color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font-size: 12px; }
  a.nav:hover { color: var(--ink); border-color: var(--muted); }
  main { padding: 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; align-items: start; }
  .empty { color: var(--muted); grid-column: 1 / -1; text-align: center; padding: 60px 0; }
  .proj { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .proj.current { border-color: var(--context); }
  .proj .top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .proj .name { font-weight: 600; font-size: 14px; }
  .proj .here { font-size: 10px; color: var(--context); border: 1px solid var(--context); border-radius: 6px; padding: 0 5px; }
  .proj .path { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; margin-bottom: 12px; }
  .prog { height: 6px; background: var(--line); border-radius: 4px; overflow: hidden; margin: 4px 0 8px; }
  .prog > span { display: block; height: 100%; background: var(--done); }
  .rowline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .rowline .strong { color: var(--ink); }
  .pips { display: flex; gap: 6px; margin: 10px 0 2px; flex-wrap: wrap; }
  .pip { font-size: 11px; border-radius: 6px; padding: 2px 8px; background: #333a47; color: var(--muted); }
  .pip.doing { color: #1d2027; background: var(--doing); }
  .pip.p1 { color: #fff; background: var(--blocker); }
  .pip.blockers { color: var(--blocker); border: 1px solid var(--blocker); background: transparent; }
  .noboard { color: var(--muted); font-size: 12px; font-style: italic; }
  .links { margin-top: 12px; display: flex; gap: 10px; }
  .links a { color: var(--context); text-decoration: none; font-size: 12px; }
  .links a:hover { text-decoration: underline; }
</style>
${themeStyle()}
${themeBoot()}
</head>
<body>
<header>
  <h1>🛰 Command Center</h1>
  <span class="sub" id="totals">…</span>
  <span class="spacer"></span>
  ${themeToggleButton()}
  <a class="nav" href="/">📝 Notes</a>
  <a class="nav" href="/board">📋 Board</a>
</header>
<main id="grid"><div class="empty">Loading…</div></main>
<script>
  // No backticks and no backslash-regex in this block: the whole page is a template literal.
  var BS = String.fromCharCode(92);
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function projName(p) {
    if (!p) return '(global)';
    var parts = String(p).split('/').join(BS).split(BS).filter(Boolean);
    return parts[parts.length - 1] || p;
  }

  function card(p) {
    var c = el('div', 'proj' + (p.current ? ' current' : ''));
    var top = el('div', 'top');
    top.append(el('span', 'name', projName(p.project_path)));
    if (p.current) top.append(el('span', 'here', 'this project'));
    c.append(top);
    c.append(el('div', 'path', p.project_path));

    if (p.board && p.board.ok && p.board.rollup && p.board.rollup.total) {
      var r = p.board.rollup;
      var bar = el('div', 'prog');
      var fill = el('span');
      fill.style.width = r.pct + '%';
      bar.append(fill);
      c.append(bar);
      var line = el('div', 'rowline');
      line.append(el('span', 'strong', r.done + '/' + r.total + ' plans'));
      line.append(el('span', null, '(' + r.pct + '% shipped)'));
      c.append(line);
    } else {
      c.append(el('div', 'noboard', 'No .planning board'));
    }

    var pips = el('div', 'pips');
    if (p.board && p.board.ok && p.board.counts) {
      var ct = p.board.counts;
      pips.append(el('span', 'pip', '☐ ' + ct.todo));
      if (ct.doing) pips.append(el('span', 'pip doing', '▶ ' + ct.doing));
      pips.append(el('span', 'pip', '✓ ' + ct.done));
    }
    var s = p.stickies || { total: 0, p1: 0, blockers: 0 };
    if (s.p1) pips.append(el('span', 'pip p1', s.p1 + ' P1'));
    if (s.blockers) pips.append(el('span', 'pip blockers', s.blockers + ' blocker' + (s.blockers === 1 ? '' : 's')));
    pips.append(el('span', 'pip', '🟨 ' + s.total));
    c.append(pips);

    if (p.current) {
      var links = el('div', 'links');
      var b = el('a', null, 'Flow board →'); b.setAttribute('href', '/board');
      var n = el('a', null, 'Notes →'); n.setAttribute('href', '/');
      links.append(b); links.append(n);
      c.append(links);
    }
    return c;
  }

  async function load() {
    var res, data;
    try { res = await fetch('/api/command', { cache: 'no-store' }); data = await res.json(); }
    catch (e) { return; }
    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    var t = data.totals || { projects: 0, done: 0, total: 0, pct: 0, p1: 0, blockers: 0 };
    document.getElementById('totals').textContent =
      t.projects + ' projects · ' + t.done + '/' + t.total + ' plans (' + t.pct + '% shipped) · ' + t.p1 + ' P1 · ' + t.blockers + ' blockers';
    if (!data.projects || !data.projects.length) {
      grid.append(el('div', 'empty', 'No projects yet — add a sticky inside a project and it shows up here.'));
      return;
    }
    for (var i = 0; i < data.projects.length; i++) grid.append(card(data.projects[i]));
  }

  load();
  setInterval(load, 5000);
</script>
</body>
</html>`;
}
