// Renders the dashboard HTML. Self-contained (no external assets). Sticky content is
// inserted via textContent in the client script, never innerHTML, so note bodies can't
// inject markup into the dashboard.

import { relativeTime } from './flow/relative-time.mjs';
import { themeStyle, themeBoot, themeToggleButton } from './flow/theme.mjs';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderPage({ token, project, categories, importances }) {
  const catOptions = categories.map((c) => `<option value="${c}">${c}</option>`).join('');
  const impOptions = importances.map((i) => `<option value="${i}"${i === 'P2' ? ' selected' : ''}>${i}</option>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stickies</title>
<style>
  :root {
    --bg: #1d2027; --panel: #262a33; --ink: #e7e9ee; --muted: #9aa3b2; --line: #353b47;
    --decision: #f6c453; --blocker: #ef6f6c; --preference: #8bd450; --context: #6cb6ff; --todo: #c89bf0;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
  header .proj { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header .spacer { flex: 1; }
  .toggle { display: flex; gap: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
  .toggle button { background: transparent; color: var(--muted); border: 0; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .toggle button.active { background: #333a47; color: var(--ink); }
  a.nav { color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font-size: 12px; }
  a.nav:hover { color: var(--ink); border-color: var(--muted); }
  main { padding: 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; align-items: start; }
  /* "All projects" groups into one lane per project — a flat wall of every project's notes
     at once is unreadable, which defeats the point of looking at the board. */
  main.grouped { display: block; }
  .lane { margin-bottom: 26px; }
  .lane-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .lane-head .name { font-weight: 600; font-size: 13px; }
  .lane-head .path { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lane-head .count { color: var(--muted); font-size: 11px; margin-left: auto; }
  .lane .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; align-items: start; }
  .card { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .card.decision { border-left-color: var(--decision); }
  .card.blocker { border-left-color: var(--blocker); }
  .card.preference { border-left-color: var(--preference); }
  .card.context { border-left-color: var(--context); }
  .card.todo { border-left-color: var(--todo); }
  .card .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; letter-spacing: .4px; }
  .badge.p1 { background: #5a1f1f; color: #ffb3b0; }
  .badge.p2 { background: #3a3f4c; color: #cfd6e4; }
  .badge.p3 { background: #2c3340; color: #8d97a8; }
  .cat { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
  .card .body { white-space: pre-wrap; word-break: break-word; }
  .card .meta { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
  .tag { background: #2f3643; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: #b9c2d2; }
  /* Due chip: colour encodes urgency so a deadline reads at a glance without doing math. */
  .due { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .due.later { color: #b9c2d2; background: #2f3643; }
  .due.soon { color: #f6c453; background: #3a3320; border-color: #5a4a1f; }
  .due.overdue { color: #ffb3b0; background: #5a1f1f; border-color: #7a2b2b; font-weight: 700; }
  .phase-chip { background: #2c3a4a; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: #9cc4ff; text-decoration: none; }
  .phase-chip:hover { border-color: var(--todo); color: #cfe4ff; }
  .glob { color: var(--context); }
  .card .meta .spacer { flex: 1; }
  .dismiss { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 11px; }
  .dismiss:hover { border-color: var(--blocker); color: var(--blocker); }
  .empty { color: var(--muted); grid-column: 1 / -1; text-align: center; padding: 60px 0; }
  /* Selection: a checked card gets a ring so the picked set stays legible across lanes. */
  .card.sel { border-color: var(--context); box-shadow: 0 0 0 1px var(--context), 0 1px 3px rgba(0,0,0,.25); }
  /* Deep-link target: a note reached via #note-<id> pulses a bright ring + glow, briefly lifts,
     then settles — unmistakable even when the note was already on screen. Uses --doing (defined
     in both light + dark token sets) so it reads on either theme. */
  @keyframes stickyFlash {
    0%   { box-shadow: 0 0 0 3px var(--doing), 0 0 0 0 var(--doing); transform: scale(1); }
    12%  { box-shadow: 0 0 0 3px var(--doing), 0 0 22px 5px var(--doing); transform: scale(1.03); }
    100% { box-shadow: 0 0 0 0 transparent, 0 0 0 0 transparent; transform: scale(1); }
  }
  .card.flash { animation: stickyFlash 2.2s ease-out; position: relative; z-index: 2; }
  /* Search box in the header + the [[wikilink]] cross-reference inside a note body. */
  header .filter { background: var(--panel); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 6px 10px; font-size: 12px; width: 170px; }
  header .filter::placeholder { color: var(--muted); }
  header .filter:focus { outline: none; border-color: var(--muted); }
  .card .body a.wikilink { color: var(--todo); text-decoration: none; border-bottom: 1px dotted var(--todo); cursor: pointer; }
  .card .body a.wikilink:hover { border-bottom-style: solid; }
  .card .top input.pick { accent-color: var(--context); width: 14px; height: 14px; margin: 0; cursor: pointer; flex: none; }
  .lane-head .pickall { font-size: 11px; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .lane-head .pickall:hover { color: var(--ink); border-color: var(--muted); }
  /* Floating action bar — only exists while something is selected. */
  .selbar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px; display: none; gap: 12px; align-items: center;
            background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px;
            box-shadow: 0 6px 24px rgba(0,0,0,.5); z-index: 20; }
  .selbar.on { display: flex; }
  .selbar .n { font-size: 13px; font-weight: 600; }
  .selbar .paused { font-size: 11px; color: var(--muted); }
  .selbar button { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .selbar button:hover { color: var(--ink); border-color: var(--muted); }
  .selbar button.danger { background: #5a1f1f; color: #ffb3b0; border-color: #7a2b2b; }
  .selbar button.danger:hover { background: #6d2626; color: #fff; }
  .selbar button[disabled] { opacity: .5; cursor: default; }
  form#add { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--bg); align-items: center; }
  form#add input[type=text] { flex: 1; min-width: 240px; }
  form#add input, form#add select { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; font-size: 13px; }
  form#add label { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 5px; }
  form#add button { background: #3a4a6b; color: #fff; border: 0; border-radius: 7px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
  .ttl { font-variant-numeric: tabular-nums; }
  .orig { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .when { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; cursor: default; }
  .lane-head .orig { margin-left: 4px; }
</style>
${themeStyle()}
${themeBoot()}
</head>
<body>
<header>
  <h1>🟡 Stickies</h1>
  <span class="proj" id="projLabel">${escapeHtml(project || '(global)')}</span>
  <span class="spacer"></span>
  <div class="toggle">
    <button id="tProject" class="active">This project</button>
    <button id="tAll">All projects</button>
    <button id="tSession">By session</button>
  </div>
  <input class="filter" id="search" type="text" placeholder="Search notes…" aria-label="Search notes by text or tag" autocomplete="off" spellcheck="false" />
  ${themeToggleButton()}
  <a class="nav" href="/command">🛰 Command</a>
  <a class="nav" href="/board">📋 Flow Board →</a>
</header>

<form id="add">
  <input type="text" id="content" placeholder="New sticky… (max 500 chars)" maxlength="500" />
  <select id="category" title="category">${catOptions}</select>
  <select id="importance" title="importance">${impOptions}</select>
  <input type="text" id="tags" placeholder="tags (comma sep)" style="max-width:160px" />
  <input type="text" id="due" placeholder="due (1h · 2d · 2026-07-20)" title="Optional deadline: 30m, 2h, 3d, 1w, tomorrow, or a date" style="max-width:190px" />
  <label><input type="checkbox" id="global" /> global</label>
  <button type="submit">Add</button>
</form>

<main id="grid"><div class="empty">Loading…</div></main>

<div class="selbar" id="selbar">
  <span class="n" id="selCount">0 selected</span>
  <span class="paused" title="Auto-refresh is paused so the list can't shift under your selection.">⏸ refresh paused</span>
  <button id="selAll">Select all visible</button>
  <button id="selClear">Clear</button>
  <button class="danger" id="selDismiss">Dismiss selected</button>
</div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  // view: 'project' (this folder) | 'all' (grouped by folder) | 'session' (grouped by session)
  let view = 'project';

  function ttl(expires) {
    if (!expires) return '';
    const ms = new Date(expires).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return days + 'd left';
    const hrs = Math.floor(ms / 3600000);
    return hrs + 'h left';
  }

  // Due date -> { cls, label } for the chip, or null. Mirrors dueStatus() in due.js:
  // overdue (past), soon (<=24h), later. Label is a compact human delta.
  function dueChip(dueIso) {
    if (!dueIso) return null;
    const t = new Date(dueIso).getTime();
    if (!isFinite(t)) return null;
    const ms = t - Date.now();
    const abs = Math.abs(ms);
    const mins = Math.round(abs / 60000), hrs = Math.round(abs / 3600000), days = Math.round(abs / 86400000);
    const mag = days >= 1 ? days + 'd' : hrs >= 1 ? hrs + 'h' : Math.max(1, mins) + 'm';
    if (ms < 0) return { cls: 'overdue', label: 'overdue ' + mag };
    const cls = ms <= 86400000 ? 'soon' : 'later';
    return { cls, label: 'due ' + mag };
  }

  // Relative "born" time — the shared, unit-tested relativeTime() embedded verbatim so the
  // browser and the tests format ages identically. Accepts an ISO string or epoch ms; the
  // absolute local timestamp goes in the title attr for hover.
  const ago = ${relativeTime.toString()};

  const ORIGIN_LABELS = {
    terminal: '💻 terminal', desktop: '🖥️ desktop', mobile: '📱 mobile',
    dashboard: '🟡 dashboard', unknown: '',
  };
  function originLabel(o) { return ORIGIN_LABELS[o] || ''; }

  // Compact glyph per category, so the top row reads as an icon + label badge.
  const CAT_ICONS = {
    blocker: '🔴', todo: '📝', decision: '🧭', preference: '⭐', context: '💬',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent => no XSS from note bodies
    return e;
  }

  // Ids picked for bulk action. Keyed by id (not DOM node) so a selection survives the
  // re-render that load() does, and so it spans lanes: in "All projects" you can pick notes
  // from several folders plus globals and clear them in one request.
  const selected = new Set();
  let rendered = []; // ids currently on screen — what "select all visible" means
  let ALLNOTES = []; // the full fetched set, for [[wikilink]] resolution
  let query = '';    // active search text (filters what's shown, persists across the poll)
  let pollTimer = null; // handle for the 5s refresh, so a deep-link flash can defer it
  // (Re)start the 5s auto-refresh. Called at boot and after a deep-link flash, so the flash
  // animation always gets its full run before the next re-render.
  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (selected.size === 0) load(); }, 5000);
  }

  function card(s) {
    const c = el('div', 'card ' + s.category);
    c.dataset.id = s.id; // lets paintSelection() re-sync boxes without a re-render
    c.id = 'note-' + s.id; // stable anchor for #note-<id> deep-links (statusline / Discord)
    const top = el('div', 'top');
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.title = 'Select for bulk dismiss';
    pick.checked = selected.has(s.id);
    pick.onchange = () => {
      if (pick.checked) selected.add(s.id); else selected.delete(s.id);
      c.classList.toggle('sel', pick.checked);
      syncSelBar();
    };
    top.append(pick);
    if (pick.checked) c.classList.add('sel');
    top.append(el('span', 'badge ' + s.importance.toLowerCase(), s.importance));
    const catIco = CAT_ICONS[s.category] ? CAT_ICONS[s.category] + ' ' : '';
    top.append(el('span', 'cat', catIco + s.category));
    c.append(top);
    const body = el('div', 'body');
    renderBody(body, s.content);
    c.append(body);
    const meta = el('div', 'meta');
    for (const t of (s.tags || [])) meta.append(el('span', 'tag', t));
    if (!s.project_path) meta.append(el('span', 'glob', '🌐 global'));
    // Cross-link: when the store associated this note with a flow-board phase, a clickable
    // chip to /board. Label is set via textContent (el); the href is the static board route.
    if (s.phase) {
      const a = el('a', 'phase-chip', '📋 ' + (s.phase.phase || 'phase'));
      a.setAttribute('href', '/board');
      a.title = s.phase.title ? (s.phase.phase + ' — ' + s.phase.title) : (s.phase.phase || '');
      meta.append(a);
    }
    const dc = dueChip(s.due_at);
    if (dc) {
      const chip = el('span', 'due ' + dc.cls, '⏰ ' + dc.label);
      chip.title = 'Due ' + new Date(s.due_at).toLocaleString();
      meta.append(chip);
    }
    const ol = originLabel(s.origin);
    if (ol) meta.append(el('span', 'orig', ol));
    if (s.created_at) {
      const when = el('span', 'when', ago(s.created_at));
      when.title = new Date(s.created_at).toLocaleString(); // exact time on hover
      meta.append(when);
    }
    meta.append(el('span', 'spacer'));
    meta.append(el('span', 'ttl', ttl(s.expires_at)));
    const btn = el('button', 'dismiss', 'dismiss');
    btn.onclick = () => dismiss(s.id);
    meta.append(btn);
    c.append(meta);
    return c;
  }

  // Last path segment — the folder name is what you recognise, not the absolute path.
  // Split on both separators without writing a backslash: this whole page is emitted from a
  // template literal, so an escaped backslash collapses on the way out and would corrupt a
  // regex literal here.
  const BACKSLASH = String.fromCharCode(92);
  function projectName(p) {
    if (!p) return '🌐 global';
    const parts = String(p).split('/').flatMap((s) => s.split(BACKSLASH)).filter(Boolean);
    return parts[parts.length - 1] || p;
  }

  const ORDER = { P1: 0, P2: 1, P3: 2 };
  const byImportance = (a, b) => ORDER[a.importance] - ORDER[b.importance];

  // A grouping lane. headParts is a pre-built array of header spans so project- and
  // session-grouping can label their lanes differently while sharing the card grid.
  function lane(headParts, items) {
    const l = el('section', 'lane');
    const head = el('div', 'lane-head');
    for (const p of headParts) head.append(p);
    head.append(el('span', 'count', items.length + (items.length === 1 ? ' note' : ' notes')));
    // Per-lane pick: clearing one folder's notes is the common case, and hunting for its
    // checkboxes among every other lane's is the tedious part.
    const all = el('button', 'pickall', 'select all');
    all.onclick = () => {
      const ids = items.map((s) => s.id);
      const everySelected = ids.every((id) => selected.has(id));
      for (const id of ids) { if (everySelected) selected.delete(id); else selected.add(id); }
      paintSelection();
      syncSelBar();
    };
    head.append(all);
    l.append(head);
    const cards = el('div', 'cards');
    for (const s of items) cards.append(card(s));
    l.append(cards);
    return l;
  }

  function projectHead(key) {
    const parts = [el('span', 'name', projectName(key))];
    if (key) parts.push(el('span', 'path', key));
    return parts;
  }

  // Short, human session tag — the head of the uuid is enough to tell two sessions apart.
  function sessionLabel(id) { return id ? 'session ' + String(id).slice(0, 8) : '⚑ unattributed'; }
  function sessionHead(key, items) {
    const parts = [el('span', 'name', sessionLabel(key))];
    // Show the surface the session ran on (the newest note's origin — one session = one surface).
    const ol = originLabel(items[0] && items[0].origin);
    if (ol) parts.push(el('span', 'orig', ol));
    // Which folder this session touched, so a bare session id still has context.
    const proj = items.find((s) => s.project_path);
    if (proj) parts.push(el('span', 'path', projectName(proj.project_path)));
    return parts;
  }

  function groupBy(items, keyFn) {
    const groups = new Map();
    for (const s of items) {
      const k = keyFn(s) || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    return groups;
  }

  // A note matches the search when the text appears in its body, a tag, or its category.
  function matchesQuery(s) {
    const q = query.toLowerCase();
    if ((s.content || '').toLowerCase().includes(q)) return true;
    if ((s.category || '').toLowerCase().includes(q)) return true;
    return (s.tags || []).some((t) => String(t).toLowerCase().includes(q));
  }

  async function load() {
    // Session and folder views both need every project's notes; "this project" doesn't.
    const scopeAll = view !== 'project';
    const r = await fetch('/api/stickies?all=' + (scopeAll ? '1' : '0'), { cache: 'no-store' });
    const data = await r.json();
    ALLNOTES = data.stickies; // resolve [[wikilinks]] against the full fetched set
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    grid.className = scopeAll ? 'grouped' : '';

    // Search narrows what's shown. Selection reconciliation still runs against the FULL fetched
    // set (drop ids dismissed here / by the CLI / by another surface) so filtering a note out of
    // view never silently deselects it; "select all visible" acts on the filtered set.
    const shown = query ? data.stickies.filter(matchesQuery) : data.stickies;
    const live = new Set(data.stickies.map((s) => s.id));
    for (const id of [...selected]) if (!live.has(id)) selected.delete(id);
    rendered = shown.map((s) => s.id);
    syncSelBar();

    if (!shown.length) {
      grid.append(el('div', 'empty', query ? 'No notes match your search.' : 'No active stickies.'));
      return;
    }

    if (view === 'project') {
      for (const s of shown.slice().sort(byImportance)) grid.append(card(s));
    } else if (view === 'session') {
      const groups = groupBy(shown, (s) => s.session_id);
      // Most-recent session first (by newest note); unattributed sinks to the bottom.
      const newest = (items) => items.reduce((m, s) => s.created_at > m ? s.created_at : m, '');
      const keys = [...groups.keys()].sort((a, b) => {
        if (a === '') return 1;
        if (b === '') return -1;
        return newest(groups.get(b)).localeCompare(newest(groups.get(a)));
      });
      for (const k of keys) grid.append(lane(sessionHead(k, groups.get(k)), groups.get(k).slice().sort(byImportance)));
    } else {
      // group by folder; globals last (ambient, not the project you came to look at).
      const groups = groupBy(shown, (s) => s.project_path);
      const keys = [...groups.keys()].sort((a, b) => {
        if (a === '') return 1;
        if (b === '') return -1;
        return projectName(a).localeCompare(projectName(b));
      });
      for (const k of keys) grid.append(lane(projectHead(k), groups.get(k).slice().sort(byImportance)));
    }
    focusFromHash(); // runs for EVERY view now (was previously only reached in the folder view)
  }

  // Deep-link: a URL like /#note-<id> (or the older /#<id>) scrolls to that note and pulses
  // it. Runs after every render but flashes at most ONCE per distinct hash, so the 5s poll,
  // a dismiss, or an add don't re-scroll or re-flash. Changing the hash re-arms it.
  let focusedHash = null;
  function focusFromHash() {
    const hash = location.hash;
    if (!hash || hash === focusedHash) return;
    const id = decodeURIComponent(hash.replace(/^#/, '')).replace(/^note-/, '');
    if (!id) return;
    // Note ids are UUIDs (no chars that need escaping); CSS.escape is belt-and-suspenders.
    // Deliberately no regex with a backslash here — this page is a template literal, and a
    // backslash inside a regex literal collapses on emission and ships a dead script.
    const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const c = document.querySelector('[data-id="' + sel + '"]');
    if (!c) return; // not on screen (wrong view / already dismissed) — leave it re-armable
    focusedHash = hash;
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.classList.remove('flash');
    void c.offsetWidth; // restart the animation if the same card is re-targeted
    c.classList.add('flash');
    schedulePoll(); // push the next 5s refresh out so it can't re-render mid-flash
  }
  window.addEventListener('hashchange', () => { focusedHash = null; focusFromHash(); });

  // [[wikilink]]: a [[token]] in a note body becomes a link to another note — resolved by id
  // prefix first, else by a content substring — that deep-links (#note-<id>) to it. Built with
  // text nodes + createElement only (never innerHTML), and scanned with indexOf (no regex, so
  // no backslash that would collapse in this template-literal page).
  function resolveNote(token) {
    const t = token.toLowerCase();
    if (!t) return null;
    const byId = ALLNOTES.find((s) => s.id.toLowerCase().indexOf(t) === 0);
    if (byId) return byId.id;
    const byText = ALLNOTES.find((s) => (s.content || '').toLowerCase().indexOf(t) !== -1);
    return byText ? byText.id : null;
  }
  function renderBody(container, text) {
    const body = String(text == null ? '' : text);
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('[[', i);
      if (open === -1) { container.append(document.createTextNode(body.slice(i))); break; }
      if (open > i) container.append(document.createTextNode(body.slice(i, open)));
      const close = body.indexOf(']]', open + 2);
      if (close === -1) { container.append(document.createTextNode(body.slice(open))); break; }
      const token = body.slice(open + 2, close).trim();
      const target = token ? resolveNote(token) : null;
      if (target) {
        const a = document.createElement('a');
        a.className = 'wikilink';
        a.setAttribute('href', '#note-' + target);
        a.textContent = token;
        a.title = 'Jump to note ' + target.slice(0, 8);
        container.append(a);
      } else {
        container.append(document.createTextNode('[[' + token + ']]'));
      }
      i = close + 2;
    }
  }

  async function dismiss(id) {
    await fetch('/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': TOKEN }, body: JSON.stringify({ id, reason: 'dashboard' }) });
    load();
  }

  // Re-check the boxes / rings from the selected set without a server round-trip.
  // (No backticks in this script block: the whole page is a template literal.)
  function paintSelection() {
    for (const c of document.querySelectorAll('.card')) {
      const on = selected.has(c.dataset.id);
      c.classList.toggle('sel', on);
      const box = c.querySelector('input.pick');
      if (box) box.checked = on;
    }
  }

  function syncSelBar() {
    const n = selected.size;
    document.getElementById('selbar').classList.toggle('on', n > 0);
    document.getElementById('selCount').textContent = n + ' selected';
    document.getElementById('selDismiss').textContent = 'Dismiss ' + n + ' selected';
  }

  // One request for the whole batch → one git sync, not one per note.
  async function dismissSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm('Dismiss ' + ids.length + (ids.length === 1 ? ' sticky?' : ' stickies?'))) return;
    const btn = document.getElementById('selDismiss');
    btn.disabled = true;
    btn.textContent = 'Dismissing…';
    try {
      const r = await fetch('/api/dismiss-bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stickies-token': TOKEN },
        body: JSON.stringify({ ids, reason: 'dashboard bulk' }),
      });
      const out = await r.json();
      if (!r.ok || out.error) { alert(out.error || 'bulk dismiss failed'); return; }
      selected.clear();
      if (out.failed && out.failed.length) {
        alert('Dismissed ' + out.dismissed + '. ' + out.failed.length + ' could not be dismissed.');
      }
    } catch (err) {
      alert('bulk dismiss failed: ' + err.message);
    } finally {
      btn.disabled = false;
      syncSelBar();
      load();
    }
  }

  document.getElementById('selDismiss').onclick = dismissSelected;
  document.getElementById('selClear').onclick = () => { selected.clear(); paintSelection(); syncSelBar(); };
  document.getElementById('selAll').onclick = () => {
    const everySelected = rendered.length > 0 && rendered.every((id) => selected.has(id));
    for (const id of rendered) { if (everySelected) selected.delete(id); else selected.add(id); }
    paintSelection();
    syncSelBar();
  };

  document.getElementById('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('content').value.trim();
    if (!content) return;
    const tags = document.getElementById('tags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const due = document.getElementById('due').value.trim();
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stickies-token': TOKEN },
      body: JSON.stringify({
        content,
        category: document.getElementById('category').value,
        importance: document.getElementById('importance').value,
        tags,
        due: due || null,
        global: document.getElementById('global').checked,
      }),
    });
    const out = await res.json();
    if (!out.ok) { alert(out.error || 'failed'); return; }
    e.target.reset();
    load();
  });

  const TOGGLES = { project: 'tProject', all: 'tAll', session: 'tSession' };
  function setView(v) {
    view = v;
    for (const [name, id] of Object.entries(TOGGLES)) {
      document.getElementById(id).classList.toggle('active', name === v);
    }
    load();
  }
  document.getElementById('tProject').onclick = () => setView('project');
  document.getElementById('tAll').onclick = () => setView('all');
  document.getElementById('tSession').onclick = () => setView('session');

  // Live search: narrows the visible notes; the value persists in the query state so the 5s
  // poll keeps the filter applied (no flash of the full list after a refresh).
  document.getElementById('search').addEventListener('input', (e) => { query = e.target.value.trim(); load(); });

  load();
  // The 5s poll would yank cards out from under a half-made selection, so it idles while
  // anything is picked. The bar says so ("⏸ refresh paused"); clearing resumes it.
  schedulePoll();
</script>
</body>
</html>`;
}
