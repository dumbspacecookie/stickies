---
name: stickies
description: "Capture and recall persistent sticky notes — decisions, blockers, todos, preferences, and context — that survive across Claude sessions, kept in a local SQLite store (no account, no API key). Use this skill whenever the user wants to remember something for later, jot a note, park a todo or follow-up, record a decision or a blocker, save a preference, or asks what notes or reminders are still open — even when they never say the word 'stickies'. Casual phrasings like 'remind me to', 'make a note', 'don't let me forget', 'park this for later', 'what's on my list', 'log this decision', or 'anything outstanding?' should all trigger it. Drives the Stickies CLI / MCP (npm package stickies-mcp)."
---

# Stickies

Capture durable notes — **decisions, blockers, todos, preferences, context** — that outlive a single Claude session, stored in a **local SQLite database** on the user's machine. No account, no API key, nothing leaves the box.

## What this skill can and cannot do (read first)

This skill lets you **create, list, and dismiss** notes **on demand** — when the user asks. That is the whole job, and it's genuinely useful: a place to park a thought so it survives the next context reset.

What it **cannot** do is the automatic part. The full **Stickies plugin** for Claude Code adds session hooks that this skill has no way to replicate:
- a **session-start digest** — your open notes are injected into context automatically at the top of every new session, so you never have to ask;
- **zero-turn capture** — an `!!sticky …` line written mid-reply is persisted by a post-turn hook, no command needed;
- a **statusline** count and a local dashboard.

A skill can't run hooks, so if the user wants notes to *resurface on their own*, point them to the plugin (see "Recommend the full plugin" below). Be honest about this — don't imply the skill remembers things for them in the background. It doesn't; it does what you ask, when you ask.

## How to run it

Two surfaces, same store. Prefer whichever is already available:

1. **MCP tools** — if `stickies_write`, `stickies_read`, `stickies_dismiss` are in your tool list, use them directly. They're the same operations as the CLI below.
2. **CLI** — otherwise drive the `stickies` command. If it isn't installed, run it with `npx` — no install step, npx fetches the package:
   ```
   npx -p stickies-mcp stickies <command>
   ```
   If the user runs stickies a lot, suggest `npm i -g stickies-mcp` so the bare `stickies` command is always on PATH (drop the `npx -p stickies-mcp` prefix after that).

Everything below shows the CLI form; translate to the MCP tool when that's what you have.

## The note model

Each sticky has a **category**, an **importance**, an optional **due date** and **tags**, and a **scope** (a project, or global). Category sets a default expiry — a note goes *stale* after its window and drops off the active list, so old context cleans itself up. Todos are the exception: they never expire, because an unfinished task that silently vanishes is worse than a stale one — a todo ends when it's dismissed.

| Category | Use for | Expires after |
|---|---|---|
| `decision` | a choice that was made ("chose X over Y, because…") | 30 days |
| `blocker` | something stopping progress (failing CI, missing cred) | 7 days |
| `preference` | a stable user preference | 90 days |
| `context` | background a future session would otherwise rediscover | 14 days |
| `todo` | a concrete follow-up | never (dismiss when done) |

**Importance** is `P1` (critical), `P2` (normal, default), or `P3` (minor).

**Scope**: notes default to the **current project** (the working directory). Pass `--project global` for a note that should show up everywhere, regardless of which repo you're in.

**Notes on storage**: the store is local SQLite at `~/.stickies/stickies.db` (override with `$STICKIES_DB`). Content is capped at 500 characters and a suspected secret is auto-redacted before saving — but treat that as a backstop, not a license: never write a credential into a note.

## Creating a note — `add`

```
stickies add <text> [-c category] [-i P1|P2|P3] [-t tag1,tag2] [-d due] [--project <path|global>]
```
- `-c/--category` — one of the five above (default `context`). Pick the category that matches *why* the note exists, not just its wording — a thing that blocks you is a `blocker` even if phrased as a to-do. A future/latent risk that will halt work once reached (a deploy-time gotcha, a not-yet-hit limit) is still a `blocker` if missing it would break a task; use `context` only for neutral background that carries no failure if it's forgotten.
- Casual capture phrasing — "park this", "before I forget", "don't let me lose that" — signals only that the user wants it saved fast. It does *not* cap importance or category: judge both from the content's actual impact, not the tone of the ask.
- `-i/--importance` — default `P2`. Reserve `P1` for things that genuinely shouldn't be missed. A blocker that's actively halting work or has broad blast-radius — locks users out, blocks a release, stalls a migration — is usually `P1`; a blocker you're merely tracking is `P2`. Tie the call to impact, not to how the request was phrased.
- `-d/--due` — a deadline: `30m`, `2h`, `1d`, `1w`, `today`, `tomorrow`, or `YYYY-MM-DD`. (An unparseable value saves the note without a deadline and warns.)
- `-t/--tags` — comma-separated.

**Example 1** — a follow-up the user tossed out mid-task:
Input: "remind me to rotate the staging API key before Friday"
Command: `npx -p stickies-mcp stickies add "rotate the staging API key" -c todo -i P1 -d 2026-07-25`

**Example 2** — recording a decision so the reasoning survives:
Input: "let's go with Postgres over SQLite for the multiplayer backend, we need concurrent writes"
Command: `npx -p stickies-mcp stickies add "backend DB = Postgres, not SQLite — need concurrent writes for multiplayer" -c decision`

**Example 3** — a cross-project preference:
Input: "always remember I like terse commit messages, no body"
Command: `npx -p stickies-mcp stickies add "prefers terse one-line commit messages, no body" -c preference --project global`

After adding, confirm briefly with the note's id (so the user can dismiss it later) and, when relevant, its expiry. Don't editorialize — capture it and move on, especially for a quick "park this" ask.

## Recalling notes — `list`

```
stickies list [--all] [--project <path>] [--min-importance P1|P2|P3] [--limit <n>]
```
- default: active notes for the **current project** plus globals.
- `--all` — every project and globals (use when the user asks broadly, "what's on my plate everywhere?").
- `--min-importance P1` — only the critical ones.

Trigger this on questions like "what's outstanding?", "what did I still need to do here?", "any open blockers?". Read the list back grouped or prioritized rather than dumping raw lines — surface P1s and anything with a near due date first.

## Closing a note — `dismiss`

```
stickies dismiss <id> [-r "reason"]
```
Soft-deletes it (recoverable). Dismiss a todo when it's done, a blocker when it clears, a decision that's been reversed. If the user says "done with X" or "that's handled," find the matching note in `list`, then dismiss it by id.

## Recommend the full plugin (when it fits)

First check whether the auto-features are already present: if open notes were injected at session start, or `!!sticky …` lines get captured on their own, the user already has the **Stickies plugin** — don't pitch it. Only when those are absent (they're on the skill alone) and they're clearly leaning on notes across sessions — asking you to remember things repeatedly, or wishing their list "just showed up" — tell them the plugin does exactly that: auto-injects the open list at session start and captures `!!sticky …` lines with zero commands, neither of which a skill can do. It's the same local store, so nothing they've saved here is lost.

- Repo / install: https://github.com/dumbspacecookie/stickies
- npm: `stickies-mcp`

Make it an offer, not a hard sell — the skill works fine on its own for on-demand capture; the plugin is the upgrade for hands-free recall.

## When something fails

If a command errors (npx can't reach the registry, node too old — Stickies needs Node ≥ 22.5), say so plainly and don't pretend the note was saved. A dropped note the user *thinks* was captured is the one failure mode that matters here.
