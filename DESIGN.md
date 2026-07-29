# xscs — cross-session context persistence for coding agents

**Status:** working implementation, v0.1
**Runtime:** Bun 1.3+, TypeScript, `bun:sqlite`, React 19
**Harnesses:** Claude Code and Codex CLI, sharing one store

---

## 1. The problem

A coding agent's memory ends when its context window does. Every new session in a
repository you have worked in for months starts by rediscovering the same things:
which directory the auth code lives in, that the test runner needs a preload
script, that you asked it three times not to commit directly to `main`.

Addy Osmani's *Long-Running Agents* series frames this as one of three core
engineering problems for agents that work over hours or days — alongside finite
context windows and unreliable self-verification — and describes the shape of the
answer that Anthropic, Google and Cursor have all converged on:

> **decouple the model loop (brain) from the execution environment (hands) from
> durable state (the session log).**

The session log is load-bearing. Anthropic treats sessions as append-only event
logs of every thought, tool call and observation, so a run survives a container
dying. Google's Agent Engine exposes the same split as managed services (Agent
Sessions for event history, Memory Bank for curated long-term memory). Cursor
splits planners from workers from judges.

The patterns that matter for a *local* coding agent, extracted from that series:

| Pattern | What it means here |
|---|---|
| **Checkpoint-and-resume** | Write state at meaningful intervals — not every step, not only at the end |
| **Memory-layered context** | A curated long-term store, separate from raw session history |
| **Context resets over summarization** | For long jobs, tear down and rebuild from a *structured handoff file* rather than summarizing repeatedly |
| **Memory drift** | The production failure mode: a lesson from one atypical session hardens into a general rule |
| **Explicit done-conditions** | A written list of what "finished" means, so goals cannot silently be redefined |
| **Ambient processing** | Policy and maintenance decoupled from the agent's own code path |

Two failure modes get much less attention than they deserve, and they drove most
of the decisions below:

- **Context rot.** Degradation sets in well before the hard token limit. A bigger
  window does not fix a store that injects forty mediocre facts.
- **Alignment drift through repeated summarization.** Every round of
  "summarize the summary" loses fidelity to the original goal.

Both point the same direction: **the constraint is precision, not capacity.** The
job is not to remember more. It is to remember less, better.

---

## 2. What the harnesses actually give you

This is the part that makes a single cross-harness tool possible, and it is worth
stating precisely because it is a recent development.

**Claude Code** and **Codex CLI** now ship near-identical hook systems. Both:

- read a JSON payload on **stdin**
- write a JSON object on **stdout**
- put model-visible text under `hookSpecificOutput.additionalContext`
- use exit code `2` to block, anything else to continue
- share the field names `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `permission_mode`, `model`
- share the event names this design depends on: `SessionStart`,
  `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`

The divergences are small and absorbable: config lives in
`.claude/settings.json` versus `.codex/hooks.json`; Codex caps `SessionEnd` at
three seconds; Claude Code has a richer matcher vocabulary.

Both also persist full session transcripts as newline-delimited JSON, in
different envelopes:

```
Claude Code  ~/.claude/projects/<slug>/<session-id>.jsonl
             {"type":"user"|"assistant","message":{role,content},"timestamp",...}

Codex CLI    ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
             {"type":"response_item","payload":{"type":"message"|"function_call",...}}
```

Hooks give you the *edges* of a turn. The transcript gives you what happened in
between — which is where the durable conclusions are. xscs reads both.

**Consequence:** one hook binary, one store, one memory model, both harnesses. A
constraint you state to Codex on Tuesday is recalled by Claude Code on Thursday.

---

## 3. Design decisions

### 3.1 Separate capture from interpretation

Hooks run on a hundred-millisecond budget on the user's critical path. Codex
allows `SessionEnd` one second by default and three at most. An LLM call there
would be killed mid-flight or would stall the terminal.

So capture and interpretation are separated *in time*:

```
hook  →  append-only event log        (microseconds, synchronous, never fails)
         ↓ later, out of band
         distillation                (heuristics; optionally an LLM)
         ↓
         durable items               (curated, typed, scoped, decaying)
         ↓ next session start
         recall brief                (token-budgeted, ranked, injected)
```

`SessionEnd` writes one row and detaches a background process. Nothing that can
take unbounded time runs inside a hook.

### 3.2 Two distillers, and the cheap one is the default

The LLM distiller is the component most likely to be unavailable — offline, rate
limited, out of budget. **A memory system that only remembers when a model call
succeeds is a memory system that silently stops remembering.**

So the default distiller is deterministic and free. It extracts:

- **explicit user directives** (`never …`, `always …`, `prefer …`, `remember that …`) —
  the single highest-precision signal in any session, promoted straight to active
- **unfinished work** (`still need to`, `next step`, `blocked on`) → open threads
- **stated decisions** (`I'll use X because`, `decided to`, `switched to`)
- **the working set** — files that moved together, as one item, not one per file

Anything not stated by the human lands as `proposed` and stays out of every brief
until reviewed. The LLM distiller (`--mode agent`) produces better items; it is an
upgrade, never a dependency.

