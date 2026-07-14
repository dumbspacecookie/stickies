# Stickies from the phone — parked research

**Not built. Not needed yet.** Get the local loop solid first ([USAGE.md](USAGE.md)). This
file exists so the research isn't lost.

## The thing that trips everyone up

**Claude Code on the iPhone app and on claude.ai/code does not run on your machine.** It runs
in an ephemeral cloud VM that Anthropic provisions, clones your repo into, and destroys. Three
hard consequences for Stickies:

- **User-scope plugins don't exist there.** Stickies is installed into `~/.claude/` on this
  box. The cloud sandbox only sees files **committed in the repo** it cloned. So `/btw` and
  `/stickies` are simply absent.
- **`~/.stickies/stickies.db` doesn't exist there.** No home directory survives between cloud
  sessions. The file the whole tool is built on is local.
- **A git remote alone does not fix this.** Necessary for cross-machine sync; nowhere near
  sufficient for the cloud sandbox.

## Option A — Remote Control (works today, nothing to build)

Connects the Claude iOS app (or claude.ai/code) to a Claude Code session **running on your own
machine**. Code executes locally — your filesystem, MCP servers, plugins — and the phone is a
full remote for it. Brokered through the Anthropic API over TLS; your machine makes only
**outbound** requests and never opens an inbound port.

Stickies therefore just works: the session has the real DB, plugin, hooks, MCP server.

```powershell
claude remote-control --name "stickies"
```

Prints a session URL and a QR code (**spacebar** toggles the QR). Scan with the Claude app, or
open claude.ai/code and pick the session from the list — live ones show a computer icon with a
green dot. No app yet? Run `/mobile` for the App Store QR.

Variants: `claude --remote-control` gives a normal interactive session that's *also* remotely
steerable (type at the desk and from the phone interchangeably); `/remote-control` flips it on
inside a session you're already in, carrying history over.

**The phone gets full steering, not view-only:** send prompts, approve/deny permission prompts,
watch tool output and subagent progress, upload images and files, run most slash commands. A
few terminal-UI commands (`/plugin`, `/resume`) are local-only.

**Limits, honestly:**

- Pro / Max / Team / Enterprise, signed in via `/login`. **API-key auth is not supported.**
- **The `claude` process must stay running.** Close the terminal and the session dies. This is
  the real cost.
- The laptop **may sleep** and the network may drop — it reconnects when the machine returns.
  But awake-and-offline for **~10 minutes** times the session out; re-run the command.
- While connected, the **session transcript is stored on Anthropic's servers** (that's what
  syncs it across devices). Execution and filesystem access stay local.
- **Research preview.** Off by default on Team/Enterprise until an owner enables it.
- Starting an **ultraplan** session disconnects Remote Control — they compete for the same
  claude.ai/code surface.

## Option B — make Stickies cloud-native (a real build)

To run inside an actual cloud session, Stickies must stop being a user-scope plugin with a
local DB and become **repo-scoped, with git-backed JSON as the store**:

1. **Commit the plugin into the repo.** The cloud VM only sees repo files. Hooks must be
   declared in the repo's `.claude/settings.json` (user-level hooks don't carry over), the MCP
   server in the repo's `.mcp.json`, commands in `.claude/commands/`. All three *do* fire in
   cloud sessions.
2. **Replace SQLite-as-source-of-truth with the JSON export.** SessionStart pulls the notes
   JSON and injects the digest; the Stop hook appends and pushes. The DB becomes a cache, not
   the store. (Node 22 is in the sandbox, so `node:sqlite` works — but a database in an
   ephemeral VM is a scratch file, not storage.)
3. **Resolve the open question below first.**

### ⚠️ The known unknown — spike this before designing anything

A cloud session's git auth is brokered through an Anthropic proxy and scoped to **the repo it
cloned, pushing only to the current branch**. Whether a sandbox can clone *and push to a
second, unrelated private repo* (`stickies-data`) is **not documented and has not been
verified.**

If it can't, Option B's store must live **inside each project repo** (say `.stickies/notes.json`,
committed) — which works, but splits notes per-repo, puts them in git history, and gives up the
single shared board that makes the tool good.

**The answer to that one question determines the entire architecture.** Spike it first.
