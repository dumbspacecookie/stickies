// Discord notifier: opt-in, host-locked, batched, and never fatal.
// No real network: global.fetch is stubbed and we assert on what would have been sent.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// Point the stickies DB at a throwaway BEFORE importing anything that opens it (buildBoard
// cross-links stickies), so this suite never touches the developer's real ~/.stickies store.
process.env.STICKIES_DB = join(tmpdir(), `notify-test-${process.pid}-${Date.now()}.db`);

import { parseWebhook, isEnabled, notify, notifyDigest, notifySessionReport, notifyBoard, eventsEnabled, toEmbed } from '../src/notify.js';
import { buildBoard } from '../src/flow/board.mjs';

// Hermetic board fixture: a throwaway project carrying a real .planning/ROADMAP.md, so the
// board-backed assertions don't depend on THIS repo's cwd having a planning dir — it won't in
// a published/npm checkout, only in the dev tree.
const BOARD_PROJECT = mkdtempSync(join(tmpdir(), 'notify-board-'));
mkdirSync(join(BOARD_PROJECT, '.planning'), { recursive: true });
writeFileSync(join(BOARD_PROJECT, '.planning', 'ROADMAP.md'), [
  '# Roadmap', '',
  '### Phase 1: Foundations — ✅ COMPLETE',
  '**Status:** ✅ Complete (3/3 plans)',
  '- [x] 01-01-PLAN.md', '- [x] 01-02-PLAN.md', '- [x] 01-03-PLAN.md', '',
  '### Phase 2: Build — in progress',
  '**Status:** ⏳ in progress',
  '- [x] 02-01-PLAN.md', '- [ ] 02-02-PLAN.md', '',
].join('\n'));

