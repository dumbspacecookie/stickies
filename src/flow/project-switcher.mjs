// Shared project switcher for the local dashboard pages (/, /board, /graph).
//
// One dashboard serves every project (see src/project-scope.js), so two things have to be true
// on EVERY page, not just the board: it must say which project you're looking at, and it must
// carry that project onto every request and nav link it emits. A page that forgets turns its
// links into a silent trip back to whichever folder launched the server — the original bug.
//
// Injection contract (per page): switcherStyle() + switcherBoot(project) in <head>, and
// switcherButton(project) in the header. The boot script defines window.withProj() before any
// page script runs, rewrites `a.nav` hrefs once the DOM is up, and wires the popover.
//
// Pages must NOT declare their own top-level `const PROJ` / `withProj`: separate classic
// <script> blocks share one global lexical scope, so a second declaration is a SyntaxError
// that kills the whole page script.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Colours come from the theme tokens (see theme.mjs) so this works in light and dark without
// a second rule set. No hardcoded greys.
export function switcherStyle() {
  return `<style>
  /* The label must answer "which project am I about to edit?" — writeback rewrites a real
     ROADMAP.md, so mistaking the project is the expensive error. Paths differ at their END, so
     the basename is shown whole and only the parent is allowed to clip. */
  header .proj { color: var(--ink); font-size: 13px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                 background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; max-width: 52ch;
                 white-space: nowrap; cursor: pointer; text-align: left; display: inline-flex; align-items: baseline; gap: 0;
                 min-width: 12ch; overflow: hidden; }
  /* direction: rtl puts the ellipsis at the START, so the parent loses its least useful end.
     unicode-bidi must NOT be 'plaintext' here - that derives direction from the first strong
     character (the C of C:/...), which silently cancels the rtl and clips the wrong end again.
     'isolate' keeps the clip at the left AND stops a mixed-script segment being reordered. */
  /* flex: 0 1 auto — the parent GIVES UP space. It must not be 1-1-auto, which makes it grab
     space and squeeze the basename instead, i.e. exactly the failure this split exists to fix. */
  header .proj .parent { color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis;
                         direction: rtl; unicode-bidi: isolate; min-width: 0; flex: 0 1 auto; }
  /* The basename never shrinks. If it alone is wider than the button, the button's own overflow
     clips it — a last resort, and still better than clipping it before the parent has gone. */
  header .proj .base { flex: 0 0 auto; }
  header .proj:hover { border-color: var(--muted); }
  header .proj:focus-visible { outline: 2px solid var(--todo); outline-offset: 2px; }
  header .proj .caret { color: var(--muted); font-weight: 400; margin-left: 6px; }
  /* fixed, not absolute: the header is position:sticky and this menu is appended to <body>, so
     an absolute top was measured from the top of the DOCUMENT — scroll down a long board and the
     menu opened above the viewport, leaving the button looking dead. */
  .projmenu { position: fixed; top: 52px; left: 20px; z-index: 20; background: var(--panel); border: 1px solid var(--line);
              border-radius: 10px; padding: 6px; min-width: 320px; max-width: 70ch; max-height: 60vh; overflow: auto;
              box-shadow: 0 10px 30px rgba(0,0,0,.35); }
  .projmenu .head { color: var(--muted); font-size: 11px; padding: 4px 10px 6px; font-family: ui-sans-serif, system-ui, sans-serif; }
  .projmenu .row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; cursor: pointer;
                   font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink);
                   white-space: nowrap; width: 100%; border: 0; background: transparent; text-align: left; }
  /* Parent clips from the left, basename never clips — see the header rules above. */
  .projmenu .row .ppar { color: var(--muted); overflow: hidden; text-overflow: ellipsis;
                         direction: rtl; unicode-bidi: isolate; min-width: 0; flex: 0 1 auto; }
  .projmenu .row .pbase { flex: 0 0 auto; }
  .projmenu .row:hover { background: var(--line); }
  .projmenu .row:focus-visible { outline: 2px solid var(--todo); outline-offset: -2px; }
  /* "you are here" was colour-only, and that amber fails contrast on a light background. The
     ✓ carries the meaning; the tint is decoration — and it must not be the same tint as :hover,
     or hovering any row makes two rows look current. */
  .projmenu .row.here { background: var(--bg); font-weight: 600; box-shadow: inset 2px 0 0 var(--doing); }
  .projmenu .row .tick { width: 1.2em; flex: 0 0 auto; color: var(--doing); }
  .projmenu .row .tag { color: var(--muted); font-size: 11px; font-family: ui-sans-serif, system-ui, sans-serif; margin-left: auto; padding-left: 10px; }
  </style>`;
}

// Split a path into the part that may be clipped and the part that must never be: two projects
// under a deep shared prefix are told apart only by their last segment, and an ellipsis that
// eats the end renders them identically.
function splitPath(p) {
  // Strip trailing separators first: 'C:/x/proj/' would otherwise yield an EMPTY basename, and
  // the basename is the one part that must never vanish. normalizeProjectPath already does this
  // upstream, but this is an exported helper and should not depend on a caller's guarantee.
  const s = String(p).replace(/[/\\]+$/, '');
  const cut = s.lastIndexOf('/');
  return cut <= 0 ? { parent: '', base: s } : { parent: s.slice(0, cut + 1), base: s.slice(cut + 1) };
}

