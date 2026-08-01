# Changelog

Notable changes to Stickies. Versions follow the npm package `stickies-mcp`.

## 0.14.0 — 2026-07-31

A bug-fix release, and an admission: every defect below shipped in a release whose test suite was
green. Green is not the bar any more — `npm run gate` is, and it is now armed on push.

### Fixed — data loss

- **Auto-sync no longer commits work you didn't offer it.** The sync commit was a bare
  `git commit -m …`, which commits **the whole index** — so anything you happened to have staged
  in the sync repo went out under a "stickies sync" message and was then pushed. A staged and
  forgotten `.env.local` was enough to publish a credential. The commit is now scoped by pathspec
  to the sync file alone, and runs `--no-verify`: a `pre-commit` hook doing `git add -A` (a common
  formatter setup) would otherwise put every other dirty file straight back in.
- **Auto-sync no longer creates remote branches.** `push -u origin HEAD` on a branch with no
  upstream *creates* that branch on the remote, so a half-finished WIP branch got published as a
  side effect of taking a note. Stickies now pushes only to an upstream you configured, and says
  so plainly when there isn't one. What it still cannot fix, and the docs now say so: git sends a
  commit with all its ancestors, so unpushed commits of your own beneath ours go too. Use a
  dedicated sync repo.
- **A corrupt repo-mode store no longer becomes an empty one.** `loadStore()` caught every error
  and returned `{ notes: [] }`, so an unreadable or half-written `.stickies/notes.json` read as a
  board with nothing on it — which was then saved over the real file, committed and pushed. It now
  refuses to overwrite a store it could not parse.
- **A note is capped *after* redaction, not before.** The length check ran on the raw text, and
  `[REDACTED]` is longer than much of what it replaces, so a note under the limit could cross it
  on the way to disk and lose its tail.
- **A project note can no longer land in every project.** An unusable `project_path` degraded to a
  null scope, which means global.

### Fixed — capture

- **A directive in a file you merely read is no longer executed.** `!!sticky …` was honoured
  anywhere on a line and inside code fences, so a directive quoted in a README, a diff or a web
  page could write a note — including with the `global` modifier, which escapes the project. A
  directive is now honoured only at column 0, outside any code fence: the model has to *speak* it,
  not *quote* it. `STICKIES_NO_GLOBAL_CAPTURE=1` removes the global exception entirely.
- Control characters are stripped (a NUL truncated the note at rest and defeated dedup), captures
  are deduped on scope + content + category + importance, **a note you dismissed stays dismissed**
  instead of returning the next time the model restates it, and a turn is capped at 20 notes with
  a 15s hook timeout.

### Fixed — secrets

- **Eleven more credential shapes are redacted**: Hugging Face `hf_`, GitLab `glpat-`, AWS temp
  `ASIA`, Slack `xapp-`/`xoxe`, Google `GOCSPX-`, Fly `fm2_`, Azure `AccountKey=`, and opaque
  `Bearer` values. Armored PGP blocks terminated with CR or U+0085 are handled.
- **Redaction is a fixed point.** Running it over already-redacted text was rewriting markers it
  had itself placed, eating the surrounding characters.
- **A denial of service in the redactor**: an unbounded lookbehind took 4.7 seconds over 100KB of
  input, in a function every write path calls. Now bounded — about a millisecond.
- **The repo-mode engine is generated, not hand-copied.** It carries its own self-contained copy of
  the redactor, that copy was maintained by hand, and it had drifted **nine credential patterns**
  behind — a repo-mode user was getting a months-old redactor. It is now built from the real
  sources and stamped with a content hash, and the gate fails if the two disagree.

### Fixed — the board

- **A `### Phase N` heading inside a code fence became a real, draggable card** — and moving it
  rewrote a *different* phase's status in `.planning/ROADMAP.md`, silently. The reader and the
  writer each tracked fences separately and disagreed; they now share one implementation.
- A leading `---` horizontal rule was parsed as frontmatter and swallowed the document.
- `snapshotBoard` could write outside the project directory, unlike the containment-checked
  `backupRoadmap` sitting next to it.

### Fixed — counts

- **One folder is one project again.** On Windows a directory has several stored spellings, and
  while reads folded them, everything that *counted* did not: the dashboard listed one folder
  twice with the notes split between the rows, the session report showed you only the notes
  written under the capitalisation your shell happened to use, and the project switcher offered
  the same folder twice. (Deliberately a no-op on Linux and macOS, where `/home/A` and `/home/a`
  really are two directories.)

