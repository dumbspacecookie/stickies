# The release gate

Run this after every build, before any push or publish.

**How much it enforces, honestly.** `prepublishOnly` and the pre-push hook make the gate the
default path, not an unbypassable one. `git push --no-verify`, `STICKIES_SKIP_GATE=1`,
`npm publish --ignore-scripts` and `npm pack` all still skip it. Treat it as a seatbelt, not a
lock — and read the honest-limits list at the bottom before trusting a green tick.

**Arming it in a clone.** `core.hooksPath` lives in `.git/config`, which is not a tracked file, so
the hook does not travel with a clone. Two things carry it now: `npm install` runs the `prepare`
script, which arms it, and `npm run gate` **fails** if this clone is not armed. By hand it is one
command:

```sh
git config core.hooksPath .githooks
```

Then:

```sh
npm run gate            # static checks + full suite. Run this after every build.
npm run gate:release    # the above, plus a record that an agent review was run over exactly
                        # these bytes. Required to publish.
```

## Why this exists

Every bug this project has shipped was found later by someone reading code, not by a test going
red. The dev README told users to open a port the code had already moved off. Three call sites
hand-rolled a redaction ordering that sliced credentials in half. A hook fix sat inert for days
because the plugin cache is keyed by version. A corrupt sync file read as an empty board and got
committed over the real one.

In every one of those cases the suite was green. **Green was never the problem — green was the
problem's disguise.** A green suite tells you the things you thought to check still work. It says
nothing about the things you didn't.

So the gate has two halves, and the second is the one that actually finds bugs.

---

## Half 1 — static (automated)

`npm run gate`. Each check encodes a mistake that really happened:

| Check | The mistake it prevents |
|---|---|
| test suite | the baseline |
| docs match the dashboard port | README/USAGE documented 4317 for weeks after the code moved to 7317 |
| no hand-rolled redact-then-cap | `redactSecrets(x.slice(0,n))` cuts a credential in half; the anchored patterns then match nothing and the fragment is stored |
| git commit is pathspec-scoped | a bare `git commit` commits the whole index — it published a staged `.env.local` |
| no invisible characters in source | a literal U+2028 is correct, unreadable, and silently dropped by the next edit |
| every `*-test.mjs` runs in `npm test` | an unregistered test file reads as coverage and runs never |
| version agreement | two manifests disagreeing means an installed plugin never sees the new hooks |
| version bumped since the last release | two *agreeing but stale* manifests do the same thing — this compares against the `v*` tags and fails if shipping code changed since the tagged version |
| dev-only inventory | apprentice must not reach the public tree |
| push enforcement is armed | `core.hooksPath` is not a tracked setting, and a hook committed 100644 or with CRLF endings does not execute on POSIX — three ways to have no gate at all and not know |
| inlined engine is up to date | `repo-mode/engine.mjs` hand-carried copies of the redactor and the directive parser and fell three releases behind them — see below |

The gate has its own tests (`test/gate-test.mjs`). They run the whole gate against throwaway trees
where exactly one thing is wrong, because two checks in this file once passed while blind and a
third passed on the very fix it was written for. **A check nobody has watched go red is not a
check.**

**A check that has never caught anything and could not catch anything should be deleted**, not
kept for the look of it.

### The one duplicate that is allowed, and what keeps it honest

`src/repo-mode/engine.mjs` is committed into a *user's* repository and runs there with no
`node_modules`, so it cannot import `src/redact.js` — it has to carry a copy. That is a real
constraint, and for three releases the copy was maintained by hand. By the time anyone diffed them
the engine was missing **nine credential patterns**, the armor-header fix and the redaction
idempotence guard, and its directive parser still used the `^\s*` anchor — so every
quoted-directive injection closed in `src/directives.js` was still open in repo-mode. Both copies
were reviewed each time.

A parity *test* did not save it either, and that is the instructive part.
`redaction-parity-test.mjs` printed a `DRIFT` line naming all nine missing shapes **on every single
run**, and the suite stayed green because the check reported instead of failing. Nobody reads a
warning inside a passing suite.

So the copy is no longer maintained — it is **generated**:

```sh
node scripts/build-engine.mjs           # regenerate after touching redact.js / directives.js
node scripts/build-engine.mjs --check   # what the gate calls
```

The region between the `// <<<GENERATED:name>>>` markers is a verbatim copy of the canonical file
with `export ` stripped. Editing inside those markers is pointless — the next build overwrites it,
and both the gate and `test/engine-generated-test.mjs` fail meanwhile. The parity test's soft
report is now a hard assertion, which it can afford to be: the fix is one command.

Two things make this more than a text comparison. `test/engine-generated-test.mjs` spawns the real
`engine.mjs` and asserts on the store it writes — a `hf_` token redacted, a fenced hostile
`global` directive refused — because a generator test stays green if the generated code is never
reached. And the gate's redact-ordering check *blanks* generated regions rather than skipping the
file, so a redactor hand-typed into `engine.mjs` outside the markers still fails.

---

## Half 2 — the agent review (not automatable)

Static checks only catch what someone already understood. The review is for the rest.

Spawn **read-only** agents, one per area, in a single message so they run concurrently. Give each
its own output file. Then:

```sh
npm run gate:agents-done   # records the reviewed commit
```

`gate:release` refuses if that record is missing, or if **any reviewed file has changed since** —
committed or not. The record is a content fingerprint (sha1 per file over `src/`, `scripts/`,
`test/`, `hooks/`, `commands/`, `.githooks/`, the two manifests and the docs), not a commit id, so
"stamp it, then edit without committing" no longer passes. The failure names the files that moved.

### Areas

Split by blast radius, not by folder size:

