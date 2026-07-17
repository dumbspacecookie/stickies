// Shared light/dark theming for the local dashboard pages (/, /board, /graph).
//
// The pages are authored DARK: their `:root` and a few component rules hardcode dark
// colours. Rather than rewrite them, this appends LIGHT overrides that apply when the
// viewer prefers light (`prefers-color-scheme`) OR forces it with the header toggle
// (`data-theme="light"`). Forcing `data-theme="dark"` re-asserts the dark tokens so a
// light-OS user can still pin dark. Nothing here mutates a dark rule, so dark is untouched.
//
// Injection contract (per page): put themeStyle() + themeBoot() in <head>, drop
// themeToggleButton() in the header. The boot script sets data-theme from localStorage
// synchronously (before paint, no flash) and wires the toggle on load.

const LIGHT_TOKENS = `
  --bg:#f5f6f8; --panel:#ffffff; --ink:#1a1d24; --muted:#59626f; --line:#dfe3ea;
  --todo:#2d7fd1; --doing:#b9800a; --done:#489a2e;
  --decision:#b9800a; --blocker:#d64a46; --preference:#489a2e; --context:#2d7fd1; --stodo:#8a5cc0;
`;
const DARK_TOKENS = `
  --bg:#1d2027; --panel:#262a33; --ink:#e7e9ee; --muted:#9aa3b2; --line:#353b47;
  --todo:#6cb6ff; --doing:#f6c453; --done:#8bd450;
  --decision:#f6c453; --blocker:#ef6f6c; --preference:#8bd450; --context:#6cb6ff; --stodo:#c89bf0;
`;

// Light restyles for the hardcoded pills/badges. `p` prefixes the selectors so the same
// rule text serves both the media-query block ('') and the forced-attribute block
// (':root[data-theme="light"] ', higher specificity). Non-existent selectors on a given
// page are harmless — each page only has some of these classes.
function componentRules(p) {
  return `
    ${p}.toggle button.active, ${p}.tab.active { background:#e7eaf0; color:var(--ink); }
    ${p}.badge { background:#e7eaf0; color:#3a4250; }
    ${p}.badge.p1 { background:#fbe3e2; color:#a5322a; }
    ${p}.badge.p2 { background:#e7eaf0; color:#3a4250; }
    ${p}.badge.p3 { background:#eef0f4; color:#6b7480; }
    ${p}.badge.wave { background:#e2ecfa; color:#2f6bb0; }
    ${p}.tag, ${p}.chip { background:#eef0f4; color:#48515e; }
    ${p}.phase-chip { background:#e2ecfa; color:#2f6bb0; }
    ${p}.pill { background:#eef0f4; color:#48515e; }
    ${p}.prog, ${p}.rbar { background:#e7eaf0; }
    ${p}form#add button { background:#356fb0; color:#fff; }
    ${p}.sbadge.blocked { background:#fbe3e2; color:#a5322a; }
    ${p}.sbadge.shipped { background:#e3f2e0; color:#3f8a3a; }
    ${p}.sbadge.shipped.full { background:#d5edcf; color:#347a2b; }
    ${p}.due.later { background:#eef0f4; color:#48515e; }
    ${p}.due.soon { background:#fbf1d6; color:#8a6910; border-color:#e6d18f; }
    ${p}.due.overdue { background:#fbe3e2; color:#a5322a; border-color:#e9b3af; }
    ${p}.doc-body code { background:#f0f2f6; }
    ${p}.doc-body pre { background:#f4f6f9; }
    ${p}.card { box-shadow:0 1px 3px rgba(20,30,50,.08); }
  `;
}

export function themeStyle() {
  return `<style>
  @media (prefers-color-scheme: light) {
    :root { ${LIGHT_TOKENS} }
    ${componentRules('')}
  }
  :root[data-theme="light"] { ${LIGHT_TOKENS} }
  ${componentRules(':root[data-theme="light"] ')}
  :root[data-theme="dark"] { ${DARK_TOKENS} }
  body { transition: background .35s ease, color .35s ease; }
  .theme-toggle {
    background: var(--panel); color: var(--muted); border: 1px solid var(--line);
    border-radius: 8px; width: 30px; height: 30px; cursor: pointer; font-size: 14px;
    display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  }
  .theme-toggle:hover { color: var(--ink); border-color: var(--muted); }
  .theme-toggle:focus-visible { outline: 2px solid var(--todo); outline-offset: 2px; }
  </style>`;
}

export function themeToggleButton() {
  return `<button class="theme-toggle" id="themeToggle" title="Toggle light / dark" aria-label="Toggle light and dark theme">☾</button>`;
}

// Runs in <head>: applies a saved override before paint (no flash), wires the toggle on load.
export function themeBoot() {
  return `<script>(function(){
    var KEY='stickies-theme';
    function eff(){var a=document.documentElement.getAttribute('data-theme');if(a==='light'||a==='dark')return a;return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}
    try{var s=localStorage.getItem(KEY);if(s==='light'||s==='dark')document.documentElement.setAttribute('data-theme',s);}catch(e){}
    function paint(){var b=document.getElementById('themeToggle');if(b)b.textContent=eff()==='dark'?'☾':'☀';}
    function wire(){var b=document.getElementById('themeToggle');if(b)b.addEventListener('click',function(){var n=eff()==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem(KEY,n);}catch(e){}paint();});paint();}
    if(document.readyState!=='loading')wire();else document.addEventListener('DOMContentLoaded',wire);
  })();</script>`;
}