let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL  ${label}${detail ? ` (${detail})` : ''}\x1b[0m`);
  }
}

const HOOK = 'https://discord.com/api/webhooks/123/token';
const ENV = { STICKIES_DISCORD_WEBHOOK: HOOK, STICKIES_NOTIFY_EVENTS: '1' };
const ENV_NO_EVENTS = { STICKIES_DISCORD_WEBHOOK: HOOK }; // webhook set, firehose off (the default)

const sticky = (over = {}) => ({
  id: 'id-1',
  content: 'ship the release',
  category: 'todo',
  importance: 'P1',
  project_path: '/home/dev/myapp',
  tags: [],
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  ...over,
});

// --- capture outbound posts instead of sending them -------------------------------
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 204 };
};

// --- host lock ---------------------------------------------------------------------
ok(parseWebhook(HOOK) !== null, 'accepts a real discord webhook');
ok(parseWebhook('https://evil.com/api/webhooks/1/x') === null, 'rejects a non-discord host');
ok(parseWebhook('http://discord.com/api/webhooks/1/x') === null, 'rejects plain http');
ok(parseWebhook('https://discord.com/api/oauth2/token') === null, 'rejects a non-webhook path');
ok(parseWebhook(undefined) === null, 'rejects undefined');

// --- inert by default (this is the important one) -----------------------------------
ok(isEnabled({}) === false, 'disabled when env var is absent');
sent.length = 0;
const skipped = await notify(sticky(), 'created', {});
ok(skipped.ok === false && skipped.skipped, 'notify is a no-op with no webhook configured');
ok(sent.length === 0, 'nothing sent when disabled', 'zero outbound calls');

// --- created ------------------------------------------------------------------------
sent.length = 0;
const r1 = await notify(sticky(), 'created', ENV);
ok(r1.ok === true, 'created event posts');
ok(sent.length === 1, 'exactly one POST');
ok(sent[0].url === HOOK, 'posts to the configured webhook');
ok(sent[0].body.embeds[0].author.name.includes('added'), 'titled as an add');
ok(sent[0].body.embeds[0].description.includes('ship the release'), 'carries the note text');

// --- dismissed ----------------------------------------------------------------------
sent.length = 0;
await notify(sticky(), 'dismissed', ENV);
ok(sent[0].body.embeds[0].author.name.includes('cleared'), 'dismiss event titled as cleared');

// --- batching: N notes in one turn = ONE post, not N ---------------------------------
sent.length = 0;
const many = Array.from({ length: 4 }, (_, i) => sticky({ id: `id-${i}`, content: `note ${i}` }));
await notify(many, 'created', ENV);
ok(sent.length === 1, 'a batch of 4 sends one POST, not four');
ok(sent[0].body.embeds.length === 4, 'batch carries all 4 embeds');

// --- Discord's 10-embed hard cap ------------------------------------------------------
sent.length = 0;
const flood = Array.from({ length: 14 }, (_, i) => sticky({ id: `f-${i}`, content: `n${i}` }));
await notify(flood, 'created', ENV);
ok(sent[0].body.embeds.length === 10, 'caps embeds at discord max of 10');
ok(/\+4 more/.test(sent[0].body.content || ''), 'says how many were withheld', 'no silent truncation');

// --- digest ---------------------------------------------------------------------------
sent.length = 0;
await notifyDigest([sticky(), sticky({ id: 'id-2', importance: 'P3', content: 'minor thing' })], '/home/dev/myapp', ENV);
ok(sent.length === 1, 'digest posts once');
ok(/P1/.test(sent[0].body.embeds[0].description), 'digest groups by priority');
ok(/myapp/.test(sent[0].body.embeds[0].title), 'digest names the project');

sent.length = 0;
await notifyDigest([], '/home/dev/myapp', ENV);
ok(/Clean board/.test(sent[0].body.content || ''), 'empty digest says the board is clean');

// --- never fatal: a webhook that throws must not take the caller down -------------------
global.fetch = async () => {
  throw new Error('network is down');
};
const r2 = await notify(sticky(), 'created', ENV);
ok(r2.ok === false && typeof r2.error === 'string', 'a dead webhook resolves to an error, does not throw');

global.fetch = async () => ({ ok: false, status: 429 });
const r3 = await notify(sticky(), 'created', ENV);
ok(r3.ok === false && /429/.test(r3.error), 'a rate-limited webhook is reported, not thrown');

global.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 204 };
};

// --- per-event pings are OFF by default (the channel must not become noise) ---------
ok(eventsEnabled({}) === false, 'per-event pings off by default');
ok(eventsEnabled({ STICKIES_NOTIFY_EVENTS: '1' }) === true, 'per-event pings opt in via env');
sent.length = 0;
const quiet = await notify(sticky(), 'created', ENV_NO_EVENTS);
ok(quiet.ok === false, 'webhook set but firehose off -> no per-note post');
ok(sent.length === 0, 'default config sends nothing on a single write');

// --- session report: the surface you actually read ----------------------------------
sent.length = 0;
const rep = await notifySessionReport(
  {
    created: [sticky({ id: 'c1', content: 'park this' })],
    dismissed: [sticky({ id: 'd1', content: 'fixed that', importance: 'P2' })],
    projectPath: '/home/dev/webapp',
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:30:00.000Z',
    sessionId: 'abcd1234-ffff',
  },
  ENV_NO_EVENTS
);
ok(rep.ok === true, 'session report posts with the default config (no firehose needed)');
ok(sent.length === 1, 'session report is exactly one post');
const emb = sent[0].body.embeds[0];
ok(/webapp/.test(emb.title), 'report names the folder');
ok(/Parked \(1\)/.test(emb.description), 'report lists what was parked');
ok(/Cleared \(1\)/.test(emb.description), 'report lists what was cleared');
ok(/park this/.test(emb.description) && /fixed that/.test(emb.description), 'report carries both note texts');
ok(emb.fields.some((f) => /2026-07-14 10:00/.test(f.value) && /2026-07-14 11:30/.test(f.value)), 'report carries the session window (date + time)');
ok(emb.fields.some((f) => /\/home\/dev\/webapp/.test(f.value)), 'report carries the full folder path');
ok(/abcd1234/.test(emb.footer.text), 'report carries the session id');

sent.length = 0;
const noop = await notifySessionReport({ created: [], dismissed: [], projectPath: 'x' }, ENV_NO_EVENTS);
ok(noop.ok === false && sent.length === 0, 'a session that touched nothing posts nothing');

// --- session report: a note's origin shows as a compact "from …" tag ----------------
sent.length = 0;
await notifySessionReport(
  {
    created: [sticky({ id: 'o1', content: 'wrote from a terminal', origin: 'terminal' })],
    projectPath: 'x',
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
  },
  ENV_NO_EVENTS
);
ok(/from terminal/.test(sent[0].body.embeds[0].description), 'a note carries its origin as a "from …" tag');

sent.length = 0;
await notifySessionReport(
  {
    created: [sticky({ id: 'o2', content: 'no origin recorded' })], // sticky() carries no origin
    projectPath: 'x',
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
  },
  ENV_NO_EVENTS
);
ok(!/ from /.test(sent[0].body.embeds[0].description), 'a note with no origin renders no origin tag');

// --- session report: per-phase board status when the project has a flow board --------
sent.length = 0;
await notifySessionReport(
  {
    created: [sticky({ id: 'b1', content: 'board-backed project' })],
    projectPath: BOARD_PROJECT, // throwaway project with a real .planning/ROADMAP.md
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
  },
  ENV_NO_EVENTS
);
const withBoard = sent[0].body.embeds[0].fields.find((f) => f.name === 'board');
ok(withBoard && /Phase \d/.test(withBoard.value), 'report adds a board status field when the project has a flow board');
ok(withBoard ? withBoard.value.length <= 1024 : false, 'board field stays within Discord\'s 1024-char value limit');

sent.length = 0;
await notifySessionReport(
  {
    created: [sticky({ id: 'b2', content: 'no board here' })],
    projectPath: '/no/such/project/anywhere', // no .planning/ or .flow/ -> buildBoard ok:false
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
  },
  ENV_NO_EVENTS
);
ok(!sent[0].body.embeds[0].fields.some((f) => f.name === 'board'), 'a project with no board omits the board field');

// --- notifyBoard: the standalone board card -----------------------------------------
sent.length = 0;
const boardCard = await notifyBoard(BOARD_PROJECT, ENV);
ok(boardCard.ok === true && sent.length === 1, 'notifyBoard posts one card for a project with a board');
ok(/flow board/.test(sent[0].body.embeds[0].title), 'board card is titled as a flow board');
ok(sent[0].body.embeds[0].fields.some((f) => f.name === 'columns'), 'board card carries a columns breakdown');

sent.length = 0;
const noBoardCard = await notifyBoard('/no/such/project/anywhere', ENV);
ok(noBoardCard.ok === false && sent.length === 0, 'notifyBoard posts nothing when the project has no board');

sent.length = 0;
const noHookCard = await notifyBoard(BOARD_PROJECT, {});
ok(noHookCard.ok === false && sent.length === 0, 'notifyBoard with no webhook configured is a no-op');

// --- the host lock, pushed on ---------------------------------------------------------------
// The five cases above cover the typo. These cover the attempt. Every one of them is a URL that
// LOOKS like the real thing to a human reading an env var, and the only thing standing between it
// and a copy of every note you write is this function returning null.
for (const [label, url] of [
  ['a host that merely starts with discord', 'https://discord.com.evil.example/api/webhooks/1/x'],
  ['a host that merely ends with discord.com', 'https://evil-discord.com/api/webhooks/1/x'],
  ['userinfo dressed up as the host', 'https://discord.com@evil.example/api/webhooks/1/x'],
  ['a trailing-dot FQDN', 'https://discord.com./api/webhooks/1/x'],
  ['a path that traverses out of /api/webhooks', 'https://discord.com/api/webhooks/../../evil'],
  ['ftp', 'ftp://discord.com/api/webhooks/1/x'],
  ['javascript:', 'javascript:fetch("https://discord.com/api/webhooks/1/x")'],
  ['data:', 'data:text/plain,https://discord.com/api/webhooks/1/x'],
  ['a bare hostname with no scheme', 'discord.com/api/webhooks/1/x'],
  ['an empty string', ''],
  ['a number', 1234],
]) {
  ok(parseWebhook(url) === null, `webhook validator rejects: ${label}`);
}
// …and does not reject things it should accept, or the guard would be "secure" by being useless.
ok(parseWebhook(`  ${HOOK}\n`) === HOOK, 'a webhook pasted with surrounding whitespace still works');
ok(parseWebhook('https://DISCORD.COM/api/webhooks/1/x') !== null, 'the host match is case-insensitive');
ok(parseWebhook('https://ptb.discord.com/api/webhooks/1/x') !== null, 'the ptb host is allowed');
// The one that would make every rejection above meaningless: a rejected URL must never be posted
// to, not merely "not returned". This is the property, checked end to end.
sent.length = 0;
const hostile = await notify(sticky(), 'created', { ...ENV, STICKIES_DISCORD_WEBHOOK: 'https://evil.example/api/webhooks/1/x' });
ok(hostile.ok === false && sent.length === 0, 'a rejected webhook host receives no POST at all');

// --- every embed field stays inside Discord's limits ------------------------------------------
//
// Over ANY limit and Discord 400s the WHOLE request — not the field, the post. A monorepo path of
// 1674 characters in the `folder` field is what found this: that project's session reports never
// arrived, once, ever, and the 400 went into a swallowed catch.
//
// This is Discord's documented table, restated here so the assertion is against the platform's
// rule rather than against whatever the code currently happens to do.
const DISCORD = { content: 2000, title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25, embeds: 10 };
function overLimit(body) {
  const bad = [];
  const at = (path, text, cap) => { if (typeof text === 'string' && text.length > cap) bad.push(`${path} ${text.length} > ${cap}`); };
  at('content', body.content, DISCORD.content);
  const embeds = body.embeds || [];
  if (embeds.length > DISCORD.embeds) bad.push(`embeds ${embeds.length} > ${DISCORD.embeds}`);
  embeds.forEach((e, i) => {
    at(`embeds.${i}.title`, e.title, DISCORD.title);
    at(`embeds.${i}.description`, e.description, DISCORD.description);
    at(`embeds.${i}.author.name`, e.author?.name, DISCORD.author);
    at(`embeds.${i}.footer.text`, e.footer?.text, DISCORD.footer);
    const fields = e.fields || [];
    if (fields.length > DISCORD.fields) bad.push(`embeds.${i}.fields ${fields.length} > ${DISCORD.fields}`);
    fields.forEach((f, j) => {
      at(`embeds.${i}.fields.${j}.name`, f.name, DISCORD.fieldName);
      at(`embeds.${i}.fields.${j}.value`, f.value, DISCORD.fieldValue);
      // An EMPTY value is a 400 too, and it is the failure a naive "just cap it" fix introduces.
      if (!f.name || !f.value) bad.push(`embeds.${i}.fields.${j} empty name/value`);
    });
  });
  return bad;
}

const LONG_PATH = `/srv/${'deeply-nested-monorepo-package/'.repeat(60)}app`;
ok(LONG_PATH.length > DISCORD.fieldValue,
  'control: the fixture path really is over the field limit, so this test is not vacuous',
  `${LONG_PATH.length} chars`);
sent.length = 0;
const longRep = await notifySessionReport(
  {
    created: [sticky({ id: 'L1', content: 'x'.repeat(6000) })], // over-long content too
    dismissed: [sticky({ id: 'L2', content: 'y'.repeat(6000) })],
    projectPath: LONG_PATH,
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
    sessionId: 'deadbeef-1111',
  },
  ENV_NO_EVENTS
);
ok(longRep.ok === true, 'a session report for an absurdly long path is still sent');
ok(overLimit(sent[0].body).length === 0, 'and every field of it is inside Discord\'s limits', overLimit(sent[0].body).join('; ') || 'clean');
const folderField = sent[0].body.embeds[0].fields.find((f) => f.name === 'folder');
ok(folderField.value.length <= DISCORD.fieldValue, 'the folder field is bounded', `${folderField.value.length} chars`);
ok(folderField.value.endsWith('…'), 'and says it was truncated rather than cutting silently');
ok(folderField.value.includes('deeply-nested-monorepo-package'), 'while still carrying the start of the real path');

// The same bound applies on every surface, not just the one that broke.
for (const [label, run] of [
  ['per-note batch', () => notify(Array.from({ length: 14 }, (_, i) => sticky({ id: `x${i}`, content: 'z'.repeat(5000), tags: ['t'.repeat(2000)] })), 'created', ENV)],
  ['digest', () => notifyDigest(Array.from({ length: 40 }, (_, i) => sticky({ id: `d${i}`, content: 'w'.repeat(400) })), LONG_PATH, ENV)],
  ['board card', () => notifyBoard(BOARD_PROJECT, ENV)],
]) {
  sent.length = 0;
  await run();
  const problems = sent.length ? overLimit(sent[0].body) : ['nothing was sent'];
  ok(problems.length === 0, `${label}: every field inside Discord's limits`, problems.join('; ') || 'clean');
}

