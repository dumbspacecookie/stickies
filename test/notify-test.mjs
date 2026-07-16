// Discord notifier: opt-in, host-locked, batched, and never fatal.
// No real network: global.fetch is stubbed and we assert on what would have been sent.

import { parseWebhook, isEnabled, notify, notifyDigest, notifySessionReport, eventsEnabled, toEmbed } from '../src/notify.js';

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
  project_path: 'C:/Users/ash/flops',
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
await notifyDigest([sticky(), sticky({ id: 'id-2', importance: 'P3', content: 'minor thing' })], 'C:/Users/ash/flops', ENV);
ok(sent.length === 1, 'digest posts once');
ok(/P1/.test(sent[0].body.embeds[0].description), 'digest groups by priority');
ok(/flops/.test(sent[0].body.embeds[0].title), 'digest names the project');

sent.length = 0;
await notifyDigest([], 'C:/Users/ash/flops', ENV);
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
    projectPath: 'C:/Users/ash/Documents/4_Experiment/2_stickies',
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
ok(emb.fields.some((f) => /4_Experiment/.test(f.value)), 'report carries the full folder path');
ok(/abcd1234/.test(emb.footer.text), 'report carries the session id');

sent.length = 0;
const noop = await notifySessionReport({ created: [], dismissed: [], projectPath: 'x' }, ENV_NO_EVENTS);
ok(noop.ok === false && sent.length === 0, 'a session that touched nothing posts nothing');

global.fetch = realFetch;

console.log('');
if (fail) {
  console.log(`\x1b[31mNOTIFY FAILED — ${fail} failing, ${pass} passing\x1b[0m`);
  process.exit(1);
}
console.log(`NOTIFY OK — ${pass} passing`);
