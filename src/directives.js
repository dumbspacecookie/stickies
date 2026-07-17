// Parses inline sticky directives out of assistant message text.
//
// The model may capture a durable fact by writing a single line of the form:
//
//   !!sticky <category> [P1|P2|P3] [global] [#tag ...] :: <content>
//
// Examples:
//   !!sticky decision P1 #storage #arch :: Phase 1 storage is node:sqlite, no native deps
//   !!sticky todo :: wire the dashboard to the dismiss endpoint
//   !!sticky blocker P2 #ci :: integration tests blocked on staging creds
//   !!sticky todo P1 global :: cut the npm release  (applies across every project)
//
// category is required; importance defaults to P2; `global` and tags are optional and may
// appear in any order. Content is the rest of the line after `::`. The post-turn Stop hook
// reads these and persists them, so capture is guaranteed by code rather than relying on a
// tool round-trip.

const CATEGORY = '(decision|blocker|preference|context|todo)';
// One modifier blob (importance / `global` / #tags / due:<when> in any order), parsed out
// below — an ordered grammar would silently ignore `global P1` while accepting `P1 global`.
// Importance may arrive bracketed (`[P2]`) because the model often copies the
// `[P1|P2|P3]` notation from the convention doc literally — tolerate it.
const MODIFIER = String.raw`(?:\[?P[123]\]?|global|due:[\w:-]+|#[\w./-]+)`;
const DIRECTIVE = new RegExp(
  String.raw`^\s*!!sticky\s+${CATEGORY}` + //   category
    String.raw`((?:\s+${MODIFIER})*)` + //      optional modifiers, any order
    String.raw`\s*::\s*(.+?)\s*$`, //           :: content
  'i'
);

// Returns an array of { category, importance, tags, global, content } parsed from `text`.
// Lines that don't match are ignored. Invalid/empty content is skipped.
export function parseDirectives(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(DIRECTIVE);
    if (!m) continue;

    const category = m[1].toLowerCase();
    const modifiers = (m[2] || '').split(/\s+/).filter(Boolean);

    const importance = (modifiers.find((t) => /^\[?P[123]\]?$/i.test(t)) || 'P2').replace(/[[\]]/g, '').toUpperCase();
    const global = modifiers.some((t) => /^global$/i.test(t));
    const tags = modifiers.filter((t) => t.startsWith('#')).map((t) => t.slice(1).trim()).filter(Boolean);
    // Raw due token (e.g. "1h", "2026-07-20"); resolved to an instant at capture time by
    // the store, so the offset is measured from when the note is actually written.
    const dueTok = modifiers.find((t) => /^due:/i.test(t));
    const due = dueTok ? dueTok.slice(4) : null;

    const content = m[3].trim();
    if (!content) continue;

    out.push({ category, importance, tags, global, content, due });
  }

  return out;
}
