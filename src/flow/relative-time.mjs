// Relative "time ago" formatting, shared by the stickies dashboard and the flow board so
// both surfaces phrase ages identically. Pure and self-contained (Date/Math only), which
// lets it be unit-tested AND embedded verbatim into a page's inline script via
// relativeTime.toString() — one source of truth, no hand-mirrored copies that can drift.
//
// Accepts an ISO 8601 string OR an epoch-millisecond number. Anything unparseable, empty,
// or nullish returns '' so a caller can simply skip rendering when there's no timestamp.
export function relativeTime(input) {
  if (input == null || input === '') return '';
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(t)) return '';
  const ms = Date.now() - t;
  if (ms < 60000) return 'just now'; // covers small clock skew (future timestamps) too
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(ms / 3600000);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(ms / 86400000);
  if (d < 30) return d + 'd ago';
  return new Date(t).toLocaleDateString();
}
