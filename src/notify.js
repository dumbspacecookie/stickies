// Optional outbound notifications: mirror sticky lifecycle events to a Discord webhook.
//
// Off unless STICKIES_DISCORD_WEBHOOK is set, so the default install never talks to the
// network. Every function here is best-effort: a webhook that is down, slow, or
// misconfigured must never fail a sticky write or stall a hook. We swallow, we don't throw.
//
// Content posted here has already been through redactSecrets() in store.js, so a webhook
// cannot become a secret-exfiltration path for anything the redactor recognises. It is
// still an outbound copy of your notes — that's the deal you opt into by setting the env var.

import { buildBoard } from './flow/board.mjs';
import { dashboardPort } from './dashboard-port.js';
import { redactAndCap } from './redact.js';

const ENV_VAR = 'STICKIES_DISCORD_WEBHOOK';
const TIMEOUT_MS = 3000;

// Discord's documented webhook limit is 5 requests per 2s per webhook. We pace well under
// it; a burst (e.g. auto-capture writing several notes in one turn) is batched into a
// single POST instead of one POST per note, so the limit is not a practical concern.
const MIN_INTERVAL_MS = 400;
const MAX_EMBEDS_PER_POST = 10; // Discord hard limit

// Discord's documented per-field limits. Going over ANY of them is a 400 for the WHOLE request —
// not a truncated field, the entire post rejected — and every call in this file is best-effort, so
// the rejection went into a catch nobody reads. Measured: a session report for a deep monorepo
// path sent a 1674-character `folder` field against a 1024 limit, so that project's reports never
// arrived once, and there was nothing anywhere to say why.
const LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  fieldCount: 25,
};

// Bound and scrub one outbound string. Both jobs, one call, because they were being done
// separately and each was being forgotten somewhere.
//
// redactAndCap, never the hand-rolled cut-then-redact. Cutting first slices a credential in half,
// and these patterns are anchored, so the fragment matches nothing and is published intact. That
// exact ordering has been hand-written five times in this codebase; see src/redact.js. (Spelling
// the wrong call out in prose here is not free either — the gate reads this file as text, and it
// flagged the comment. Which is the check working: it cannot tell a warning from an instruction.)
//
// The `…` is not decoration. A value that hits the cap has lost something, and the failure this
// whole block exists for was invisible truncation of a path — so when we cut, we say we cut. A
// value that lands EXACTLY on the cap and was not truncated pays one character for that; the
// alternative is a caller who cannot tell a complete field from a clipped one.
function clean(value, cap) {
  const { text } = redactAndCap(value, cap);
  return text.length >= cap ? `${text.slice(0, cap - 1)}…` : text;
}

// Everything Discord will read, bounded and scrubbed, at the single point every post goes through.
//
// Per-call-site scrubbing is what produced this bug: `board` is parsed out of the project's
// ROADMAP.md at send time, so unlike sticky content it never passed through redactSecrets() at
// write time — and it rides the session report, which fires automatically at SessionEnd. A phase
// line reading `deploy: AWS_SECRET_ACCESS_KEY=…` went to the channel verbatim. Doing it here
// instead means a field added later cannot quietly skip it.
function sanitizeEmbed(embed) {
  const out = { ...embed };
  if (embed.title != null) out.title = clean(embed.title, LIMITS.title);
  if (embed.description != null) out.description = clean(embed.description, LIMITS.description);
  if (embed.author && embed.author.name != null) {
    out.author = { ...embed.author, name: clean(embed.author.name, LIMITS.authorName) };
  }
  if (embed.footer && embed.footer.text != null) {
    out.footer = { ...embed.footer, text: clean(embed.footer.text, LIMITS.footerText) };
  }
  if (Array.isArray(embed.fields)) {
    out.fields = embed.fields
      .map((f) => ({ ...f, name: clean(f.name, LIMITS.fieldName), value: clean(f.value, LIMITS.fieldValue) }))
      // An EMPTY name or value is rejected exactly as hard as an over-long one, and scrubbing can
      // empty a field that arrived non-empty. Drop it rather than lose the whole post for it.
      .filter((f) => f.name && f.value)
      .slice(0, LIMITS.fieldCount);
  }
  return out;
}

function sanitizeBody(body) {
  const out = { ...body };
  if (body.content != null) out.content = clean(body.content, LIMITS.content);
  if (Array.isArray(body.embeds)) out.embeds = body.embeds.slice(0, MAX_EMBEDS_PER_POST).map(sanitizeEmbed);
  return out;
}

