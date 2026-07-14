# Stickies — Security notes

Stickies persists notes locally and injects a digest of them into session context at
startup. Note bodies are written by the model and the user, stored in a shared local
SQLite DB, and (in later phases) intended to sync across machines. This file documents
the threat model, what is defended, and the residual risks to weigh before relying on it
or publishing it.

## Trust boundary

- **Single local user.** All stickies for all projects live in one DB
  (`$STICKIES_DB` or `~/.stickies/stickies.db`) with normal user file permissions.
- **No authentication / no network** in phase 1. Nothing is exposed off-host.
- A note written in one project (or synced from another machine) is **untrusted input**
  to every later session that reads it.

## Defended (verified by `test/redteam.mjs`)

| Vector | Defense |
|--------|---------|
| **SQL injection** (content, tags, dismiss id) | All queries are parameterized; no user input is concatenated into SQL. |
| **CLAUDE.md managed-section injection** | Note text can contain `<!-- stickies:end -->`; the digest escapes `<!--`/`-->` so content cannot forge the markers, break out of the managed section, or corrupt the file on repeated session starts. Content outside the markers is always preserved. |
| **Oversized input / DoS surface** | content ≤ 500 chars; tags ≤ 20, each ≤ 40 chars; read `limit` ≤ 500. |
| **Secret capture at rest** | Content is scrubbed on write (`src/redact.js`): PEM private keys, AWS/GitHub/Slack/Google/OpenAI-Anthropic token shapes, JWTs, and `key=<value>` assignments are replaced with `[REDACTED]`; the write tool/CLI warn when this happens. |
| **Arbitrary file write** | The SessionStart hook only writes `<cwd>/CLAUDE.md` (cwd from the trusted hook event). A sticky's `project_path` is a **filter only** — it is never used as a write target. |
| **Native-dependency supply chain** | Zero native modules. Storage uses Node's built-in `node:sqlite`; runtime deps are only `@modelcontextprotocol/sdk`, `commander`, `zod`. |

## Phase 2 surfaces (auto-capture hook + dashboard)

| Surface | Notes |
|---------|-------|
| **Post-turn Stop hook** (`src/auto-capture.js`) | Parses `!!sticky …` directives from the just-finished assistant turn and persists them. Directive content flows through the same `createSticky` path → secret redaction + size/tag bounds apply; writes are deduped and scoped to `cwd`; storing a note is not code execution. The hook is non-blocking and never emits a `block` decision, so it can't cause a stop loop. It trusts `transcript_path`/`cwd` from the (local, Claude-Code-issued) hook event. |
| **Local web dashboard** (`src/dashboard.js`) | Binds **127.0.0.1 only**. Mutations (`/api/dismiss`, `/api/create`) require a per-launch random token **and** a same-origin/no `Origin` check → a drive-by website cannot dismiss or create stickies (CSRF-defended; verified in `test/dashboard-test.mjs`). The page renders note bodies via `textContent`, never `innerHTML`, so a sticky can't inject script into the dashboard. No external assets/CDN. Read endpoints aren't token-gated, but cross-origin pages can't read responses (no CORS headers granted). |

Dashboard residual: any local process running as you can reach the loopback API while the
dashboard is running (single-user assumption). Stop it when not in use; it does not
auto-start.

| **Auto-sync** (`maybeAutoSync` in `src/git-sync.js`) | Doubly gated: runs only when **both** `$STICKIES_AUTO_SYNC` is truthy **and** `$STICKIES_SYNC_REPO` is set. When on, the SessionStart hook pulls and the Stop hook pushes (only on turns that captured a new sticky). Best-effort: any failure is swallowed so it can't break a session. Off by default — no automatic git/network activity unless you opt in. |
| **Git sync** (`src/git-sync.js`, `src/sync.js`) | Opt-in and off by default — does nothing unless `$STICKIES_SYNC_REPO` points at a git working copy you own. All git calls use argument arrays (never a shell string), so repo paths/commit messages can't inject shell commands. Pull/push only happen if the repo has a remote you configured; with no remote it's purely local. **The exported sync document is plaintext JSON** containing all note bodies — store it in a **private** repo. Secret redaction still applies on write, but treat the repo as containing your notes. Merge is last-writer-wins by `updated_at`; a malicious/edited sync file can only add/replace stickies (data), not execute code, and bad records are skipped. |

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

## Residual risks (by design or accepted in phase 1)

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

## Before publishing to a registry

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `package.json` contain
  an **author email**. Replace with a noreply/handle if you don't want it public.
- Repo scanned: no secrets, no hardcoded user paths in shipped files (configs use
  `${CLAUDE_PLUGIN_ROOT}`).
- `test/` is bundled in the plugin copy; harmless but can be excluded to slim the package.

Run the checks any time:

```sh
node --disable-warning=ExperimentalWarning test/redteam.mjs
```
