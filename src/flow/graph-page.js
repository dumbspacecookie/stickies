// Renders the /graph page: the plan-execution DAG. Self-contained (no external assets),
// same visual language as the flow board. Nodes are plans laid out in columns by `wave`,
// edges are `depends_on` links, each node lit by its own todo/doing/done status. The SVG is
// built entirely with createElementNS + setAttribute + textContent — never innerHTML for
// node/edge content — so plan ids/labels can't inject markup (RESEARCH §4: static SVG, not
// force-directed). This page carries its OWN back-nav (Board, Stickies); the forward
// board -> graph link is owned by board-page.js and is not touched here.

import { themeStyle, themeBoot, themeToggleButton } from './theme.mjs';

export function renderGraphPage({ project }) {
  const proj = String(project || '(global)');
  const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Flow Graph</title>
<style>
  :root {
    --bg: #1d2027; --panel: #262a33; --ink: #e7e9ee; --muted: #9aa3b2; --line: #353b47;
    --todo: #6cb6ff; --doing: #f6c453; --done: #8bd450;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
  header .proj { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header .spacer { flex: 1; }
  header .legend { display: flex; gap: 12px; color: var(--muted); font-size: 11px; }
  header .legend .lg { display: flex; align-items: center; gap: 5px; }
  header .legend .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  header .legend .sw.todo { background: var(--todo); } header .legend .sw.doing { background: var(--doing); } header .legend .sw.done { background: var(--done); }
  a.nav { color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; font-size: 12px; }
  a.nav:hover { color: var(--ink); border-color: var(--muted); }
  main { padding: 20px; overflow: auto; }
  .wrap { border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.02); padding: 12px; min-height: 200px; overflow: auto; }
  svg { display: block; }
  .node-label { font: 700 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #12151b; }
  .node-sub { font: 11px ui-sans-serif, system-ui, sans-serif; fill: #12151b; }
  .wave-label { font: 700 11px ui-sans-serif, system-ui, sans-serif; fill: var(--muted); letter-spacing: .5px; }
  .edge { stroke: var(--muted); stroke-width: 1.6; fill: none; opacity: .55; }
  .banner { color: var(--muted); padding: 22px; }
</style>
${themeStyle()}
${themeBoot()}
</head>
<body>
<header>
  <h1>🕸 Flow Graph</h1>
  <span class="proj">${escHtml(proj)}</span>
  <span class="spacer"></span>
  <span class="legend">
    <span class="lg"><span class="sw todo"></span>To-Do</span>
    <span class="lg"><span class="sw doing"></span>Doing</span>
    <span class="lg"><span class="sw done"></span>Done</span>
  </span>
  ${themeToggleButton()}
  <a class="nav" href="/command">🛰 Command</a>
  <a class="nav" href="/board">📋 Board →</a>
  <a class="nav" href="/">🟡 Stickies →</a>
</header>

<main>
  <div class="wrap" id="wrap"><div class="banner">Loading…</div></div>
</main>

<script>
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Fills mirror the board's --todo/--doing/--done palette so the two pages read as one.
  const STATUS_FILL = { todo: '#6cb6ff', doing: '#f6c453', done: '#8bd450' };

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k])); // attrs only via setAttribute
    return e;
  }
  // Remove all children without touching innerHTML — the whole render path is injection-free.
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  const COL_W = 210, ROW_H = 86, NODE_W = 156, NODE_H = 56, PAD = 26, TOP = 30;

  // Deterministic layered layout: one column per wave (ascending), rows in id order within a
  // wave. No physics/force-direction — pure arithmetic, so the same graph always lays out the
  // same way and diffs cleanly.
  function layout(nodes) {
    const waves = [...new Set(nodes.map((n) => Number(n.wave) || 0))].sort((a, b) => a - b);
    const col = new Map(waves.map((w, i) => [w, i]));
    const rowOf = new Map(); // wave -> next free row
    const pos = new Map();
    const ordered = [...nodes].sort((a, b) =>
      (Number(a.wave) || 0) - (Number(b.wave) || 0) || String(a.id).localeCompare(String(b.id)));
    for (const n of ordered) {
      const w = Number(n.wave) || 0;
      const r = rowOf.get(w) || 0; rowOf.set(w, r + 1);
      pos.set(n.id, { x: PAD + col.get(w) * COL_W, y: TOP + r * ROW_H });
    }
    const maxRows = Math.max(1, ...rowOf.values());
    const width = PAD * 2 + Math.max(1, waves.length - 1) * COL_W + NODE_W;
    const height = TOP + PAD + maxRows * ROW_H - (ROW_H - NODE_H);
    return { pos, waves, col, width, height };
  }

  function render(graph) {
    const wrap = document.getElementById('wrap');
    clear(wrap);
    const nodes = (graph && graph.nodes) || [];
    const edges = (graph && graph.edges) || [];
    if (!nodes.length) {
      const b = document.createElement('div');
      b.className = 'banner';
      b.textContent = 'No plan graph yet. Add PLAN.md files with wave/depends_on frontmatter under .planning/phases/.';
      wrap.append(b);
      return;
    }

    const { pos, waves, col, width, height } = layout(nodes);
    const svg = svgEl('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Plan dependency graph' });

    // Column headers, one per wave.
    for (const w of waves) {
      const x = PAD + col.get(w) * COL_W;
      const t = svgEl('text', { x: x + NODE_W / 2, y: 16, 'text-anchor': 'middle', class: 'wave-label' });
      t.textContent = 'Wave ' + w;
      svg.append(t);
    }

    // Edges under the nodes: a smooth curve from the source's right edge to the target's left.
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
      const x2 = b.x, y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      svg.append(svgEl('path', { class: 'edge', d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 }));
    }

    // Nodes: a rect filled by status + the plan id + its done/total (or status word).
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const fill = STATUS_FILL[n.status] || STATUS_FILL.todo;
      const g = svgEl('g', { transform: 'translate(' + p.x + ',' + p.y + ')' });
      g.append(svgEl('rect', { x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 10, ry: 10, fill, 'fill-opacity': 0.9, stroke: fill }));
      const label = svgEl('text', { x: 13, y: 23, class: 'node-label' });
      label.textContent = n.label || n.id;
      g.append(label);
      const sub = svgEl('text', { x: 13, y: 42, class: 'node-sub' });
      sub.textContent = n.progress ? (n.progress.done + '/' + n.progress.total) : n.status;
      g.append(sub);
      svg.append(g);
    }

    wrap.append(svg);
  }

  async function load() {
    let data;
    try {
      const r = await fetch('/api/plan-graph', { cache: 'no-store' });
      data = await r.json();
    } catch { return; }
    render(data);
  }

  load();
  setInterval(load, 5000); // relight nodes as PLAN.md checkboxes flip
</script>
</body>
</html>`;
}