### Fixed — other

- **`stickies doctor` no longer modifies the store it is inspecting** — a read-only diagnostic was
  rewriting `status` and `updated_at` on the rows it looked at.
- `doctor` reports a diverged sync repo instead of printing `✓ Nothing broken` over one.
- Every Discord embed field is bounded and redirects are refused, so a note can't be truncated
  into an error or followed off to another host.
- The session-start digest is size-capped and marked as data rather than instruction.

### Changed — git sync no longer pushes unless you ask

**If you use `STICKIES_AUTO_SYNC`, read this one.** Taking a note now **commits** to your sync repo
and stops there. Set **`STICKIES_SYNC_PUSH=1`** to restore automatic pushing.

Deciding where a commit should go turned out to hold more of your git configuration than any
reimplementation of it could. This function had three separate bugs in two attempts: it created
remote branches; then it wrote a `wip` branch onto shared `main`; then it used your *fetch* remote
as the *push* remote, which on a fork sends your notes to the project you forked from — because
`remote.pushDefault` and `branch.<n>.pushRemote` exist precisely so those can differ. Getting this
wrong writes to a repository other people share, so the default is now to do nothing.

With the opt-in set, Stickies runs a bare `git push` — no refspec, no remote — so `push.default`,
`pushRemote` and your branch's own upstream decide, and it goes exactly where your own `git push`
would send it. We defer to that policy rather than re-deriving it.

The hook and the CLI now say **"committed locally — NOT pushed"** instead of "auto-synced" when the
push is held, so an upgrade cannot leave you believing you are syncing across machines when you are
not. `stickies sync` prints the same in its step list.

### Fixed — found by the release gate, before this version shipped

The gate's agent review ran over this release and found six defects in it, every one invisible to a
green suite. They are listed separately because the honest thing to say about them is that they were
in the release candidate, not in 0.13.0 — three of them are in code this very release introduced.

- **A 444-character note could freeze Stickies for two minutes.** The pattern that recognises a
  pasted private key let its armor-header tail and its trailing whitespace both match the same
  spaces, so a header line padded with *W* spaces had *W+1* equivalent readings, nested eight deep,
  and the engine enumerated all of them. Measured on the candidate: 294 chars → 2.6 s, 444 chars →
  125 s, against 0.4 ms for ordinary text of the same length. It ran on **every** write — the MCP
  tool, the CLI, the dashboard, the post-turn hook — and on records arriving from a shared sync
  file. The scan window is bounded to 1,524 characters, but a bound only helps a cost that grows
  with length, and this one peaked well inside a note you were allowed to write. Now linear:
  re-measured across ~530,000 adversarial inputs, the worst case anywhere in the redactor is
  2.3 ms.
- **Taking a note could push your branch onto `main`.** The new upstream-aware push read the tracked
  branch and pushed to it *by name*, so on a branch made the ordinary way (`git checkout -b wip
  origin/main`) a captured note fast-forwarded shared `main` to your unfinished work. This was a
  regression introduced by the push fix in this same release, and it is worse than the stray remote
  branch it replaced. Stickies now follows git's own `push.default=simple`: it pushes only when the
  tracked branch has the same name as the branch you are on, and otherwise says which branch it
  declined to write to.
- **The remote is no longer assumed to be called `origin`.** On a fork (`@{u} = upstream/main`) the
  old code created a branch literally named `upstream/main`; with any remote not named `origin`,
  every push failed forever while the CLI reported the sync as fine.
- **A sync record with no text could blank a real note — and publish the blank.** `upsertFromSync`
  validated the id, category, importance and path but never the content, so a missing or non-string
  value became `''` and, with a newer timestamp, replaced a real note. The local store is what the
  next export publishes, so the empty note then propagated to every other machine. It now applies
  the same rule `createSticky` always has.
- **One malformed field no longer wedges sync permanently.** Timestamps were bound straight to
  SQLite, which refuses values that are not strings or numbers; one object-valued `created_at` threw,
  aborted the *entire* import, and — because every auto-sync caller discards the error — the machine
  silently stopped sending and receiving notes with nothing said.
- **An invisible character no longer disables the code-fence rule.** `!!sticky` directives are
  honoured only when the model *speaks* them, never when it *quotes* them inside a fence. A U+2028 or
  U+2029 on the fence's opening line made the scanner miss the fence entirely, so a directive quoted
  out of a hostile file was executed — including with `global`, which files it into every project on
  the machine — while the summary still reported nothing refused.

