// Optional outbound notifications: mirror sticky lifecycle events to a Discord webhook.
//
// Off unless STICKIES_DISCORD_WEBHOOK is set, so the default install never talks to the
// network. Every function here is best-effort: a webhook that is down, slow, or
// misconfigured must never fail a sticky write or stall a hook. We swallow, we don't throw.
//
// Content posted here has already been through redactSecrets() in store.js, so a webhook
// cannot become a secret-exfiltration path for anything the redactor recognises. It is
// still an outbound copy of your notes — that's the deal you opt into by setting the env var.

const ENV_VAR = 'STICKIES_DISCORD_WEBHOOK';
const TIMEOUT_MS = 3000;

// Discord's documented webhook limit is 5 requests per 2s per webhook. We pace well under
// it; a burst (e.g. auto-capture writing several notes in one turn) is batched into a
// single POST instead of one POST per note, so the limit is not a practical concern.
const MIN_INTERVAL_MS = 400;
const MAX_EMBEDS_PER_POST = 10; // Discord hard limit

const COLORS = { P1: 0xe5534b, P2: 0xd9a441, P3: 0x8b949e };
const EVENT_TITLE = {
  created: '📌 Sticky added',
  dismissed: '✅ Sticky cleared',
  digest: '🗒️ Stickies digest',
};

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

// One sticky -> one Discord embed.
export function toEmbed(sticky, event = 'created') {
  return {
    title: EVENT_TITLE[event] ?? EVENT_TITLE.created,
    description: shorten(sticky.content),
    color: COLORS[sticky.importance] ?? COLORS.P3,
    fields: [
      { name: 'priority', value: sticky.importance, inline: true },
      { name: 'type', value: sticky.category, inline: true },
      { name: 'project', value: projectLabel(sticky), inline: true },
    ],
    footer: { text: sticky.id },
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
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `discord responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err) };
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

  const line = (s) => `• \`${s.importance}\` (${s.category}) ${shorten(s.content, 160)}`;
  const sections = [];

  if (created.length) {
    sections.push(`**📌 Parked (${created.length})**`);
    sections.push(...created.slice(0, 12).map(line));
    if (created.length > 12) sections.push(`_…+${created.length - 12} more_`);
    sections.push('');
  }
  if (dismissed.length) {
    sections.push(`**✅ Cleared (${dismissed.length})**`);
    sections.push(...dismissed.slice(0, 12).map(line));
    if (dismissed.length > 12) sections.push(`_…+${dismissed.length - 12} more_`);
  }

  return post(url, {
    embeds: [
      {
        title: `🗂️ ${folder} — session report`,
        description: shorten(sections.join('\n').trim(), 3800),
        color: created.some((s) => s.importance === 'P1') ? COLORS.P1 : COLORS.P2,
        fields: [
          { name: 'folder', value: `\`${projectPath ?? 'global'}\``, inline: false },
          { name: 'session', value: fmt(startedAt) + ' → ' + fmt(endedAt) + ' UTC', inline: false },
        ],
        footer: { text: sessionId ? `session ${String(sessionId).slice(0, 8)}` : 'stickies' },
        timestamp: endedAt || new Date().toISOString(),
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
    lines.push(`**${p}**`);
    for (const s of group.slice(0, 15)) {
      lines.push(`• (${s.category}) ${shorten(s.content, 140)}`);
    }
    if (group.length > 15) lines.push(`_…+${group.length - 15} more_`);
  }

  return post(url, {
    embeds: [
      {
        title: `🗒️ Open stickies — ${label}`,
        description: shorten(lines.join('\n'), 3800),
        color: byP('P1').length ? COLORS.P1 : COLORS.P2,
        footer: { text: `${stickies.length} open` },
      },
    ],
  });
}
