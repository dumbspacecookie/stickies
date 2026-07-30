// Which project the dashboard is allowed to serve.
//
// The dashboard used to be pinned for its whole life to the cwd it was launched from. With a
// fixed machine-wide port that meant the FIRST terminal to start one owned the URL: a second
// terminal in another folder would Ctrl+click its own statusline and silently land on the
// first project's board — reading someone else's plans while believing they were its own.
//
// The project is now chosen per request (?project=...), which means a request string reaches
// buildBoard() / readPhaseDoc() / the sticky store. So it MUST be constrained: an arbitrary
// path would turn a loopback GET into a filesystem probe of any directory on the machine.
// The allowlist is the launch project ∪ projects with stored stickies ∪ projects a recent
// Claude session registered. The raw request value is never used as a path.
//
// "With stored stickies" means ANY note, including dismissed ones — see registeredProjects().
// Counting only active notes made the allowlist a function of how tidy your board is: dismiss
// the last note in a project and its board stops being reachable.

import { normalizeProjectPath } from './store-path.js';
import { registeredProjects } from './store.js';
import { sessionProjects } from './session-marker.js';

// The allowlist is rebuilt from sqlite + the sessions dir, and every scoped route needs it,
// so a page load with a dozen fetches would otherwise re-walk both each time. A short TTL
// keeps it effectively free while still picking up a brand-new project within seconds.
const CACHE_TTL_MS = 2000;
let cache = { at: 0, set: null };

// Every UNKNOWN project forced the `fresh` rebuild below — a sqlite aggregate plus a walk of the
// sessions dir — measured at ~21x the cost of an accepted request. That path needs no token and
// no preflight, so any page the user happens to visit can drive it in a loop and peg this
// single-threaded server.
//
// The throttle is GLOBAL rather than per-path on purpose: remembering individual rejections is
// no defence at all, because the caller simply varies the path (`/nope/1`, `/nope/2`, …) and
// every request is a fresh miss. Capping how often ANY miss may trigger a rebuild bounds the
// total cost no matter what is asked for. The window is short enough that a project registered
// a moment ago still resolves on the user's next click.
const FRESH_MIN_INTERVAL_MS = 250;
let lastFreshAt = 0;

function mayRebuild() {
  const now = Date.now();
  if (now - lastFreshAt < FRESH_MIN_INTERVAL_MS) return false;
  lastFreshAt = now;
  return true;
}

export function knownProjects(launchProject, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.set && now - cache.at < CACHE_TTL_MS) {
    // The launch project is always permitted, even if the cached set predates it.
    const cached = new Set(cache.set);
    const lp = normalizeProjectPath(launchProject);
    if (lp) cached.add(lp);
    return cached;
  }

  const set = new Set();
  const add = (p) => {
    const n = normalizeProjectPath(p);
    if (n) set.add(n);
  };
  add(launchProject);
  // Either source failing must not collapse the allowlist to nothing — a broken store should
  // cost you the project switcher, not your own board.
  try { for (const p of registeredProjects()) add(p); } catch { /* store unavailable */ }
  try { for (const p of sessionProjects()) add(p); } catch { /* no session markers */ }

  cache = { at: now, set: new Set(set) };
  return set;
}

// Resolve the project for one request.
//
// No ?project= => the launch project, i.e. exactly the old behaviour. A value that is not
// allowlisted is REJECTED rather than quietly replaced by the launch project: serving a
// different folder than the one that was asked for is the bug this whole module exists to
// end, and doing it on the rejection path would just move the lie.
export function resolveProject(requested, launchProject) {
  const launch = normalizeProjectPath(launchProject);
  if (requested === null || requested === undefined || requested === '') {
    return { ok: true, project: launch };
  }
  // A value that normalizes to nothing ("/", "   ", "\\", or one carrying characters a path may
  // not contain) is still a value the caller ASKED for. Serving the launch project under it would
  // be the same substitution this module refuses two lines below — the lie moved, not removed.
  const want = normalizeProjectPath(requested);
  if (!want) return { ok: false, project: null, requested: String(requested) };
  if (knownProjects(launchProject).has(want)) return { ok: true, project: want };
  // A genuinely new project may have registered since the last cache fill — pay for one fresh
  // rebuild before rejecting, so a just-opened terminal isn't told "unknown". Throttled: if
  // another miss just did this, answer from what we already know rather than rebuilding again.
  if (mayRebuild() && knownProjects(launchProject, { fresh: true }).has(want)) {
    return { ok: true, project: want };
  }
  return { ok: false, project: null, requested: want };
}

export function _clearCache() {
  cache = { at: 0, set: null };
  lastFreshAt = 0;
}
