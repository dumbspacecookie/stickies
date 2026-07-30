// Who is allowed to READ from the dashboard.
//
// Mutations have always needed the in-page token. Reads did not: `/api/stickies`, `/api/board`,
// `/api/projects`, `/api/command` and every page served themselves to anything that could reach
// the port. That was defensible while the dashboard only ran when you started one by hand. It is
// not defensible now: SessionStart brings one up automatically, it serves EVERY project this
// machine has registered rather than one folder, and it stays up for the life of the machine. The
// exposure window went from "the minutes I had it open" to "always", and the contents went from
// "this project" to "all of them".
//
// The guard is a shared secret in a file only the user can read, exchanged once for a cookie:
//
//   1. The dashboard keeps a 32-byte key in $STICKIES_HOME/dashboard-auth.key, mode 0600.
//   2. Anything that can read that file can build an authorized link (`?k=<key>`) — that is the
//      statusline, the CLI, and `stickies doctor`. Being able to read it IS being the user.
//   3. On a request carrying a valid `?k=`, the server sets an HttpOnly, SameSite=Strict cookie
//      and redirects to the same URL without the key, so the secret leaves the address bar.
//   4. Everything afterwards rides the cookie.
//
// What this buys, stated honestly. It stops another local ACCOUNT reading your notes (the key is
// 0600). It stops a web page you happen to visit reading them: SameSite=Strict means a
// cross-site navigation to 127.0.0.1 carries no cookie, and a fetch() from another origin has no
// key, so this closes the drive-by class even where the Host guard would not. It does NOT stop
// malware running AS YOU — that can read the key file, the cookie jar, or the sqlite store
// directly, and no local-only scheme can change that.
//
// The key is persisted rather than regenerated per launch so a cookie survives the dashboard
// restarting, which it does on every reboot now that SessionStart starts it.

import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Cookies are scoped by HOST, not by origin — the port is not part of their identity. Two
// dashboards on 127.0.0.1 (a second one on another port, which the CLI supports and the test
// fixtures use) would therefore share one cookie under a fixed name: redeeming a link for one
// silently logs you out of the other, forever alternating. Naming the cookie after the port
// gives each instance its own.
export function cookieName(port) {
  return `stickies_auth_${Number(port) || 0}`;
}
export const KEY_PARAM = 'k';
export const KEY_HEADER = 'x-stickies-key';

export function authKeyPath() {
  return join(process.env.STICKIES_HOME || join(homedir(), '.stickies'), 'dashboard-auth.key');
}

// An escape hatch, not a default. Someone running this in a container they own, or behind their
// own proxy, may genuinely want reads open; they should have to say so out loud.
export function authEnabled() {
  return process.env.STICKIES_DASHBOARD_AUTH !== '0';
}

export function readAuthKey() {
  try {
    const k = readFileSync(authKeyPath(), 'utf8').trim();
    return k.length >= 32 ? k : null;
  } catch {
    return null;
  }
}

// Write a fresh key so that it appears COMPLETE or not at all: created under a random temp name
// with 'wx' at mode 0600, then renamed over the target. Two things need that.
//
// 'wx' rather than 'w' because 'w' follows a symlink at the final component, which would let
// anything able to plant that path have the dashboard write a secret into a file of its choosing.
//
// The rename because the file is read by OTHER processes (the statusline, on every prompt
// render) and by another dashboard starting at the same instant. Writing in place gives them a
// window in which they can read a half-written key, and a half-written key is indistinguishable
// from a wrong one — an authorized link that mysteriously does not work.
function writeNewKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, randomBytes(32).toString('hex')); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

// A synchronous pause, for the one place that has to wait for another process's rename.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The key for this machine: the existing one, or a new one.
//
// Always returns what is ON DISK, never what this process happened to generate. That distinction
// is the whole correctness argument when two dashboards start together: both may write, the last
// rename wins, and both then agree with the file — and so does the statusline, which builds links
// from it. Returning our own generated value would give one dashboard a key that matches nothing.
//
// An existing file that is NOT usable (truncated, empty, corrupted by a crash mid-write) is
// REPLACED rather than deferred to. Deferring is what the first version did, via a bare 'wx' that
// failed with EEXIST and returned null — and a null key fails closed, so the dashboard came up
// and answered 401 to every request forever, left the bad file in place, and explained nothing.
// The cost of replacing is that browsers holding the old cookie need a fresh link; the cost of
// not replacing is a dashboard that can never be opened again by anyone.
export function ensureAuthKey() {
  const existing = readAuthKey();
  if (existing) return existing;
  try { writeNewKey(authKeyPath()); } catch { /* another process may have won the race */ }
  for (let i = 0; i < 5; i++) {
    const k = readAuthKey();
    if (k) return k;
    sleepSync(20);
  }
  return null; // caller must treat this as fatal; a silent 401-everything is not an option
}

