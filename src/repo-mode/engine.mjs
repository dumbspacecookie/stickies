#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Stickies repo-mode engine — SELF-CONTAINED, ZERO DEPENDENCIES.
// ---------------------------------------------------------------------------
// This single file is committed into a project repo (at .stickies/engine.mjs) so
// stickies works inside an ephemeral cloud session (mobile / claude.ai/code),
// where the user-scope plugin and its node_modules do not exist. Verified in a
// cloud sandbox 2026-07-15: repo-scoped hooks fire and a committed store persists.
//
// Source of truth : .stickies/notes.json   (synced, machine-readable)
// Human mirror     : .stickies/NOTES.md     (auto-generated, nice PR diffs)
//
// Two modes, wired via the repo's .claude/settings.json:
//   node .stickies/engine.mjs digest    (SessionStart)  -> inject the note digest
//   node .stickies/engine.mjs capture    (Stop)          -> parse !!sticky, persist
//
// Everything below (directive parsing, secret redaction) is inlined from the main
// package so this file has no imports beyond node core — nothing to install.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STORE = join(ROOT, '.stickies', 'notes.json');
const MIRROR = join(ROOT, '.stickies', 'NOTES.md');

// ---- store -----------------------------------------------------------------
function loadStore() {
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf8'));
    return Array.isArray(data.notes) ? data : { notes: [] };
  } catch {
    return { notes: [] };
  }
}
function saveStore(store) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
}

// ---- secret redaction (inlined from src/redact.js) -------------------------
const CONNECTION_URI = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s@/]+@/gi;
const TOKEN_PATTERNS = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /dop_v1_[a-f0-9]{64}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const SENSITIVE =
  'password|passwd|passphrase|pwd|secret|token|apikey|api[_-]?key|access[_-]?key|' +
  'access[_-]?token|client[_-]?secret|bearer|auth[_-]?token|credential|private[_-]?key';
const ASSIGNMENT = new RegExp(
  '(["\'`]?)' +
    '((?=(?:[A-Za-z0-9]+[_.-])*(?:' + SENSITIVE + ')(?:[_.-]|["\'`:=\\s]|$))' +
    '[A-Za-z0-9_.-]+)' +
    '\\1' +
    '(\\s*[:=]\\s*)' +
    '(?:"([^"\\r\\n]{3,})"|\'([^\'\\r\\n]{3,})\'|`([^`\\r\\n]{3,})`|([^\\r\\n,;]{3,}))',
  'gi',
);
function redactSecrets(input) {
  let text = String(input);
  let redacted = false;
  const hit = () => { redacted = true; };
  text = text.replace(CONNECTION_URI, (_m, scheme) => { hit(); return `${scheme}[REDACTED]@`; });
  for (const re of TOKEN_PATTERNS) text = text.replace(re, () => { hit(); return '[REDACTED]'; });
  text = text.replace(ASSIGNMENT, (m, q, key, sep, dq, sq, bq, bare) => {
    if (dq === undefined && sq === undefined && bq === undefined && bare === undefined) return m;
    hit();
    if (dq !== undefined) return `${q}${key}${q}${sep}"[REDACTED]"`;
    if (sq !== undefined) return `${q}${key}${q}${sep}'[REDACTED]'`;
    if (bq !== undefined) return `${q}${key}${q}${sep}\`[REDACTED]\``;
    return `${q}${key}${q}${sep}[REDACTED]`;
  });
  return { text, redacted };
}

// ---- directive parsing (inlined from src/directives.js) --------------------
const CATEGORY = '(decision|blocker|preference|context|todo)';
const MODIFIER = String.raw`(?:\[?P[123]\]?|global|#[\w./-]+)`; // tolerate bracketed [P2]
const DIRECTIVE = new RegExp(
  String.raw`^\s*!!sticky\s+${CATEGORY}` +
    String.raw`((?:\s+${MODIFIER})*)` +
    String.raw`\s*::\s*(.+?)\s*$`,
  'i',
);
function parseDirectives(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(DIRECTIVE);
    if (!m) continue;
    const category = m[1].toLowerCase();
    const modifiers = (m[2] || '').split(/\s+/).filter(Boolean);
    const importance = (modifiers.find((t) => /^\[?P[123]\]?$/i.test(t)) || 'P2').replace(/[[\]]/g, '').toUpperCase();
    const tags = modifiers.filter((t) => t.startsWith('#')).map((t) => t.slice(1).trim()).filter(Boolean);
    const content = m[3].trim();
    if (!content) continue;
    out.push({ category, importance, tags, content });
  }
  return out;
}