1. **Capture path** — `auto-capture.js`, `directives.js`, `session-marker.js`, hook wiring
2. **Egress** — `notify.js`, `redact.js`, `session-report.js` (anything leaving the machine)
3. **Persistence** — `db.js`, `store.js`, `doctor.js`, migrations, bulk paths
4. **Sync** — `repo-mode/engine.mjs`, `sync.js`, `git-sync.js` (hostile shared input)
5. **User files** — `flow/writeback.mjs` and friends (it edits `.planning/*.md` in place)

### What to demand of each agent

These are the rules that made round 4 produce 36 real findings instead of a list of maybes:

- **Read the code before theorising.** Cite `file.js:LINE` for every claim.
- **Reproduce or retract.** Write and run a script that demonstrates the bug. A finding you could
  not reproduce goes under "unreproduced suspicions", never under "confirmed".
- **Default to refuted.** Zero confirmed findings is a good outcome. A long list is not a KPI.
- **Isolate.** Read-only on the repo. Scratch DB via `STICKIES_DB` (never `STICKIES_HOME`), sync
  vars blanked, scratch git repos in a temp dir. Agents that mutate and agents that measure must
  not share a working tree — that has produced phantom findings before.
- **Ask whether a test would catch it.** "No test discriminates here" is a finding on its own.

### Then verify the findings yourself

**Do not relay an agent's verdict unchecked.** In round 4, one agent's headline finding did not
reproduce on my first two attempts and needed a third fixture before it held; another was real
but its obvious fix would have reintroduced a documented ReDoS. Reproduce the ones you intend to
act on.

---

## Mutation testing — the step people skip

A passing test proves nothing until you have watched it fail.

After writing a test, break the thing it covers and confirm the test goes red. This has caught,
in this repo alone: a security test whose fixture put the secret *past* the truncation boundary
so it was removed by truncation rather than by redaction — it passed under the bug and under the
fix, and twelve other green assertions did not notice.

Two of the sync guards also survived their first mutation run, because an empty file dies in
`JSON.parse` anyway and a missing array crashes later on `.map`. Same outcome, worse diagnostic.
The fix was to assert the *message*, not just the refusal. Prefer asserting what the user is
told over asserting that something merely didn't happen.

Where a control is cheap, write one: `redaction-parity-test.mjs` asserts that the *old* ordering
does leak, so the test cannot quietly become vacuous.

---

## Before a release specifically

1. `npm run gate` — green
2. Agent review over the areas above → `npm run gate:agents-done`
3. `npm run gate:release` — green
4. **Bump the version** in `package.json` *and* `.claude-plugin/plugin.json`. Without it an
   installed plugin keeps running the cached old hooks and your fix reaches nobody.
5. Remember a public push **is** a release: `.claude-plugin/marketplace.json` has `"source": "./"`,
   so `claude plugin marketplace add dumbspacecookie/stickies` serves whatever is at HEAD.

---

## Honest limits (adversarial review 2026-07-30, revised after the fixes)

A reviewer ran 70 mutations against the first version of this gate. **19 were caught, 51 were
missed.** Two checks were reporting green over bugs they could not see, including the only one
guarding credential disclosure — it was a copy-paste of another check and the word "redact" never
appeared in its body.

**Closed since that review** (each with a test that was watched failing first, in
`test/gate-test.mjs`): the stamp now fingerprints file *content* instead of trusting `HEAD`; the
pre-push hook refuses when the commit being pushed is not `HEAD`, when the tree is dirty, or when
there are untracked source files, so a green gate always describes the code actually leaving the
machine; `npm install` arms `core.hooksPath` and the gate fails if this clone is unarmed, if the
hook is committed non-executable, or if it has CRLF endings; check 7 compares against the `v*` tags
and fails when shipping code changed but the version did not.

**Still true, and not fixable by trying harder:**

- **Check 2 (docs/port)** only matches `127.0.0.1:NNNN` and `localhost:NNNN`. Prose forms — "port
  7317" written into a sentence — are matched only in the `port NNNN` shape; anything else
  ("the board's port", "the default port above") is invisible to it.
- **Check 5 (invisible characters)** covers the zero-width, bidi-override and BOM ranges, but only
  scans `src/`. A Trojan-Source line in `scripts/`, `test/`, `hooks/` or any document passes.
- **Check 6 (test registration)** matches whole path tokens, so it no longer shadows
  `sync-test.mjs` behind `git-sync-test.mjs`. What it still cannot do is judge a test: "has some
  route to a non-zero exit" is a *warning* heuristic, and a file full of assertions that are all
  true of an empty list satisfies it comfortably.
- **The review record proves nothing about a review.** It proves that the files have not changed
  since someone ran `npm run gate:agents-done`. It is a plain JSON file, forgeable by anyone
  willing to type hashes, and `.flow/` is gitignored so it never travels — per-clone by
  construction. It also covers only the paths listed above: `demo/`, `.claude-plugin/marketplace.json`
  and anything new outside them can change without invalidating it.
- **The hook is a seatbelt.** `git push --no-verify`, `STICKIES_SKIP_GATE=1`,
  `npm publish --ignore-scripts` and `npm pack` all bypass it, and `npm install --ignore-scripts`
  skips the arming. It also cannot check an arbitrary commit — it *refuses* the cases where the
  working tree and the pushed commit differ rather than pretending to inspect the commit.
- **The mode check reads the git index**, which is the thing that travels. A hook made
  non-executable only in your working tree is not caught (git does not track that on Windows
  anyway).
- **Workflow trap:** the release steps below bump the version *after* `gate:release`, which
  invalidates the review record and makes `prepublishOnly` block the legitimate publish. Bump
  first, then review, then release.

Nothing here is a reason to skip the gate. It is a reason not to read a green tick as proof.
