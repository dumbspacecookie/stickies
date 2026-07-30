// The read gate.
//
// Until now the dashboard's read routes served anything that could reach the port. That was
// defensible while you started one by hand; it is not now that SessionStart starts one
// automatically, it serves every project this machine has registered, and it stays up for the
// life of the machine. These tests pin what the gate must do — and, just as importantly, what it
// must NOT break: the statusline link has to keep landing on a working page, or the whole
// feature reverts to "the link looks broken because it is".

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { freePort, scratchDir, cleanup, killAndWait } from './_env.mjs';

const ROOT = scratchDir('auth');
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
mkdirSync(join(PROJ, '.planning'), { recursive: true });
mkdirSync(HOME, { recursive: true });
writeFileSync(join(PROJ, '.planning', 'ROADMAP.md'), '### Phase 1: A\n**Status:** Planned\n');

const NO_SYNC = { STICKIES_AUTO_SYNC: '', STICKIES_SYNC_REPO: '', STICKIES_SYNC_FILE: '', STICKIES_DISCORD_WEBHOOK: '' };
const env = { ...process.env, STICKIES_DB: join(ROOT, 'a.db'), STICKIES_HOME: HOME, ...NO_SYNC };
Object.assign(process.env, { STICKIES_DB: join(ROOT, 'a.db'), STICKIES_HOME: HOME, ...NO_SYNC });
delete process.env.STICKIES_DASHBOARD_AUTH;

let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

const { createSticky } = await import('../src/store.js');
createSticky({ content: 'a private note', category: 'context', importance: 'P1', project_path: PROJ });

const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dashboard.js',
  '--port', String(PORT), '--project', PROJ], { env });
srv.stderr.on('data', (d) => process.stdout.write('  srv: ' + d));