// ---- transcript reading (inlined from src/auto-capture.js) -----------------
function isHumanTurnStart(obj) {
  if (!obj || obj.type !== 'user' || obj.isSidechain) return false;
  const content = obj.message?.content;
  if (Array.isArray(content)) return !content.some((b) => b?.type === 'tool_result');
  return true;
}
function lastTurnAssistantText(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const parsed = [];
  let lastUserIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    let obj = null;
    try { obj = JSON.parse(lines[i]); } catch { /* skip */ }
    parsed.push(obj);
    if (isHumanTurnStart(obj)) lastUserIdx = i;
  }
  const texts = [];
  for (let i = lastUserIdx + 1; i < parsed.length; i++) {
    const obj = parsed[i];
    if (!obj || obj.type !== 'assistant' || obj.isSidechain) continue;
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    } else if (typeof content === 'string') texts.push(content);
  }
  return texts.join('\n');
}

// ---- NOTES.md mirror -------------------------------------------------------
const BAND = { P1: '🔴 P1 — critical', P2: '🟡 P2', P3: '⚪ P3 — minor' };
function renderMirror(notes) {
  const open = notes.filter((n) => !n.dismissed);
  const lines = ['# Stickies', '', `_${open.length} open note(s). Auto-generated from notes.json — do not edit by hand._`, ''];
  if (!open.length) lines.push('_No open notes._');
  for (const band of ['P1', 'P2', 'P3']) {
    const group = open.filter((n) => (n.importance || 'P2') === band);
    if (!group.length) continue;
    lines.push(`## ${BAND[band]}`, '');
    for (const n of group) {
      const tags = (n.tags || []).length ? ' ' + n.tags.map((t) => `\`#${t}\``).join(' ') : '';
      lines.push(`- **[${n.category}]** ${n.content}${tags}`);
    }
    lines.push('');
  }
  writeFileSync(MIRROR, lines.join('\n').replace(/\n+$/, '\n'));
}

// ---- git (best-effort; never throws) ---------------------------------------
function git(args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').trim() };
  }
}
function autocommit(n) {
  if (/^(0|false|no|off)$/i.test(process.env.STICKIES_REPO_AUTOCOMMIT || '')) return 'autocommit off';
  git(['add', '.stickies/notes.json', '.stickies/NOTES.md']);
  const c = git(['-c', 'user.email=stickies@repo.local', '-c', 'user.name=stickies',
    'commit', '-m', `stickies: capture ${n} note(s)`]);
  if (!c.ok) return `commit skipped (${c.out.split('\n')[0] || 'nothing to commit'})`;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'HEAD';
  const p = git(['push', 'origin', `HEAD:${branch}`]);
  return p.ok ? `committed + pushed to ${branch}` : `committed; push skipped (${p.out.split('\n')[0]})`;
}

// ---- optional Discord mirror (inlined, opt-in): rich cards ------------------
const DCOLORS = { P1: 0xe5534b, P2: 0xd9a441, P3: 0x8b949e };
const DBAND = { P1: '🔴', P2: '🟡', P3: '⚪' };

// Link to the committed board on GitHub — works from a phone (unlike a localhost
// dashboard). Derived from origin; points at main's NOTES.md (the converged board).
function boardUrl() {
  const r = git(['remote', 'get-url', 'origin']);
  if (!r.ok) return null;
  const m = r.out.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/main/.stickies/NOTES.md` : null;
}

async function toDiscord(created) {
  const raw = process.env.STICKIES_DISCORD_WEBHOOK;
  if (!raw) return 'discord off';
  let url;
  try {
    url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const ok = ['discord.com', 'discordapp.com', 'ptb.discord.com'].includes(host) && /^\/api\/webhooks\//.test(url.pathname);
    if (!ok) return 'discord: invalid webhook';
  } catch { return 'discord: invalid webhook'; }

  const board = boardUrl();
  const embeds = created.slice(0, 10).map((n) => {
    const tags = (n.tags || []).length ? n.tags.map((t) => `\`#${t}\``).join(' ') : '—';
    const link = board ? `\n\n[🟨 View board on GitHub →](${board})` : '';
    return {
      author: { name: '🟨 Sticky added (repo-mode)' },
      title: `${DBAND[n.importance] || ''} ${n.importance} · ${n.category}`.trim(),
      description: `**${String(n.content).slice(0, 3500)}**${link}`,
      color: DCOLORS[n.importance] || DCOLORS.P3,
      fields: [
        { name: 'priority', value: n.importance, inline: true },
        { name: 'type', value: n.category, inline: true },
        { name: 'tags', value: tags, inline: false },
      ],
      timestamp: n.created || new Date().toISOString(),
    };
  });
  try {
    const res = await fetch(url.toString(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embeds }),
    });
    return res.ok ? 'discord: posted' : `discord: HTTP ${res.status}`;
  } catch (e) { return `discord: ${e.message}`; }
}