// A rejected post must not vanish. Best-effort is the right policy for the SEND — a webhook that
// is down must never fail a sticky write — but best-effort had become silent: the failure was
// stringified into a return value that every caller ignores, so "my session reports stopped
// arriving" had no trace on any surface. One line on stderr costs nothing when the webhook is
// healthy and is the whole difference when it is not.
function reportFailure(error) {
  try {
    process.stderr.write(`stickies: discord post failed — ${error}\n`);
  } catch {
    // stderr can be closed on a detached hook; losing the notice must not raise here of all places
  }
}

const COLORS = { P1: 0xe5534b, P2: 0xd9a441, P3: 0x8b949e };
const BAND = { P1: '🔴', P2: '🟡', P3: '⚪' };
const EVENT_TITLE = {
  created: '🟨 Sticky added',
  dismissed: '✅ Sticky cleared',
  digest: '🟨 Stickies',
};

// Dashboard deep-link for a note. Clicking lands only on the machine running the
// dashboard (localhost) — a desk convenience; the card content is what reads anywhere.
const dashUrl = (id) => `http://127.0.0.1:${dashboardPort()}/#note-${id}`;

let lastPostAt = 0;

// Only accept a real Discord webhook URL. Guards against a typo'd or hostile env var
// quietly turning every sticky you write into a POST at some arbitrary host.
export function parseWebhook(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const ok = host === 'discord.com' || host === 'discordapp.com' || host === 'ptb.discord.com';
  if (!ok) return null;
  if (!/^\/api\/webhooks\//.test(u.pathname)) return null;
  return u.toString();
}

export function isEnabled(env = process.env) {
  return parseWebhook(env[ENV_VAR]) !== null;
}

function shorten(text, max = 300) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function projectLabel(sticky) {
  if (!sticky.project_path) return 'global';
  const parts = String(sticky.project_path).split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || sticky.project_path;
}

// Short "where was this written" tag for a card. The origin values are already plain words;
// we just render them as ` · from terminal`. Missing or 'unknown' origin gets no tag.
const ORIGIN_LABEL = { terminal: 'terminal', desktop: 'desktop', mobile: 'mobile', dashboard: 'dashboard' };
function originTag(sticky) {
  const label = ORIGIN_LABEL[sticky && sticky.origin];
  return label ? ` · from ${label}` : '';
}

// One sticky -> one rich Discord card: full content, priority colour, all metadata,
// and a dashboard deep-link. This is the "see what the pin really is" popup.
export function toEmbed(sticky, event = 'created') {
  const tags = (sticky.tags || []).length ? sticky.tags.map((t) => `\`#${t}\``).join(' ') : '—';
  const links = `[🔗 Open in dashboard →](${dashUrl(sticky.id)})  ·  \`dismiss ${sticky.id}\``;
  return {
    author: { name: EVENT_TITLE[event] ?? EVENT_TITLE.created },
    title: `${BAND[sticky.importance] ?? ''} ${sticky.importance} · ${sticky.category}${originTag(sticky)}`.trim(),
    description: `**${shorten(sticky.content, 3500)}**\n\n${links}`,
    color: COLORS[sticky.importance] ?? COLORS.P3,
    fields: [
      { name: 'priority', value: sticky.importance, inline: true },
      { name: 'type', value: sticky.category, inline: true },
      { name: 'project', value: projectLabel(sticky), inline: true },
      { name: 'tags', value: tags, inline: false },
    ],
    footer: { text: `id ${sticky.id}` },
    timestamp: sticky.updated_at || sticky.created_at,
  };
}

async function post(url, body) {
  // Pace consecutive posts from a single process (Discord: 5 req / 2s per webhook).
  const wait = Math.max(0, lastPostAt + MIN_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPostAt = Date.now();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sanitizeBody(body)),
      signal: ctl.signal,
      // The host allowlist in parseWebhook() is checked against the URL we ASK for. With the
      // default `redirect: 'follow'` the server gets to replace that URL, and fetch will carry
      // the body — your notes — to whatever host a 302 names, with nothing in this file able to
      // see it happen. The allowlist has to hold on the socket that actually carries the payload,
      // so a redirect is an error here, not an instruction. Discord's webhook endpoint does not
      // redirect; anything that does is not the thing we agreed to talk to.
      redirect: 'error',
    });
    if (!res.ok) {
      // Discord's 400 body names the offending field — "embeds.0.fields.0.value: Must be 1024 or
      // fewer in length" — which is the one sentence worth having. Best-effort: a proxy, or a
      // stub, may hand us no readable body at all.
      let detail = '';
      try {
        detail = String((await res.text()) || '').replace(/\s+/g, ' ').slice(0, 300);
      } catch {
        // no body to read; the status alone still says more than nothing
      }
      const error = `discord responded ${res.status}${detail ? ` — ${detail}` : ''}`;
      reportFailure(error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    // A blocked redirect arrives as a bare "fetch failed"; the reason ("unexpected redirect")
    // lives on .cause, and dropping it turns the one interesting failure into the generic one.
    const cause = err?.cause?.message ? ` (${err.cause.message})` : '';
    const error = err?.name === 'AbortError' ? 'timed out' : `${String(err?.message || err)}${cause}`;
    reportFailure(error);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

// Per-note pings are OFF by default: the session report (below) is the surface you read,
// and a webhook that fires on every single write becomes noise you filter out. Opt in with
// STICKIES_NOTIFY_EVENTS=1 if you want the live firehose as well.
export function eventsEnabled(env = process.env) {
  return env.STICKIES_NOTIFY_EVENTS === '1';
}

// Mirror one or more stickies to Discord. `event` is 'created' | 'dismissed'.
// Returns {ok, skipped?, error?} and never throws — callers can ignore the result entirely.
export async function notify(stickies, event = 'created', env = process.env) {
  if (!eventsEnabled(env)) return { ok: false, skipped: 'per-event notifications are off' };

  const url = parseWebhook(env[ENV_VAR]);
  if (!url) return { ok: false, skipped: 'no webhook configured' };

  const list = (Array.isArray(stickies) ? stickies : [stickies]).filter(Boolean);
  if (!list.length) return { ok: false, skipped: 'nothing to send' };

  // Batch: one POST for the whole turn's worth of notes, not one per note.
  const embeds = list.slice(0, MAX_EMBEDS_PER_POST).map((s) => toEmbed(s, event));
  const overflow = list.length - embeds.length;
  const body = { embeds };
  if (overflow > 0) body.content = `_+${overflow} more not shown_`;

  return post(url, body);
}

// Per-phase board status line for the session report, derived from the project's flow board.
// buildBoard() reads the filesystem, so it's wrapped: any failure (no board, unreadable
// planning dir, thrown error) degrades to `null` — no field, never a throw inside notify.
// Returns a Discord field capped at the 1024-char value limit, or null when there's no board.
function boardField(projectPath) {
  if (!projectPath) return null;
  let board;
  try {
    board = buildBoard(projectPath);
  } catch {
    return null;
  }
  if (!board || !board.ok) return null;

  const cards = [...(board.columns?.todo || []), ...(board.columns?.doing || []), ...(board.columns?.done || [])];
  if (!cards.length) return null;

  const phaseNum = (c) => {
    const m = String((c && c.phase) || '').match(/(\d+)/);
    return m ? Number(m[1]) : Infinity;
  };
  cards.sort((a, b) => phaseNum(a) - phaseNum(b));

  const token = (c) => {
    const label = c.phase || 'Phase ?';
    if (c.blocked && c.blocked.count) return `${label} ⛔ blocked`;
    const shipped = c.metadata && c.metadata.shipped;
    if (shipped && shipped.total) return `${label} ✓ ${shipped.done}/${shipped.total}`;
    return `${label} …`;
  };
  // Scrubbed HERE as well as in sanitizeEmbed, and not only for belt-and-braces: the greedy fit
  // below counts characters, and redaction changes them. `AWS_SECRET_ACCESS_KEY=…` in a phase
  // title is longer or shorter once it becomes `AWS_SECRET_ACCESS_KEY=[REDACTED]`, so measuring
  // the raw text and scrubbing afterwards would produce a field that is either over the limit or
  // truncated in the middle of the marker. Scrub first, then measure what will really be sent.
  //
  // A per-phase cap as well, because one absurd ROADMAP heading should cost its own phase its
  // detail, not swallow the whole field's budget and hide every other phase behind "+N more".
  const tokens = cards.map((c) => clean(token(c), 240));

  // Greedily include phases; if we can't fit them all, close with "+N more" and stay under
  // Discord's 1024-char field-value cap (reserve a little room for the suffix).
  const MAX = 1024;
  const RESERVE = 16;
  const parts = [];
  let len = 0;
  for (const t of tokens) {
    const add = (parts.length ? 3 : 0) + t.length; // ' · ' joiner
    const suffixRoom = parts.length < tokens.length - 1 ? RESERVE : 0;
    if (len + add + suffixRoom > MAX) break;
    parts.push(t);
    len += add;
  }
  if (!parts.length) return null;
  const remaining = tokens.length - parts.length;
  const value = parts.join(' · ') + (remaining > 0 ? ` · +${remaining} more` : '');
  return { name: 'board', value, inline: false };
}

// The session report: one post at the end of a Claude Code session saying what happened to
// the board — what got parked, what got cleared, in which folder, over what window.
// This is the primary Discord surface; `notify()` above is the opt-in firehose.
export async function notifySessionReport(
  { created = [], dismissed = [], projectPath, startedAt, endedAt, sessionId } = {},
  env = process.env
) {
  const url = parseWebhook(env[ENV_VAR]);
  if (!url) return { ok: false, skipped: 'no webhook configured' };
  if (!created.length && !dismissed.length) return { ok: false, skipped: 'no activity' };

  const folder = projectPath
    ? String(projectPath).split(/[/\\]/).filter(Boolean).pop()
    : 'global';

  const fmt = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().replace('T', ' ').slice(0, 16);
  };

  const line = (s) => `• \`${s.importance}\` (${s.category}) ${shorten(s.content, 160)}${originTag(s)}`;
  const sections = [];

  if (created.length) {
    sections.push(`**🟨 Parked (${created.length})**`);
    sections.push(...created.slice(0, 12).map(line));
    if (created.length > 12) sections.push(`_…+${created.length - 12} more_`);
    sections.push('');
  }
  if (dismissed.length) {
    sections.push(`**✅ Cleared (${dismissed.length})**`);
    sections.push(...dismissed.slice(0, 12).map(line));
    if (dismissed.length > 12) sections.push(`_…+${dismissed.length - 12} more_`);
  }

  const fields = [
    { name: 'folder', value: `\`${projectPath ?? 'global'}\``, inline: false },
    { name: 'session', value: fmt(startedAt) + ' → ' + fmt(endedAt) + ' UTC', inline: false },
  ];
  const board = boardField(projectPath);
  if (board) fields.push(board);

  return post(url, {
    embeds: [
      {
        title: `🗂️ ${folder} — session report`,
        description: shorten(sections.join('\n').trim(), 3800),
        color: created.some((s) => s.importance === 'P1') ? COLORS.P1 : COLORS.P2,
        fields,
        footer: { text: sessionId ? `session ${String(sessionId).slice(0, 8)}` : 'stickies' },
        timestamp: endedAt || new Date().toISOString(),
      },
    ],
  });
}

// Post the current flow board as a standalone card — a phone-glanceable snapshot of where
// every phase stands (progress, column counts, per-phase shipped/blocked). Reuses the same
// board-status field the session report appends. Opt-in + best-effort like everything here.
export async function notifyBoard(projectPath, env = process.env) {
  const url = parseWebhook(env[ENV_VAR]);
  if (!url) return { ok: false, skipped: 'no webhook configured' };

  let board;
  try { board = buildBoard(projectPath); } catch { board = null; }
  if (!board || !board.ok) return { ok: false, skipped: 'no flow board for this project' };

  const folder = projectPath ? String(projectPath).split(/[/\\]/).filter(Boolean).pop() : 'global';
  const c = board.counts || {};
  const r = board.rollup;

  const fields = [];
  if (r && r.total) fields.push({ name: 'progress', value: `${r.done}/${r.total} plans (${r.pct}%)`, inline: false });
  fields.push({ name: 'columns', value: `☐ ${c.todo || 0} to-do · ▶ ${c.doing || 0} doing · ✓ ${c.done || 0} done`, inline: false });
  const bf = boardField(projectPath);
  if (bf) fields.push(bf);

  return post(url, {
    embeds: [
      {
        title: `📋 ${folder} — flow board`,
        color: COLORS.P2,
        fields,
        footer: { text: 'stickies board' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// Post the current open list — "here's everything still pending" — rather than a single
// lifecycle event. This is the one you'd run on a schedule.
export async function notifyDigest(stickies, project, env = process.env) {
  const url = parseWebhook(env[ENV_VAR]);
  if (!url) return { ok: false, skipped: 'no webhook configured' };

  const label = project ? String(project).split(/[/\\]/).filter(Boolean).pop() : 'all projects';

  if (!stickies.length) {
    return post(url, { content: `🗒️ **${label}** — no open stickies. Clean board.` });
  }

  const byP = (p) => stickies.filter((s) => s.importance === p);
  const lines = [];
  for (const p of ['P1', 'P2', 'P3']) {
    const group = byP(p);
    if (!group.length) continue;
    lines.push(`${BAND[p]} **${p}**`);
    for (const s of group.slice(0, 15)) {
      lines.push(`• \`${s.category}\` ${shorten(s.content, 160)}`);
    }
    if (group.length > 15) lines.push(`_…+${group.length - 15} more_`);
    lines.push('');
  }

  return post(url, {
    embeds: [
      {
        title: `🟨 Full board — ${label}`,
        description: shorten(lines.join('\n').trim(), 3800),
        color: byP('P1').length ? COLORS.P1 : COLORS.P2,
        footer: { text: `${stickies.length} open · /stickies notify --all for global` },
      },
    ],
  });
}
