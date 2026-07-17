// Cross-link stickies to flow-board phases. Pure and dependency-free so both consumers
// share one heuristic: board.mjs uses it for per-phase sticky counts on a phase card, and
// the /api/stickies route uses it to stamp each sticky with the phase it chips to. Testable
// with plain objects — no DB, no filesystem.
//
// ── Association heuristic (v1 — deliberately simple, matched case-insensitively) ──────────
// A sticky is "related to" a phase when either:
//   (a) one of its TAGS identifies the phase — a tag that equals the bare phase number
//       ("0"), the zero-padded number ("00"), or the phase's title slug; or a tag that
//       contains a "phase-N" / "phaseN" / "phase N" form (padded or not); or
//   (b) it has NO matching tag, but its CONTENT names the phase explicitly, matching
//       /\bphase[\s-]?0*N\b/ — the literal word "phase" is required, so a lone "0" in prose
//       can never false-match.
// Tags are consulted first; content is the fallback only when no tag matched. A sticky can
// relate to more than one phase (it counts toward each phase's tally); its single chip
// points at the first phase it matches in roadmap order.

// Category → glyph for the compact per-phase count row (e.g. "🔴 2 · 📝 3"). Order below is
// the render priority — blockers and todos lead because they're the actionable ones.
export const CATEGORY_ICONS = {
  blocker: '🔴',
  todo: '📝',
  decision: '🧭',
  preference: '⭐',
  context: '💬',
};
export const CATEGORY_ORDER = ['blocker', 'todo', 'decision', 'preference', 'context'];

// The phase's number as a canonical string ("0", "1", "12"), or null when the phase label
// carries no number. "Phase 0" -> "0", "Phase 03" -> "3".
export function phaseNumberOf(card) {
  const m = String((card && card.phase) || '').match(/(\d+)/);
  return m ? String(Number(m[1])) : null;
}

// Slugify a phase title for exact-tag matching ("Foundations & Setup" -> "foundations-setup").
function titleSlug(card) {
  return String((card && card.title) || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function stickyRelatesToPhase(sticky, card) {
  const n = phaseNumberOf(card);
  if (n == null) return false;
  const padded = n.padStart(2, '0');
  const slug = titleSlug(card);
  const phaseForms = [
    `phase-${n}`, `phase${n}`, `phase ${n}`,
    `phase-${padded}`, `phase${padded}`, `phase ${padded}`,
  ];

  const tags = Array.isArray(sticky && sticky.tags) ? sticky.tags.map((t) => String(t).toLowerCase()) : [];
  for (const tag of tags) {
    if (tag === n || tag === padded) return true;
    if (slug.length >= 3 && tag === slug) return true;
    for (const pf of phaseForms) if (tag.includes(pf)) return true;
  }

  // Fallback: an explicit "phase N" mention in the body (word "phase" required to avoid
  // a bare number matching random prose). 0* absorbs any zero-padding the author used.
  const text = String((sticky && sticky.content) || '').toLowerCase();
  return new RegExp(`\\bphase[\\s-]?0*${n}\\b`).test(text);
}

// Cross-link a set of phase cards against a set of stickies. Returns:
//   perPhase[card.id] = { counts: {category: n, ...}, total }   (only phases with matches)
//   perSticky[sticky.id] = { id, phase, title }                 (the FIRST phase it matched)
export function crossLink(cards, stickies) {
  const perPhase = {};
  const perSticky = {};
  const cardList = Array.isArray(cards) ? cards : [];
  for (const s of Array.isArray(stickies) ? stickies : []) {
    for (const card of cardList) {
      if (!stickyRelatesToPhase(s, card)) continue;
      const key = card.id;
      const bucket = perPhase[key] || (perPhase[key] = { counts: {}, total: 0 });
      bucket.counts[s.category] = (bucket.counts[s.category] || 0) + 1;
      bucket.total += 1;
      if (!(s.id in perSticky)) perSticky[s.id] = { id: card.id, phase: card.phase, title: card.title };
    }
  }
  return { perPhase, perSticky };
}
