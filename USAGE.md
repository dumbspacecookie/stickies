# Stickies — how to actually use it

Plain-terms guide for **this machine**. Internals live in [README.md](README.md); the
phone/remote story is parked in [PHONE.md](PHONE.md) until the local loop is solid.

## What it is, in one paragraph

Stickies is a notepad that lives **outside** any single Claude session. You (or Claude) pin
a note; it survives context resets, `/clear`, closing the terminal, and rebooting. Next time
you open Claude Code in that folder, the important notes get injected back into its context
automatically. It's one SQLite file — `~/.stickies/stickies.db` — that every terminal, every
project, and every Claude session on this machine reads and writes.

You never touch the file. You use three verbs.

## The three verbs

| I want to… | Command |
|---|---|
| Pin a thought | `/btw <the thought>` |
| See my notes | `/stickies` |
| Mark one done | `/stickies dismiss <id>` |

That's the tool. Everything below is detail.

### Pin — `/btw`

```
/btw the auth check on the public route is probably leaking
/btw ship the npm release global
```

Type it mid-build, in the middle of anything. Claude writes it down, confirms in one line,
and **does not act on it or ask you about it** — that's the point. Costs you nothing, so you
actually use it.

- Defaults to **P1 todo**, scoped to the folder you're in.
- Add `global` to make it follow you into every project.
- It takes a conversational turn like any message — it isn't parallel. It just can't derail
  Claude, because the command forbids follow-up. For **zero** conversational cost, use the
  dashboard or a second terminal (below).

#### `/btw` vs `/stickies add` — the only difference is the defaults

Same database, same kind of note. What differs is what they assume about *why you're typing*:

| | Category | Importance | Use when |
|---|---|---|---|
| `/btw <text>` | `todo` | **P1** | you want this in your face next session |
| `/stickies add <text>` | `context` | **P2** | you want it on the board, quietly |

You can always override with flags. The defaults just save you from thinking about it —
and `/btw` is the one you'll reach for 90% of the time.

### Review — `/stickies`

```
/stickies            # this project's notes + globals, with ids
/stickies all        # every project at once
/stickies p1         # just the P1s — the action list
/stickies global     # just the globals
/stickies dashboard  # the web UI
```

**This is the part everyone misses.** What Claude sees at session start is a *digest*, not
the list — P3 notes collapse to a bare count like "2 stickys", with no ids and nothing to act
on. To see the real thing, with ids, you have to ask. `/stickies` is the ask.

### Done — `/stickies dismiss <id>`

```
/stickies dismiss 5844e6bc-4119-4cfa-adcf-58970127cdca
```

Ids come from `/stickies`. Dismissing is a **soft delete** — marked dismissed, never
destroyed. `todo` notes never expire on their own, so a task can't silently vanish; it's done
when you say it's done.

## P1 / P2 / P3 — what they actually mean

**Not urgency. Loudness.** Nothing in the system acts on the number. It only decides how much
of the note gets injected into Claude's context at session start:

| | In the session-start digest |
|---|---|
| **P1** | rendered **in full**, verbatim — impossible to miss |
| **P2** | truncated to the first **100 chars** |
| **P3** | a **bare count** — "P3 — minor: 2 stickys" |

Ask yourself: *next time I open Claude in this folder, do I want this shoved in my face?*
Yes → P1. Want it around but won't die without it → P2. Keep it, but stop cluttering me → P3.

The failure mode is **P1 inflation**: mark everything P1 and the digest becomes a wall of
noise, so you stop reading it, so the tool dies. `/btw` defaults to P1 on purpose (you said it
out loud, so it mattered); `/stickies add` defaults to P2. Demote and dismiss aggressively.

## Categories and how long notes live

| Category | Lives for | Use it for |
|---|---|---|
| `todo` | **forever** (until dismissed) | a task, a fix, come back to this |
| `blocker` | 7 days | stuck on something external — missing cred, failing CI |
| `decision` | 30 days | chose X over Y, and the reasoning should survive |
| `context` | 14 days | background worth keeping, not actionable |
| `preference` | 90 days | a stable statement about how you want things done |

Only `todo` is immortal, because a task shouldn't expire — it should get done.

## Scope: project vs global

Every note is stamped with the project you were in when you wrote it. Open Claude in one
project and `/stickies` shows **that project's notes plus your globals** — never the whole pile
from every project you've ever touched. That's the feature: the notes come to you, filtered.

Append `global` when a note should surface everywhere:

```
/btw chase the Sentry issues global
```

**How a project is identified matters.** If the folder is a git repo with a remote, the note
is keyed to the **remote URL** (SSH and HTTPS collapse to the same key). If not, the key falls
back to the **absolute folder path** — so renaming the folder orphans its notes. If a
project's notes matter, give it a git remote.

## Three ways in (pick by how much you want to interrupt)

**1. In the conversation — `/btw`.** Costs one turn. Can't derail Claude.

**2. Zero conversational cost — the dashboard.**