try {
  for (let i = 0; i < 80; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // --- the key file itself -------------------------------------------------------------------
  const keyFile = join(HOME, 'dashboard-auth.key');
  check(existsSync(keyFile), 'the dashboard writes a key file under STICKIES_HOME');
  const KEY = readFileSync(keyFile, 'utf8').trim();
  check(/^[0-9a-f]{64}$/.test(KEY), `the key is 32 random bytes (${KEY.length} hex chars)`);
  if (process.platform !== 'win32') {
    // The whole scheme rests on "only the user can read this file". POSIX can express that;
    // Windows ACLs inherit from the profile directory, which is already user-scoped.
    check((statSync(keyFile).mode & 0o077) === 0, 'and is not readable by anyone else (0600)');
  } else {
    console.log('  SKIP  file-mode check is POSIX-only (Windows inherits the profile ACL)');
  }

  // --- health stays open, and must not leak the read key -------------------------------------
  // autostart, --stop and doctor all probe liveness before any cookie can exist.
  const health = await (await fetch(base + '/api/health')).json();
  check(health.app === 'stickies', '/api/health answers without any credential');
  check(!JSON.stringify(health).includes(KEY), 'and does NOT carry the read key');
  // It publishes NO secret at all now: --stop presents the ownership nonce rather than asking the
  // server to prove it knows one, so an unauthenticated route has nothing worth scraping.
  check(health.nonce === undefined, 'and carries no ownership nonce either — it publishes no secret');
  check(Object.keys(health).sort().join(',') === 'app,ok,pid,port,project',
    `health stays a fixed, boring shape (${Object.keys(health).sort().join(',')})`);

  // --- everything else is closed -------------------------------------------------------------
  for (const path of ['/', '/board', '/graph', '/command', '/api/stickies', '/api/projects', '/api/board', '/api/command']) {
    const r = await fetch(base + path, { redirect: 'manual' });
    check(r.status === 401, `${path} is refused without a credential (got ${r.status})`);
  }
  const body = await (await fetch(base + '/api/stickies')).text();
  check(!body.includes('a private note'), 'and the refusal does not include the data it refused');
  check(/--link/.test(await (await fetch(base + '/', { headers: { accept: 'text/html' } })).text()),
    'the refusal tells you how to get in');

  // --- the key header works (how a script or the CLI authenticates) --------------------------
  const withHeader = await fetch(base + '/api/stickies', { headers: { 'x-stickies-key': KEY } });
  check(withHeader.status === 200, `the key header is accepted (got ${withHeader.status})`);
  check(JSON.stringify(await withHeader.json()).includes('a private note'), 'and serves the real data');
  const wrongHeader = await fetch(base + '/api/stickies', { headers: { 'x-stickies-key': 'f'.repeat(64) } });
  check(wrongHeader.status === 401, 'a wrong key of the right length is refused');
  // A multi-byte value must not reach timingSafeEqual and throw: that class of bug once killed
  // the whole server from one header.
  const multibyte = await fetch(base + '/api/stickies', { headers: { 'x-stickies-key': 'é'.repeat(32) } });
  check(multibyte.status === 401, `a multi-byte key is refused, not a 500 (got ${multibyte.status})`);
  check((await (await fetch(base + '/api/health')).json()).app === 'stickies', 'and the server is still alive after it');

  // --- a URL never carries the long-lived key --------------------------------------------------
  // Links end up in scrollback, browser history and process command lines. What goes in one is a
  // token derived from the key and the current five-minute bucket, so a link found later is dead.
  const { linkToken, verifyLinkToken } = await import('../src/dashboard-auth.js');
  // The cookie outlives the browser session on purpose: session-scoped meant every browser
  // restart began by hunting for a fresh link, and that friction is what gets a security control
  // switched off wholesale. Still HttpOnly + Strict; the key file remains the revocation point.
  {
    const { cookieHeader } = await import('../src/dashboard-auth.js');
    const h = cookieHeader(KEY, PORT);
    check(/Max-Age=2592000/.test(h), 'the auth cookie lasts 30 days, not just the browser session');
    check(/HttpOnly/.test(h) && /SameSite=Strict/.test(h), 'and is still HttpOnly + SameSite=Strict');
  }
  const TOKEN = linkToken(PORT, KEY);
  check(/^[0-9a-f]{32}$/.test(TOKEN) && TOKEN !== KEY, 'a link token is derived from the key, and is not the key');
  check(verifyLinkToken(TOKEN, PORT, KEY), 'the current window verifies');

  // A token is only good for the dashboard it was minted for.
  //
  // Before the port was signed, every token was interchangeable between instances sharing the key
  // file. On a shared host that is a real path in: another account squats the default port before
  // your dashboard starts and answers /api/health as Stickies, your statusline links there, you
  // Ctrl+click, and the squatter replays the token it just received against your real dashboard on
  // whatever port it ended up on. Proven by replay against a live server before this was fixed.
  check(!verifyLinkToken(TOKEN, PORT + 1, KEY),
    'a token minted for one port does NOT verify against another');
  check(!verifyLinkToken(linkToken(9999, KEY), PORT, KEY),
    'and a token minted elsewhere does not open this one');
  check(verifyLinkToken(linkToken(String(PORT), KEY), PORT, KEY),
    'a string port and a numeric port sign identically (the CLI passes strings)');
  // Both times pinned. Buckets are absolute (floor(t / 5min)), so "six minutes ago" is one bucket
  // back or two depending on where the wall clock happens to sit inside the window — a coin flip,
  // which is exactly the kind of assertion that goes red at 3am for no reason. Minting at T and
  // checking at T + one window is one bucket later by construction, every time.
  const WINDOW = 5 * 60 * 1000;
  const T = 1_800_000_000_000; // any fixed instant
  check(verifyLinkToken(linkToken(PORT, KEY, T), PORT, KEY, T + WINDOW),
    'a token stays valid into the next window, so a link cannot die mid-click');
  check(!verifyLinkToken(linkToken(PORT, KEY, T), PORT, KEY, T + 12 * WINDOW),
    'an hour-old link from scrollback does NOT');
  const keyInUrl = await fetch(`${base}/?k=${KEY}`, { redirect: 'manual' });
  check(keyInUrl.status === 401, `and the raw key is refused in a URL entirely (got ${keyInUrl.status})`);

  // --- the link redeems for a cookie ------------------------------------------------------------
  // This is the path the statusline Ctrl+click takes, so it has to end on a usable page.
  const redeem = await fetch(`${base}/board?project=${encodeURIComponent(PROJ.replace(/\\/g, '/'))}&k=${TOKEN}`, { redirect: 'manual' });
  check(redeem.status === 302, `an authorized link redirects (got ${redeem.status})`);
  const setCookie = redeem.headers.get('set-cookie') || '';
  check(/stickies_auth_\d+=/.test(setCookie), 'setting the auth cookie (named per-port)');
  check(/HttpOnly/i.test(setCookie), 'HttpOnly, so page script cannot read it');
  check(/SameSite=Strict/i.test(setCookie), 'and SameSite=Strict, which is what blocks a drive-by from another origin');
  const dest = redeem.headers.get('location') || '';
  check(!dest.includes(KEY) && !dest.includes(TOKEN), `the credential is stripped from the URL it lands on (${dest})`);
  check(dest.startsWith('/board') && dest.includes('project='), 'while keeping the project it was asked for');

  // …and the cookie then works on its own.
  const cookie = (setCookie.split(';')[0] || '').trim();
  const viaCookie = await fetch(base + dest, { headers: { cookie } });
  check(viaCookie.status === 200, `the cookie alone opens the page (got ${viaCookie.status})`);
  const forged = await fetch(base + '/api/stickies', { headers: { cookie: `stickies_auth_${PORT}=` + 'a'.repeat(64) } });
  check(forged.status === 401, 'a forged cookie is refused');
  // A cookie minted by ANOTHER dashboard on this host must not open this one.
  const neighbour = await fetch(base + '/api/stickies', { headers: { cookie: `stickies_auth_${PORT + 1}=${KEY}` } });
  check(neighbour.status === 401, "another instance's cookie does not open this one");

  // --- the statusline builds a link that actually opens ---------------------------------------
  // The link is the only way most people ever reach the dashboard. If it stopped carrying a
  // credential the gate would simply have broken the feature.
  // stdin ignored, i.e. /dev/null: the statusline reads the Claude Code hook event from stdin
  // and waits for EOF. Inheriting this process's stdin means it waits forever.
  const sl = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/statusline.js', '--project', PROJ],
    { env: { ...env, STICKIES_DASHBOARD_PORT: String(PORT), FORCE_HYPERLINK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let slOut = '';
  sl.stdout.on('data', (d) => (slOut += d));
  await new Promise((r) => sl.on('close', r));
  const linked = /\x1b\]8;;(http:[^\x1b]+)\x1b/.exec(slOut);
  check(!!linked, 'the statusline still emits a hyperlink');
  if (linked) {
    check(linked[1].includes('k='), 'and the link carries a credential');
    // The whole point: what lands in scrollback, hundreds of times a day, must not be the key.
    check(!linked[1].includes(KEY), 'which is NOT the long-lived key — scrollback keeps this forever');
    const opened = await fetch(linked[1], { redirect: 'manual' });
    check(opened.status === 302, `following it lands somewhere real rather than a 401 (got ${opened.status})`);
  }

  // --- the redeem redirect can only ever send you to a PATH here ------------------------------
  // The Location header is built from url.pathname, so a protocol-relative request line like
  // `GET //example.com/?k=...` collapses to "/" rather than becoming an off-site redirect. That
  // safety comes from using pathname instead of the whole URL, which is exactly the kind of
  // detail a later refactor discards — so pin it. fetch() normalizes these away, hence raw http.
  const rawGet = (path) => new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { host: `127.0.0.1:${PORT}` } },
      (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || '' }); });
    r.on('error', () => resolve({ status: 0, location: '' }));
    r.end();
  });
  // The credential must be one the gate ACCEPTS, or there is no redirect to inspect and the
  // assertion passes on an empty Location for the wrong reason. It sent the raw key — which this
  // same file asserts is refused fifty lines above — so it could never have failed.
  for (const hostile of [`//example.com/?k=${TOKEN}`, `/\\example.com/?k=${TOKEN}`, `//127.0.0.1@example.com/?k=${TOKEN}`]) {
    const { location } = await rawGet(hostile);
    const offsite = /^[a-z]+:/i.test(location) || location.startsWith('//') || location.startsWith('/\\');
    check(!offsite, `redeeming ${hostile.split('?')[0]} stays on this origin (Location: ${location})`);
  }

  // --- a corrupt key file must not brick the dashboard ----------------------------------------
  // Found by probing: a truncated key made ensureAuthKey's 'wx' fail with EEXIST, which returned
  // null, which fails closed — so the dashboard came up and answered 401 to EVERYTHING, forever,
  // left the bad file in place, and said nothing. Recovery meant knowing to delete a file nobody
  // has heard of. A bad key is now replaced.
  const CORRUPT_HOME = join(ROOT, 'corrupt-home');
  mkdirSync(CORRUPT_HOME, { recursive: true });
  writeFileSync(join(CORRUPT_HOME, 'dashboard-auth.key'), 'too-short');
  const PORT3 = await freePort();
  const srv3 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dashboard.js',
    '--port', String(PORT3), '--project', PROJ], { env: { ...env, STICKIES_HOME: CORRUPT_HOME } });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${PORT3}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const healed = readFileSync(join(CORRUPT_HOME, 'dashboard-auth.key'), 'utf8').trim();
    check(/^[0-9a-f]{64}$/.test(healed), `a corrupt key file is replaced, not deferred to (${JSON.stringify(healed.slice(0, 12))}…)`);
    const usable = await fetch(`http://127.0.0.1:${PORT3}/api/stickies`, { headers: { 'x-stickies-key': healed } });
    check(usable.status === 200, `and the dashboard can actually be opened afterwards (got ${usable.status})`);
  } finally {
    await killAndWait(srv3);
  }

  // --- two dashboards on one host must not fight over one cookie -------------------------------
  // Cookies are scoped by HOST; the port is not part of their identity. Under one fixed cookie
  // name, redeeming a link for the dashboard on 4321 logs you out of the one on 4317 and vice
  // versa — which presents as "the gate is broken", not as "you have two dashboards".
  const { cookieName } = await import('../src/dashboard-auth.js');
  check(cookieName(PORT) !== cookieName(PORT + 1), 'the cookie name is per-port');
  check(new RegExp(`${cookieName(PORT)}=`).test(setCookie), `and the server sets that name (${cookieName(PORT)})`);

  // --- one-shot tickets, for URLs that end up in a process command line -----------------------
  // `--open` hands its URL to the OS browser opener, so it lands in a command line that other
  // accounts can read and that audit logging records verbatim. The long-lived key must never go
  // there; a ticket that works once and dies in a minute can.
  const { mintTicket, redeemTicket, _ticketCount } = await import('../src/dashboard-auth.js');
  const ticket = mintTicket();
  check(/^[0-9a-f]{32}$/.test(ticket), 'a ticket is 16 random bytes');
  check(ticket !== KEY, 'and is not the long-lived key');
  check(redeemTicket(ticket) === true, 'it redeems once');
  check(redeemTicket(ticket) === false, 'and never again — a command line anyone can read is spent by the time they read it');
  const expired = mintTicket(1);
  await new Promise((r) => setTimeout(r, 20));
  check(redeemTicket(expired) === false, 'an expired ticket is refused');
  check(redeemTicket('deadbeef'.repeat(4)) === false, 'and a made-up one is refused');
  const beforeMint = _ticketCount();
  for (let i = 0; i < 5; i++) mintTicket(1);
  await new Promise((r) => setTimeout(r, 20));
  mintTicket();
  check(_ticketCount() <= beforeMint + 1, `expired tickets are swept rather than accumulating (${_ticketCount()})`);
  // The long-lived key, by contrast, keeps working — it is what the header path uses.
  check((await fetch(base + '/api/stickies', { headers: { 'x-stickies-key': KEY } })).status === 200,
    'the long-lived key is still reusable, unlike a ticket');

  // --- the key must not leak into anything a human pastes --------------------------------------
  // `stickies doctor` exists to be copied into an issue; the audit that made its paths
  // paste-safe would be undone by printing a secret that gates every note on the machine.
  const doctor = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', 'doctor'],
    { env: { ...env, STICKIES_DASHBOARD_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let docOut = '';
  doctor.stdout.on('data', (d) => (docOut += d));
  doctor.stderr.on('data', (d) => (docOut += d));
  await new Promise((r) => doctor.on('close', r));
  check(!docOut.includes(KEY), 'stickies doctor does not print the read key');
  check(/--link/.test(docOut), 'but it does say how to get an authorized link');

  // --- the opt-out is honoured, and only when asked for ---------------------------------------
  const OPEN_PORT = await freePort();
  const openSrv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dashboard.js',
    '--port', String(OPEN_PORT), '--project', PROJ], { env: { ...env, STICKIES_DASHBOARD_AUTH: '0' } });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${OPEN_PORT}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const openRead = await fetch(`http://127.0.0.1:${OPEN_PORT}/api/stickies`);
    check(openRead.status === 200, `STICKIES_DASHBOARD_AUTH=0 opens reads for someone who asks for it (got ${openRead.status})`);
  } finally {
    await killAndWait(openSrv);
  }
} catch (err) {
  console.log(`  FAIL  auth test threw: ${err.stack || err.message}`);
  fail++;
} finally {
  await killAndWait(srv);
  try { (await import('../src/db.js')).closeDb(); } catch { /* nothing open */ }
  cleanup(ROOT);
}

console.log(fail ? `\ndashboard-auth: ${fail} FAILED` : '\ndashboard-auth: all passed');
process.exit(fail ? 1 : 0);
