// Project-path normalization, factored out so both the store and the project-key
// deriver can use it without a circular import.
//
// Normalizes so a sticky written for a project is matched on read regardless of slash
// direction, trailing slash, or drive-letter casing (Windows). Returns null for global.
export function normalizeProjectPath(p) {
  if (p === null || p === undefined || p === '') return null;
  let out = String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  out = out.replace(/^([a-z]):\//, (_, d) => `${d.toUpperCase()}:/`);
  return out === '' ? null : out;
}
