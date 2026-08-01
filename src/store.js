// Core sticky operations, independent of any transport (MCP, CLI, hooks all use this).

import { randomUUID } from 'node:crypto';
import {
  getDb,
  CATEGORY_TTL_DAYS,
  CATEGORIES,
  IMPORTANCES,
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
} from './db.js';
import { redactSecrets, redactAndCap } from './redact.js';
import { normalizeProjectPath, isUnsafeProjectPath, projectIdentity, canonicalSpelling } from './store-path.js';
import { deriveProjectKey } from './project-key.js';
import { normalizeOrigin } from './origin.js';
import { resolveDueDate } from './due.js';

export { normalizeProjectPath };

const IMPORTANCE_RANK = { P1: 1, P2: 2, P3: 3 };

// Accept either an already-resolved ISO instant or a raw due token ("1h", "2026-07-20").
// A token is resolved against now; an unparseable value degrades to null (no due date)
// rather than throwing — a bad deadline must never block capturing the note itself.
function normalizeDueAt(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  // Already an ISO instant? Keep it verbatim (this is the sync/import path).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? s : null;
  }
  return resolveDueDate(s);
}

function nowIso() {
  return new Date().toISOString();
}

// expires_at = created_at + category TTL, as ISO 8601. A null TTL means the category
// never expires (see CATEGORY_TTL_DAYS); sweepExpired already skips null expires_at.
function computeExpiry(category, fromIso) {
  const days = CATEGORY_TTL_DAYS[category];
  if (days === null || days === undefined) return null;
  const base = new Date(fromIso).getTime();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

// Turn a DB row into a clean object (parse JSON tags).
function safeParseTags(raw) {
  try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t : [];
  } catch {
    return []; // a corrupt tags value must not break reads of this or other rows
  }
}

function rowToSticky(row) {
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    importance: row.importance,
    project_path: row.project_path,
    project_key: row.project_key ?? null,
    tags: safeParseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    source: row.source,
    origin: row.origin ?? 'unknown',
    session_id: row.session_id ?? null,
    due_at: row.due_at ?? null,
    status: row.status,
    dismiss_reason: row.dismiss_reason ?? null,
  };
}

// Lazily flip any active-but-expired stickies to 'stale' so reads stay honest.
function sweepExpired(db) {
  db.prepare(
    `UPDATE stickies
        SET status = 'stale', updated_at = @now
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= @now`
  ).run({ now: nowIso() });
}

