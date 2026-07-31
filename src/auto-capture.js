#!/usr/bin/env node
// Stop hook entry point: deterministic post-turn auto-write.
//
// Claude Code runs this after the assistant finishes a turn, piping a JSON event on
// stdin: { session_id, transcript_path, cwd, stop_hook_active, hook_event_name }.
// We read the assistant text from the just-completed turn, parse `!!sticky ...`
// directives out of it, and persist them (deduped, scoped to cwd).
//
// Non-blocking and best-effort: any failure exits 0 so a sticky problem never wedges
// the session. We never emit a `block` decision, so there is no risk of a stop loop.
//
// THE INPUT IS NOT TRUSTED. Directives arrive as model output, and model output is shaped by
// whatever the model just read — a cloned repo, a web page, a tool result. src/directives.js
// refuses the mechanically-reproducible forms (quoted, fenced, indented). Everything that gets
// past that is bounded HERE, because volume, scope and validity are capture policy, not
// grammar:
//
//   - at most MAX_CAPTURES_PER_TURN notes are written per turn, and at most EXAMINE_LIMIT
//     directives are even looked at (one quoted file produced 2,000 notes in 1,470 ms, and
//     hooks.json sets no timeout, so the old ceiling was tens of thousands of rows per turn);
//   - control characters are stripped before anything reaches the store (a U+0000 truncated
//     the note at rest, because node:sqlite binds NUL-terminated strings, AND defeated dedup —
//     500 rows all reading `DUPLICATE`);
//   - a note the user DISMISSED is not silently written again;
//   - a bad tag costs you the tag, never the whole note.
//
// The capture loop lives here rather than in store.autoCapture because all of the above is a
// policy about the post-turn hook, not about what a sticky is. The store still owns what gets
// written: every row still goes through createSticky, so redaction, size bounds, path safety
// and TTL are unchanged.

import { readFileSync } from 'node:fs';
import { scanDirectives } from './directives.js';
import { createSticky } from './store.js';
import { getDb, MAX_CONTENT_LENGTH, MAX_TAGS, MAX_TAG_LENGTH } from './db.js';
import { redactAndCap } from './redact.js';
import { isUnsafeProjectPath, normalizeProjectPath, projectIdentity } from './store-path.js';
import { notify } from './notify.js';
import { maybeAutoSync } from './git-sync.js';

// How many notes one turn may create. A turn that genuinely captures more than this is not a
// turn, it is a paste. Twenty is already far above anything observed from real work (one to
// three is typical), and the overflow is reported rather than dropped in silence.
const MAX_CAPTURES_PER_TURN = 20;
// How many directives we are willing to sanitise and look up at all. Separate from the cap
// above because the cap counts CREATED notes: a turn restating fifteen notes it already wrote
// should still be able to add a new one. But the work per directive (redaction, dedup lookup)
// is not free, so the number examined has its own ceiling.
const EXAMINE_LIMIT = MAX_CAPTURES_PER_TURN * 5;

// Set STICKIES_NO_GLOBAL_CAPTURE=1 to refuse unscoped writes from this hook entirely; a
// directive marked `global` is then filed under the current project instead, and you are told.
// Off by default because `global` is a documented feature of the grammar (see USAGE.md and
// test/todo-global-test.mjs) and the parser now refuses the quoted forms that made it
// exploitable — but it is the switch to flip if you want "the Stop hook only ever writes to
// cwd" to be true without exception.
function globalCaptureDisabled() {
  const v = process.env.STICKIES_NO_GLOBAL_CAPTURE;
  return v === '1' || v === 'true';
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref?.();
  });
}

// A turn boundary is a message the *human* sent. Tool results are also logged with
// type 'user', so keying the boundary off `type === 'user'` alone would treat every tool
// call as the start of a new turn — and silently drop any directive written before the
// turn's last tool use.
function isHumanTurnStart(obj) {
  if (!obj || obj.type !== 'user') return false;
  if (obj.isSidechain) return false; // subagent traffic, not the operator
  const content = obj.message?.content;
  if (Array.isArray(content)) return !content.some((b) => b?.type === 'tool_result');
  return true;
}