// Constant-time, and compared as BYTES. JS string length is not byte length, and timingSafeEqual
// throws RangeError on unequal buffers — inside a request handler that is an unhandled rejection,
// which is exactly how one header once killed this server.
export function keyMatches(offered, expected) {
  if (typeof offered !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

// Time-boxed link tokens, for the places a URL is written somewhere that persists.
//
// The statusline emits an OSC 8 hyperlink on every prompt render. Putting the long-lived key in
// it meant writing a credential that never expires into terminal scrollback, hundreds of times a
// day — invisible, because it lives inside the escape sequence, and therefore never noticed. Any
// transcript, screen recording, or `script` log of that terminal carries it. Same for the URL
// `--link` prints, which goes straight into the same scrollback.
//
// A token derived from the key and the current five-minute bucket fixes that without a round
// trip: the statusline can compute it from the key file alone, and the server can check it with
// no shared state. The window you are looking at always works; the one in yesterday's scrollback
// does not. Current and previous bucket are both accepted, so a link is good for five to ten
// minutes rather than dying mid-click on a bucket boundary.
//
// The key itself is no longer accepted in a URL at all. Keeping it would have left the footgun in
// place for anyone with an old link, and there is nothing a URL needs it for.
const LINK_WINDOW_MS = 5 * 60 * 1000;

function bucketToken(key, bucket) {
  return createHmac('sha256', key).update(`stickies-link:${bucket}`).digest('hex').slice(0, 32);
}

export function linkToken(key = readAuthKey(), at = Date.now()) {
  if (!key) return null;
  return bucketToken(key, Math.floor(at / LINK_WINDOW_MS));
}

export function verifyLinkToken(offered, key = readAuthKey(), at = Date.now()) {
  if (!key || typeof offered !== 'string' || !offered) return false;
  const now = Math.floor(at / LINK_WINDOW_MS);
  for (const bucket of [now, now - 1]) {
    if (keyMatches(offered, bucketToken(key, bucket))) return true;
  }
  return false;
}

// One-shot links, for the places where a URL is unavoidably exposed.
//
// `--open` hands a URL to the OS browser opener, which means it appears in a process command
// line: readable by any other account via ps or Task Manager, and captured wholesale by ordinary
// command-line audit logging (Windows 4688, auditd, EndpointSecurity). Putting the long-lived key
// there gives away, to exactly the observer the 0600 file is meant to exclude, a credential that
// does not expire. A ticket is minted by this process, dies sixty seconds later, and works once —
// so what leaks into the command line is spent by the time anyone reads the log.
//
// In-memory on purpose: the process that mints is the process that checks, so there is no file to
// protect and nothing to synchronise. It follows that a ticket is useless after a restart, which
// is correct — it was for one browser launch.
const tickets = new Map(); // ticket -> expiry (epoch ms)

export function mintTicket(ttlMs = 60_000) {
  const now = Date.now();
  for (const [t, exp] of tickets) if (exp <= now) tickets.delete(t); // keep it from growing
  const ticket = randomBytes(16).toString('hex');
  tickets.set(ticket, now + ttlMs);
  return ticket;
}

export function redeemTicket(value) {
  if (typeof value !== 'string' || !value) return false;
  const exp = tickets.get(value);
  if (exp === undefined) return false;
  tickets.delete(value); // consumed whether or not it was still valid: one use means one use
  return Date.now() <= exp;
}

export function _ticketCount() {
  return tickets.size;
}

// How a request may prove it is the user, in the order they are cheapest to check:
//   'cookie' — already redeemed in this browser
//   'header' — a script or the CLI sending the key directly (X-Stickies-Key)
//   'query'  — a fresh authorized link, which the caller should now redeem for a cookie
//   null     — not authorized
export function authKind(req, url, key, port) {
  if (!authEnabled()) return 'disabled';
  if (!key) return null; // no key on disk means nothing can match; fail closed
  if (keyMatches(parseCookies(req.headers.cookie).get(cookieName(port)), key)) return 'cookie';
  if (keyMatches(req.headers[KEY_HEADER], key)) return 'header';
  // NOT the raw key: it is deliberately not accepted in a URL, so that nothing which records
  // URLs — scrollback, history, a Referer, a process command line — ever holds a credential that
  // outlives the minute it was made.
  const offered = url ? url.searchParams.get(KEY_PARAM) : null;
  if (verifyLinkToken(offered, key)) return 'query';
  // Consuming, and deliberately last: a one-shot ticket is spent by looking at it. authKind is
  // called once per request, from the handler.
  if (redeemTicket(offered)) return 'query';
  return null;
}

// The cookie is Strict on purpose: it is what stops a page on another origin navigating you to
// the dashboard and reading the result. Session-scoped (no Max-Age) so closing the browser ends
// it; the link can always mint another.
export function cookieHeader(key, port) {
  return `${cookieName(port)}=${key}; Path=/; HttpOnly; SameSite=Strict`;
}

// The link to hand a human. Built by anything that can read the key file — the statusline, the
// CLI, the server itself. Carries a time-boxed token by default; `credential` overrides it with a
// one-shot ticket for the `--open` path, where the URL becomes a process command line.
export function authorizedUrl(port, path = '/', credential = linkToken()) {
  const base = `http://127.0.0.1:${port}${path}`;
  if (!credential || !authEnabled()) return base;
  return base + (path.includes('?') ? '&' : '?') + `${KEY_PARAM}=${encodeURIComponent(credential)}`;
}
