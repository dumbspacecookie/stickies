# Stickies (Claude Code plugin)

[![npm](https://img.shields.io/npm/v/stickies-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/stickies-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.dumbspacecookie%2Fstickies-6f42c1)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/node/v/stickies-mcp)](https://nodejs.org)

A small, deterministic sticky-note layer for Claude Code. You pin a note — a decision, a
blocker, a todo — and it survives session resets, `/clear`, and closing the terminal. Next
session in that project, the notes that still matter are handed back to Claude automatically.

**Stickies is not a memory system, and it doesn't try to be one.** It won't watch your session
and decide what to remember. It's the opposite: a handful of notes *you* (or Claude, on request)
write down on purpose, that expire on their own, and that you can read, prune, and trust. No
vectors, no LLM summarization pass, no cloud. If you want an AI that auto-remembers everything,
use [Claude Code's built-in memory](https://code.claude.com/docs/en/memory) — it's on by default.
Stickies is for when you want the twenty notes that actually matter, and you want them to expire.

**Two things here you won't find elsewhere:**

- **Zero-turn capture.** Claude parks a note by writing one line *in a reply it was already
  writing* — `!!sticky todo P1 :: fix the auth leak` — and a Stop hook persists it. No extra
  tool call, no extra turn, no tokens spent on a round-trip. (Details: [auto-capture](#auto-capture-directive).)
- **Importance-graded injection.** The session-start digest degrades *by importance*, not by
  position: P1 in full, P2 truncated, P3 a bare count. It never just chops the list at N lines.

**New here? Read [USAGE.md](USAGE.md)** — plain-terms guide (the three verbs, what P1/P2/P3
control, project vs global). For the phone/desktop story, see [PHONE.md](PHONE.md). This README
is the reference: components, internals, install.

**Everything runs locally.** SQLite on your disk, a deterministic auto-capture hook, a loopback
web dashboard. Optional git-backed sync through a repo you own — off unless you configure it, and
the only thing that ever touches the network.

**Clients — what's shipped vs planned** (full detail in [PHONE.md](PHONE.md)):

| Surface | State | How |
|---|---|---|
| Terminal (Claude Code) | ✅ full loop | plugin: hooks + commands + MCP |
| Claude Desktop (Windows/Mac) | ✅ read/write | MCP tools only — no hooks, pass the project path |
| iPhone / web | ✅ full loop **via Remote Control** | run `claude remote-control` on your machine; the phone drives that local session (nothing to build) |
| iPhone / web (cloud sandbox) | ✅ full loop **via repo-mode** | `stickies init-repo` commits a store + hooks into the repo; notes persist and converge to `main` (see [repo-mode](#repo-mode-cloud--mobile)) |
| Anywhere, read-only | ✅ | Discord session report |

## Components

| Component | File | Purpose |
|-----------|------|---------|
| MCP server | `src/server.js` (via `.mcp.json`) | tools `stickies_write`, `stickies_read`, `stickies_dismiss` |
| SessionStart hook | `src/session-start.js` (via `hooks/hooks.json`) | injects a digest into the live session via the hook's `additionalContext` (no file is touched) |
| Stop hook (auto-capture) | `src/auto-capture.js`, `src/directives.js` | persists `!!sticky …` directives from each turn, deduped |
| Local dashboard | `src/dashboard.js`, `src/dashboard-page.js` | loopback web UI to view/add/dismiss stickies |
| Slash command | `commands/stickies.md` | `/stickies`, `/stickies all`, `/stickies add <text>`, `/stickies dismiss <id>`, `/stickies dashboard` |
| CLI | `src/cli.js` | backs the slash command; also usable directly |
| Store / DB | `src/store.js`, `src/db.js` | sticky CRUD + schema + TTL logic + auto-capture dedup |
| Sync engine | `src/sync.js` | export/import a sync document, last-writer-wins merge |
| Git sync | `src/git-sync.js` | pull → merge → export → commit → push against a repo you own |
| Project identity | `src/project-key.js`, `src/store-path.js` | machine-independent project key (git remote, else path) |
| Digest | `src/digest.js` | digest formatting; one-time cleanup of the deprecated CLAUDE.md managed section |
| Redaction | `src/redact.js` | scrubs secrets from content on write |
| Repo-mode | `src/repo-mode/` (`engine.mjs`, `install.js`, `stickies-sync.yml`) | cloud/mobile-native: committed store + hooks + reconcile Action; installed by `stickies init-repo` |

## Auto-capture directive

In a reply, the model can capture a durable fact with one line — a Stop hook persists it:

```
!!sticky <category> [P1|P2|P3] [global] [#tag ...] :: <content>
!!sticky decision P1 #storage :: storage is node:sqlite, no native deps
!!sticky todo P1 global :: cut the npm release
```

category required; importance defaults to P2; deduped. `global` and tags are optional and
may appear in any order. Without `global` a note is scoped to the current project; with it
the note is unscoped and surfaces in every project.

The Stop hook scans the assistant text of the whole completed turn — the turn boundary is
the **human's** message, not merely the last transcript entry of type `user` (Claude Code
logs tool results as `user` entries too). So a directive written mid-turn survives any tool
calls that follow it. Directives inside subagent (`isSidechain`) replies are ignored.

## Clients

Notes belong to the *project*, not the client: one DB, scoped by project key. What differs
is how much is automatic.

| | Claude Code (terminal + desktop app) | Claude Desktop (chat app) |
|---|---|---|
| Digest injected at session start | ✅ SessionStart hook | ❌ no hook support |
| `!!sticky` auto-capture | ✅ Stop hook | ❌ no hook support |
| `/stickies` command | ✅ | ❌ |
| `stickies_write/read/dismiss` | ✅ | ✅ (MCP) |
| Knows the current project | ✅ from cwd | ❌ pass `project_path` explicitly |

Claude Code needs no setup beyond installing the plugin. Claude Desktop supports only the
MCP tools — add to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows,
`~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "stickies": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/abs/path/to/stickies/src/server.js"]
    }
  }
}
```

Both clients read the same `~/.stickies/stickies.db`, so notes written in one are visible
in the other with no sync step.

## Repo-mode (cloud / mobile)

The plugin above is **user-scoped** — it lives in `~/.claude`, so it does not exist in a cloud
session (the iPhone app / claude.ai/code run in an ephemeral VM that only sees files committed in
the repo it cloned). **Repo-mode** makes Stickies work there, with no plugin and nothing to install:

```sh
stickies init-repo                 # in the repo you want notes in
# or: node src/cli.js init-repo /path/to/repo
```

That commits a self-contained, zero-dependency engine and wires it up:

- `.stickies/notes.json` — the store (source of truth) + a human-readable `.stickies/NOTES.md` mirror
- `.claude/settings.json` — a SessionStart hook (injects the digest) and a Stop hook (captures `!!sticky …`)
- `CLAUDE.md` — teaches Claude the `!!sticky` convention (the plugin's MCP instructions aren't present in the cloud)
- `.github/workflows/stickies-sync.yml` — converges notes from every session branch into `main`

In a cloud session Claude reads the repo's notes at start and captures new ones into
`.stickies/notes.json`; because that's committed, the note survives the disposable VM. Cloud
sessions write to their own `claude/*` branch, so the bundled GitHub Action merges each note into
`main` (union + dismiss-wins + dedupe) — one converged board per repo, hands-off. Secrets are
redacted before the store and before Discord, exactly as in the local plugin.

Repo-mode is **per-repo** (notes live in that repo). The user-scope plugin remains the way to get
the cross-project shared board on your desktop. Both use the same `!!sticky` grammar and redaction.

## Dashboard

```sh
npm run dashboard                       # http://127.0.0.1:4317/
node src/cli.js dashboard --open        # and open the browser
node src/cli.js dashboard --detach      # run in background
```

Loopback only; mutations are gated by an in-page token (CSRF-safe).

## Statusline

Stickies renders a compact segment in the Claude Code statusline — the 🟨 sticky icon, a count,
and the top pending note. In modern terminals (Windows Terminal, iTerm2, WezTerm, Kitty, Ghostty)
that segment is a **Ctrl+click hyperlink that opens the dashboard** to the full board (this project
+ global). Auto-skipped under tmux (which mangles OSC 8 links); disable with `--no-link`; port
follows `STICKIES_DASHBOARD_PORT`. The dashboard must be running for the click to land.

## Sync (git-backed, opt-in)

Stickies sync through a git repo **you own** — no third-party service, no new account.

Each note records a machine-independent `project_key` derived from the project's **git
remote** (SSH and HTTPS collapse to the same key). So a project's notes follow you between
machines even though the checkout lives at a different path on each — not just globals.
Projects without a git remote fall back to a path-based key (same-machine scope).

```sh
export STICKIES_SYNC_REPO=/path/to/your/stickies-data   # a git clone you control
node src/cli.js sync          # pull -> merge (last-writer-wins) -> export -> commit -> push
# or offline, through any file channel:
node src/cli.js export -f notes.json
node src/cli.js import -f notes.json
```

Merge is whole-record last-writer-wins by `updated_at` — conflict-free and order-independent.
Pull/push are skipped if the repo has no remote, so a purely local repo works too. Sync is
the only feature that can reach the network, and only when you configure a remote.

### Auto-sync (opt-in)

```sh
export STICKIES_SYNC_REPO=/path/to/your/stickies-data
export STICKIES_AUTO_SYNC=1
```

With both set, Stickies pulls on session start (so your digest reflects other machines)
and pushes when a turn captures a new sticky. Off by default — with `STICKIES_AUTO_SYNC`
unset, nothing syncs automatically and you sync manually with `/stickies sync`.

## Sticky model

Fields: `id`, `content` (≤500 chars), `category`, `importance` (P1/P2/P3),
`project_path` (absolute, or null for global), `tags[]`, `created_at`, `updated_at`,
`expires_at`, `source` (auto/manual), `status` (active/stale/dismissed).

Default TTLs: decision 30d · blocker 7d · preference 90d · context 14d · **todo never
expires** (a task is done when you dismiss it, not when a timer runs out).

### Task lists

`todo` + `global` makes stickies usable as a task list: per-project todos live in the
project's drawer, cross-project ones (`global`) surface everywhere. Neither expires, so an
unfinished task can't silently vanish. Finish one by dismissing it:

```sh
node src/cli.js list                        # this build's todos + globals
node src/cli.js add "ship it" -c todo -i P1 # project todo
node src/cli.js add "ship it" -c todo -p global
node src/cli.js dismiss <id> -r "done"      # a todo is done when dismissed
```

## Storage

One SQLite file shared across all projects, scoped per-project by `project_path`.
Location: `$STICKIES_DB` if set, else `~/.stickies/stickies.db`.

Uses Node's **built-in** SQLite (`node:sqlite`, requires Node ≥ 22.5) rather than a
native addon, so the plugin has zero compiled dependencies and survives Claude Code's
plugin-cache copy on any machine. (`node` is invoked with
`--disable-warning=ExperimentalWarning` to mute the node:sqlite experimental notice.)

## Digest format (session start)

P1 shown in full · P2 summarised to first 100 chars · P3 count only. The digest is handed to
the session through the SessionStart hook's `additionalContext` — it reaches Claude **without
writing to any file**. (Earlier versions wrote the digest into the project's `CLAUDE.md`
between `<!-- stickies:start -->` / `<!-- stickies:end -->` markers; that mutated a git-tracked,
often team-shared file, so a note could land in a diff. The SessionStart hook now removes that
managed section on next run — a one-time cleanup.)

## Install

Requires **Node ≥ 22.5** (for the built-in `node:sqlite`). Check with `node -v`.

```sh
claude plugin marketplace add dumbspacecookie/stickies
claude plugin install stickies@stickies --scope user
```

Then restart Claude Code — hooks and the MCP server are read at startup. Install once at user
scope and it's available in every project; per-project scoping is by `project_path` on each
note, not by per-project install.

**Local dev** (working on Stickies itself):

```sh
git clone https://github.com/dumbspacecookie/stickies
claude plugin marketplace add ./stickies
claude plugin install stickies@stickies --scope user
npm test        # 13 suites, no network
```

## How Stickies compares

Persistent-notes-for-Claude-Code is a crowded space. Being honest about it:

- **[Claude Code's built-in memory](https://code.claude.com/docs/en/memory)** — on by default,
  the model decides what to save, no expiry, no importance tiers, no cross-project globals,
  per-repo only. Stickies is the deterministic, human-authored, *expiring* alternative for people
  who turned that off.
- **Knowledge-graph / vector memory servers** (mem0, OpenMemory, `server-memory`, basic-memory) —
  fuzzy retrieval over everything you've said. Different job. Stickies stores a small typed set,
  not an embedding index.
- **Hook-based memory plugins** — several exist and some are excellent. Stickies' narrow bets are
  the three above: zero-turn `!!sticky` capture, importance-graded injection, and a global tier
  that surfaces across projects alongside per-repo scoping.

If you want auto-recall of your whole history, use one of those. Stickies is for a short,
trustworthy, self-pruning list.

## CLI usage

```sh
node src/cli.js list                 # active stickies for cwd + globals
node src/cli.js list --all           # every project + globals
node src/cli.js add "text" -c todo -i P1
node src/cli.js dismiss <id> -r "done"
```
