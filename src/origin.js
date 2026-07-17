// Provenance: which surface a sticky was born on. Answers "where did I write this?"
// on the dashboard — terminal vs desktop vs phone. Each entry point stamps the origin
// it knows (the Stop hook knows it's the CLI, repo-mode knows it's the cloud/phone path);
// the MCP server can't be told directly, so it guesses from the environment.

// Canonical set. Keep aligned with the badges in dashboard-page.js.
export const ORIGINS = ['terminal', 'desktop', 'mobile', 'dashboard', 'unknown'];

export const ORIGIN_LABELS = {
  terminal: '💻 terminal',
  desktop: '🖥️ desktop',
  mobile: '📱 mobile',
  dashboard: '🟡 dashboard',
  unknown: '',
};

// Coerce any value to a known origin; unknown/garbage collapses to 'unknown' so a bad
// stamp can never wedge a write (createSticky validates against ORIGINS).
export function normalizeOrigin(o) {
  return ORIGINS.includes(o) ? o : 'unknown';
}

// Best-effort guess for entry points that aren't told their surface (the MCP server is
// launched by whatever host connects — Claude Code CLI or Claude Desktop). Claude Code
// exports CLAUDECODE=1 into the tool environment; its absence on a local MCP stdio server
// points at the desktop app. Honest fallback is 'desktop', not a false 'terminal'.
export function detectOrigin(env = process.env) {
  if (env.STICKIES_ORIGIN && ORIGINS.includes(env.STICKIES_ORIGIN)) return env.STICKIES_ORIGIN;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'terminal';
  return 'desktop';
}