// --- the board field is redacted, like every other field --------------------------------------
//
// `board` is the one field on the session report that does NOT come from the store: it is parsed
// out of the project's planning files at send time, so it never met redactSecrets() at write time.
// And a .flow/board.json is a COMMITTED, synced file — a phase label in it can say anything at
// all, including something somebody pasted into a branch. The report fires by itself at
// SessionEnd, so nobody is watching when it goes.
const SECRET_BOARD = mkdtempSync(join(tmpdir(), 'notify-secretboard-'));
const LEAKED = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
mkdirSync(join(SECRET_BOARD, '.flow'), { recursive: true });
writeFileSync(join(SECRET_BOARD, '.flow', 'board.json'), JSON.stringify({
  generatedAt: '2026-07-14T00:00:00.000Z',
  rollup: { done: 0, total: 1, pct: 0 },
  columns: {
    todo: [{ id: 'p9', phase: `Phase 9 AWS_SECRET_ACCESS_KEY=${LEAKED}`, title: 'rotate the key', column: 'todo' }],
    doing: [],
    done: [],
  },
}));
// Control: the SOURCE really does carry the credential. Without this, a board that simply failed
// to load would make every assertion below pass for the wrong reason.
const rawBoard = buildBoard(SECRET_BOARD);
ok(rawBoard.ok && JSON.stringify(rawBoard.columns).includes(LEAKED),
  'control: the board source really does carry an unredacted credential');

