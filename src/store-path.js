// Project-path normalization, factored out so both the store and the project-key
// deriver can use it without a circular import.
//
// Normalizes so a sticky written for a project is matched on read regardless of slash
// direction, trailing slash, or drive-letter casing (Windows). Returns null for global.
// Characters that must never reach a stored project path, because a project path is later
// rendered into the dashboard's HTML and into a <script> block, and the MCP tool takes
// project_path from whatever the calling agent says — so a prompt-injected agent could
// otherwise register `C:/x</script><img src=x onerror=...>` and have every dashboard page
// serve it.
//
// The list is deliberately narrow: angle brackets, control characters, and the two JS line
// separators. NOT quotes or backticks — `/home/dev/john's-app` is a perfectly ordinary POSIX
// directory, and rejecting it would break every note that user writes. Quotes are handled where
// they matter, by HTML-escaping at render time.
const UNSAFE_IN_PATH = /[<>\u0000-\u001f\u007f\u2028\u2029]/;

export function isUnsafeProjectPath(p) {
  return p !== null && p !== undefined && UNSAFE_IN_PATH.test(String(p));
}

export function normalizeProjectPath(p) {
  if (p === null || p === undefined || p === '') return null;
  let out = String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  out = out.replace(/^([a-z]):\//, (_, d) => `${d.toUpperCase()}:/`);
  if (UNSAFE_IN_PATH.test(out)) return null;
  return out === '' ? null : out;
}
