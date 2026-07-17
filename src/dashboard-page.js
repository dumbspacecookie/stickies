// Renders the dashboard HTML. Self-contained (no external assets). Sticky content is
// inserted via textContent in the client script, never innerHTML, so note bodies can't
// inject markup into the dashboard.

import { relativeTime } from './flow/relative-time.mjs';

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
  .phase-chip { background: #2c3a4a; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: #9cc4ff; text-decoration: none; }
  .phase-chip:hover { border-color: var(--todo); color: #cfe4ff; }
  .glob { color: var(--context); }
  .card .meta .spacer { flex: 1; }
  .dismiss { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 11px; }
  .dismiss:hover { border-color: var(--blocker); color: var(--blocker); }
  .empty { color: var(--muted); grid-column: 1 / -1; text-align: center; padding: 60px 0; }
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
  <a class="nav" href="/board">📋 Flow Board →</a>
</header>

<form id="add">
  <input type="text" id="content" placeholder="New sticky… (max 500 chars)" maxlength="500" />
  <select id="category" title="category">${catOptions}</select>
  <select id="importance" title="importance">${impOptions}</select>
  <input type="text" id="tags" placeholder="tags (comma sep)" style="max-width:160px" />
  <label><input type="checkbox" id="global" /> global</label>
  <button type="submit">Add</button>
</form>

<main id="grid"><div class="empty">Loading…</div></main>

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

  function card(s) {
    const c = el('div', 'card ' + s.category);
    const top = el('div', 'top');
    top.append(el('span', 'badge ' + s.importance.toLowerCase(), s.importance));
    const catIco = CAT_ICONS[s.category] ? CAT_ICONS[s.category] + ' ' : '';
    top.append(el('span', 'cat', catIco + s.category));
    c.append(top);
    c.append(el('div', 'body', s.content));
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

  async function load() {
    // Session and folder views both need every project's notes; "this project" doesn't.
    const scopeAll = view !== 'project';
    const r = await fetch('/api/stickies?all=' + (scopeAll ? '1' : '0'), { cache: 'no-store' });
    const data = await r.json();
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    grid.className = scopeAll ? 'grouped' : '';
    if (!data.stickies.length) { grid.append(el('div', 'empty', 'No active stickies.')); return; }

    if (view === 'project') {
      data.stickies.sort(byImportance);
      for (const s of data.stickies) grid.append(card(s));
      return;
    }

    if (view === 'session') {
      const groups = groupBy(data.stickies, (s) => s.session_id);
      // Most-recent session first (by newest note); unattributed sinks to the bottom.
      const newest = (items) => items.reduce((m, s) => s.created_at > m ? s.created_at : m, '');
      const keys = [...groups.keys()].sort((a, b) => {
        if (a === '') return 1;
        if (b === '') return -1;
        return newest(groups.get(b)).localeCompare(newest(groups.get(a)));
      });
      for (const k of keys) {
        const items = groups.get(k).sort(byImportance);
        grid.append(lane(sessionHead(k, items), items));
      }
      return;
    }

    // view === 'all': group by folder.
    const groups = groupBy(data.stickies, (s) => s.project_path);
    // Globals last: they're the ambient ones, not the project you came here to look at.
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === '') return 1;
      if (b === '') return -1;
      return projectName(a).localeCompare(projectName(b));
    });
    for (const k of keys) grid.append(lane(projectHead(k), groups.get(k).sort(byImportance)));
  }

  async function dismiss(id) {
    await fetch('/api/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', 'x-stickies-token': TOKEN }, body: JSON.stringify({ id, reason: 'dashboard' }) });
    load();
  }

  document.getElementById('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('content').value.trim();
    if (!content) return;
    const tags = document.getElementById('tags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stickies-token': TOKEN },
      body: JSON.stringify({
        content,
        category: document.getElementById('category').value,
        importance: document.getElementById('importance').value,
        tags,
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

  load();
  setInterval(load, 5000);
</script>
</body>
</html>`;
}