The distiller prompt is itself a designed artifact. It states the cost of a wrong
memory, forbids restating anything already stored, and demands a `why` for every
item — because an item without a reason cannot be re-evaluated later and becomes
permanent by default. "Zero items is a valid and common answer" is in the prompt.

The LLM distiller runs with all filesystem tools disabled. It reads a transcript,
and a transcript is untrusted input; a distiller that can write files is a
prompt-injection target.

### 3.3 Scope is the defence against memory drift

Every item is born at the narrowest plausible scope:

- `session` — never crosses a session boundary
- `branch` — recalled only on its own branch, *excluded* elsewhere rather than
  down-weighted
- `workspace` — the default
- `global` — every workspace on the machine

Widening is an explicit human action (`xscs promote --scope global`). The LLM
distiller is structurally forbidden from writing `global` at all. This is what
stops a lesson learned in one atypical session from hardening into a universal
rule — the failure mode Osmani names as the one you will actually hit in
production.

### 3.4 Forgetting is a feature

A store that only grows becomes a store nobody trusts, and an untrusted store gets
ignored — which is the same as not having one.

Two forces act on every item. Recall reinforces it: being injected bumps
`use_count` and `last_used_at`; being derived again from a different session
raises `confidence`. Time erodes it: items unused for 30 days lose 10% confidence
per maintenance pass, and below 0.15 they are archived. Open threads older than
three weeks are archived on the theory that they are either done or abandoned.

Pinned items are exempt, because a human asserted them.

Maintenance runs opportunistically at `SessionStart`, rate-limited to twice a day,
riding on a moment the user is already waiting through. No daemon.

### 3.5 Duplicate writes are evidence, not errors

The same fact derived again from a different session does not create a second
row — it reinforces the first. The dedupe key is a hash of type + title + body,
normalised for case, whitespace and punctuation, so *"Use bun:sqlite rather than
better-sqlite3"* and *"Use bun:sqlite, rather than better-sqlite3!"* collapse.

This is what keeps a store readable after a few hundred sessions.

### 3.6 Recall is a packing problem, not a search problem

At session start there is no query — just a workspace and a token budget. Items
are scored:

```
score = 2.0·pinned
      + 1.2·confidence
      + 1.0·query_relevance        (BM25, when a query exists)
      + 0.8·0.5^(age_days / 21)    (three-week half-life)
      + 0.6·type_weight            (constraint > open_thread > decision > … > glossary)
      + 0.5·branch_match
      + 0.3·min(1, log1p(use_count)/3)
      − 0.6·(never used AND older than 45 days)
```

then packed greedily into the budget **with per-type quotas**. Without quotas, a
burst of twenty `fact`s from one large session crowds out the single `constraint`
that actually matters. Packing continues past an item too large to fit, because a
small high-value item may still fit behind it.

Retrieval is SQLite **FTS5 with BM25** — no embeddings, no vector store, no extra
process. At the scale one developer generates this wins on latency, cost and
operational surface area, and it degrades honestly: it either matches your words
or it doesn't. User text is sanitised into a bare token OR-query before it reaches
FTS5, because `foo:bar` or an unbalanced quote in a prompt would otherwise
surface as a hook crash.

### 3.7 The brief tells the agent what kind of thing it is reading

Injected context is framed explicitly as *prior conclusions, not instructions for
this turn*, with an instruction to verify anything load-bearing and to correct the
store when it is wrong. Item ids are included so the agent can supersede a
specific memory through the MCP tools.

This matters more than it looks. Text injected into a system position reads as
authority. Memory that reads as authority is memory that cannot be corrected, and
an uncorrectable store drifts by construction.

### 3.8 Ambient recall *and* deliberate recall

Hooks give ambient recall: context arrives whether the agent asked or not. That is
the right default — an agent does not know what it does not know — but it is
one-directional and always a guess.

An MCP server closes the loop. `context_search`, `context_remember`,
`context_supersede`, `context_forget`, `context_pin`, `context_brief`,
`context_open_threads`, `context_conflicts`. Deliberate writes are far higher
quality than anything a distiller infers after the fact, because the agent knows
what surprised it.

### 3.9 A file, as well as a database

`.xscs/HANDOFF.md` is regenerated at compaction and session end. The database is
the system of record, but a file has properties a database does not: it survives
the store being deleted, it can be read by a harness that has never heard of xscs
(`cat .xscs/HANDOFF.md`), it diffs in review, and it can be committed so a
teammate's agent starts warm.

This is the concrete form of the "reconstruct from a structured handoff file"
step that hard context resets depend on.

### 3.10 Conflicts are surfaced, not resolved

