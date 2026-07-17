// Resolve a human-written due token into an absolute ISO 8601 instant.
//
// A directive can carry an optional deadline:  !!sticky todo P1 due:1h :: cut the release
// The token is deliberately small and deterministic — no locale weekday parsing, no NLP —
// so the same string always resolves the same way and is trivial to reason about:
//
//   relative offset : 30m, 2h, 3d, 1w   -> now + N units
//   'tomorrow'      : now + 24h
//   date            : 2026-07-20         -> end of that day, LOCAL time (by 23:59:59)
//   datetime        : 2026-07-20T14:30   -> that exact local instant
//
// Anything else returns null: the sticky is still captured, just without a due date. We
// never throw — a malformed due token must not lose the note it was attached to.
//
// `nowMs` is injected so callers resolve against the capture time and tests are hermetic.

const UNIT_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function resolveDueDate(token, nowMs = Date.now()) {
  if (token == null) return null;
  const t = String(token).trim().toLowerCase();
  if (!t) return null;

  if (t === 'tomorrow') return new Date(nowMs + UNIT_MS.d).toISOString();
  if (t === 'today' || t === 'tonight') return endOfLocalDay(new Date(nowMs));

  // relative offset: <int><unit>
  const rel = t.match(/^(\d{1,5})([mhdw])$/);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(nowMs + n * UNIT_MS[rel[2]]).toISOString();
  }

  // absolute date or datetime (interpreted in LOCAL time, like a person means it)
  const date = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (isNaN(d)) return null;
    return endOfLocalDay(d);
  }
  const dt = t.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/);
  if (dt) {
    const d = new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]));
    return isNaN(d) ? null : d.toISOString();
  }

  return null;
}

// 23:59:59 on the given date's LOCAL day — "due 2026-07-20" means by end of the 20th.
function endOfLocalDay(d) {
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0);
  return isNaN(e) ? null : e.toISOString();
}

// Bucket a due date relative to now, for rendering. Returns one of:
//   'overdue'  — past
//   'soon'     — within soonMs (default 24h)
//   'later'    — beyond the window
//   null       — no due date
export function dueStatus(dueIso, nowMs = Date.now(), soonMs = 24 * 60 * 60 * 1000) {
  if (!dueIso) return null;
  const t = new Date(dueIso).getTime();
  if (!Number.isFinite(t)) return null;
  if (t < nowMs) return 'overdue';
  if (t - nowMs <= soonMs) return 'soon';
  return 'later';
}