### Added

- **`npm run gate`** — one command that has to pass before anything leaves the repo: the suite,
  manifest agreement, dev-only files staying out of the tarball, the inlined engine matching its
  sources, and push enforcement actually being armed. A `pre-push` hook runs it and refuses when
  the pushed sha isn't `HEAD` or the tree is dirty, because otherwise the gate reports on code
  that isn't the code being pushed. `STICKIES_SKIP_GATE=1` is the one documented override; see
  `GATE.md`.

## 0.13.0 — 2026-07-30

The dashboard grows up. Everything here already existed and had been in daily use privately;
this release is it becoming part of the published package, with two defaults deliberately
changed first so that installing a notes plugin doesn't hand you things you didn't ask for.

### Added

- **One dashboard for every project.** It is no longer welded to the folder it was launched
  from: a header switcher moves between every project you've taken notes in, and each page and
  API route takes `?project=`. The list is an allowlist built from projects that have notes
  (dismissed ones count) plus recent sessions; anything outside it is refused rather than
  silently served as the launch project.
- **A read gate.** The dashboard serves your notes and planning documents, and loopback is not
  proof of identity — anything running on your machine is also on `127.0.0.1`. Reads now need an
  authorized browser: `stickies dashboard --link` prints a URL, opening it sets an `HttpOnly`
  cookie, and the statusline's Ctrl+click carries one. Links carry a short-lived token derived
  from the key, never the key itself, so an old link in scrollback is inert. Opt out with
  `STICKIES_DASHBOARD_AUTH=0`.
- **`stickies dashboard --stop`**, which asks the dashboard to exit itself rather than signalling
  a pid — so a stale pidfile naming a recycled pid can't get an unrelated process killed.
- **`stickies doctor`** — reports the whole setup in one shot: what's running, on what port,
  whether the installed plugin copy is stale. Paths are abbreviated to `~` so the output is safe
  to paste into an issue (`--raw` opts out).
- **Board writeback (opt-in).** With `STICKIES_BOARD_WRITEBACK=1`, dragging a card on `/board`
  rewrites that phase's `**Status:**` line in `.planning/ROADMAP.md`. Pre-edit copies land in
  `.flow/roadmap-backups/`, writes are realpath-confined, and a move contradicting the phase's
  plan checkboxes is refused rather than written.
- **Optional session autostart** — `STICKIES_DASHBOARD_AUTOSTART=1` has a Claude session bring a
  dashboard up if none is running, announced once.

### Changed

- **Autostart is off by default.** It was previously on unless you set `=0`. Installing a notes
  plugin should not put a long-lived HTTP server on your machine that you never asked for and
  have no reason to look for. The CI/remote-session guard remains, and an explicit opt-in no
  longer overrides it — that escape hatch made sense when `=1` merely forced the default-on path,
  but now that `=1` is the only route to a spawn, honouring it there would make the guard
  unreachable and put a listener on any build agent whose repo exports the variable.
- **The default port is 7317, not 4317.** 4317 is OpenTelemetry's OTLP gRPC port, so on a machine
  running a collector the dashboard either lost the bind or the statusline link handed you to
  somebody else's server. The port also now lives in one module instead of being a bare literal
  in five, and an out-of-range `STICKIES_DASHBOARD_PORT` falls back to the default instead of
  becoming `NaN` and being passed to `listen()` as "pick any port".

### Fixed

- **Writeback confined the backup it wrote but not the file it edited.** A `.planning` directory
  that was a symlink or an unprivileged Windows junction pointing outside the project let one card
  drag rewrite a `**Status:**` line in a file elsewhere on disk. Found by attacking a live
  dashboard during this release's audit, before any of it shipped.
- **Authorized links are now bound to the port they were minted for.** Previously every token was
  interchangeable between dashboards sharing the key file, so on a shared host another account
  could squat the default port, answer as Stickies, harvest a token from a Ctrl+click and replay it
  against the real dashboard. Confirmed by replay, then closed.
- A `Host` guard rejects DNS-rebinding attempts before any cookie is consulted.
- A corrupt or truncated dashboard key file used to be a permanent lockout — the server started
  healthy and refused everything forever while saying nothing. Keys are now written atomically
  and an unusable one is replaced.
- Auth cookies are scoped per port, so two dashboards no longer evict each other's sessions.

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