```powershell
node --disable-warning=ExperimentalWarning src/cli.js dashboard --detach   # → http://127.0.0.1:4317/
```

A local web page. Add, browse, and dismiss by clicking, in a browser tab, while Claude is busy
working. Nothing enters the conversation. Loopback-only and CSRF-gated, so nothing off this
machine can reach it. **This is the best surface for reviewing and clearing the board.**

Two views, top right:

- **This project** — only the folder you launched from, plus globals. The default, and the one
  you want most of the time.
- **All projects** — everything, **grouped into one lane per project**, each lane sorted P1
  first, with globals last. Without the grouping this view is a flat wall of every note you own
  and is genuinely unusable; the lanes are what make it a board.

If the page looks stale after an update, the old server is probably still holding port 4317 —
kill the `node` process on that port and relaunch.

**3. Zero conversational cost — a second terminal.**

```powershell
node --disable-warning=ExperimentalWarning src/cli.js list                    # active here
node --disable-warning=ExperimentalWarning src/cli.js list --all              # every project
node --disable-warning=ExperimentalWarning src/cli.js add "the thought" -c todo -i P1
node --disable-warning=ExperimentalWarning src/cli.js add "ship it" -c todo -p global
node --disable-warning=ExperimentalWarning src/cli.js dismiss <id> -r "done"
node --disable-warning=ExperimentalWarning src/cli.js status                  # one-line summary
```

**And the fourth, which is free:** during a normal reply, when something durable comes up,
Claude writes an `!!sticky` line inline and the Stop hook persists it when the turn ends. No
extra turn, no action from you. This is how most notes get written.

```
!!sticky decision P1 #storage :: storage is node:sqlite, no native deps
```

## Optional: the statusline

A live one-line summary of the current project's stickies, under your Claude Code prompt. Add
to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node --disable-warning=ExperimentalWarning \"/path/to/stickies/src/statusline.js\""
  }
}
```

It prints **nothing** when there are zero stickies — an always-on counter that usually reads
zero trains your eye to ignore it, which defeats the point.

## Discord pings (opt-in)

```powershell
[Environment]::SetEnvironmentVariable('STICKIES_DISCORD_WEBHOOK','https://discord.com/api/webhooks/…','User')
```

Stickies posts **one summary per session, at session end** — what got parked, what got cleared
— rather than a ping per note. A channel that fires on every write becomes noise you learn to
ignore, which is the same failure mode as a statusline that always reads zero. The URL is
validated as a genuine Discord webhook host; anything else is refused.

Prove it works without waiting for a session to end:

```powershell
node --disable-warning=ExperimentalWarning src/cli.js notify --test   # one test message
node --disable-warning=ExperimentalWarning src/cli.js notify          # push the open list now
node --disable-warning=ExperimentalWarning src/cli.js notify --all    # …across every project
```

> **The webhook URL is a credential.** Anyone who has it can post into that channel. Keep it in
> the env var — never in a repo file, never in a commit. Rotate it in Discord if it leaks.

## Backup / sync (opt-in)

Notes sync through a git repo **you own** — no third-party service, no new account. Clone (or
create) a private repo somewhere, then point Stickies at it:

```powershell
# Windows (PowerShell) — set at User scope so every terminal inherits it
[Environment]::SetEnvironmentVariable('STICKIES_SYNC_REPO','C:\path\to\stickies-data','User')
[Environment]::SetEnvironmentVariable('STICKIES_AUTO_SYNC','1','User')
```

```sh
# macOS / Linux — add to your shell profile
export STICKIES_SYNC_REPO=/path/to/stickies-data
export STICKIES_AUTO_SYNC=1
```

Set it at a scope every terminal inherits (User env var / shell profile), not just one shell —
otherwise only that terminal syncs. With both set, Stickies pulls at session start and pushes
when a turn captures a note. Manually: `/stickies sync`. Merge is whole-record last-writer-wins
by timestamp, so two machines can't corrupt each other.

If that repo has **no remote**, sync is a local backup. Give it a remote and a second machine
(or your phone via Remote Control — see [PHONE.md](PHONE.md)) sees the same board. Sync is the
only feature that ever touches the network, and only once you configure it.

## Troubleshooting

**"I see the pins but can't do anything with them."** You're looking at the digest, not the
list. Run `/stickies`.

**"My `/btw` note didn't show up next session."** Check scope — a project note only surfaces
in that folder. Use `global` if you want it everywhere.

**"I changed the plugin source but nothing changed."** Installing from a directory marketplace
*copies* the folder into `~/.claude/plugins/cache/`. Editing the source doesn't touch the copy:

```powershell
claude plugin marketplace update stickies-local
claude plugin update stickies@stickies-local
```

Then **restart Claude Code** — hooks and MCP servers are only read at startup.

**"Did the hooks even fire?"** `node src/cli.js status`, or check for the managed block
between `<!-- stickies:start -->` markers in the project's `CLAUDE.md`.
