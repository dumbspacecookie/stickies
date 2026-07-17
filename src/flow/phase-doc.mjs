// Path-confined reader for a single .planning/ doc, served as tokenized JSON by
// GET /api/phase-doc. This is the security-critical surface: an untrusted `path` query
// crosses into filesystem reads, so confinement is enforced with realpathSync on BOTH the
// base and the target — the resolved target must live inside the resolved `.planning/`
// dir, which blocks `../` traversal, absolute paths, and symlink escapes BEFORE any read.
//
// When the live file is absent (cloud/mobile with no `.planning/`), it falls back to the
// pre-tokenized entry in `.flow/docs.json` (written by snapshotBoard).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { tokenize } from './md-tokenize.mjs';
import { sectionizeBlocks, summarizeFrontmatter } from './gsd-doc.mjs';

function kindFromPath(relPath) {
  const f = String(relPath).toUpperCase();
  if (f.includes('RESEARCH')) return 'RESEARCH';
  if (f.includes('CONTEXT')) return 'CONTEXT';
  if (f.includes('VERIFICATION')) return 'VERIFICATION';
  if (f.includes('VALIDATION')) return 'VALIDATION';
  if (f.includes('SUMMARY')) return 'SUMMARY';
  if (f.includes('PLAN')) return 'PLAN';
  return 'DOC';
}

// Look the doc up in a committed .flow/docs.json snapshot. The relPath is used only as a
// map key (never as a filesystem path here), so an escape attempt simply misses.
function readSnapshotDoc(projectPath, relPath) {
  try {
    const docsPath = join(projectPath, '.flow', 'docs.json');
    if (!existsSync(docsPath)) return null;
    const map = JSON.parse(readFileSync(docsPath, 'utf8'));
    const entry = map[relPath];
    if (!entry) return null;
    return { kind: entry.kind, frontmatter: entry.frontmatter || {}, blocks: entry.blocks || [] };
  } catch {
    return null;
  }
}

export function readPhaseDoc(projectPath, relPath) {
  if (!projectPath || typeof relPath !== 'string' || relPath === '') {
    return { ok: false, reason: 'missing path' };
  }

  const planningDir = join(projectPath, '.planning');

  // Resolve the confinement base to its real path. If .planning is not a real dir we can
  // still try the snapshot fallback (repo-mode with .planning/ deleted).
  let baseReal = null;
  try { baseReal = realpathSync(planningDir); } catch { baseReal = null; }

  if (baseReal) {
    const target = resolve(planningDir, relPath);
    let targetReal = null;
    try { targetReal = realpathSync(target); } catch { targetReal = null; }

    if (targetReal) {
      // Confinement gate: the target's realpath MUST be the base or live beneath it.
      // This is evaluated before any readFileSync, so an escaping target is never read.
      if (targetReal === baseReal || targetReal.startsWith(baseReal + sep)) {
        try {
          const { frontmatter, body } = parseFrontmatter(readFileSync(targetReal, 'utf8'));
          // sectionizeBlocks humanizes GSD section tags into headings; summary distills the
          // frontmatter into a readable line. Both are inert (no HTML) — same safety contract.
          return {
            ok: true,
            kind: kindFromPath(relPath),
            frontmatter,
            blocks: sectionizeBlocks(tokenize(body)),
            summary: summarizeFrontmatter(frontmatter),
          };
        } catch {
          // fall through to the snapshot fallback
        }
      } else {
        return { ok: false, reason: 'path escapes .planning' };
      }
    }
    // targetReal === null => the live file does not exist; try the snapshot below.
  }

  const snap = readSnapshotDoc(projectPath, relPath);
  if (snap) {
    // Sectionize on the way out too: fresh snapshots are already section-aware (readPhaseDoc
    // produced them), and re-running is idempotent, so this also upgrades older snapshots.
    return {
      ok: true,
      kind: snap.kind,
      frontmatter: snap.frontmatter,
      blocks: sectionizeBlocks(snap.blocks),
      summary: summarizeFrontmatter(snap.frontmatter),
    };
  }

  return { ok: false, reason: 'not found' };
}