// Collect assistant text from the final turn (everything after the last human message).
function lastTurnAssistantText(transcriptPath) {
  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let lastUserIdx = -1;
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      obj = null;
    }
    parsed.push(obj);
    if (isHumanTurnStart(obj)) lastUserIdx = i;
  }

  const texts = [];
  for (let i = lastUserIdx + 1; i < parsed.length; i++) {
    const obj = parsed[i];
    if (!obj || obj.type !== 'assistant') continue;
    if (obj.isSidechain) continue; // don't capture directives out of subagent replies
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
  }
  return texts.join('\n');
}

// Control characters are removed from captured content before it reaches the store.
//
// A U+0000 anywhere in the content was the whole bug: node:sqlite binds strings
// NUL-terminated, so the row on disk stopped at the NUL while the value we had just compared
// against was the full string. Every later capture of the same text therefore looked new, and
// one directive repeated 500 times wrote 500 rows that all read `DUPLICATE` in the dashboard.
// The rest are here for the same reason they are refused in a project path
// (src/store-path.js): they are invisible, they survive a round trip through the sync file,
// and none of them mean anything in a one-line note. A tab does mean something, so it becomes
// a space rather than vanishing and gluing two words together.
//
// Written as explicit code-point ranges rather than a regex character class because a class
// of this kind can only be written with \u escapes or with the characters themselves, and
// this project has already been bitten by both: an escape is one careless edit away from
// becoming the literal character, and the literal U+2028 IS a line terminator to the JS
// parser, so the file simply stops loading. scripts/gate.mjs refuses literal invisibles in
// src/ for that reason. Numbers cannot be mistyped invisibly.
const CONTROL_RANGES = [
  [0x00, 0x1f], // C0 controls, including NUL, CR and LF
  [0x7f, 0x9f], // DEL and the C1 controls
  [0x2028, 0x2029], // LINE SEPARATOR / PARAGRAPH SEPARATOR
];

function isControl(code) {
  for (const [lo, hi] of CONTROL_RANGES) if (code >= lo && code <= hi) return true;
  return false;
}

function stripControl(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0);
    if (code === 9) out += ' '; // tab: a separator, so keep the separation
    else if (!isControl(code)) out += ch;
  }
  return out.trim();
}

