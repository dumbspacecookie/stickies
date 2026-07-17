// GSD-doc humanizer. Pure, dependency-free (imports NOTHING) so it inlines into repo-mode
// exactly like the tokenizer/frontmatter parsers next to it.
//
// GSD PLAN.md / SUMMARY.md files are authored with pseudo-XML section tags (<objective>,
// <tasks>, <success_criteria>, …) and a YAML frontmatter block. The tokenizer (by design)
// treats `<...>` as inert literal text, so those tags otherwise render as raw text and the
// frontmatter as a machine-readable key/value dump. These two pure helpers turn both into
// human-readable shapes WITHOUT reintroducing any HTML/innerHTML path:
//   • sectionizeBlocks() rewrites lone section tags into heading Blocks (still inert tokens).
//   • summarizeFrontmatter() distills the frontmatter into one short plain-text line.

// Known GSD section tags (case-insensitive). Kept as a Set so it is trivial to extend.
export const GSD_SECTIONS = new Set([
  'objective', 'purpose', 'context', 'tasks', 'task', 'execution_context',
  'success_criteria', 'verification', 'files_to_read', 'files_modified', 'deviations',
  'notes', 'parallel_execution', 'sequential_execution', 'baseline_context',
  'worktree_branch_check', 'mcp_tools',
]);

// A block that is a single pseudo-XML tag on its own line: `<name>`, `</name>`, or
// `<name attr="x">`. Anchored — a tag embedded in prose does not match.
const LONE_TAG_RE = /^<(\/?)([a-z_][a-z0-9_]*)(\s[^>]*)?>$/i;

// Reconstruct the source-ish text of a para from its inert spans. The tokenizer consumes
// markdown delimiters (a snake_case tag like `<files_to_read>` gets its middle `_to_`
// parsed into an `em` span), so we re-add the delimiters to recover the literal tag text
// before testing it against LONE_TAG_RE.
function spanRaw(s) {
  if (!s) return '';
  const text = s.text != null ? s.text : '';
  switch (s.t) {
    case 'strong': return '**' + text + '**';
    case 'em': return '_' + text + '_';
    case 'code': return '`' + text + '`';
    default: return text; // text, link
  }
}

function paraText(block) {
  return (block.spans || []).map(spanRaw).join('');
}

// snake_case / underscore tag name -> Title Case ("execution_context" -> "Execution Context").
function humanize(name) {
  return String(name)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Rewrite lone GSD section tags into readable heading blocks. Returns a NEW array (never
// mutates the input or its blocks). Opening tag for a KNOWN section -> a level-2 heading
// with a humanized title; a closing tag for a known section is dropped; unknown lone tags
// and every non-tag block pass through unchanged (angle brackets in prose stay literal).
export function sectionizeBlocks(blocks) {
  const out = [];
  for (const b of (blocks || [])) {
    if (b && b.type === 'para') {
      const m = paraText(b).match(LONE_TAG_RE);
      if (m) {
        const closing = m[1] === '/';
        const name = m[2].toLowerCase();
        if (GSD_SECTIONS.has(name)) {
          if (closing) continue; // drop the closing tag entirely
          out.push({ type: 'heading', level: 2, spans: [{ t: 'text', text: humanize(name) }] });
          continue;
        }
        // Unknown lone tag: leave the block untouched (it stays literal text).
      }
    }
    out.push(b);
  }
  return out;
}

// Distill frontmatter into one short human-readable line, e.g.
//   "Wave 1 · no dependencies · touches 9 files · FR-01, FR-02 · execute"
// Only known keys contribute; absent keys are omitted. Returns '' when nothing is known.
// Pure string — never HTML.
export function summarizeFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return '';
  const parts = [];

  if (fm.wave != null && fm.wave !== '') parts.push('Wave ' + fm.wave);

  if (Array.isArray(fm.depends_on)) {
    parts.push(fm.depends_on.length ? 'depends on ' + fm.depends_on.join(', ') : 'no dependencies');
  }

  if (Array.isArray(fm.files_modified)) {
    const n = fm.files_modified.length;
    parts.push('touches ' + n + ' file' + (n === 1 ? '' : 's'));
  }

  const reqs = fm.requirementIds || fm.req_ids || fm.requirements;
  if (Array.isArray(reqs) && reqs.length) parts.push(reqs.join(', '));

  if (fm.type != null && fm.type !== '') parts.push(String(fm.type));

  return parts.join(' · ');
}