// ---- modes -----------------------------------------------------------------
function normContent(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

function digest() {
  const open = loadStore().notes.filter((n) => !n.dismissed);
  const body = open.length
    ? `Stickies — ${open.length} open note(s):\n` +
      ['P1', 'P2', 'P3'].flatMap((band) =>
        open.filter((n) => (n.importance || 'P2') === band)
          .map((n) => `  - [${band}/${n.category}] ${n.content}`),
      ).join('\n')
    : 'Stickies: no open notes for this repo.';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `🟨 ${body}` },
  }));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let d = '';
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(d); };
    const timer = setTimeout(finish, 1000);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function capture() {
  let event = {};
  try { const raw = await readStdin(); if (raw.trim()) event = JSON.parse(raw); } catch { return; }
  if (!event.transcript_path) return;

  let text = '';
  try { text = lastTurnAssistantText(event.transcript_path); } catch { return; }
  const directives = parseDirectives(text);
  if (!directives.length) return;

  const store = loadStore();
  const openKeys = new Set(store.notes.filter((n) => !n.dismissed).map((n) => `${n.category}::${normContent(n.content)}`));
  const created = [];
  for (const d of directives) {
    const { text: safe } = redactSecrets(d.content);
    const key = `${d.category}::${normContent(safe)}`;
    if (openKeys.has(key)) continue; // dedup within this repo's open notes
    openKeys.add(key);
    const tags = (d.tags || []).map((t) => redactSecrets(t).text);
    const note = {
      id: randomUUID(), content: safe, category: d.category, importance: d.importance,
      tags, created: new Date().toISOString(), dismissed: false,
    };
    store.notes.push(note);
    created.push(note);
  }
  if (!created.length) return;

  saveStore(store);
  renderMirror(store.notes);
  const persisted = autocommit(created.length);
  const posted = await toDiscord(created);
  process.stderr.write(`stickies(repo): captured ${created.length}; ${persisted}; ${posted}\n`);
}

// reconcile <incoming-notes.json> — merge another branch's store into this one
// (used by the stickies-sync GitHub Action to converge every session branch into
// main). Union by id, dismiss-wins on id collisions, then collapse open notes with
// identical category+content so repeated sessions don't pile up duplicates.
function reconcile(incomingPath) {
  const base = loadStore();
  let incoming = [];
  try { incoming = JSON.parse(readFileSync(incomingPath, 'utf8')).notes || []; } catch { return; }

  const byId = new Map(base.notes.map((n) => [n.id, n]));
  for (const n of incoming) {
    if (!byId.has(n.id)) { base.notes.push(n); byId.set(n.id, n); }
    else if (n.dismissed) byId.get(n.id).dismissed = true; // dismiss wins
  }

  // Collapse duplicate OPEN notes, keeping the earliest by created timestamp.
  const ordered = [...base.notes].sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const seen = new Set();
  const kept = [];
  for (const n of ordered) {
    if (n.dismissed) { kept.push(n); continue; }
    const key = `${n.category}::${normContent(n.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(n);
  }
  base.notes = kept;
  saveStore(base);
  renderMirror(base.notes);
  process.stderr.write(`stickies(repo): reconciled -> ${kept.filter((n) => !n.dismissed).length} open note(s)\n`);
}

const mode = process.argv[2];
const run = mode === 'digest' ? async () => digest()
  : mode === 'capture' ? capture
  : mode === 'reconcile' ? async () => reconcile(process.argv[3])
  : null;
if (!run) { process.stderr.write('usage: engine.mjs <digest|capture|reconcile <file>>\n'); process.exit(1); }
// Release the stdin pipe and let the loop drain naturally. Calling process.exit()
// here races libuv closing the pipe on Windows (Assertion failed … async.c), so we
// set the code and destroy stdin instead of force-exiting.
run().catch(() => {}).finally(() => {
  try { process.stdin.destroy(); } catch { /* ignore */ }
  process.exitCode = 0;
});