sent.length = 0;
await notifySessionReport(
  {
    created: [sticky({ id: 's1', content: 'ordinary note' })],
    projectPath: SECRET_BOARD,
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:00:00.000Z',
  },
  ENV_NO_EVENTS
);
const secretField = sent[0].body.embeds[0].fields.find((f) => f.name === 'board');
ok(secretField && /Phase 9/.test(secretField.value), 'the board field is still built from the project board');
ok(!JSON.stringify(sent[0].body).includes(LEAKED), 'and no credential from the board reaches the webhook');
ok(/\[REDACTED\]/.test(secretField.value), 'the board field says a secret was removed rather than dropping it silently');

sent.length = 0;
await notifyBoard(SECRET_BOARD, ENV);
ok(!JSON.stringify(sent[0].body).includes(LEAKED), 'the standalone board card is redacted too');

// The board field fits phases into 1024 characters by counting them. Redaction CHANGES the count
// — `SECRET_TOKEN=abc` is seven characters longer once it reads `SECRET_TOKEN=[REDACTED]` — so a
// field measured raw and scrubbed afterwards ends up over the limit and gets blind-cut at 1024,
// losing the "+N more" that tells you phases are missing. Measure what will actually be sent.
const MANY_BOARD = mkdtempSync(join(tmpdir(), 'notify-manyboard-'));
mkdirSync(join(MANY_BOARD, '.flow'), { recursive: true });
writeFileSync(join(MANY_BOARD, '.flow', 'board.json'), JSON.stringify({
  generatedAt: '2026-07-14T00:00:00.000Z',
  rollup: { done: 0, total: 60, pct: 0 },
  columns: {
    todo: Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, phase: `Phase ${i} SECRET_TOKEN=abc`, title: 't', column: 'todo' })),
    doing: [],
    done: [],
  },
}));
sent.length = 0;
await notifyBoard(MANY_BOARD, ENV);
const fitted = sent[0].body.embeds[0].fields.find((f) => f.name === 'board');
ok(fitted.value.length <= DISCORD.fieldValue, 'a 60-phase board still fits the field limit', `${fitted.value.length} chars`);
ok(!fitted.value.includes('abc'), 'control: those phase labels really were redacted (so growth really happened)');
ok(!(fitted.value.length === DISCORD.fieldValue && fitted.value.endsWith('…')),
  'and it was trimmed by the phase-aware fit, not blind-cut at 1024 afterwards', fitted.value.slice(-24));
