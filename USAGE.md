# xscs — power user guide

Everything in this document is verified against the CLI as it currently ships
(`xscs/0.2.0-alpha.0`). Exact constants are given because tuning behavior without
them is guesswork.

For *why* the system is shaped this way, see [DESIGN.md](./DESIGN.md). This
document is about operating it.

---

## Contents

1. [The runtime model](#1-the-runtime-model)
2. [Installation and the binary](#2-installation-and-the-binary)
3. [The item model](#3-the-item-model)
4. [Command reference](#4-command-reference)
5. [What actually gets captured](#5-what-actually-gets-captured)
6. [How recall picks what you see](#6-how-recall-picks-what-you-see)
7. [Decay and maintenance](#7-decay-and-maintenance)
8. [Distillation](#8-distillation)
9. [MCP: the agent driving the store](#9-mcp-the-agent-driving-the-store)
10. [Scripting and automation](#10-scripting-and-automation)
11. [Operating across repos and machines](#11-operating-across-repos-and-machines)
12. [Troubleshooting playbook](#12-troubleshooting-playbook)
13. [Tuning recipes](#13-tuning-recipes)
14. [Anti-patterns](#14-anti-patterns)

---

## 1. The runtime model

xscs is **not a daemon**. It is a binary your agent shells out to at five
lifecycle moments, plus a stdio MCP server, plus a CLI you drive by hand. Three
processes, never running at the same time except by accident.

### The five hook moments

Installed by `xscs init` into `.claude/settings.json` and `.codex/hooks.json`, or
explicitly for Kiro with `xscs init --kiro`. Kiro maps its available
`AgentSpawn`, `UserPromptSubmit`, and `Stop` events into the shared lifecycle;
it does not expose compaction or session-end hooks.

| Event | Matcher | Timeout | What it does |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact\|fork` | 20s | Ranks items, packs a brief, prints it on stdout as `additionalContext`. Also runs rate-limited decay and kicks background distillation. |
| `UserPromptSubmit` | — | 15s | Logs your prompt verbatim to `events`. Optionally injects up to 4 query-matched items. |
| `Stop` | — | 10s | Logs the agent's closing message for that turn. |
| `PreCompact` | `manual\|auto` | 20s | Records the compaction and rewrites `.xscs/HANDOFF.md` before the window is destroyed. |
| `SessionEnd` | — | **3s** | Marks the session ended, spawns a detached distiller, returns. |

`SessionEnd` is 3 seconds because that is Codex's hard ceiling. Nothing slow can
ever be added there.

`PostToolUse` is supported by the hook handler but **deliberately not installed** —
it fires dozens of times per turn and adds nothing that isn't recoverable from
the transcript at distillation time.

### The data path

```
events   every prompt, turn, compaction, session boundary
         append-only · NEVER injected into a prompt · pruned after 60 days
   │
   │  distillation (out of band, detached process)
   ▼
items    typed · scoped · confidence-scored · decaying
         the ONLY table whose contents ever reach a model
   │
   │  ranking + budget packing
   ▼
brief    markdown, token-capped, injected at SessionStart
```

Two supporting tables: `briefs` records every injection (what, when, why, token
cost) so recall is auditable; `links` records supersession and dismissed conflict
pairs.

### Failure posture

Every hook handler is wrapped. On any error it writes to `~/.xscs/xscs.log`,
prints `{}`, and exits `0`. **A hook can never break your agent session.** The
corollary: silent failure is the default, so `~/.xscs/xscs.log` is the first place
to look when something seems wrong.

---

## 2. Installation and the binary

### The build requirement is not optional

`packages/cli/src/version.ts` reads a build-time `define`. Running the CLI from
TypeScript source throws:

```
ReferenceError: XSCS_VERSION is not defined
```

So `bun run packages/cli/index.ts` **only works for `hook` and `mcp`** (which
bootstrap before the CAC command graph loads and never touch `VERSION`). Every
interactive command needs the built bundle:

```bash
bun install
bunx turbo build          # produces packages/cli/dist/xscs.js
```

Put it on your PATH once:

```bash
ln -sf "$PWD/packages/cli/dist/xscs.js" ~/.local/bin/xscs
```

**After any source change, rebuild.** `xscs init` refuses to wire an unbuilt tree,
but nothing stops your hooks from running a *stale* bundle indefinitely.

### Wiring

```bash
xscs init                      # this project only
xscs init --user               # your home dir — applies to every repo
xscs init --claude             # one harness only
xscs init --kiro --with-mcp    # Kiro CLI 3 hooks and MCP
xscs init --dry-run            # show the diff without writing
xscs init --no-mcp             # skip Claude Code MCP registration
```

`init` merges into existing config rather than replacing it, identifies its own
entries by command signature (so re-running updates in place instead of stacking
duplicates), and backs up any pre-existing file to `*.xscs-backup-<epoch>`.

Codex MCP registration is a separate command — `init` prints it:

```bash
codex mcp add xscs -- "$(which bun)" /abs/path/to/packages/cli/dist/xscs.js mcp
```

### Environment

| Variable | Effect |
|---|---|
| `XSCS_HOME` | Directory for the store and log. Default `~/.xscs`. |
| `XSCS_DB` | Full path to the database file. Overrides `XSCS_HOME` for the DB only. |
| `XSCS_DISTILLER` | `claude` \| `codex` \| `ollama` \| `none`. Forces the LLM backend; otherwise auto-detected from PATH. |
| `XSCS_OLLAMA_MODEL` | Ollama model used for distillation. Required unless `--model` is provided. |
| `OLLAMA_HOST` | Ollama API host. Default `http://127.0.0.1:11434`. |
| `XSCS_INTERNAL=1` | Makes every hook a no-op. Set automatically inside distiller subprocesses to prevent recursion. Set it manually to temporarily disable xscs for a shell. |

---

## 3. The item model

### Types

Ordered here by recall priority (see §6):

| Type | Holds | Example |
|---|---|---|
| `constraint` | Binding rules | "Never commit directly to main" |
| `open_thread` | Unfinished work with a next action | "Migration half-applied on feat/x" |
| `decision` | A choice and its reason | "Chose bun:sqlite — no native build step" |
| `preference` | How you like work done | "Named exports only" |
| `pitfall` | A trap and its resolution | "PRAGMA can't take bound params" |
| `fact` | Non-obvious discovered truth | "Auth lives in packages/api/src/auth" |
| `artifact` | Files/branches that move together | working sets |
| `glossary` | Project vocabulary | "Void = the design system" |

### Scopes

| Scope | Recalled when | Set by |
|---|---|---|
| `session` | Never crosses a session. Effectively write-only. | rarely used |
| `branch` | Only on the matching branch — **excluded elsewhere**, not down-ranked | `--scope branch` |
| `workspace` | Default. Anywhere in this git root. | default |
| `global` | Every workspace on the machine | **humans only** |

The LLM distiller is structurally forbidden from writing `global`. That promotion
is always a deliberate act:

```bash
xscs promote <id>                  # --scope defaults to global
xscs promote <id> --scope branch   # narrow it back down
```

### Statuses

```
proposed ──accept──▶ active ──archive/decay──▶ archived
    │                   │
  reject            supersede
    ▼                   ▼
 rejected          superseded
```

Only **`active`** items are ever recalled. `proposed` is the review gate;
`archived` is what decay does to neglected items; `superseded` preserves history
when something is replaced; `rejected` is a tombstone that keeps re-derivation
from resurrecting a bad item.

### Deduplication and reinforcement

The dedupe key is a hash of `type + title + body`, normalized for case,
whitespace and punctuation, scoped by `(workspace, scope, scope_key)`. Writing the
same fact twice does not create a second row. Instead:

- `confidence` += 0.1, capped at 1.0
- `updated_at` refreshed
- `pinned` can only go **up**
- `status` is **untouched** — a re-derived `proposed` item stays proposed
- `use_count` is **untouched** — it means "was recalled", not "was extracted again"

That last pair matters: without them a chatty distiller could manufacture evidence
that its own output is valuable, and could promote its guesses past your review.

---

## 4. Command reference

Global flags on every interactive command: `--json`, `--cwd <path>`.
`hook` and `mcp` dispatch *before* the command graph and accept neither.

### Setup

```bash
xscs init [--user] [--claude] [--codex] [--kiro] [--with-mcp|--no-mcp] [--dry-run]
xscs doctor
xscs mcp                                    # stdio server; not for interactive use
```

`doctor` checks: store presence, workspace resolution, git branch, all four
possible hook config locations (project/user × claude/codex), both CLIs on PATH,
and recall health (active item count + sessions awaiting distillation).

### Reading

```bash
xscs brief [...query] [--budget <tokens>]     # default budget 1200
xscs search [...query] [--limit <n>]          # default limit 15
xscs list [--type t] [--status s] [--limit n] # defaults: status=active, limit=60
xscs open                                     # list --type open_thread
xscs handoff [--stdout] [--budget <tokens>]
xscs stats [--all]
xscs workspaces
xscs export [--all]                           # always JSON, ignores --json
```

`brief` and `search` take a **positional multi-word query** — no quoting needed:

```bash
xscs search how does authentication rotate tokens
xscs brief database migrations
```

`--type` and `--status` accept repeats or commas:

```bash
xscs list --type constraint,decision --status active,proposed
xscs list --type constraint --type decision
```

### Writing

```bash
xscs remember [...title] --type <t> [--title ...] [--body ...] [--why ...]
              [--pin] [--scope <s>] [--tag <t>] [--confidence <0-1>]
xscs review [--accept <id>] [--reject <id>] [--accept-all]
xscs pin <...ids>
xscs unpin <...ids>
xscs promote <...ids> [--scope global|workspace|branch]
xscs forget <...ids>
```

`remember` defaults: `type=fact`, `confidence=0.7`, `scope=workspace`,
`status=active`, `source=manual`. Body falls back to the title if omitted.
Title can be positional or `--title`.

`review` with no flags prints the queue. `--accept`/`--reject` take repeats or
commas. All the id-taking commands are variadic:

```bash
xscs forget itm_a itm_b itm_c
xscs review --accept itm_a,itm_b --reject itm_c
```

### Maintenance

```bash
xscs distill [--session <id>] [--pending] [--mode heuristic|agent|both]
             [--backend claude|codex|ollama|none] [--limit n] [--dry-run]
             [--handoff] [--quiet]
xscs conflicts [--dismiss <idA> --dismiss <idB>] [--limit n]
xscs prune [--events-days n] [--briefs-days n]   # defaults 60 / 30
xscs serve [--port 4319] [--no-open]
```

`conflicts --dismiss` requires **exactly two** ids to register a dismissal; with
one it silently falls through to listing.

### Exit codes

`0` on success. `1` on usage error (missing required args, invalid `--scope`) and
on unknown command. Hooks always exit `0` regardless.

### Sharp edges

These are real and worth internalizing:

- **Invalid `--type` on `remember` silently becomes `fact`.** `--type bogus`
  produces a `fact` item with no warning. Same pattern for `--scope`.
- **Invalid `--type`/`--status` on `list` is silently dropped**, which turns into
  *no filter at all* — so `xscs list --type nonsense` lists everything and looks
  like a match.
- **`--json` on `export` is redundant**; export always emits JSON to stdout.
- **`open` bypasses status filtering entirely** — it is `list --type open_thread`
  with the default `active` status.

---

## 5. What actually gets captured

This is the highest-leverage section. The default distiller is regex-based, so
**you can seed memory deliberately by choosing your phrasing.**

### Phrasings that become `active` constraints immediately (confidence 0.65)

Detected in *your prompts*, split by sentence, questions excluded:

| Pattern | Becomes |
|---|---|
| `never`, `don't`, `do not`, `avoid`, `stop`, `must not`, `should not`, `no longer` | `constraint` (prohibition) |
| `always`, `make sure`, `be sure to`, `ensure that`, `you must`, `required to`, `from now on` | `constraint` (obligation) |
| `prefer`, `I like`, `I'd rather`, `use X instead of Y`, `rather than`, `convention is` | `preference` |
| `remember that`, `note that`, `keep in mind`, `for future reference`, `fyi,` / `fyi:` | `fact` |

Sentences must be 12–400 characters and must not end in `?`. Code fences are
stripped before matching.

**Practical consequence:** *"Let's not put business logic in components"* captures
nothing. *"Never put business logic in components."* becomes a binding constraint
that every future session in this repo sees. Same intent, completely different
persistence. Write the second one when you mean it.

### Phrasings that become `proposed` items (need your review)

From the **agent's** messages, never trusted automatically:

| Pattern | Becomes | Confidence |
|---|---|---|
| `still need to`, `next step`, `remaining work`, `not yet done/implemented/wired`, `left to do`, `todo:`, `follow-up`, `I did not`, `I haven't`, `couldn't finish`, `blocked on` | `open_thread` | 0.45 |
| `I'll use`, `we'll use`, `chose`, `chosen`, `decided to`, `going with`, `settled on`, `switched to`, `opted for` | `decision` | 0.35 |
| ≥3 files touched together via tools | `artifact` (working set) | 0.40 |

Decisions must be 30–400 characters.

### What is filtered out

Harness envelopes are never treated as user intent: `<environment_context>`,
`<system-reminder>`, `<local-command…>`, `<command-name…>`, and the
`Caveat: The messages below were generated…` prefix.

**Tool results are never treated as user intent.** Claude threads tool output back
through a `user` record; xscs splits those out as `tool_result` entries. Without
that, a file containing the words "never use TypeScript" could be mined into a
constraint you never stated. That is a prompt-injection boundary, not a nicety.

---

## 6. How recall picks what you see

### Score

```
score = 2.0 · pinned
      + 1.2 · confidence
      + 1.0 · query_relevance          (BM25, only when a query exists)
      + 0.8 · 0.5^(age_days / 21)      (21-day half-life on updated_at)
      + 0.6 · type_weight
      + 0.5 · branch_match
      + 0.3 · min(1, log1p(use_count) / 3)
      − 0.6 · (use_count == 0 AND age > 45 days)
```

`type_weight`: constraint 1.0 · open_thread 0.95 · decision 0.85 · preference 0.75
· pitfall 0.7 · fact 0.55 · artifact 0.4 · glossary 0.35

Hard exclusions applied before scoring: `session` scope always; `branch` scope
when the branch doesn't match; any item that isn't `active`.

### Per-type quotas

Applied while packing, so one prolific type can't crowd out a critical one:

```
constraint 8 · decision 8 · fact 8 · open_thread 6 · preference 6
pitfall 5 · glossary 5 · artifact 4
```

A pool of 40 glossary entries yields at most 5 in any brief, regardless of budget.

### Budgets by entry point

| Trigger | Budget |
|---|---|
| `SessionStart` after `compact` | 1800 tokens |
| `SessionStart` on `resume` / `fork` | 900 |
| `SessionStart` otherwise | 1200 |
| `UserPromptSubmit` top-up | `max(120, budget / 4)` |
| `xscs brief` | 1200 (`--budget`) |
| `xscs handoff` | 2400 |

The budget covers the **entire rendered brief**, framing and section headings
included — items are dropped until the rendered text fits.

### Top-up rules

Injection at prompt time is deliberately stingy:

- at most **3 top-ups per session**
- at most **4 items** per top-up
- BM25 relevance must exceed **0.55**
- items already injected in this session are excluded
- branch-scoped items must match the current branch

### Query sanitation

Your prompt text never reaches FTS5 raw. It's lowercased, split on non-word
characters, stopword-filtered, tokens under 3 chars dropped, capped at 24 tokens,
and rebuilt as a quoted `OR` query. So `foo: bar`, `"unbalanced`, and `-x` cannot
produce a syntax error — but it also means **operators you type are ignored**.
There is no `AND`, no phrase search, no field search. Search is bag-of-words.

---

## 7. Decay and maintenance

Runs opportunistically at `SessionStart`, rate-limited to **once per 12 hours**
via an atomic claim (concurrent hooks can't all fire it).

| Rule | Threshold |
|---|---|
| Idle → confidence × 0.9 | untouched for 30 days |
| Idle + low confidence → `archived` | confidence < 0.15 |
| Open thread → `archived` | 21 days since the last sign of life |
| Pinned items | **exempt from all of the above** |

"Last sign of life" is `max(last_used_at, updated_at, created_at)`, so a thread
that keeps getting recalled is not archived out from under you.

Force a pass and reclaim disk:

```bash
xscs prune                              # decay + prune events/briefs + VACUUM
xscs prune --events-days 14 --briefs-days 7
```

`prune` deletes only **consumed** events (already distilled). Undistilled history
is never dropped.

---

## 8. Distillation

### Modes

```bash
xscs distill --pending                    # heuristic (default)
xscs distill --pending --mode agent       # LLM only
xscs distill --pending --mode both        # regex + LLM
xscs distill --session ses_abc --dry-run  # inspect without writing
```

- **heuristic** — regex, in-process, free, offline, deterministic. Runs
  automatically in the background at SessionStart and SessionEnd.
- **agent** — uses `claude -p`, `codex exec`, or Ollama's local HTTP API. Everything it produces
  lands as `proposed`. Backend auto-detected; override with `--backend` or
  `XSCS_DISTILLER`.

The LLM distiller runs with **all filesystem tools disabled** (`--disallowed-tools
Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit` for Claude;
`--sandbox read-only` for Codex). Ollama receives only the distillation prompt
and has no xscs-provided tools. All transcript and event material is untrusted input.

### The lease

Both `SessionEnd` and the next `SessionStart` kick a distiller, so two processes
routinely reach the same session. `distilled_at` doubles as an atomic lease: the
loser reports `skipped: true` and writes nothing. A crashed run releases its claim
so the session is retried later.

`--dry-run` neither claims nor writes — safe to run repeatedly.

### Auditing what it would do

```bash
xscs distill --pending --dry-run --json \
  | jq -r '.[].drafts[] | "\(.status)\t\(.type)\t\(.title)"'
```

This is the fastest way to judge whether `--mode agent` is worth its cost on your
codebase before enabling it.

---

## 9. MCP: the agent driving the store

Hooks give *ambient* recall — context arrives whether the agent asked or not.
MCP gives *deliberate* recall and, more importantly, **write-back**.

| Tool | Use it when |
|---|---|
| `context_search` | Before asking you something a past session may have been told |
| `context_remember` | Something surprising was just learned that will matter later |
| `context_supersede` | A recalled item is now wrong — replaces it, keeps lineage |
| `context_forget` | An item is junk |
| `context_pin` | Something must always be recalled (use sparingly) |
| `context_brief` | After a context reset, or when picking up unfamiliar work |
| `context_open_threads` | Resuming abandoned work |
| `context_conflicts` | Recalled context contradicted itself |

Deliberate writes beat inferred ones — the agent knows what surprised it, and a
regex never will. A useful habit is ending a hard debugging session with:

> *"Store what we learned about the migration ordering as a pitfall."*

The brief itself tells the agent these tools exist and that it should correct the
store when it's wrong. That instruction is why memory here is fixable rather than
accumulating.

Verify the server by hand:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | xscs mcp
```

---

## 10. Scripting and automation

`--json` emits the raw data payload of any read or write command. Shapes:

| Command | Shape |
|---|---|
| `list`, `open` | `Item[]` |
| `search` | `{ item: Item, relevance: number }[]` |
| `brief`, `handoff` | `{ text, tokens, item_ids, dropped }` |
| `stats` | `{ stats: {...}, sessions: [...] }` |
| `conflicts` | `{ kind, overlap, hint, a: Item, b: Item }[]` |
| `distill` | `DistillReport[]` |
| `export` | `{ version, exported_at, items }` |

### Recipes

Bulk-reject everything the agent merely narrated:

```bash
xscs list --status proposed --json \
  | jq -r '.[] | select(.type=="decision" and .confidence < 0.4) | .id' \
  | xargs -r xscs review --reject
```

Audit what your next session will actually be told, per repo:

```bash
xscs workspaces --json | jq -r '.[].root' | while read -r repo; do
  printf '%-40s %s tokens\n' "$(basename "$repo")" \
    "$(xscs brief --cwd "$repo" --json | jq .tokens)"
done
```

Find pinned items you've forgotten about — pins never decay, so they are the most
likely source of quiet rot:

```bash
xscs list --json | jq -r '.[] | select(.pinned) | "\(.use_count)×\t\(.title)"' | sort -n
```

Nightly LLM distillation without touching your interactive flow:

```bash
0 3 * * *  XSCS_DISTILLER=claude /Users/you/.local/bin/xscs distill --pending --mode both --quiet
```

Snapshot before a risky curation pass:

```bash
xscs export --all > ~/xscs-backup-$(date +%F).json
```

Note there is no `import` command — that JSON is for inspection and disaster
recovery, not round-tripping.

---

## 11. Operating across repos and machines

**One store per machine**, at `~/.xscs/store.db`, shared by every repo and both
harnesses. Workspace identity is the git root, hashed.

```bash
xscs workspaces                        # every repo the store knows
xscs stats --all                       # aggregate, not just here
xscs brief --cwd ~/other-project       # inspect another repo without cd
```

`--cwd` retargets every interactive command, which makes cross-repo scripting
straightforward.

### Isolation

```bash
XSCS_DB=/tmp/experiment.db xscs stats     # scratch store
XSCS_HOME=~/work-xscs xscs brief          # fully separate home
```

Useful for testing curation strategies, or keeping client work in a separate file.

### Sharing with a team

`.xscs/HANDOFF.md` is the portable artifact. It's regenerated at `PreCompact` and
`SessionEnd`, is plain markdown, diffs in review, and can be read by a harness
that's never heard of xscs (`cat .xscs/HANDOFF.md`). Commit it if you want
teammates' agents to start warm.

The database itself is **not** designed to be shared — it holds verbatim excerpts
of your sessions.

### Backup

The store is SQLite in WAL mode. Copy `store.db`, `store.db-wal`, and
`store.db-shm` together, or use `sqlite3 ~/.xscs/store.db ".backup out.db"`.

---

## 12. Troubleshooting playbook

**Nothing is being recalled at session start.**
`xscs doctor` → is the harness row `wired`? Then `xscs brief` — if that's empty
the store is empty for this workspace, not broken. If `brief` has content but
sessions don't, the hook is failing: check `~/.xscs/xscs.log`.

**`xscs` throws `XSCS_VERSION is not defined`.**
You're running TypeScript source. Use the built bundle (§2).

**Hooks stopped working after I edited the source.**
They're running the old bundle. `bunx turbo build`.

**Everything is stuck in the review queue.**
Distillation writes `proposed`; only you promote. `xscs review`, or
`xscs review --accept-all` if you trust the batch, or the dashboard for bulk
triage.

**The brief is full of junk.**
That's a curation debt, not a bug. `xscs list --status proposed --json | jq length`
to size it, reject aggressively, then `xscs prune`. Long-term the fix is reviewing
weekly rather than monthly.

**The agent believes something stale.**
`xscs search <the wrong thing>` → `xscs forget <id>`. Better, mid-session: tell the
agent to use `context_supersede`, which replaces it and keeps the lineage.

**Two memories contradict each other.**
`xscs conflicts`. Keep one via the dashboard (which supersedes the other), or
`xscs conflicts --dismiss <idA> --dismiss <idB>` if they genuinely coexist.

**Sessions never leave `pending`.**
`xscs stats` shows the count. Run `xscs distill --pending` by hand and read the
output — `--quiet` in the background path hides errors that surface here.

**A session distilled to nothing.**
Usually correct. `xscs distill --session <id> --dry-run` shows what it considered.
If your prompts were phrased conversationally rather than normatively, nothing
matched (§5).

**I want it off, right now.**
`XSCS_INTERNAL=1` in your shell makes every hook a no-op. Permanently: remove the
`xscs` entries from the harness config files.

---

## 13. Tuning recipes

**"Briefs are too long."**
Lower the budget at the hook by editing the installed command to add
`--budget 600`, or raise your rejection rate. Prefer the second — a smaller budget
on a junk-filled store just picks junk more selectively.

**"I never want prompt-time interruptions."**
Add `--no-topup` to the `UserPromptSubmit` hook command in your harness config.

**"Distillation is too noisy in the background."**
Add `--no-background` to the `SessionStart` and `SessionEnd` commands, then run
`xscs distill --pending` on your own schedule.

**"I want higher-quality items and I'll pay for them."**
Run `--mode both` on a cron (§10). Keep heuristic in the hook path — it's what
keeps the system working offline.

**"This rule applies to all my projects."**
`xscs promote <id>` then `xscs pin <id>`. Pinned + global + exempt from decay is
the strongest possible statement. Budget for it: each one costs tokens in every
session in every repo, forever.

**"I want branch-local scratch memory."**
`xscs remember --scope branch --type open_thread ...`. It vanishes from every
other branch and self-archives after 21 idle days.

---

## 14. Anti-patterns

**Pinning liberally.** Pins never decay and are recalled everywhere. Five pins is
a working set; fifty is a permanent tax on every session you will ever run.

**Using xscs as documentation.** If you're hand-writing memories to explain your
architecture, that belongs in `CLAUDE.md` / `AGENTS.md` — prescriptive,
version-controlled, reviewed. xscs is for what *accumulates from working*.

**`--accept-all` as a habit.** It exists for a queue you've already read in the
dashboard. Used reflexively it deletes the only quality gate in the system.

**Never reviewing.** Decay will archive unused junk on its own, so the store
degrades gracefully rather than catastrophically — but decay cannot tell a
confident wrong item from a right one. Only you can.

**Editing `.xscs/HANDOFF.md` by hand.** It's regenerated on every compaction and
session end. Curate the store instead.

**Trusting a recalled item because it's in the brief.** The brief explicitly frames
its contents as prior conclusions requiring verification. That framing is load-
bearing — memory that reads as authority is memory that never gets corrected.
