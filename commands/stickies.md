---
description: View and manage Stickies — persistent notes for this project
argument-hint: "[all | add <text> | dismiss <id> | dashboard | sync]"
allowed-tools: Bash(node:*)
---

# Stickies

The user invoked `/stickies` with arguments: `$ARGUMENTS`

Run the Stickies CLI via the Bash tool and show the user its output. The CLI lives
at `${CLAUDE_PLUGIN_ROOT}/src/cli.js`. Dispatch on `$ARGUMENTS`:

- **empty** → list active stickies for the current project (plus globals):
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" list`

- **`all`** → list active stickies across every project and global scope:
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" list --all`

- **`add <text...>`** → create a manual sticky from the text after `add`.
  Default category `context`, importance `P2`, scoped to the current project. If the
  text clearly implies a category, pass `-c <decision|blocker|preference|context|todo>`,
  and `-i <P1|P2|P3>` for importance:
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" add "<text>" -c <category> -i <importance>`

- **`dismiss <id>`** → soft-delete the sticky with that id:
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" dismiss <id>`

- **`dashboard`** → launch the local web dashboard in the background and tell the user
  the URL. Run it detached so the command returns immediately:
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" dashboard --detach`

- **`sync`** → sync stickies through the user's own git repo (pull, merge, push).
  Requires `$STICKIES_SYNC_REPO` to point at a git working copy they own; if it errors
  with that message, relay it — do not configure a repo for them:
  `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.js" sync`

Run exactly one command based on the arguments, then present the result plainly.
Do not invent ids; if a dismiss id is missing, list stickies first so the user can pick one.