ok(/\+\d+ more$/.test(fitted.value), 'so the field ends by saying how many phases are not shown', fitted.value.slice(-14));
rmSync(MANY_BOARD, { recursive: true, force: true });

// --- a rejected post is visible, not swallowed -------------------------------------------------
//
// Best-effort is right for the SEND. It was wrong for the REPORT: the 400 was stringified into a
// return value every caller ignores, so the only symptom was reports that stopped arriving.
{
  const BODY = '{"embeds": ["0.fields.0.value: Must be 1024 or fewer in length."]}';
  global.fetch = async () => ({ ok: false, status: 400, text: async () => BODY });
  let stderr = '';
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  const rejected = await notifySessionReport(
    { created: [sticky()], projectPath: 'x', startedAt: '2026-07-14T10:00:00.000Z', endedAt: '2026-07-14T11:00:00.000Z' },
    ENV_NO_EVENTS
  );
  process.stderr.write = realWrite;
  ok(rejected.ok === false, 'a 400 from discord is reported as a failure');
  ok(/400/.test(rejected.error) && /1024 or fewer/.test(rejected.error),
    'and the returned error quotes what discord objected to', rejected.error);
  ok(/stickies: discord post failed/.test(stderr), 'and it is written where a person can see it');
  ok(/1024 or fewer/.test(stderr), 'with the reason, not just "something went wrong"', stderr.trim());

  // A timeout must be visible too — same swallow, different cause.
  stderr = '';
  global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  const timedOut = await notifySessionReport(
    { created: [sticky()], projectPath: 'x', startedAt: '2026-07-14T10:00:00.000Z', endedAt: '2026-07-14T11:00:00.000Z' },
    ENV_NO_EVENTS
  );
  process.stderr.write = realWrite;
  ok(timedOut.ok === false && /timed out/.test(stderr), 'a timed-out post is announced as well');
}