Contradictory memories cannot be resolved automatically without an LLM call and
more confidence than the situation warrants. What *can* be done cheaply and
deterministically is surface the pairs a human should look at: same type, ≥35%
token overlap, and — the strong signal — opposite polarity (one contains a
negation, the other doesn't). FTS narrows the comparison from O(n²) to items that
share words.

The dashboard shows both sides and asks which survives. Dismissed pairs are
recorded so they never resurface.

---

## 4. Architecture

```
packages/core        storage, distillation, recall, decay, drift, handoff
packages/cli         xscs binary: hook bridge, MCP server, curation commands
apps/dashboard       Bun.serve + React 19 curation UI
```

Bun workspaces + Turbo, mirroring the Project-Arcturus layout: each package
bundles with its own `build.ts` via `Bun.build` (`packages: 'external'`), emits
declarations with `tsc`, and exports **built JS from `dist/`** — never TypeScript
source. Hooks point at `packages/cli/dist/xscs.js`; `xscs init` refuses to wire
an unbuilt tree.

### Schema

```sql
workspaces  id, root, name
sessions    id, agent, harness_session_id, workspace_id, cwd, git_branch,
            transcript_path, model, source, started_at, ended_at, distilled_at,
            prompt_count, turn_count            UNIQUE(agent, harness_session_id)
events      id, session_id, ts, kind, payload, consumed_at        -- append-only
items       id, workspace_id, scope, scope_key, type, title, body, why,
            status, confidence, pinned, source, origin_session_id, origin_agent,
            supersedes, content_hash, tags, created_at, updated_at,
            last_used_at, use_count
items_fts   FTS5 external-content index over items (porter unicode61)
links       from_id, to_id, kind        -- supersedes / reviewed / derived_from
briefs      what was injected, when, why, and at what token cost
settings    rate-limit watermarks
```

`events` is the episodic layer and is **never injected into a prompt** — it is raw
material for distillation only. `items` is the only table that reaches a model.
`briefs` exists so that "why did the agent believe that?" is answerable three days
later, and so recall usage is measurable rather than assumed.

Concurrency: WAL plus a 5-second busy timeout. Several hook processes from
different harnesses can hit the file at the same instant, and a hook that throws
`SQLITE_BUSY` is a hook that loses a session's context permanently.

### Item taxonomy

Deliberately decision-oriented rather than the cognitive-science taxonomy
(episodic / semantic / procedural). A coding agent resuming work needs to know
what was decided, what it must not do, and what is still open:

`constraint` · `open_thread` · `decision` · `preference` · `pitfall` · `fact` ·
`artifact` · `glossary`

### Hook coverage

| Event | What happens | Budget |
|---|---|---|
| `SessionStart` | build and inject the brief; run rate-limited maintenance; kick background distillation | ~150 ms |
| `UserPromptSubmit` | record the prompt; inject up to 4 query-matched items, at most 3 times per session, never repeating | ~50 ms |
| `Stop` | append a turn checkpoint | ~30 ms |
| `PreCompact` | record the compaction; rewrite `HANDOFF.md` before the window is destroyed | ~80 ms |
| `SessionEnd` | close the session, detach distillation | ~30 ms |

`PostToolUse` is supported but **not installed by default**: it fires dozens of
times per turn, and everything it would tell us is recoverable from the transcript
at distillation time.

Safety properties, all of which are load-bearing:

- every handler is wrapped; failures are logged to `~/.xscs/xscs.log` and the hook
  still exits `0` with `{}`. A memory system must never be able to break the
  harness it is attached to.
- `XSCS_INTERNAL=1` makes every hook a no-op, so a distiller subprocess (itself an
  agent session) cannot recursively record its own attempts to summarise the store.
- the branch is read by parsing `.git/HEAD` rather than spawning `git` — 40 ms
  saved on every hook, and no blocking on an index lock.

---

## 5. What this deliberately does not do

- **No embeddings or vector store.** At single-developer scale FTS5 + BM25 wins on
  every axis that matters. Revisit at tens of thousands of items.
- **No automatic conflict resolution.** Surfaced, never silently merged.
- **No global writes from a model.** Promotion to global scope is a human action.
- **No daemon.** Maintenance rides on session start.
- **No network.** The store is local, the server binds to loopback, and the
  default distiller makes no calls at all.

## 6. Open questions

- **Does recall actually get used?** The `briefs` table records every injection;
  `use_count` records every touch. The honest next step is measuring whether
  injected items correlate with better sessions, rather than assuming they do.
- **Budget tuning.** 1200 tokens at cold start, 1800 after compaction. Chosen by
  judgement, not measurement.
- **Multi-agent shared workspaces.** Two agents writing the same store
  concurrently works (WAL), but neither is aware of the other's in-flight
  reasoning. Coordination is the frontier Osmani points at, and this design does
  not attempt it.
- **Team sharing.** `HANDOFF.md` can be committed today. A shared store would need
  a sync story and a trust model that does not exist yet.

## 7. References

- Addy Osmani — [Long-Running Agents](https://addyosmani.com/blog/long-running-agents/) ([O'Reilly Radar](https://www.oreilly.com/radar/long-running-agents/), [Substack](https://addyo.substack.com/p/long-running-agents))
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex CLI hooks reference](https://learn.chatgpt.com/docs/hooks)
- Geoffrey Huntley — the Ralph loop (structured task list + persistent notes + verification, in bash)
- Prior art in the same shape: memweave, agentmem, ai-memory — all converging on markdown + SQLite + FTS5 over hosted vector stores
