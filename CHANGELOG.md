# Changelog

Notable changes to Stickies. Versions follow the npm package `stickies-mcp`.

## 0.12.1 — 2026-07-27

A bugfix release. No new features, and nothing here changes how you use the tool — but two of
these were losing data on shipped installs, so upgrading is worth doing.

### Fixed — data loss

- **CLAUDE.md could silently lose content on every session start.** The routine that removes a
  leftover managed section searched for the start and end markers as plain strings anywhere in
  the file, rather than looking for *our* section. A `CLAUDE.md` that merely *mentioned* those
  markers — a sentence explaining what Stickies does to the file, or an indented example —
  supplied the opening index while the real section supplied the closing one, and everything in
  between was deleted. Measured on a real file: 346 bytes in, 67 bytes out, taking the
  project's architecture and on-call sections with it, in a git-tracked file, on every
  SessionStart. Markers are now recognised only at column zero, candidates inside fenced code
  blocks are skipped, and the span is taken from the *last* opening before the first closing —
  so a stray marker is structurally unable to start a section. Same fix applied to the
  `init-repo` convention block, which had the same flaw.

- **A note mentioning a private-key header lost everything after it.** The pattern for an
  unpaired `-----BEGIN … PRIVATE KEY-----` (a paste that lost its footer) ran to the end of the
  string, so writing "the deploy key starts with -----BEGIN OPENSSH PRIVATE KEY-----" redacted
  the rest of the note. Permanently, at write time, with no notice on the auto-capture path. It
  now requires a following line of actual key material.

- **Repo-mode could replace a `.claude/settings.json` it had failed to read.** An unparseable
  file fell back to `{}` and was then written out — losing permissions, env, statusline, and
  any hooks the user or their team had configured, silently, reported as a successful install.
  The likeliest reason that file will not parse is an unresolved merge conflict, and a
  repo-shared settings file is exactly what repo-mode targets. It is now left untouched, with a
  warning on stderr and a non-zero exit.

### Fixed — secrets

- **Discord webhook URLs were not redacted** on the main write path — the one credential a
  Stickies user is most likely to paste, since Stickies itself asks for one. The redactor is
  duplicated in the self-contained repo-mode engine, and the two copies had drifted; the fix
  came from diffing them. `test/redaction-parity-test.mjs` now runs one corpus through both and
  fails if their output differs.
- **PGP private keys were stored verbatim** — a PGP block ends `PRIVATE KEY BLOCK-----`, which
  the old pattern could not match.
- **Dismiss reasons were never redacted**, and they are carried into the exported sync document
  that git-sync commits and pushes. It was the one write path that skipped the redactor.
- **Notes imported from a sync document were not redacted**, so a hand-edited file or a peer on
  an older build could re-import raw secrets into the local store, and every later export
  re-published them. Tags already were; content now is too.

### Fixed — repo-mode (`stickies init-repo`)

- **The installed GitHub Actions workflow was vulnerable to script injection.** A branch name
  was interpolated into three `run:` bodies under `permissions: contents: write`, and
  `git check-ref-format` happily accepts `claude/x$(id)y` — while `claude/**` is exactly the
  namespace cloud agents name from task text. The branch name is now passed through `env:` and
  expanded as `"$REF"` after bash has parsed the script, refused outright if it contains
  anything outside `[A-Za-z0-9._/-]`, and the commit message goes in on stdin. Checkout now
  sets `persist-credentials: false`. This workflow is copied into every repo `init-repo`
  touches.
- **Auto-commit could sweep up unrelated staged files.** It staged the two note files and then
  ran `git commit` with no pathspec, which commits everything already staged — and pushes it.
  Reproduced with a staged `.env.local`. The commit is now restricted to the note files.
  `STICKIES_REPO_AUTOCOMMIT=0` turns it off, and is now documented.
- **Writes are confined to the repo.** Every target is resolved with `realpathSync` and checked
  to be inside the repo root, so a symlink or junction planted at `.claude`, `.github`, or
  `.stickies` cannot redirect a write outside it.
- A hostile-but-valid `settings.json` (e.g. `"hooks": 5`) no longer throws a stack trace after
  CLAUDE.md has already been rewritten, leaving a half-installed repo.

### Fixed — other

- `stickies --version` reported `0.7.0`; it had been hardcoded for four releases, so every
  version a user reported back was wrong. It now reads `package.json`.
- `npx stickies-mcp` opened with two `ExperimentalWarning` lines on stderr. Every invocation in
  our own docs passes `--disable-warning`, so the flag was keeping stderr quiet rather than the
  code — the published bin has no flag. The entry point now installs the warning suppressor
  before loading the server.
- A `project_path` containing angle brackets, control characters, or the JS line separators is
  now refused by both the MCP schema and the store, instead of normalizing to `null` — which
  means *global*, and would have filed the note into every project's digest.
- Auto-capture now checks the length cap *before* redacting. The regexes previously ran on
  unbounded transcript text, and one lookahead is catastrophic on `_`-segmented input: 14KB
  measured 818ms, 130KB measured 17s, in the post-turn hook, on every turn.

### Changed (behaviour)

- `stickies init-repo` **exits non-zero and warns on stderr** when it skips a step. A skipped
  install must not look identical to a working one.
- The repo-mode convention block in `CLAUDE.md` is delimited by `stickies:repo-start` /
  `stickies:repo-end`. It previously shared its closing marker with the digest section, so an
  orphaned marker let a refresh run on and replace everything in between. Existing installs are
  migrated in place.

### Docs

- `SECURITY.md` claimed "no network" (three opt-in egress paths ship: Discord webhook, git
  sync, repo-mode push) and that the SessionStart hook "writes nothing to disk" (it writes a
  session marker). Both corrected, with a new Egress table and a repo-mode section — repo-mode
  writes into your repository and installs a workflow that runs on your pushes, and had no
  mention at all.
- `USAGE.md` told you to verify an install by looking for a managed block in `CLAUDE.md` — the
  block the hook now deliberately removes, so its absence is the healthy state. It also
  documented `/stickies p1` and `/stickies global`, neither of which exists.
- `PUBLISHING.md`'s pre-flight `mcp-publisher publish --dry-run` does not exist; the command is
  `mcp-publisher validate`.

## 0.12.0 — 2026-07-17

- Light/dark theme (dashboard toggle, AA-contrast statusline palette).
- Due dates: `due:1h` / `due:tomorrow` / `due:YYYY-MM-DD` on directives, a CLI `--due` flag, a
  colour-coded card chip, and a statusline clock pip.
- Cross-project Command Center (`/command`).
- Note search and `[[wikilinks]]` between notes, with deep-link and flash-highlight.
- True-progress board rollup.
- Hardening: DNS-rebinding `Host` guard on the dashboard, `node:sqlite` warning-leak fix,
  statusline double-render fix.

## 0.11.1 — 2026-07-16

- Kanban Flow Board, per-sticky provenance, statusline compaction, `stickies board`
  (GitHub-viewable `BOARD.md`, `--discord`).
- Rewritten README.

## 0.10.0

- Ctrl+click statusline opens the dashboard (OSC 8 hyperlink).
- Rich Discord cards; `stickies notify [--all]`.

## 0.9.0

- Repo-mode (`stickies init-repo`): committed `.stickies/notes.json`, generated `NOTES.md`,
  repo-scoped hooks, and a reconciliation workflow — so notes written from a phone reach the
  same board.
- First MCP-registry release.
