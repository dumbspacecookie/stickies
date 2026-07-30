# Stickies — Security notes

Stickies persists notes locally and injects a digest of them into session context at
startup. Note bodies are written by the model and the user, stored in a shared local
SQLite DB, and (in later phases) intended to sync across machines. This file documents
the threat model, what is defended, and the residual risks to weigh before relying on it
or publishing it.

## Trust boundary

- **Single local user.** All stickies for all projects live in one DB
  (`$STICKIES_DB` or `~/.stickies/stickies.db`) with normal user file permissions.
- **No authentication against yourself.** The store is a file readable by your user, and while a
  dashboard is running, anything running as you can authorize itself to it by reading the same
  key file you do. The dashboard's read gate raises the bar against *another account* on a shared
  host and against a drive-by web page — not against code already running as you.
- **Network is opt-in — but it is not "none".** Three paths can carry note content off this
  machine, all off by default. See [Egress](#egress) for exactly what leaves and when.
- A note written in one project (or synced from another machine) is **untrusted input**
  to every later session that reads it.

## Egress

A default install does not talk to the network. These are the three ways that changes, so you
can decide which you have turned on:

| Path | Turned on by | What leaves |
|------|--------------|-------------|
| **Discord webhook** (`src/notify.js`) | `STICKIES_DISCORD_WEBHOOK` set to a Discord webhook URL | Note content — including full note bodies for `stickies notify [--all]`. Only a real `discord.com/api/webhooks/…` URL is accepted, so a typo'd or hostile value is refused rather than posted to. Content has been through `redactSecrets()` first. |
| **Git sync** (`src/git-sync.js`, `src/sync.js`) | **both** `STICKIES_AUTO_SYNC` truthy **and** `STICKIES_SYNC_REPO` set | A plaintext JSON document of **all** your notes, committed and pushed to whatever remote that repo has. SessionStart pulls, the Stop hook pushes on turns that captured something. Use a **private** repo. |
| **Repo-mode** (`stickies init-repo`) | Running the command in a repo, then committing what it wrote | Notes are committed into `.stickies/notes.json` **in that repo** and pushed with it — so they inherit that repo's visibility. Public repo means public notes. It also installs a GitHub Actions workflow that runs on pushes to `claude/**` and `stickies/**`. |

Auto-sync is best-effort: failures are swallowed so a broken remote cannot break your session —
which also means a push can fail without you noticing. Nothing here reports telemetry, phones
home, or contacts any endpoint the author controls; every destination is one you configured.

## Defended (verified by `test/redteam.mjs`)

| Vector | Defense |
|--------|---------|
| **SQL injection** (content, tags, dismiss id) | All queries are parameterized; no user input is concatenated into SQL. |
| **Context/CLAUDE.md injection** | The SessionStart digest is delivered via the hook's `additionalContext` channel — the digest text itself is never written to a file. Note text is still escaped (`<!--`/`-->` neutralized) so a note can't forge the managed-section markers used by the one-time legacy-file cleanup, and any pre-existing user content in `<cwd>/CLAUDE.md` is always preserved. |
| **Oversized input / DoS surface** | content ≤ 500 chars; tags ≤ 20, each ≤ 40 chars; read `limit` ≤ 500. |
| **Secret capture at rest** | Content **and tags** are scrubbed on write (`src/redact.js`): PEM private key blocks, including PGP (`…PRIVATE KEY BLOCK-----`) and a header that lost its footer; AWS/GitHub/Slack/Google/OpenAI/Anthropic/Stripe/npm/SendGrid/DigitalOcean token shapes and JWTs; Slack **and Discord** incoming-webhook URLs — the latter matters because Stickies itself asks you for one; `scheme://user:pass@host` connection strings; and labelled `KEY=<value>` / `"key":"<value>"` assignments (including `SCREAMING_SNAKE` env-var names) are replaced with `[REDACTED]`; the write tool/CLI warn when this happens. The redactor is duplicated in `src/repo-mode/engine.mjs`, which has to be self-contained — `test/redaction-parity-test.mjs` runs one corpus through both copies and fails if their output differs, because the Discord gap was found by the two copies disagreeing. Best-effort, not a vault — an unlabelled high-entropy token with no known shape can still pass. |
| **Arbitrary file write** | A sticky's `project_path` is a **filter only** — it is never used as a write target. The SessionStart hook does write, to exactly two places: a session marker at `$STICKIES_HOME/sessions/<id>.json` (so SessionEnd can report what changed during the session; the id is sanitized so it cannot escape that directory), and a one-time removal of a legacy managed section from `<cwd>/CLAUDE.md` — it never creates that file, and if it cannot find a well-formed section it leaves the file alone. Separately, `stickies init-repo` writes into a repo you point it at; see [Repo-mode](#repo-mode-stickies-init-repo). |
| **Native-dependency supply chain** | Zero native modules. Storage uses Node's built-in `node:sqlite`; runtime deps are only `@modelcontextprotocol/sdk`, `commander`, `zod`. |

## Phase 2 surfaces (auto-capture hook + dashboard)

| Surface | Notes |
|---------|-------|
| **Post-turn Stop hook** (`src/auto-capture.js`) | Parses `!!sticky …` directives from the just-finished assistant turn and persists them. Directive content flows through the same `createSticky` path → secret redaction + size/tag bounds apply; writes are deduped and scoped to `cwd`; storing a note is not code execution. The hook is non-blocking and never emits a `block` decision, so it can't cause a stop loop. It trusts `transcript_path`/`cwd` from the (local, Claude-Code-issued) hook event. |
| **Local web dashboard** (`src/dashboard.js`) | Binds **127.0.0.1 only**, on port 7317 by default. Mutations (`/api/dismiss`, `/api/create`) require a per-launch random token **and** a same-origin/no `Origin` check → a drive-by website cannot dismiss or create stickies (CSRF-defended; verified in `test/dashboard-test.mjs`). A `Host` header guard rejects DNS-rebinding attempts. The page renders note bodies via `textContent`, never `innerHTML`, so a sticky can't inject script into the dashboard. No external assets/CDN. **Reads are gated too** — see [Dashboard](#dashboard-the-widest-surface-stickies-has). |

| **Auto-sync** (`maybeAutoSync` in `src/git-sync.js`) | Doubly gated: runs only when **both** `$STICKIES_AUTO_SYNC` is truthy **and** `$STICKIES_SYNC_REPO` is set. When on, the SessionStart hook pulls and the Stop hook pushes (only on turns that captured a new sticky). Best-effort: any failure is swallowed so it can't break a session. Off by default — no automatic git/network activity unless you opt in. |
| **Git sync** (`src/git-sync.js`, `src/sync.js`) | Opt-in and off by default — does nothing unless `$STICKIES_SYNC_REPO` points at a git working copy you own. All git calls use argument arrays (never a shell string), so repo paths/commit messages can't inject shell commands. Pull/push only happen if the repo has a remote you configured; with no remote it's purely local. **The exported sync document is plaintext JSON** containing all note bodies — store it in a **private** repo. Secret redaction still applies on write, but treat the repo as containing your notes. Merge is last-writer-wins by `updated_at`; a malicious/edited sync file can only add/replace stickies (data), not execute code, and bad records are skipped. Records arriving from a sync document are redacted on import as well as on write, so a hand-edited or older-build document cannot re-import raw secrets into the local store. Verified by attack: `__proto__` and `constructor` keys do not reach `Object.prototype`, unknown categories/importances/statuses are refused, oversized content is capped on import, and a path carrying markup characters is skipped rather than becoming a global note. **Two consequences of the merge rule are worth stating plainly, because they follow from the design rather than from a bug: anyone who can write to your sync repo can (a) revive notes you dismissed, since last-writer-wins by `updated_at` applies to status too, and (b) place a note in _every_ project on your machine, since a null `project_path` means global. Both are the same trust you extend by sharing the repo.** |

## Dashboard — the widest surface Stickies has

The dashboard is a real HTTP server holding your notes and, if you turn writeback on, a write
path into your planning documents. It is the part of this package most worth understanding.

- **It does not start itself.** Autostart is **off unless `STICKIES_DASHBOARD_AUTOSTART=1`**.
  Installing this package does not put a server on your machine; you get one when you run
  `stickies dashboard`. With autostart on, the SessionStart hook brings one up if none is
  running, announces it once, and skips entirely in CI and remote/cloud sessions — an explicit
  opt-in does **not** override that, because a listener on a build agent is never what was meant.
  `stickies dashboard --stop` ends a running one.
- **One dashboard serves every project you have touched**, not just the folder it was launched
  from — any project that has ever had a sticky (dismissed ones count), plus any a Claude session
  ran in recently. `/api/projects` enumerates those paths to a caller holding the read key. A
  `?project=` value outside that allowlist is refused rather than quietly serving the launch
  project.
- **Loopback is not an authentication boundary.** Anything running as you can reach 127.0.0.1,
  so reads are gated by a key file (`$STICKIES_HOME/dashboard-auth.key`) rather than by being on
  loopback. `stickies dashboard --link` mints an authorized link; redeeming it sets an
  `HttpOnly SameSite=Strict` cookie, scoped per port so two dashboards do not evict each other.
  Scripts can send `X-Stickies-Key` instead. Opt out with `STICKIES_DASHBOARD_AUTH=0`.
  - Links carry a **short-lived HMAC token derived from the key, the port, and the current
    5-minute bucket**, never the key itself — so an old link in terminal scrollback is inert, and
    the raw key is not accepted in a URL at all. The port is signed so a token is only valid for
    the dashboard it was minted for: without that, another account on a shared host could squat
    the default port, answer `/api/health` as Stickies, collect a token from your Ctrl+click and
    replay it against your real dashboard on another port. The gate stops another account on a
    shared host; it does **not** stop code running as you.
  - The key file is written mode `0600`. On Windows that is largely nominal — Node maps only the
    read-only bit, so the file's real protection is the ACL on your home directory.
- **Board writeback is off by default.** `STICKIES_BOARD_WRITEBACK=1` lets dragging a card
  rewrite that phase's `**Status:**` line in `.planning/ROADMAP.md`. Pre-edit copies are kept in
  `.flow/roadmap-backups/`, the target path is realpath-confined, the temp file is created with
  `wx` so a planted symlink cannot be followed, and a move that contradicts the plan checkboxes
  is refused rather than written.
- **`stickies doctor`** abbreviates your home directory to `~` in both rendered and JSON output.
  `--raw` prints full paths — do not paste that into a public issue.
- **`--stop` asks; it does not signal.** The dashboard writes a random nonce into
  `$STICKIES_HOME/dashboard-<port>.pid`. `--stop` reads it and POSTs it to `/api/stop`, and the
  process ends *itself*. No signal is sent to a pid, so a stale pidfile naming a recycled pid
  cannot get an unrelated process killed. The nonce is published nowhere: `/api/health` returns
  only `{ok, app, project, port, pid}`, so an unauthenticated route has no secret to scrape and
  replay. A port-holder that ignores the request is reported as still running; nothing escalates
  to a kill.

Residual: while a dashboard is running, any local process running as you can reach it. That is
the single-user assumption this whole tool rests on. Stop it when you are not using it.

## Repo-mode (`stickies init-repo`)

This is the highest-consequence command in the package: it is the only one that writes into a
repository you name, and the only one that installs something which later runs on GitHub's
infrastructure with a write token. Run it deliberately, and read the diff before committing.

**What it writes** (each step is reported; a step it cannot do safely is reported as a warning
and the command exits non-zero, so a partial install never looks like a successful one):

- `.stickies/` — `notes.json` (the committed note store) and a self-contained `engine.mjs`.
- `NOTES.md` — generated from the store, so notes are readable in the GitHub UI.
- `CLAUDE.md` — a managed block, delimited by `stickies:repo-start` / `stickies:repo-end`
  markers that must stand alone at the start of their line. Marker handling is deliberately
  strict: a malformed or orphaned marker causes the block to be **appended** rather than
  letting a replacement span swallow the text between two unrelated markers.
- `.claude/settings.json` — two hook entries. If that file exists but cannot be parsed or is
  not an object, it is **left untouched** and the step is reported as a warning; it is never
  replaced with a fresh file, because the likeliest reason it will not parse is an unresolved
  merge conflict, and a repo-shared settings file carries other people's hooks and permissions.
- `.github/workflows/stickies-sync.yml` — the reconciliation workflow.

Every write target is resolved with `realpathSync` and checked to still be inside the repo
root before it is written, so a symlink or junction planted at `.claude`, `.github`, or
`.stickies` cannot redirect a write outside the repo.

**The workflow.** It triggers on pushes to `claude/**` and `stickies/**` that touch
`.stickies/notes.json`, and holds `contents: write`. A branch name is attacker-controlled text
(`git check-ref-format` accepts `claude/x$(id)y`), so it is passed to the script through `env:`
and expanded as `"$REF"` after bash has parsed the script — never interpolated into the script
body, which would have been command execution on the runner. It additionally refuses a ref
containing anything outside `[A-Za-z0-9._/-]`, passes the commit message on stdin rather than
on a command line, and sets `persist-credentials: false` so the checkout does not leave a token
in `.git/config`. It only ever touches `.stickies/`.

**Auto-commit.** In a repo-mode session, captured notes are committed automatically. The commit
is restricted to a pathspec covering only the note files, so anything else you happen to have
staged is not swept into it. Set `STICKIES_REPO_AUTOCOMMIT=0` to turn the commit off and stage
notes yourself.

## Resilience (storage / real-store paths)

Verified by `test/resilience-test.mjs` and `test/migration-test.mjs`:

- **Schema upgrade** from a pre-`project_key` DB migrates in place (column added before it
  is indexed); old rows keep working and match by path.
- **Concurrent access** — `busy_timeout = 5000` is set *before* the WAL switch, so the
  MCP server, both hooks, the dashboard and the CLI can open the store together without
  "database is locked". The first-run migration is idempotent under a race (duplicate-column
  is tolerated).
- **Corrupt DB** — a malformed store is renamed aside (`*.corrupt-<ts>`, never deleted) and
  a fresh one is created so the tool keeps working; the bad file is preserved for recovery.
- **Corrupt row data** — a bad `tags` value degrades to `[]` instead of breaking the whole read.

## Residual risks (by design, or accepted)

1. **Prompt injection is inherent to the feature.** Note bodies are injected into context.
   Mitigations: the digest is prefixed with a "treat as data, not instructions" banner, and
   markers/HTML comments are neutralized. This **reduces** but does not eliminate the risk —
   a malicious synced note could still attempt to steer the model. Treat stickies you did not
   write with the same caution as any other untrusted text.
2. **Cross-project read.** `stickies_read` with no `project_path` returns active stickies from
   *all* projects (needed for the global digest). A session in project A can therefore read
   project B's stickies. Acceptable for a single local user; relevant if you store
   project-sensitive context and run untrusted code/agents.
3. **Best-effort redaction, not a vault.** `redact.js` catches common secret shapes, not all.
   Do not deliberately store credentials in stickies; storage is plaintext.
4. **`/stickies add` shell construction.** The slash command has the model build a
   `node cli.js add "<text>"` invocation (restricted to `Bash(node:*)`). Avoid passing
   untrusted text through it; prefer the `stickies_write` MCP tool for programmatic writes.
5. **Notes in a repo are as public as the repo.** Repo-mode commits your notes into the
   repository itself. That is the feature — it is how a note written on a phone reaches your
   desktop — but it means the visibility of your notes is the visibility of that repo, decided
   once when you run `init-repo` and easy to forget afterwards.

## Before publishing to a registry

- Manifests carry a handle (`dumbspacecookie`), not an email address. If you fork this, check
  `package.json` and `.claude-plugin/plugin.json` before publishing under your own name.
- Repo scanned: no secrets, no hardcoded user paths in shipped files (configs use
  `${CLAUDE_PLUGIN_ROOT}`).
- Bump the version in `package.json`, `.claude-plugin/plugin.json`, and `server.json` (in two
  places) together — see PUBLISHING.md.
- `test/` is bundled in the plugin copy; harmless but can be excluded to slim the package.

Run the checks any time:

```sh
node --disable-warning=ExperimentalWarning test/redteam.mjs
```
