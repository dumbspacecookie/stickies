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
import { redactSecrets } from './redact.js';
import { normalizeProjectPath } from './store-path.js';
import { deriveProjectKey } from './project-key.js';

export { normalizeProjectPath };

const IMPORTANCE_RANK = { P1: 1, P2: 2, P3: 3 };

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
}) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('content is required and must be a non-empty string');
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

  // Scrub obvious secrets before they are persisted (and later synced).
  const { text: safeContent, redacted } = redactSecrets(content.trim());

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
    tags: JSON.stringify(tags),
    created_at: now,
    updated_at: now,
    expires_at: computeExpiry(category, now),
    source,
    status: 'active',
    dismiss_reason: null,
  };

  db.prepare(
    `INSERT INTO stickies
       (id, content, category, importance, project_path, project_key, tags,
        created_at, updated_at, expires_at, source, status, dismiss_reason)
     VALUES
       (@id, @content, @category, @importance, @project_path, @project_key, @tags,
        @created_at, @updated_at, @expires_at, @source, @status, @dismiss_reason)`
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

// Persist a batch of parsed directives, skipping ones that duplicate an existing
// active sticky (same stored content + same project scope). Used by the post-turn
// auto-write hook, which may run many times over a session.
// `items`: [{ category, importance, tags, global, content }]
// An item marked `global` is stored unscoped (project_path null) so it surfaces in every
// project, and dedups against other globals rather than against this project's notes.
export function autoCapture(items, project_path) {
  const db = getDb();
  const np = normalizeProjectPath(project_path);
  const created = [];
  let skipped = 0;

  for (const it of items) {
    const scope = it.global ? null : np;

    // Compute the exact value createSticky will store, so dedup matches reality.
    const storedContent = redactSecrets(String(it.content || '').trim()).text;
    if (!storedContent) {
      skipped++;
      continue;
    }
    const dup = db
      .prepare(
        `SELECT id FROM stickies
          WHERE status = 'active' AND content = @content
            AND ((project_path IS NULL AND @pp IS NULL) OR project_path = @pp)
          LIMIT 1`
      )
      .get({ content: storedContent, pp: scope });
    if (dup) {
      skipped++;
      continue;
    }

    try {
      created.push(
        createSticky({
          content: it.content,
          category: it.category,
          importance: it.importance,
          tags: it.tags,
          project_path: scope,
          source: 'auto',
        })
      );
    } catch {
      // Malformed directive (e.g. bad category that slipped through) — skip it.
      skipped++;
    }
  }

  return { created, skipped };
}

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

  const db = getDb();
  const row = {
    id: rec.id,
    content: String(rec.content ?? '').slice(0, MAX_CONTENT_LENGTH),
    category: rec.category,
    importance: rec.importance,
    project_path: normalizeProjectPath(rec.project_path),
    project_key: rec.project_key ?? deriveProjectKey(rec.project_path),
    tags: JSON.stringify(Array.isArray(rec.tags) ? rec.tags.slice(0, MAX_TAGS) : []),
    created_at: rec.created_at || nowIso(),
    updated_at: rec.updated_at || nowIso(),
    expires_at: rec.expires_at ?? null,
    source: rec.source === 'manual' ? 'manual' : 'auto',
    status: ['active', 'stale', 'dismissed'].includes(rec.status) ? rec.status : 'active',
    dismiss_reason: rec.dismiss_reason ?? null,
  };

  const existing = db.prepare('SELECT updated_at FROM stickies WHERE id = ?').get(row.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO stickies
         (id, content, category, importance, project_path, project_key, tags,
          created_at, updated_at, expires_at, source, status, dismiss_reason)
       VALUES
         (@id, @content, @category, @importance, @project_path, @project_key, @tags,
          @created_at, @updated_at, @expires_at, @source, @status, @dismiss_reason)`
    ).run(row);
    return 'added';
  }

  // Last-writer-wins: only overwrite if the incoming record is strictly newer.
  if (String(row.updated_at) > String(existing.updated_at)) {
    db.prepare(
      `UPDATE stickies SET
         content=@content, category=@category, importance=@importance, project_path=@project_path,
         project_key=@project_key, tags=@tags, created_at=@created_at, updated_at=@updated_at,
         expires_at=@expires_at, source=@source, status=@status, dismiss_reason=@dismiss_reason
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

  db.prepare(
    `UPDATE stickies
        SET status = 'dismissed', dismiss_reason = @reason, updated_at = @now
      WHERE id = @id`
  ).run({ id, reason: reason || null, now: nowIso() });

  return { ok: true, sticky: getSticky(id) };
}
