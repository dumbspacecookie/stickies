# Stickies (Claude Code plugin)

[![npm](https://img.shields.io/npm/v/stickies-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/stickies-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.dumbspacecookie%2Fstickies-6f42c1)](https://registry.modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/node/v/stickies-mcp)](https://nodejs.org)

**Persistent sticky notes for Claude Code.** You pin a note — a decision, a blocker, a todo —
and it survives session resets, `/clear`, and closing the terminal. Next time you open Claude
in that project, the notes that still matter are handed back to it automatically.

**Stickies is not a memory system, and it doesn't try to be one.** It won't watch your session
and decide what to remember. It's the opposite: a handful of notes *you* (or Claude, on request)
write down on purpose, that expire on their own, and that you can read, prune, and trust. No
vectors, no LLM summarization, no cloud. If you want an AI that auto-remembers everything, use
[Claude Code's built-in memory](https://code.claude.com/docs/en/memory) — it's on by default.
Stickies is for when you want the twenty notes that actually matter, and you want them to expire.

---

## Quick start (60 seconds)

You need **Node ≥ 22.5** (`node -v` to check — it's for the built-in SQLite).

```sh
claude plugin marketplace add dumbspacecookie/stickies
claude plugin install stickies@stickies --scope user
```

Restart Claude Code. That's it — install once, it works in every project. Now try it:

- **Ask Claude to remember something:** *"pin a P1 todo: fix the auth leak before release."*
  Claude writes it down; it'll be waiting for you next session.
- **See your notes:** type `/stickies` in Claude Code. Prefer a shell? `npm i -g stickies-mcp`
  gives you a `stickies` command — then `stickies list`.
- **Open the board in a browser:** `/stickies dashboard` → `http://127.0.0.1:4317/`.

Nothing leaves your machine. Everything is a local SQLite file on your disk until *you* turn on
optional git sync.

---

## Where it works

Notes belong to the **project**, not the app you're in — one local database, scoped by project.
What changes between surfaces is how much happens automatically.

| Surface | What you get | How |
|---|---|---|
| **Terminal** (Claude Code CLI) | ✅ the full loop — auto-capture, session-start digest, `/stickies`, statusline, dashboard | install the plugin |
| **Claude Desktop** (chat app) | ✅ read / write via MCP tools (no hooks; pass the project path) | add the MCP server to `claude_desktop_config.json` |
| **iPhone / web** (Remote Control) | ✅ full loop — the phone drives a session running on your machine | run `claude remote-control` on your machine |
| **iPhone / web** (cloud sandbox) | ✅ full loop via **repo-mode** — notes committed into the repo | `stickies init-repo` (see [Repo-mode](#repo-mode-cloud--mobile)) |
| **Any MCP client** | ✅ read / write | it's on the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.dumbspacecookie/stickies` |
| **Anywhere, read-only** | ✅ a glance at your board | Discord digest / board card |

---

## Two things here you won't find elsewhere

- **Zero-turn capture.** Claude parks a note by writing one line *in a reply it was already
  writing* — `!!sticky todo P1 :: fix the auth leak` — and a Stop hook persists it. No extra tool
  call, no extra turn, no tokens spent on a round-trip. (See [Auto-capture](#auto-capture).)
- **Importance-graded injection.** The session-start digest degrades *by importance*, not by
  position: P1 in full, P2 truncated, P3 a bare count. It never just chops the list at N lines.

---

## Flow Board

If your project plans work in a `.planning/ROADMAP.md` (the GSD planning convention), Stickies also
gives you a **live Kanban board** derived straight from that roadmap —
To-Do / Doing / Done — with your stickies cross-linked onto the phases they're about. It's a
projection of your plan, derived on the fly, so it can never drift out of sync with it.

**Four places to see the same board, pick whichever fits where you are:**

| Where | Command | Good for |
|---|---|---|
| **On GitHub / your phone** | `stickies board` → commit `BOARD.md` | glancing at progress from a phone browser — `BOARD.md` renders natively on github.com, no server, no app |
| **In a browser** (local) | `stickies dashboard` → open `/board` | an interactive Kanban; `/graph` shows the plan's dependency DAG |
| **In Discord** | `stickies board --discord` | a push-glanceable card — progress, column counts, per-phase status |
| **In your statusline** | (see [Statusline](#statusline)) | a tiny always-on `📋 ▶2 ☐1 ✓2` (doing / to-do / done) |

```sh
stickies board                     # write BOARD.md in the project root (commit it → view on GitHub)
stickies board --out docs/BOARD.md # write it somewhere else
stickies board --discord           # post the board to your Discord webhook instead
```

Each phase shows its progress (`3/4`), its wave, whether it shipped (`✓ shipped 4/4`) and whether
it's blocked (`⛔`). In a cloud/mobile session with no `.planning/`, a committed `.flow/` snapshot
keeps the board self-sufficient — same repo-mode idea as the notes.

---

## Everyday commands

**In Claude Code** (the `/stickies` slash command):

| Command | Does |
|---|---|
| `/stickies` | list this project's active notes (+ globals) |
| `/stickies all` | list every project's notes |
| `/stickies add <text>` | add a note by hand |
| `/stickies dismiss <id>` | clear a note (a todo is "done" when dismissed) |
| `/stickies dashboard` | open the local web board |
| `/stickies sync` | sync through your git repo (if configured) |

**In any shell** (the CLI — same engine). Install it with `npm i -g stickies-mcp` to get the
`stickies` command on your PATH, then:

```sh
stickies list                          # active notes for this dir + globals
stickies list --all                    # every project + globals
stickies add "ship the release" -c todo -i P1     # add a P1 todo to this project
stickies add "call the bank" -c todo -p global    # a global todo — shows up everywhere
stickies dismiss <id> -r "done"        # clear it
stickies dashboard --open              # local web board, open the browser
stickies board                         # write a GitHub-viewable BOARD.md
stickies status                        # the one-line statusline summary
stickies sync                          # pull → merge → push through your git repo
stickies notify                        # push the open list to Discord
stickies init-repo                     # make notes work in cloud/mobile (repo-mode)
```

---

## Auto-capture

The lowest-friction way in: Claude captures a durable fact by writing one line in its reply, and
a Stop hook persists it — no tool call, no extra turn.

```
!!sticky <category> [P1|P2|P3] [global] [#tag ...] :: <content>
!!sticky decision P1 #storage :: storage is node:sqlite, no native deps
!!sticky todo P1 global :: cut the npm release
```

`category` is required; importance defaults to **P2**; notes are deduped. `global` and `#tags`
are optional and may appear in any order. Without `global`, a note is scoped to the current
project; with it, the note surfaces in **every** project.

The hook scans the whole completed turn, so a directive written *before* Claude runs more tools
still gets saved. Directives inside subagent replies are ignored. Secrets are scrubbed on write.

---

## Statusline

Point your Claude Code statusline at Stickies to get an always-on summary. It's **opt-in** — add
this to your `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "stickies status" } }
```

(that uses the `stickies` command from `npm i -g stickies-mcp`)

By default it's compact — a count plus an urgency flag, e.g. `🟨 2!·19` (2 urgent of 19). It
deliberately does **not** print note text (so nothing sensitive lands in your prompt); set
`STICKIES_STATUSLINE_VERBOSE=1` if you want the top note's text too.

**Clickable link.** In a terminal that supports OSC-8 hyperlinks (Windows Terminal, iTerm2,
WezTerm, Kitty, Ghostty) the segment is a **Ctrl+click link that opens the dashboard**. Two
things it needs:

- The **dashboard must be running** — `stickies dashboard --detach` — or the click has nothing
  to open.
- On **Windows Terminal**, Claude Code doesn't auto-detect hyperlink support, so set
  `FORCE_HYPERLINK=1` in your environment *before launching Claude Code* (e.g.
  `setx FORCE_HYPERLINK 1`, then restart). Without it the segment renders but isn't clickable.

The link auto-skips under tmux (which mangles OSC-8), disables with `--no-link`, and its port
follows `STICKIES_DASHBOARD_PORT`.

---

## Dashboard

```sh
stickies dashboard                 # http://127.0.0.1:4317/
stickies dashboard --open          # and open the browser
stickies dashboard --detach        # run in the background
```

Loopback only (never leaves `127.0.0.1`); mutations are gated by an in-page token, so a random
web page can't poke it. Routes: `/` the notes board, `/board` the Flow Board Kanban, `/graph` the
plan dependency DAG.

---

## Provenance

Every note records **where it was written** — 💻 terminal, 🖥️ desktop, or 📱 mobile — so on the
dashboard you can tell the note you jotted from your phone from the one Claude captured at your
desk. It's a best-effort stamp each entry point knows about itself; no configuration needed.

---

## Sync (git-backed, opt-in)

Sync through a git repo **you own** — no third-party service, no new account. This is the only
feature that ever touches the network, and only once you point it at a remote.

```sh
export STICKIES_SYNC_REPO=/path/to/your/stickies-data   # a git clone you control
stickies sync           # pull → merge (last-writer-wins) → export → commit → push

# or offline, through any file channel:
stickies export -f notes.json
stickies import -f notes.json
```

Each note carries a machine-independent key derived from the project's **git remote** (SSH and
HTTPS collapse to the same key), so a project's notes follow you between machines even when the
checkout lives at a different path on each. Merge is whole-record last-writer-wins by `updated_at`
— conflict-free and order-independent.

**Auto-sync** (also opt-in): set `STICKIES_AUTO_SYNC=1` alongside `STICKIES_SYNC_REPO` and Stickies
pulls on session start and pushes when a turn captures a note. Unset, nothing syncs on its own.

---

## Repo-mode (cloud / mobile)

The plugin lives in `~/.claude`, so it doesn't exist in a cloud session (the iPhone app /
claude.ai/code run in an ephemeral VM that only sees the repo they cloned). **Repo-mode** makes
Stickies work there — no plugin, nothing to install:

```sh
stickies init-repo         # run inside the repo you want notes in
```

That commits a self-contained, zero-dependency engine and wires it up:

- `.stickies/notes.json` — the store, plus a human-readable `.stickies/NOTES.md` mirror
- `.claude/settings.json` — a SessionStart hook (the digest) and a Stop hook (`!!sticky` capture)
- `CLAUDE.md` — teaches Claude the `!!sticky` convention
- `.github/workflows/stickies-sync.yml` — converges notes from every session branch into `main`

Cloud sessions write to their own branch; the bundled Action merges each note into `main`
(union + dismiss-wins + dedupe) — one converged board per repo, hands-off. Same `!!sticky` grammar
and same redaction as the local plugin.

---

## The sticky model

Fields: `id`, `content` (≤ 500 chars), `category`, `importance` (P1/P2/P3),
`project_path` (absolute, or null for global), `tags[]`, `origin`, timestamps, `expires_at`,
`source` (auto/manual), `status` (active/stale/dismissed).

**Default TTLs:** decision 30d · blocker 7d · preference 90d · context 14d · **todo never expires**
(a task is done when you dismiss it, not when a timer runs out). That last one is what makes
`todo` + `global` a real cross-project task list — an unfinished task can't silently vanish.

**Storage:** one SQLite file for all projects, scoped per-project — `$STICKIES_DB` if set, else
`~/.stickies/stickies.db`. It uses Node's **built-in** SQLite (`node:sqlite`, hence Node ≥ 22.5),
so the plugin has zero compiled dependencies and survives Claude Code's plugin-cache copy on any
machine.

**Session-start digest:** P1 in full, P2 to ~100 chars, P3 a count. It's handed to Claude through
the SessionStart hook's `additionalContext` — it reaches the model **without writing to any file**.

---

## Claude Desktop (MCP only)

Claude Desktop supports the MCP tools (`stickies_write` / `stickies_read` / `stickies_dismiss`) but
not hooks or the slash command, so there's no auto-capture or digest there — add it and pass the
project path explicitly. In `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows,
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

Both clients read the same `~/.stickies/stickies.db`, so a note written in one shows up in the
other with no sync step.

---

## Components (reference)

| Component | File | Purpose |
|---|---|---|
| MCP server | `src/server.js` | tools `stickies_write` / `stickies_read` / `stickies_dismiss` |
| SessionStart hook | `src/session-start.js` | injects the digest via `additionalContext` (touches no file) |
| Stop hook (auto-capture) | `src/auto-capture.js`, `src/directives.js` | persists `!!sticky …` directives, deduped |
| Local dashboard | `src/dashboard.js`, `src/dashboard-page.js` | loopback web UI: notes, `/board`, `/graph` |
| Flow Board | `src/flow/` | derive the Kanban from `.planning/ROADMAP.md`; `BOARD.md` export; `.flow/` snapshot |
| Slash command | `commands/stickies.md` | `/stickies …` |
| CLI | `src/cli.js` | backs the slash command; usable directly |
| Store / DB | `src/store.js`, `src/db.js` | CRUD + schema + TTL + dedup + provenance |
| Sync | `src/sync.js`, `src/git-sync.js` | export/import + git pull→merge→push |
| Redaction | `src/redact.js` | scrubs secrets from content on write |
| Repo-mode | `src/repo-mode/` | committed store + hooks + reconcile Action for cloud/mobile |

---

## Install & develop

```sh
# use it:
claude plugin marketplace add dumbspacecookie/stickies
claude plugin install stickies@stickies --scope user     # restart Claude Code after

# work on it:
git clone https://github.com/dumbspacecookie/stickies
cd stickies
npm test        # 23 suites, no network
```

Install once at user scope and it's in every project; per-project scoping is by `project_path` on
each note, not a per-project install.

---

## How Stickies compares

Persistent-notes-for-Claude-Code is a crowded space. Honestly:

- **[Claude Code's built-in memory](https://code.claude.com/docs/en/memory)** — on by default, the
  model decides what to save, no expiry, no importance tiers, no cross-project globals, per-repo
  only. Stickies is the deterministic, human-authored, *expiring* alternative for people who turned
  that off.
- **Knowledge-graph / vector memory servers** (mem0, OpenMemory, `server-memory`, basic-memory) —
  fuzzy retrieval over everything you've said. Different job. Stickies stores a small typed set,
  not an embedding index.
- **Hook-based memory plugins** — several exist, some excellent. Stickies' narrow bets are the ones
  above: zero-turn `!!sticky` capture, importance-graded injection, a global tier that surfaces
  across projects, and a Flow Board derived from your plan.

If you want auto-recall of your whole history, use one of those. Stickies is for a short,
trustworthy, self-pruning list — and a board you can glance at from your phone.

---

MIT · built by [dumbspacecookie](https://github.com/dumbspacecookie)
