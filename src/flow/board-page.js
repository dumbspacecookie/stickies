// Renders the flow-board Kanban page. Self-contained (no external assets), same visual
// language as the stickies dashboard. Card text and every doc block are inserted via
// textContent in the client script (never innerHTML for content), so phase titles from a
// roadmap — and the markdown doc bodies fetched from /api/phase-doc — cannot inject markup.
// The doc tokens delivered by 00-01 are inert by design; the drawer renders them with
// createElement + textContent only, preserving that safety end to end.

import { relativeTime } from './relative-time.mjs';
import { themeStyle, themeBoot, themeToggleButton } from './theme.mjs';

export function renderBoardPage({ project }) {
  const proj = String(project || '(global)');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Flow Board</title>
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
  header .src { color: var(--muted); font-size: 11px; }
  a.nav { color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; font-size: 12px; }
  a.nav:hover { color: var(--ink); border-color: var(--muted); }
  main { padding: 20px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  /* Layout toggle (Columns | Swimlanes) — mirrors the dashboard's .toggle button group. */
  header .toggle { display: flex; gap: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
  header .toggle button { background: transparent; color: var(--muted); border: 0; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  header .toggle button.active { background: #333a47; color: var(--ink); }
  /* Client-side filter box — narrows the board by substring; value is never rendered as HTML. */
  header .filter { background: var(--panel); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 5px 10px; font-size: 12px; width: 160px; }
  header .filter::placeholder { color: var(--muted); }
  header .filter:focus { outline: none; border-color: var(--muted); }
  /* Wave swimlanes (Jira-style rows) — one lane per wave, each still holding the 3 status columns. */
  main.lanes { display: block; }
  .lane { border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 16px; background: rgba(255,255,255,.01); }
  .lane-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .lane-head .lane-name { font-weight: 600; font-size: 13px; letter-spacing: .3px; }
  .lane-head .lane-count { color: var(--muted); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .lane-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 820px) { .lane-grid { grid-template-columns: 1fr; } }
  .col { background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-height: 120px; }
  .col-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .col-head .dot { width: 10px; height: 10px; border-radius: 3px; }
  .col.todo .dot { background: var(--todo); } .col.doing .dot { background: var(--doing); } .col.done .dot { background: var(--done); }
  .col-head .name { font-weight: 600; font-size: 13px; letter-spacing: .3px; }
  .col-head .count { color: var(--muted); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .card { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.25); cursor: pointer; }
  .card:hover { border-color: var(--muted); }
  .card:focus-visible { outline: 2px solid var(--doing); outline-offset: 2px; }
  .col.todo .card { border-left-color: var(--todo); } .col.doing .card { border-left-color: var(--doing); } .col.done .card { border-left-color: var(--done); }
  .card .phase { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
  .card .title { margin-top: 3px; word-break: break-word; }
  .card .foot { margin-top: 8px; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
  .prog { flex: 1; height: 5px; background: #2f3643; border-radius: 999px; overflow: hidden; }
  .prog > span { display: block; height: 100%; background: var(--done); }
  .prog-txt { font-variant-numeric: tabular-nums; }
  .status { color: var(--muted); font-size: 11px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Card-face metadata + provenance (00-02) — mirrors the dashboard's badge/tag language. */
  .card .cmeta { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; letter-spacing: .4px; background: #3a3f4c; color: #cfd6e4; }
  .badge.wave { background: #2c3a4a; color: #9cc4ff; }
  .chip { font-size: 10px; color: var(--muted); background: #2f3643; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
  .tag { background: #2f3643; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 10px; color: #b9c2d2; }
  .card .prov { margin-top: 6px; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .card .prov .pdot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); flex: none; }
  .card .prov .pdot.live { background: var(--done); }
  .card .prov .pdot.snapshot { background: var(--doing); }
  .card .prov .when { font-variant-numeric: tabular-nums; cursor: default; }
  /* Status badges (blocked / shipped) + related-sticky count row. */
  .card .cstatus { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sbadge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; letter-spacing: .3px; }
  .sbadge.blocked { background: #5a1f1f; color: #ffb3b0; }
  .sbadge.shipped { background: #2c3a2c; color: #a7d98a; }
  .sbadge.shipped.full { background: #24401f; color: #b6f09a; }
  .card .slinks { margin-top: 8px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
  .slink { font-variant-numeric: tabular-nums; }
  .sdot { color: var(--line); }
  .card .pills { margin-top: 8px; display: flex; gap: 5px; flex-wrap: wrap; }
  .pill { font-size: 10px; color: var(--muted); background: #2a303b; border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; cursor: pointer; }
  .pill:hover { color: var(--ink); border-color: var(--muted); }
  .pill:focus-visible { outline: 2px solid var(--doing); outline-offset: 1px; }
  /* Header rollup — overall done/total + progress bar, styled like the per-card .prog bar. */
  header .rollup { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
  header .rollup[hidden] { display: none; }
  header .rollup .rbar { width: 90px; height: 5px; background: #2f3643; border-radius: 999px; overflow: hidden; }
  header .rollup .rbar > span { display: block; height: 100%; background: var(--done); }
  header .rollup .rtxt { font-variant-numeric: tabular-nums; }
  .empty-col { color: var(--muted); font-size: 12px; text-align: center; padding: 22px 0; opacity: .7; }
  .banner { margin: 20px; padding: 16px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); }
  .banner code { color: var(--ink); }

  /* Detail drawer + doc rendering (00-02). */
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 20; }
  .backdrop[hidden] { display: none; }
  .drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(720px, 92vw); background: var(--panel); border-left: 1px solid var(--line); z-index: 21; display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0,0,0,.4); }
  .drawer[hidden] { display: none; }
  .drawer-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .drawer-head .dtitle { font-weight: 600; font-size: 14px; flex: 1; word-break: break-word; }
  .drawer-close { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 16px; line-height: 1; }
  .drawer-close:hover { color: var(--ink); border-color: var(--muted); }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 10px 18px; border-bottom: 1px solid var(--line); }
  .tab { background: transparent; color: var(--muted); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; cursor: pointer; font-size: 11px; letter-spacing: .3px; }
  .tab:hover { color: var(--ink); border-color: var(--muted); }
  .tab.active { background: #333a47; color: var(--ink); border-color: var(--muted); }
  .doc { padding: 16px 18px; overflow: auto; flex: 1; }
  .doc-note { color: var(--muted); padding: 12px 0; }
  /* Drawer metadata chip row — same badge/chip/tag language as the card face (cardEl). */
  .drawer-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 18px; border-bottom: 1px solid var(--line); }
  .drawer-meta[hidden] { display: none; }
  /* Readable frontmatter summary line — replaces the raw key/value table at the doc top. */
  .doc-summary { color: var(--muted); font-size: 12px; padding: 8px 11px; margin-bottom: 16px; background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 8px; line-height: 1.5; }
  .doc-body h1, .doc-body h2, .doc-body h3, .doc-body h4, .doc-body h5, .doc-body h6 { line-height: 1.3; margin: 16px 0 8px; }
  .doc-body h1 { font-size: 19px; } .doc-body h3 { font-size: 15px; } .doc-body h4, .doc-body h5, .doc-body h6 { font-size: 13px; }
  /* h2 reads as a section header — humanized GSD sections (<objective> etc.) render as h2. */
  .doc-body h2 { font-size: 17px; padding-bottom: 5px; border-bottom: 1px solid var(--line); }
  .doc-body p { margin: 8px 0; }
  .doc-body ul, .doc-body ol { margin: 8px 0; padding-left: 22px; }
  .doc-body li { margin: 3px 0; }
  .doc-body li.check { list-style: none; margin-left: -18px; }
  .doc-body .box { display: inline-block; width: 1.3em; }
  .doc-body code { background: #1d222b; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .doc-body pre { background: #1a1e26; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow: auto; }
  .doc-body pre code { background: transparent; border: 0; padding: 0; }
  .doc-body a { color: var(--todo); }
  .doc-body table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
  .doc-body th, .doc-body td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
  .doc-body hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
</style>
${themeStyle()}
${themeBoot()}
</head>
<body>
<header>
  <h1>📋 Flow Board</h1>
  <span class="proj" id="projLabel">${proj.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</span>
  <span class="src" id="src"></span>
  <span class="rollup" id="rollup" hidden>
    <span class="rbar"><span id="rollupFill"></span></span>
    <span class="rtxt" id="rollupTxt"></span>
  </span>
  <span class="spacer"></span>
  <input class="filter" id="filter" type="text" placeholder="Filter…" aria-label="Filter cards" autocomplete="off" spellcheck="false" />
  <div class="toggle" id="layoutToggle">
    <button id="tColumns" type="button" class="active">Columns</button>
    <button id="tSwimlanes" type="button">Swimlanes</button>
  </div>
  ${themeToggleButton()}
  <a class="nav" href="/command">🛰 Command</a>
  <a class="nav" href="/graph">🕸 Graph →</a>
  <a class="nav" href="/">🟡 Stickies →</a>
</header>

<main id="board"><div class="empty-col">Loading…</div></main>

<div class="backdrop" id="backdrop" hidden></div>
<aside class="drawer" id="drawer" hidden aria-label="Phase detail">
  <div class="drawer-head">
    <span class="dtitle" id="drawerTitle"></span>
    <button class="drawer-close" id="drawerClose" type="button" aria-label="Close">×</button>
  </div>
  <div class="drawer-meta" id="drawerMeta" hidden></div>
  <div class="tabs" id="tabs"></div>
  <div class="doc" id="docBody"></div>
</aside>

<script>
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent => no injection from roadmap/doc text
    return e;
  }

  // Remove all children without touching innerHTML — keeps the doc render path free of any
  // innerHTML assignment (the only innerHTML in this file is the one-time board clear below).
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Relative "last touched" time — the shared, unit-tested relativeTime() embedded verbatim,
  // the same function the stickies dashboard uses, so both surfaces phrase ages identically.
  // Accepts an ISO string or epoch ms; absolute local timestamp goes in the title attr.
  const ago = ${relativeTime.toString()};

  // Category glyphs + render order for the per-phase related-sticky count row.
  const CAT_ICONS = { blocker: '🔴', todo: '📝', decision: '🧭', preference: '⭐', context: '💬' };
  const CAT_ORDER = ['blocker', 'todo', 'decision', 'preference', 'context'];

  // Last board response — cards read board-level provenance (source, generatedAt) from here.
  let BOARD = null;

  // Page-only view state, persisted in-memory so the 5s poll never resets the chosen layout
  // or drops the active filter (no flash of unfiltered cards after a refresh).
  let LAYOUT = 'columns'; // 'columns' | 'swimlanes'
  let FILTER = '';        // lower-cased substring; '' shows everything

  const COLS = [['todo', 'To-Do'], ['doing', 'Doing'], ['done', 'Done']];

  // Case-insensitive substring match over a card's phase + title + status + requirement IDs.
  // Purely a string comparison — FILTER is never inserted into the DOM as markup (T-00-11).
  function matches(c) {
    if (!FILTER) return true;
    const reqs = c && c.metadata && Array.isArray(c.metadata.requirementIds) ? c.metadata.requirementIds : [];
    const hay = [c.phase || '', c.title || '', c.statusText || '', reqs.join(' ')].join(' ').toLowerCase();
    return hay.indexOf(FILTER) !== -1;
  }

  // Swimlane key = the phase's primary (lowest) wave; phases with no plan waves group into a
  // "No wave" lane (key null). Reads card.metadata.waves — the wave metadata already rides on
  // each card from 00-01, so grouping is client-side with no new fetch/route.
  function laneKey(c) {
    const w = c && c.metadata && Array.isArray(c.metadata.waves) ? c.metadata.waves : [];
    return w.length ? Math.min(...w) : null;
  }

  // Header rollup: overall done/total + a filled bar; hidden when the board carries no rollup.
  function renderRollup(rollup) {
    const box = document.getElementById('rollup');
    if (!rollup || !rollup.total) { box.hidden = true; return; }
    const pct = rollup.pct != null ? rollup.pct : Math.round(100 * rollup.done / rollup.total);
    document.getElementById('rollupFill').style.width = pct + '%';
    document.getElementById('rollupTxt').textContent = rollup.done + '/' + rollup.total;
    box.hidden = false;
  }

  // ---- Doc drawer -----------------------------------------------------------------------
  // Renders inert Block[]/Span[] tokens (from /api/phase-doc) into the DOM using textContent
  // for every span and setAttribute for hrefs — never innerHTML. Angle brackets in doc text
  // arrive as literal t:'text' spans (00-01), so markup in a doc renders as visible text.

  function renderSpans(spans, parent) {
    for (const s of (spans || [])) {
      if (s.t === 'link' && s.href) {
        const a = el('a', null, s.text != null ? s.text : '');
        a.setAttribute('href', s.href);       // href already scheme-checked by 00-01
        a.setAttribute('rel', 'noopener');
        parent.append(a);
      } else if (s.t === 'strong') {
        parent.append(el('strong', null, s.text));
      } else if (s.t === 'em') {
        parent.append(el('em', null, s.text));
      } else if (s.t === 'code') {
        parent.append(el('code', null, s.text));
      } else {
        parent.append(document.createTextNode(s.text != null ? s.text : ''));
      }
    }
  }

  function renderBlocks(blocks, root) {
    for (const b of (blocks || [])) {
      if (b.type === 'heading') {
        const h = el('h' + Math.min(6, Math.max(1, b.level || 1)));
        renderSpans(b.spans, h); root.append(h);
      } else if (b.type === 'para') {
        const p = el('p'); renderSpans(b.spans, p); root.append(p);
      } else if (b.type === 'list') {
        const list = el(b.ordered ? 'ol' : 'ul');
        for (const it of (b.items || [])) {
          const li = el('li');
          if (it.checked != null) {
            li.className = 'check';
            li.append(el('span', 'box', it.checked ? '☑' : '☐'));
          }
          renderSpans(it.spans, li);
          list.append(li);
        }
        root.append(list);
      } else if (b.type === 'code') {
        const pre = el('pre'); pre.append(el('code', null, b.text || '')); root.append(pre);
      } else if (b.type === 'table') {
        const t = el('table');
        if (b.headers && b.headers.length) {
          const thead = el('thead'); const tr = el('tr');
          for (const hc of b.headers) tr.append(el('th', null, hc));
          thead.append(tr); t.append(thead);
        }
        const tbody = el('tbody');
        for (const row of (b.rows || [])) {
          const tr = el('tr');
          for (const cell of row) tr.append(el('td', null, cell));
          tbody.append(tr);
        }
        t.append(tbody); root.append(t);
      } else if (b.type === 'hr') {
        root.append(el('hr'));
      }
    }
  }

  // Render the card's metadata as chips in the drawer head (reuses cardEl's badge/chip/tag
  // markup). Only chips with data are drawn; the row hides itself when there's nothing.
  function renderDrawerMeta(card) {
    const box = document.getElementById('drawerMeta');
    clear(box);
    const m = (card && card.metadata) || {};
    const waves = Array.isArray(m.waves) ? m.waves : [];
    const reqs = Array.isArray(m.requirementIds) ? m.requirementIds : [];
    if (!(waves.length || m.dependsOnCount > 0 || reqs.length)) { box.hidden = true; return; }
    if (waves.length) {
      const lo = Math.min(...waves), hi = Math.max(...waves);
      box.append(el('span', 'badge wave', 'W' + (lo === hi ? lo : lo + '–' + hi)));
    }
    if (m.dependsOnCount > 0) box.append(el('span', 'chip', '⛓ ' + m.dependsOnCount));
    for (const r of reqs) box.append(el('span', 'tag', r));
    box.hidden = false;
  }

  async function selectDoc(doc, tabs) {
    for (const t of tabs.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.path === doc.path);
    const body = document.getElementById('docBody');
    clear(body);
    body.append(el('div', 'doc-note', 'Loading…'));
    let data;
    try {
      const r = await fetch('/api/phase-doc?path=' + encodeURIComponent(doc.path), { cache: 'no-store' });
      data = await r.json();
    } catch { data = null; }
    clear(body);
    if (!data || !data.ok) { body.append(el('div', 'doc-note', 'Could not load this document.')); return; }
    // Readable one-line frontmatter summary (server-distilled) instead of a raw key/value table.
    if (data.summary) body.append(el('div', 'doc-summary', data.summary));
    const wrap = el('div', 'doc-body');
    renderBlocks(data.blocks || [], wrap);
    if (!wrap.childNodes.length) wrap.append(el('div', 'doc-note', 'This document is empty.'));
    body.append(wrap);
  }

  function openDrawer(card, targetDoc) {
    document.getElementById('drawerTitle').textContent =
      (card.phase ? card.phase + ' — ' : '') + (card.title || '');
    renderDrawerMeta(card);
    const tabs = document.getElementById('tabs');
    const body = document.getElementById('docBody');
    clear(tabs); clear(body);
    const docs = card.docs || [];
    if (!docs.length) {
      tabs.append(el('span', 'doc-note', 'No docs for this phase yet.'));
    } else {
      const want = (targetDoc && docs.find((x) => x.path === targetDoc.path)) || docs[0];
      for (const doc of docs) {
        const t = el('button', 'tab', doc.label || doc.kind);
        t.type = 'button';
        t.dataset.path = doc.path;
        if (doc === want) t.classList.add('active');
        t.onclick = () => selectDoc(doc, tabs);
        tabs.append(t);
      }
      selectDoc(want, tabs);
    }
    document.getElementById('backdrop').hidden = false;
    document.getElementById('drawer').hidden = false;
  }

  function closeDrawer() {
    document.getElementById('drawer').hidden = true;
    document.getElementById('backdrop').hidden = true;
  }

  // ---- Cards ----------------------------------------------------------------------------

  function cardEl(c) {
    const d = el('div', 'card');
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.append(el('div', 'phase', c.phase));
    d.append(el('div', 'title', c.title || ''));
    if (c.progress && c.progress.total) {
      const foot = el('div', 'foot');
      const bar = el('div', 'prog');
      const fill = el('span');
      fill.style.width = Math.round(100 * c.progress.done / c.progress.total) + '%';
      bar.append(fill);
      foot.append(bar);
      foot.append(el('span', 'prog-txt', c.progress.done + '/' + c.progress.total));
      d.append(foot);
    }
    if (c.statusText) {
      const s = el('div', 'status', c.statusText);
      s.title = c.statusText;
      d.append(s);
    }

    // Chip metadata — only rendered when the phase's plans actually declare it (no empty chips).
    const m = c.metadata || {};
    const waves = Array.isArray(m.waves) ? m.waves : [];
    const reqs = Array.isArray(m.requirementIds) ? m.requirementIds : [];
    if (waves.length || m.dependsOnCount > 0 || reqs.length) {
      const meta = el('div', 'cmeta');
      if (waves.length) {
        const lo = Math.min(...waves), hi = Math.max(...waves);
        meta.append(el('span', 'badge wave', 'W' + (lo === hi ? lo : lo + '–' + hi)));
      }
      if (m.dependsOnCount > 0) meta.append(el('span', 'chip', '⛓ ' + m.dependsOnCount));
      for (const r of reqs) meta.append(el('span', 'tag', r));
      d.append(meta);
    }

    // Status badges: blocked (unmet upstream deps) + shipped (plans with a SUMMARY). Only
    // drawn when the phase actually carries that state, so quiet phases stay uncluttered.
    const status = el('div', 'cstatus');
    let hasStatus = false;
    if (c.blocked && c.blocked.count) {
      const b = el('span', 'sbadge blocked', '⛔ blocked');
      const deps = Array.isArray(c.blocked.deps) ? c.blocked.deps : [];
      b.title = 'waiting on ' + c.blocked.count + (c.blocked.count === 1 ? ' plan' : ' plans')
        + (deps.length ? ': ' + deps.join(', ') : '');
      status.append(b); hasStatus = true;
    }
    const shipped = m.shipped;
    if (shipped && shipped.total) {
      const full = shipped.done === shipped.total && shipped.done > 0;
      const sb = el('span', 'sbadge shipped' + (full ? ' full' : ''),
        (full ? '✅ ' : '🚀 ') + 'shipped ' + shipped.done + '/' + shipped.total);
      sb.title = shipped.done + ' of ' + shipped.total + ' plans have a summary (executed)';
      status.append(sb); hasStatus = true;
    }
    if (hasStatus) d.append(status);

    // Cross-linked stickies (Task 3): a compact per-category count row (e.g. "🔴 2 · 📝 3"),
    // rendered only when this phase has related notes. Counts are just numbers — no note text
    // touches the DOM here, so nothing to escape.
    const rel = c.relatedStickies;
    if (rel && rel.total) {
      const row = el('div', 'slinks');
      row.title = rel.total + (rel.total === 1 ? ' related sticky' : ' related stickies');
      let first = true;
      for (const cat of CAT_ORDER) {
        const n = rel.counts && rel.counts[cat];
        if (!n) continue;
        if (!first) row.append(el('span', 'sdot', '·'));
        row.append(el('span', 'slink', (CAT_ICONS[cat] || '') + ' ' + n));
        first = false;
      }
      if (!first) d.append(row); // at least one category rendered
    }

    // Clickable doc pills (must_address #3): one per doc, opening the drawer straight to that
    // doc's tab. stopPropagation keeps a pill click distinct from the card-body click.
    const docs = c.docs || [];
    if (docs.length) {
      const pills = el('div', 'pills');
      for (const doc of docs) {
        const p = el('span', 'pill', doc.label || doc.kind);
        p.tabIndex = 0;
        p.setAttribute('role', 'button');
        p.onclick = (e) => { e.stopPropagation(); openDrawer(c, doc); };
        p.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openDrawer(c, doc); }
        });
        pills.append(p);
      }
      d.append(pills);
    }

    // Real provenance (must_address #2): a live/snapshot dot from the board-level source, and
    // a relative last-touched time whenever metadata.lastTouched is non-null.
    const src = BOARD && BOARD.source;
    const prov = el('div', 'prov');
    const dot = el('span', 'pdot' + (src === 'gsd' ? ' live' : src === 'snapshot' ? ' snapshot' : ''));
    dot.title = (src === 'gsd' ? 'live from GSD roadmap' : src === 'snapshot' ? 'from committed snapshot' : 'source unknown')
      + (BOARD && BOARD.generatedAt ? ' · ' + new Date(BOARD.generatedAt).toLocaleString() : '');
    prov.append(dot);
    if (m.lastTouched) {
      const when = el('span', 'when', ago(m.lastTouched));
      when.title = new Date(m.lastTouched).toLocaleString();
      prov.append(when);
    }
    d.append(prov);

    d.addEventListener('click', () => openDrawer(c));
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(c); }
    });
    return d;
  }

  function column(key, label, items) {
    const col = el('div', 'col ' + key);
    const head = el('div', 'col-head');
    head.append(el('span', 'dot'));
    head.append(el('span', 'name', label));
    head.append(el('span', 'count', String(items.length)));
    col.append(head);
    if (!items.length) col.append(el('div', 'empty-col', '—'));
    for (const c of items) col.append(cardEl(c));
    return col;
  }

  // One horizontal wave lane holding the three status columns, scoped to this lane's cards.
  function laneEl(k, cols) {
    const lane = el('div', 'lane');
    const head = el('div', 'lane-head');
    head.append(el('span', 'lane-name', k === null ? 'No wave' : 'Wave ' + k));
    let total = 0;
    const per = {};
    for (const [key] of COLS) {
      per[key] = (cols[key] || []).filter((c) => laneKey(c) === k && matches(c));
      total += per[key].length;
    }
    // With an active filter a lane can empty out entirely — drop it rather than show 3 empty cols.
    if (FILTER && total === 0) return null;
    head.append(el('span', 'lane-count', String(total)));
    lane.append(head);
    const grid = el('div', 'lane-grid');
    for (const [key, label] of COLS) grid.append(column(key, label, per[key]));
    lane.append(grid);
    return lane;
  }

  // Draw the current BOARD in the active layout. No fetch here — pure client-side render, so the
  // layout toggle (and, in Task 2, the filter) re-draw from already-fetched data.
  function render() {
    const data = BOARD;
    const board = document.getElementById('board');
    board.innerHTML = ''; // one-time container clear (the only innerHTML in this file)
    board.className = '';

    if (!data || !data.ok) {
      board.style.display = 'block';
      const b = el('div', 'banner');
      b.append(document.createTextNode('No flow board for this project yet. '));
      b.append(el('code', null, (data && data.reason) || 'Add a GSD .planning/ROADMAP.md.'));
      board.append(b);
      document.getElementById('src').textContent = '';
      renderRollup(null);
      return;
    }

    document.getElementById('src').textContent =
      data.source === 'gsd' ? 'live from GSD roadmap' : (data.source === 'snapshot' ? 'from committed snapshot' : '');
    renderRollup(data.rollup);

    const cols = data.columns || {};
    if (LAYOUT === 'swimlanes') {
      board.className = 'lanes';
      board.style.display = 'block';
      const all = [...(cols.todo || []), ...(cols.doing || []), ...(cols.done || [])];
      // Distinct lanes, waves ascending, the "No wave" (null) bucket always last.
      const keys = [...new Set(all.map(laneKey))].sort((a, b) => (a === null) - (b === null) || a - b);
      let shown = 0;
      for (const k of keys) {
        const lane = laneEl(k, cols);
        if (lane) { board.append(lane); shown++; }
      }
      if (!shown) board.append(el('div', 'empty-col', FILTER ? 'No cards match “' + FILTER + '”.' : '—'));
    } else {
      board.style.display = 'grid';
      for (const [key, label] of COLS) board.append(column(key, label, (cols[key] || []).filter(matches)));
    }
  }

  async function load() {
    let data;
    try {
      const r = await fetch('/api/board', { cache: 'no-store' });
      data = await r.json();
    } catch { return; }
    BOARD = data; // cards read board-level provenance (source, generatedAt) from here
    render();
  }

  const LAYOUTS = { columns: 'tColumns', swimlanes: 'tSwimlanes' };
  function setLayout(v) {
    LAYOUT = v;
    for (const [name, id] of Object.entries(LAYOUTS)) {
      document.getElementById(id).classList.toggle('active', name === v);
    }
    render(); // client-side re-render only — the poll keeps the choice via the LAYOUT var
  }
  document.getElementById('tColumns').onclick = () => setLayout('columns');
  document.getElementById('tSwimlanes').onclick = () => setLayout('swimlanes');

  // Live client-side filter: narrows already-fetched cards; the value persists in FILTER so the
  // 5s poll re-applies it (newly-arrived cards obey the current filter, no flash of unfiltered).
  document.getElementById('filter').addEventListener('input', (e) => {
    FILTER = e.target.value.trim().toLowerCase();
    render();
  });

  document.getElementById('drawerClose').onclick = closeDrawer;
  document.getElementById('backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  load();
  setInterval(load, 5000);
</script>
</body>
</html>`;
}