// --- a redirect cannot move the payload to another host ---------------------------------------
//
// parseWebhook() checks the URL we ASK for. With `redirect: 'follow'` the server chooses where the
// request actually goes, and a 307 keeps the method AND the body — so one response header moves a
// copy of your notes to any host it names, past a host allowlist that already said yes. Two real
// local servers here, because a stub asserting `init.redirect === 'error'` proves the flag is set,
// not that the flag does anything.
{
  const sink = [];
  const sinkServer = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { sink.push(data); res.writeHead(204).end(); });
  });
  await new Promise((r) => sinkServer.listen(0, '127.0.0.1', r));
  const SINK = `http://127.0.0.1:${sinkServer.address().port}/steal`;

  const redirectServer = createServer((req, res) => { res.writeHead(307, { location: SINK }).end(); });
  await new Promise((r) => redirectServer.listen(0, '127.0.0.1', r));
  const REDIRECTOR = `http://127.0.0.1:${redirectServer.address().port}/api/webhooks/1/x`;

  // Stand in for DNS: the code asks for the discord URL it validated, the request lands on a host
  // that answers with a redirect. Everything else — method, headers, body, options — is the real
  // ones, so what is under test is exactly what ships.
  let seenInit = null;
  global.fetch = async (_url, init) => { seenInit = init; return realFetch(REDIRECTOR, init); };
  const redirected = await notify(sticky({ content: 'notes that must not travel' }), 'created', ENV);

  ok(seenInit && seenInit.redirect === 'error', 'the POST asks fetch to refuse redirects');
  ok(redirected.ok === false, 'a redirected webhook post fails');
  ok(/unexpected redirect/.test(redirected.error || ''), 'and the reason names the redirect', redirected.error);
  ok(sink.length === 0, 'and the note body never reaches the redirect target');

  // Control: the same request with the old option DOES deliver the body to the other host.
  await realFetch(REDIRECTOR, { ...seenInit, signal: undefined, redirect: 'follow' });
  ok(sink.length === 1 && /must not travel/.test(sink[0]),
    'control: with redirect:follow the payload really does land on the other host');

  sinkServer.close();
  redirectServer.close();
}

global.fetch = realFetch;
rmSync(BOARD_PROJECT, { recursive: true, force: true });
rmSync(SECRET_BOARD, { recursive: true, force: true });

console.log('');
if (fail) {
  console.log(`\x1b[31mNOTIFY FAILED — ${fail} failing, ${pass} passing\x1b[0m`);
  process.exit(1);
}
console.log(`NOTIFY OK — ${pass} passing`);