export function createSticky({
  content,
  category,
  importance = 'P2',
  tags = [],
  project_path = null,
  source = 'auto',
  origin = 'unknown',
  session_id = null,
  due_at = null,
}) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('content is required and must be a non-empty string');
  }
  // A project path carrying markup characters normalizes to null, and null means GLOBAL — so
  // silently accepting one would file the note into every project's digest, which is the exact
  // boundary the scoping exists to hold. Refuse it out loud instead.
  if (isUnsafeProjectPath(project_path)) {
    throw new Error('project_path contains characters that are not valid in a filesystem path');
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content exceeds ${MAX_CONTENT_LENGTH} characters (got ${content.length})`);
  }
  if (!CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!IMPORTANCES.includes(importance)) {
    throw new Error(`importance must be one of: ${IMPORTANCES.join(', ')}`);
  }
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw new Error('tags must be an array of strings');
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`too many tags (max ${MAX_TAGS}, got ${tags.length})`);
  }
  if (tags.some((t) => t.length > MAX_TAG_LENGTH)) {
    throw new Error(`each tag must be <= ${MAX_TAG_LENGTH} characters`);
  }
  if (source !== 'auto' && source !== 'manual') {
    throw new Error("source must be 'auto' or 'manual'");
  }

  // Scrub obvious secrets before they are persisted (and later synced). Tags sync
  // verbatim just like content, so a credential-shaped tag must be redacted too.
  // Capped again AFTER redaction. The length check above runs on the raw text, but `[REDACTED]`
  // is longer than many of the things it replaces — a 496-char note of comma-separated assignments
  // measured 769 chars once redacted, so a value that passed validation was stored 269 over the
  // limit the rest of the system relies on.
  const { text: safeContent, redacted: contentRedacted } = redactAndCap(content.trim(), MAX_CONTENT_LENGTH);
  const safeTags = tags.map((t) => redactAndCap(t, MAX_TAG_LENGTH).text);
  const redacted = contentRedacted || safeTags.some((t, i) => t !== tags[i]);

  const db = getDb();
  const now = nowIso();
  const np = normalizeProjectPath(project_path);
  const sticky = {
    id: randomUUID(),
    content: safeContent,
    category,
    importance,
    project_path: np,
    project_key: deriveProjectKey(np),
    tags: JSON.stringify(safeTags),
    created_at: now,
    updated_at: now,
    expires_at: computeExpiry(category, now),
    source,
    origin: normalizeOrigin(origin),
    session_id: session_id ? String(session_id) : null,
    due_at: normalizeDueAt(due_at),
    status: 'active',
    dismiss_reason: null,
  };

  db.prepare(
    `INSERT INTO stickies
       (id, content, category, importance, project_path, project_key, tags,
        created_at, updated_at, expires_at, source, origin, session_id, due_at, status, dismiss_reason)
     VALUES
       (@id, @content, @category, @importance, @project_path, @project_key, @tags,
        @created_at, @updated_at, @expires_at, @source, @origin, @session_id, @due_at, @status, @dismiss_reason)`
  ).run(sticky);

  // `redacted` is informational only (not persisted) so callers can warn the user.
  return { ...rowToSticky({ ...sticky }), redacted };
}

// Retrieve active stickies relevant to a session.
// Returns project-scoped stickies, plus global (project_path IS NULL) when include_global.
export function readStickies({
  project_path = null,
  limit = 50,
  include_global = true,
  min_importance = 'P3',
} = {}) {
  const db = getDb();
  sweepExpired(db);

  const maxRank = IMPORTANCE_RANK[min_importance] ?? 3;
  project_path = normalizeProjectPath(project_path);

  const clauses = ["status = 'active'"];
  const params = {};

  if (project_path) {
    // Match by machine-independent project_key (cross-machine), OR by project_path
    // (same machine / non-git / pre-migration rows with no key). Plus globals when asked.
    params.project_path = project_path;
    params.project_key = deriveProjectKey(project_path);
    const scope = '(project_key = @project_key OR project_path = @project_path';
    clauses.push(include_global ? `${scope} OR project_path IS NULL)` : `${scope})`);
  } else if (!include_global) {
    // No project scope and global excluded -> nothing matches by definition.
    clauses.push('1 = 0');
  }
  // (no project_path + include_global) -> return everything active

  const rows = db
    .prepare(
      `SELECT * FROM stickies
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE importance WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END ASC,
          created_at DESC`
    )
    .all(params);

  return rows
    .map(rowToSticky)
    .filter((s) => IMPORTANCE_RANK[s.importance] <= maxRank)
    .slice(0, limit);
}

// Every project (distinct non-null project_path) with active stickies, plus a per-importance
// count and a blocker tally — the raw material for the cross-project command center. Globals
// (project_path IS NULL) belong to no single project and are excluded here.
// Every project this machine has ever stored a note for, whatever became of those notes.
//
// Deliberately NOT projectSummaries(): that one filters `status = 'active'` because it feeds a
// display of what is on your board right now. Using it for the dashboard's project allowlist
// meant a project UN-REGISTERED itself the moment you dismissed its last note — so clearing your
// board, the tidy thing to do, is what took the board away. The Flow Board reads ROADMAP.md and
// has nothing to do with stickies at all, so a project with a roadmap and an empty note board
// could never be opened again.
//
// A dismissed note is still evidence that this is a project of yours, which is exactly what the
// allowlist is asking. No sweepExpired() here either: rebuilding an allowlist should not write.
// Deliberately NOT folded by project identity, unlike projectSummaries() below.
//
// On Windows this can return two spellings of one folder, and its two consumers both want that:
// project-scope.js uses it as an allowlist and already matches a request by identity, so folding
// here would only shrink a set that must stay a superset; and the dashboard's project switcher
// folds it for display at the point where it renders (/api/projects). Folding in all three places
// would be a rule with two homes and no test that could tell them apart.
export function registeredProjects() {
  return getDb()
    .prepare('SELECT DISTINCT project_path AS path FROM stickies WHERE project_path IS NOT NULL')
    .all()
    .map((r) => r.path);
}

// Group values by the identity of their project path — the ONE case rule in this codebase, which
// is a no-op on POSIX where /home/A and /home/a really are two directories. Returns
// [{ identity, spellings, items }] in first-seen order.
function foldByIdentity(items, pathOf) {
  const byId = new Map();
  for (const item of items) {
    const path = pathOf(item);
    const id = projectIdentity(path);
    if (!id) continue; // a path that normalizes to nothing was never scopable to begin with
    const acc = byId.get(id) || { identity: id, spellings: [], items: [] };
    acc.spellings.push(path);
    acc.items.push(item);
    byId.set(id, acc);
  }
  return [...byId.values()];
}

export function projectSummaries() {
  const db = getDb();
  sweepExpired(db);
  const rows = db
    .prepare(
      `SELECT project_path AS path,
              COUNT(*) AS total,
              SUM(CASE WHEN importance = 'P1' THEN 1 ELSE 0 END) AS p1,
              SUM(CASE WHEN importance = 'P2' THEN 1 ELSE 0 END) AS p2,
              SUM(CASE WHEN importance = 'P3' THEN 1 ELSE 0 END) AS p3,
              SUM(CASE WHEN category = 'blocker' THEN 1 ELSE 0 END) AS blockers,
              MAX(created_at) AS lastTouched
         FROM stickies
        WHERE status = 'active' AND project_path IS NOT NULL
        GROUP BY project_path`
    )
    .all();

  // GROUP BY groups on the stored spelling, which on Windows is not the same thing as grouping by
  // project. One folder written to from two shells that capitalised the path differently came back
  // as TWO rows with the counts split between them — twelve notes reported as seven and five — and
  // the command centre drew a card for each half, each with its own board and its own P1 tally.
  //
  // readStickies() never had this problem because it scopes on project_key, which is already built
  // from projectIdentity(). The folding was on the read path and not on the aggregates. Folded in
  // JS rather than with SQL LOWER() so there is one case rule and not two: LOWER() is ASCII-only
  // in SQLite and does nothing on POSIX, where merging /home/A into /home/a would pour one real
  // project's notes into another's.
  return foldByIdentity(rows, (r) => r.path).map(({ spellings, items }) => {
    const sum = (f) => items.reduce((n, r) => n + (r[f] || 0), 0);
    const lastTouched = items.reduce((m, r) => (r.lastTouched && (!m || r.lastTouched > m) ? r.lastTouched : m), null);
    return {
      project_path: canonicalSpelling(spellings),
      stickies: { total: sum('total'), p1: sum('p1'), p2: sum('p2'), p3: sum('p3'), blockers: sum('blockers') },
      lastTouched,
    };
  });
}

// `autoCapture` used to live here and is deliberately gone.
//
// It persisted a batch of parsed directives, and its dedup was the bug: it keyed on content
// alone and considered only rows with status='active'. So an escalation (`todo P3 :: X` then
// `blocker P1 :: X`) was silently dropped as a duplicate, and a note you had deliberately
// DISMISSED came straight back the next time the model restated it.
//
// That policy now lives in `src/auto-capture.js`, which calls `createSticky` directly and keys
// dedup on scope + content + category + importance while remembering dismissals. Leaving the old
// function here as unreachable code would have been an invitation: the next caller would get the
// old behaviour back with no warning, because nothing about the name says which one is wrong.

export function getSticky(id) {
  const db = getDb();
  return rowToSticky(db.prepare('SELECT * FROM stickies WHERE id = ?').get(id));
}

// Every sticky (any status) as clean objects — used to build a sync export so that
// dismissals and stale state propagate across machines, not just active notes.
export function exportAllRows() {
  const db = getDb();
  // Stable order (id breaks created_at ties) so re-exporting identical data is
  // byte-identical across machines — no spurious git diffs.
  return db.prepare('SELECT * FROM stickies ORDER BY created_at ASC, id ASC').all().map(rowToSticky);
}

// Merge one record from a sync document into the local DB. Identity is the uuid;
// conflicts resolve last-writer-wins on updated_at (ISO 8601 UTC sorts lexically).
// Returns 'added' | 'updated' | 'skipped'.
export function upsertFromSync(rec) {
  if (!rec || typeof rec.id !== 'string') return 'skipped';
  if (!CATEGORIES.includes(rec.category) || !IMPORTANCES.includes(rec.importance)) return 'skipped';
  // The SAME rule createSticky applies at the top of this file, and it was missing here — the one
  // place the input is genuinely untrusted. Every other field was validated; content was handed
  // straight to redactAndCap, whose `String(input ?? '')` turns a missing, null or non-string
  // value into ''. With a newer updated_at that reached the full-column UPDATE below and REPLACED
  // a real note with an empty one — and because the local store is what the next export publishes,
  // the blank was then pushed to the shared file and adopted by every other machine, so no copy of
  // the text survived anywhere. Reproduced end to end across two databases.
  //
  // This is the same shape as the repo-mode `loadStore` bug this release fixes: absent input read
  // as empty, then written over the real thing. A record with nothing to say is not an instruction
  // to forget what we already know.
  if (typeof rec.content !== 'string' || rec.content.trim() === '') return 'skipped';
  // The sync document is a shared file from another machine — the genuinely untrusted input.
  // A record whose project_path normalizes to null would be imported as a GLOBAL note, i.e. it
  // would surface in every project on this machine. Skip it like any other bad record.
  if (isUnsafeProjectPath(rec.project_path)) return 'skipped';

  const db = getDb();
  const row = {
    id: rec.id,
    // Redacted like every other write path. Tags on the next lines already were; content was not,
    // which meant a hand-edited sync file, a peer on an older build, or pre-fix history re-imported
    // raw secrets into the local plaintext store — and every export afterwards re-published them.
    // redactAndCap, not slice-then-redact: a credential straddling MAX_CONTENT_LENGTH used to be
    // cut before the redactor saw it, so the fragment persisted and every export re-published it.
    content: redactAndCap(rec.content, MAX_CONTENT_LENGTH).text,
    category: rec.category,
    importance: rec.importance,
    project_path: normalizeProjectPath(rec.project_path),
    // Derive the key from the NORMALIZED path, as createSticky does. Using the raw value let a
    // synced record carry a key that disagreed with the path stored beside it.
    project_key: typeof rec.project_key === 'string'
      ? rec.project_key
      : deriveProjectKey(normalizeProjectPath(rec.project_path)),
    tags: JSON.stringify(
      (Array.isArray(rec.tags) ? rec.tags.slice(0, MAX_TAGS) : []).map((t) => redactAndCap(t, MAX_TAG_LENGTH).text)
    ),
    // `typeof === 'string'`, not `||`. These are bound straight into SQLite, and node:sqlite
    // refuses any value that is not a string, number, bigint, null or buffer — so a record whose
    // `created_at` was an object or an array threw "Provided value cannot be bound to SQLite
    // parameter N", and that throw propagated out of the per-record loop and aborted the ENTIRE
    // import. There is no transaction, so the import was left half-applied; the export that would
    // have rewritten the shared file never ran; and every auto-sync caller discards the returned
    // error, so the machine simply stopped sending and receiving notes with nothing said. A peer
    // on a build that widens one of these fields produces it without any malice at all.
    //
    // A bad value now degrades to "now", exactly as a missing one always did. Rejecting the whole
    // record would be defensible too, but a wrong timestamp is not a reason to drop a note whose
    // text is intact — and silently wedging the entire sync is not defensible under any reading.
    created_at: typeof rec.created_at === 'string' ? rec.created_at : nowIso(),
    updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : nowIso(),
    // Self-heal legacy rows: a category whose TTL is null (e.g. todo) is dismissal-only,
    // so drop any stale expires_at that an older version wrote — otherwise the row keeps
    // getting swept to 'stale' on every read. New expiries for TTL'd categories pass through.
    expires_at: CATEGORY_TTL_DAYS[rec.category] == null
      ? null
      : (typeof rec.expires_at === 'string' ? rec.expires_at : null),
    source: rec.source === 'manual' ? 'manual' : 'auto',
    origin: normalizeOrigin(rec.origin),
    session_id: rec.session_id ? String(rec.session_id) : null,
    due_at: normalizeDueAt(rec.due_at),
    status: ['active', 'stale', 'dismissed'].includes(rec.status) ? rec.status : 'active',
    // Redacted and capped like content, and for exactly the same reason. This field came in
    // RAW from the sync document — untrusted text written by anyone who can push to the shared
    // repo — so a credential in a peer's dismiss reason was stored in the local plaintext DB and
    // then re-published by the next `exportAllRows`. It was also the one uncapped string on this
    // path, which is what let a 60 KB reason through.
    dismiss_reason: rec.dismiss_reason == null ? null : redactAndCap(rec.dismiss_reason, MAX_CONTENT_LENGTH).text,
  };

  const existing = db.prepare('SELECT updated_at FROM stickies WHERE id = ?').get(row.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO stickies
         (id, content, category, importance, project_path, project_key, tags,
          created_at, updated_at, expires_at, source, origin, session_id, due_at, status, dismiss_reason)
       VALUES
         (@id, @content, @category, @importance, @project_path, @project_key, @tags,
          @created_at, @updated_at, @expires_at, @source, @origin, @session_id, @due_at, @status, @dismiss_reason)`
    ).run(row);
    return 'added';
  }

  // Last-writer-wins: only overwrite if the incoming record is strictly newer.
  if (String(row.updated_at) > String(existing.updated_at)) {
    db.prepare(
      `UPDATE stickies SET
         content=@content, category=@category, importance=@importance, project_path=@project_path,
         project_key=@project_key, tags=@tags, created_at=@created_at, updated_at=@updated_at,
         expires_at=@expires_at, source=@source, origin=@origin, session_id=@session_id,
         due_at=@due_at, status=@status, dismiss_reason=@dismiss_reason
       WHERE id=@id`
    ).run(row);
    return 'updated';
  }
  return 'skipped';
}

// Soft delete: flip status to 'dismissed', record optional reason.
export function dismissSticky(id, reason = null) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  if (!existing) {
    return { ok: false, error: `no sticky found with id ${id}` };
  }
  if (existing.status === 'dismissed') {
    return { ok: false, error: `sticky ${id} is already dismissed`, sticky: rowToSticky(existing) };
  }

  // Redacted, and length-capped, like content. A dismiss reason is free text written by the model
  // or the user ("fixed — rotated the old sk-ant-… key"), it is stored in the same plaintext
  // database, and it IS carried by exportAllRows into the sync document that git-sync commits and
  // pushes. It was the one write path that skipped the redactor entirely.
  const safeReason = reason ? redactAndCap(reason, MAX_CONTENT_LENGTH).text : null;
  db.prepare(
    `UPDATE stickies
        SET status = 'dismissed', dismiss_reason = @reason, updated_at = @now
      WHERE id = @id`
  ).run({ id, reason: safeReason || null, now: nowIso() });

  return { ok: true, sticky: getSticky(id) };
}
