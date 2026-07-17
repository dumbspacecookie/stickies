// Discord notifier: opt-in, host-locked, batched, and never fatal.
// No real network: global.fetch is stubbed and we assert on what would have been sent.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the stickies DB at a throwaway BEFORE importing anything that opens it (buildBoard
// cross-links stickies), so this suite never touches the developer's real ~/.stickies store.
process.env.STICKIES_DB = join(tmpdir(), `notify-test-${process.pid}-${Date.now()}.db`);

import { parseWebhook, isEnabled, notify, notifyDigest, notifySessionReport, notifyBoard, eventsEnabled, toEmbed } from '../src/notify.js';

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
  content: 'relight the collector',
  category: 'todo',
  importance: 'P1',
  project_path: '/home/dev/flops',
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
ok(sent[0].body.embeds[0].description.includes('relight the collector'), 'carries the note text');

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
await notifyDigest([sticky(), sticky({ id: 'id-2', importance: 'P3', content: 'minor thing' })], '/home/dev/flops', ENV);
ok(sent.length === 1, 'digest posts once');
ok(/P1/.test(sent[0].body.embeds[0].description), 'digest groups by priority');
ok(/flops/.test(sent[0].body.embeds[0].title), 'digest names the project');

sent.length = 0;
await notifyDigest([], '/home/dev/flops', ENV);
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
    projectPath: '/home/dev/2_stickies',
    startedAt: '2026-07-14T10:00:00.000Z',
    endedAt: '2026-07-14T11:30:00.000Z',
    sessionId: 'abcd1234-ffff',
  },
  ENV_NO_EVENTS
);
ok(rep.ok === true, 'session report posts with the default config (no firehose needed)');
ok(sent.length === 1, 'session report is exactly one post');
const emb = sent[0].body.embeds[0];
ok(/2_stickies/.test(emb.title), 'report names the folder');
ok(/Parked \(1\)/.test(emb.description), 'report lists what was parked');
ok(/Cleared \(1\)/.test(emb.description), 'report lists what was cleared');
ok(/park this/.test(emb.description) && /fixed that/.test(emb.description), 'report carries both note texts');
ok(emb.fields.some((f) => /2026-07-14 10:00/.test(f.value) && /2026-07-14 11:30/.test(f.value)), 'report carries the session window (date + time)');
ok(emb.fields.some((f) => /\/home\/dev\/2_stickies/.test(f.value)), 'report carries the full folder path');
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

global.fetch = realFetch;
rmSync(BOARD_PROJECT, { recursive: true, force: true });

console.log('');
if (fail) {
  console.log(`\x1b[31mNOTIFY FAILED — ${fail} failing, ${pass} passing\x1b[0m`);
  process.exit(1);
}
console.log(`NOTIFY OK — ${pass} passing`);