export function switcherButton(project) {
  const proj = String(project || '(global)');
  const { parent, base } = splitPath(proj);
  // The full path lives in title=, because even an un-clipped label is worth confirming before
  // you drag a card that edits a file. It used to read "Switch project", which told you nothing
  // about which project you were on.
  return `<button class="proj" id="projLabel" type="button" title="${esc(proj)}" aria-label="Project: ${esc(proj)}. Switch project" aria-haspopup="true" aria-expanded="false">` +
    (parent ? `<span class="parent">${esc(parent)}</span>` : '') +
    `<span class="base">${esc(base)}</span><span class="caret">▾</span></button>`;
}

// JSON destined for a <script> body. JSON.stringify does NOT escape `/`, so a value
// containing `</script>` closes the element and everything after it is parsed as markup —
// and the mutation token is a lexical binding in that same document. The line separators are
// escaped too: both are literal newlines to a JS parser but not to JSON.
function jsonInScript(value) {
  return JSON.stringify(String(value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function switcherBoot(project) {
  return `<script>(function(){
    var CURRENT = ${jsonInScript(project || '')};
    var PROJ = new URLSearchParams(location.search).get('project') || '';
    // Defined before any page script runs, because those call it at parse time.
    window.withProj = function(path){
      if(!PROJ) return path;
      return path + (path.indexOf('?') === -1 ? '?' : '&') + 'project=' + encodeURIComponent(PROJ);
    };
    function el(tag, cls, text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
    function wire(){
      var navs = document.querySelectorAll('a.nav');
      for (var i=0;i<navs.length;i++) navs[i].href = window.withProj(navs[i].getAttribute('href'));
      var btn = document.getElementById('projLabel');
      if(!btn) return;
      var menu = null;
      function close(){ if(menu){ menu.remove(); menu=null; } btn.setAttribute('aria-expanded','false'); }
      function open(){
        fetch('/api/projects',{cache:'no-store'}).then(function(r){return r.json();}).then(function(data){
          close();
          menu = el('div','projmenu');
          menu.append(el('div','head','Projects on this machine'));
          var list = data.projects || [];
          for (var j=0;j<list.length;j++){
            var p = list[j];
            var here = p.project_path === CURRENT;
            // A <button>, not a <div>: that alone restores keyboard reachability, which the
            // switcher had none of — no tabIndex, no role, no arrow keys.
            var row = el('button','row' + (here ? ' here' : ''));
            row.type = 'button';
            row.title = p.project_path;
            row.append(el('span','tick', here ? '✓' : ''));
            // Same split as the header button. The MENU is where you choose, so this is the
            // surface where two projects under one long prefix must not read identically —
            // picking the wrong one is how a card gets dragged into the wrong ROADMAP.md.
            var cut = p.project_path.lastIndexOf('/');
            if (cut > 0) {
              row.append(el('span','ppar', p.project_path.slice(0, cut + 1)));
              row.append(el('span','pbase', p.project_path.slice(cut + 1)));
            } else {
              row.append(el('span','pbase', p.project_path)); // textContent — never markup
            }
            var tags = [];
            if(here) tags.push('current');
            if(!p.hasBoard) tags.push('no board');
            if(p.current) tags.push('server started here');
            if(tags.length) row.append(el('span','tag',tags.join(' · ')));
            row.onclick = (function(path){ return function(){ location.search = '?project=' + encodeURIComponent(path); }; })(p.project_path);
            menu.append(row);
          }
          // Anchor to where the button actually is on screen, not to a fixed offset.
          var r = btn.getBoundingClientRect();
          menu.style.top = Math.round(r.bottom + 6) + 'px';
          menu.style.left = Math.round(r.left) + 'px';
          document.body.append(menu);
          btn.setAttribute('aria-expanded','true');
          // Land on the CURRENT project, not row 1: with fifteen projects the one you are on
          // could be row fifteen, and arrowing there is not a feature.
          var start = menu.querySelector('.row.here') || menu.querySelector('.row');
          if (start) start.focus();
        }).catch(function(){
          // A dead button with no explanation is worse than an error. The list is the only way
          // to change project, so say that it could not be loaded.
          close();
          menu = el('div','projmenu');
          menu.append(el('div','head','Projects on this machine'));
          menu.append(el('div','row','Could not load the project list — is the dashboard still running?'));
          var r = btn.getBoundingClientRect();
          menu.style.top = Math.round(r.bottom + 6) + 'px';
          menu.style.left = Math.round(r.left) + 'px';
          document.body.append(menu);
          btn.setAttribute('aria-expanded','true');
        });
      }
      btn.addEventListener('click', function(e){ e.stopPropagation(); if(menu) close(); else open(); });
      document.addEventListener('click', function(e){ if(menu && !menu.contains(e.target)) close(); });
      document.addEventListener('keydown', function(e){
        if(e.key === 'Escape' && menu){ close(); btn.focus(); return; } // focus goes back where it came from
        if(!menu || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
        var rows = [].slice.call(menu.querySelectorAll('.row'));
        if(!rows.length) return;
        e.preventDefault();
        var at = rows.indexOf(document.activeElement);
        var next = e.key === 'ArrowDown' ? at + 1 : at - 1;
        if(next < 0) next = rows.length - 1;
        if(next >= rows.length) next = 0;
        rows[next].focus();
      });
    }
    if(document.readyState !== 'loading') wire(); else document.addEventListener('DOMContentLoaded', wire);
  })();</script>`;
}