// Make the tags storable instead of letting them kill the note.
//
// createSticky throws on more than MAX_TAGS tags or any tag over MAX_TAG_LENGTH — correct for a
// caller that can see the error, wrong for this one: the throw was caught one level up and the
// entire note was discarded, so `!!sticky decision P1 #a #b … (21 tags) :: <the actual fact>`
// lost the fact to punish the tags. Tags are decoration; the sentence is the note.
function sanitiseTags(raw) {
  const result = { tags: [], truncated: 0, dropped: 0 };
  if (!Array.isArray(raw)) return result;

  const seen = new Set();
  for (const tag of raw) {
    const clean = stripControl(tag).replace(/^#+/, '');
    if (!clean) {
      result.dropped++;
      continue;
    }
    let value = clean;
    if (value.length > MAX_TAG_LENGTH) {
      value = value.slice(0, MAX_TAG_LENGTH);
      result.truncated++;
    }
    if (seen.has(value)) continue; // a repeat is not a loss, so it is not reported
    if (result.tags.length >= MAX_TAGS) {
      result.dropped++;
      continue;
    }
    seen.add(value);
    result.tags.push(value);
  }
  return result;
}

// The identity two notes must share to be "the same note".
//
// Content alone was not enough. `todo P3 :: X` followed later by `blocker P1 :: X` is an
// ESCALATION — the fact did not change, its urgency did — and keying on content alone dropped
// the second one silently, which is the one occasion you actually needed to hear about. Tags
// and due dates are deliberately NOT in the key: they are metadata the model varies freely, and
// putting them in would turn "same note, one more tag" into a second row.
function dedupKey(scopeId, content, category, importance) {
  return JSON.stringify([scopeId, content, category, importance]);
}

// The identity a DISMISSAL covers: scope + content, regardless of category or importance.
// Dismissing a note is the user saying "I do not want to be told this", so restating it as a
// blocker instead of a todo must not walk it back in through the side door.
function dismissKey(scopeId, content) {
  return JSON.stringify([scopeId, content]);
}

// Everything one turn wants to write, sanitised and classified, before a single row is written.
function prepare(directives, np) {
  const items = [];
  const skipped = { cap: 0, empty: 0, tooLong: 0 };
  const noGlobal = globalCaptureDisabled();
  let downgraded = 0;

  for (const it of directives) {
    if (items.length >= EXAMINE_LIMIT) {
      skipped.cap++;
      continue;
    }

    // Length is checked BEFORE redaction, not after. createSticky rejects anything over the cap,
    // so an over-long directive was going to be refused either way — but redacting first meant
    // the regexes ran on unbounded text from a transcript, and the assignment lookahead is
    // catastrophic on `_`-segmented input: a 14KB run measured 818ms, 130KB measured 17s. That
    // is the post-turn hook, on every turn, driven by whatever text is in the transcript.
    const content = stripControl(it.content);
    if (!content) {
      skipped.empty++;
      continue;
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      skipped.tooLong++;
      continue;
    }
    // The exact value createSticky will store, so dedup compares against reality.
    const stored = redactAndCap(content, MAX_CONTENT_LENGTH).text.trim();
    if (!stored) {
      skipped.empty++;
      continue;
    }

    const wantsGlobal = Boolean(it.global);
    if (wantsGlobal && noGlobal) downgraded++;
    const scope = wantsGlobal && !noGlobal ? null : np;
    const tags = sanitiseTags(it.tags);

    items.push({
      directive: it,
      content,
      stored,
      scope,
      scopeId: projectIdentity(scope),
      tags: tags.tags,
      tagsTruncated: tags.truncated,
      tagsDropped: tags.dropped,
    });
  }

  return { items, skipped, downgraded };
}

// Pull every stored row that could collide with this turn, in ONE query. Per-directive lookups
// would each scan the table (content is not indexed), and this hook runs after every turn.
function existingRows(db, items) {
  const contents = [...new Set(items.map((i) => i.stored))];
  if (!contents.length) return [];
  const placeholders = contents.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT content, category, importance, project_path, status
         FROM stickies
        WHERE content IN (${placeholders})`
    )
    .all(...contents);
}

// Persist one turn's directives. Returns { created, skipped, tagsTruncated, tagsDropped,
// downgraded } — every counter here exists so the hook can TELL the user what it did not do.
export function captureTurn(directives, project_path, { origin = 'unknown', session_id = null } = {}) {
  // Same rule as createSticky: normalizing an unsafe path yields null, and null means GLOBAL —
  // so accepting one would file every captured note into every project's digest.
  if (isUnsafeProjectPath(project_path)) {
    throw new Error('project_path contains characters that are not valid in a filesystem path');
  }
  const np = normalizeProjectPath(project_path);
  const { items, skipped, downgraded } = prepare(directives, np);

  const counts = { ...skipped, duplicate: 0, dismissed: 0, invalid: 0 };
  const created = [];
  let tagsTruncated = 0;
  let tagsDropped = 0;

  const db = getDb();
  const active = new Set();
  const dismissed = new Set();
  for (const row of existingRows(db, items)) {
    const scopeId = projectIdentity(row.project_path);
    if (row.status === 'dismissed') dismissed.add(dismissKey(scopeId, row.content));
    // 'stale' is an EXPIRY, not a decision — a fact that timed out and is being restated should
    // be re-captured, which is why only 'active' blocks as a duplicate.
    else if (row.status === 'active') active.add(dedupKey(scopeId, row.content, row.category, row.importance));
  }

  for (const item of items) {
    if (created.length >= MAX_CAPTURES_PER_TURN) {
      counts.cap++;
      continue;
    }
    if (dismissed.has(dismissKey(item.scopeId, item.stored))) {
      counts.dismissed++;
      continue;
    }
    const key = dedupKey(item.scopeId, item.stored, item.directive.category, item.directive.importance);
    if (active.has(key)) {
      counts.duplicate++;
      continue;
    }

    try {
      created.push(
        createSticky({
          content: item.content,
          category: item.directive.category,
          importance: item.directive.importance,
          tags: item.tags,
          project_path: item.scope,
          source: 'auto',
          origin,
          session_id,
          due_at: item.directive.due, // raw token; createSticky resolves it against now
        })
      );
      // Written now, so a turn that states the same thing twice writes it once. The lookup above
      // ran before any insert, so without this the second copy would find nothing and duplicate.
      active.add(key);
      tagsTruncated += item.tagsTruncated;
      tagsDropped += item.tagsDropped;
    } catch {
      // Malformed directive (e.g. a category that slipped through the grammar) — skip it.
      counts.invalid++;
    }
  }

  return { created, skipped: counts, tagsTruncated, tagsDropped, downgraded };
}

// One honest line about what was NOT written. The hook used to destructure `{ created }` and
// throw the rest away, so dedup, validation failures and (once there was one) the per-turn cap
// were all invisible: the user's evidence that a note had been dropped was the note not being
// there. Phrased as plain reasons because the point is that you can act on them.
export function skipSummary(result = {}, ignored = {}) {
  const parts = [];
  let total = 0;
  const add = (n, label) => {
    if (n > 0) {
      total += n;
      parts.push(`${n} ${label}`);
    }
  };
  const s = result.skipped || {};

  add(s.duplicate, 'already captured');
  add(s.dismissed, 'previously dismissed by you (write it again from the dashboard if you want it back)');
  add(s.cap, `over the per-turn cap of ${MAX_CAPTURES_PER_TURN}`);
  add(s.tooLong, `longer than ${MAX_CONTENT_LENGTH} characters`);
  add(s.empty, 'empty once control characters were stripped');
  add(s.invalid, 'rejected by validation');
  add(ignored.fenced, 'inside a code fence (quoted, not written)');
  add(ignored.indented, 'indented (quoted, not written)');
  add(ignored.malformed, 'not valid directive syntax');

  // These were captured, just not as asked — a different line, because "not captured" and
  // "captured differently" are different things to be told.
  const changed = [];
  if (result.downgraded) changed.push(`${result.downgraded} global directive(s) filed under this project instead (STICKIES_NO_GLOBAL_CAPTURE)`);
  if (result.tagsTruncated) changed.push(`${result.tagsTruncated} tag(s) shortened to ${MAX_TAG_LENGTH} chars`);
  if (result.tagsDropped) changed.push(`${result.tagsDropped} tag(s) dropped (max ${MAX_TAGS} per note)`);

  const lines = [];
  if (parts.length) lines.push(`stickies: ${total} directive(s) not captured — ${parts.join(', ')}`);
  if (changed.length) lines.push(`stickies: ${changed.join(', ')}`);
  return lines;
}

async function main() {
  let event = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) event = JSON.parse(raw);
  } catch {
    return; // no usable event
  }

  const transcriptPath = event.transcript_path;
  const projectPath = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!transcriptPath) return;

  let text = '';
  try {
    text = lastTurnAssistantText(transcriptPath);
  } catch {
    return; // transcript unreadable
  }

  const { directives, ignored } = scanDirectives(text);
  const ignoredTotal = ignored.fenced + ignored.indented + ignored.malformed;
  if (directives.length === 0) {
    // Nothing to write, so do not touch the database at all — opening it would create the store
    // on a turn that captured nothing. But a refusal is still worth saying out loud: "I wrote a
    // directive and no note appeared" is the confusing case, and it is exactly the case a quoted
    // or fenced line produces.
    if (ignoredTotal > 0) {
      for (const line of skipSummary({}, ignored)) process.stderr.write(line + '\n');
    }
    return;
  }

  try {
    // The Stop hook only fires inside Claude Code's CLI, so these notes are 'terminal';
    // the event carries the session that produced them, for per-session grouping.
    const result = captureTurn(directives, projectPath, {
      origin: 'terminal',
      session_id: event.session_id || null,
    });
    const { created } = result;
    if (created.length) {
      process.stderr.write(`stickies: auto-captured ${created.length} sticky(ies) this turn\n`);
    }
    for (const line of skipSummary(result, ignored)) process.stderr.write(line + '\n');
    if (created.length) {
      // Only sync when we actually captured something new (opt-in, best-effort).
      const synced = maybeAutoSync();
      if (synced && !synced.error) process.stderr.write('stickies: auto-synced new sticky(ies)\n');
      // One batched post for the turn, not one per note.
      await notify(created, 'created');
    }
  } catch (err) {
    process.stderr.write(`stickies auto-capture failed: ${err.message}\n`);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
