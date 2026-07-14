---
description: Park a stray thought as a sticky without breaking flow — the side-quest capture
argument-hint: "<the thought> [P1|P2|P3] [global]"
allowed-tools: Bash(node:*)
---

# btw

The user invoked `/btw` with: `$ARGUMENTS`

This is the **frictionless capture** path. The user had a thought mid-build and wants it
parked so it stops taking up head-space. Your job is to write it down and get out of the
way — not to discuss it, act on it, or ask about it.

Run exactly one command:

```
node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" add "<text>" -c <category> -i <importance> [-p global]
```

**Text:** `$ARGUMENTS` verbatim, minus any trailing `P1`/`P2`/`P3`/`global` keyword the user
appended as a directive. Do not rewrite, summarise, or "improve" their phrasing — a note
they don't recognise later is a note they won't trust. Fix nothing but obvious typos.

**Category** — infer from the text, defaulting to `todo`:
- `todo` — a task, a fix, something to come back to. **This is the default**, because `/btw`
  is overwhelmingly used to park work.
- `blocker` — they are stuck on something external (missing cred, failing CI, waiting on a
  person).
- `decision` — they chose X over Y and the reasoning should survive.
- `context` — background worth keeping that isn't actionable.
- `preference` — a stable statement about how they want things done.

**Importance** — default `P1`. This differs from `/stickies add` on purpose: a `/btw` note is
by definition something the user wants to *see again*, and only P1 renders in full in the
next session's digest and in the statusline (P2 is truncated, P3 is a bare count). Downgrade
to P2/P3 only if the user explicitly says so, or if the note is plainly non-actionable
background (`context`/`preference` → P2).

**Scope** — project (the cwd) unless the user says `global`, in which case pass `-p global`.

After it's written, confirm in **one short line** — what was parked, its priority, and the
id, e.g.:

> Parked (P1 todo) · "auth is probably leaking on the public route" · `a1b2c3d4-…`

Then stop. Do not expand on the note, do not offer to start working on it, do not ask
follow-up questions. If the user wanted to act on it now, they wouldn't have said "btw".
The whole value of this command is that it costs the user nothing to use mid-flow.
