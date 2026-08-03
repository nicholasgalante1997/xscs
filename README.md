# xscs — cross-session context store

Your coding agent forgets everything when the context window ends. `xscs` captures
what happened in a session, distills the parts that will still matter next week,
and injects them back into the next cold context window — **across Claude Code and
Codex, sharing one store.**

A constraint you state to Codex on Tuesday is recalled by Claude Code on Thursday.

```
hook  →  append-only event log        microseconds, on the critical path
         ↓ out of band
         distillation                 heuristics by default, LLM optionally
         ↓
         durable items                typed, scoped, decaying, reviewable
         ↓ next session start
         context brief                token-budgeted, ranked, injected
```

The design rationale — prior art, tradeoffs, and what was deliberately left out —
is in [DESIGN.md](./DESIGN.md).

---

## Install

### npm (Node 24)

```bash
npm install --global cross-session-summary
xscs init
```

The npm package also exposes `xscs-bun` for users who prefer Bun ≥ 1.3. Both
commands open the same `~/.xscs/store.db`; switching runtimes never creates a
second store or a runtime-specific migration path.

### Standalone executable

Versioned GitHub Releases contain single-file executables for macOS arm64/x64,
Linux arm64/x64, and Windows x64, plus `SHA256SUMS`. Standalone executables need
neither Node nor Bun and include the dashboard client.

### Source checkout

```bash
bun install
bun run build          # hooks run the built bundle, never TypeScript source
bun run xscs init      # wires .claude/settings.json and .codex/hooks.json
```

`init` merges into existing settings and backs up whatever was there. Add
`--user` to wire your home directory instead of just this project, `--dry-run` to
see what it would do, `--claude` / `--codex` to pick one harness.

For Codex's MCP tools (Claude Code's are registered by `init`), use the same
runtime that owns the installed command. From a source checkout:

```bash
codex mcp add xscs -- $(which bun) $PWD/packages/cli/dist/xscs.js mcp
```

Check the wiring:

```bash
bun run xscs doctor
```

---

## What gets stored

Eight item types, chosen for what a resuming agent actually needs:

| Type | Example |
|---|---|
| `constraint` | "Never commit directly to main, always open a PR" |
| `open_thread` | "Codex hooks still aren't wired into config" |
| `decision` | "Chose bun:sqlite over better-sqlite3 — no native build step" |
| `preference` | "Prefer named exports; no default exports" |
| `pitfall` | "`bun test --watch` hangs when the preload throws" |
| `fact` | "Auth lives in packages/api/src/auth" |
| `artifact` | working sets of files that move together |
| `glossary` | project vocabulary |

Every item carries provenance (which session, which agent, which distiller), a
confidence score, a scope, and a `why`.

**Nothing a model inferred is trusted automatically.** Explicit user directives go
straight in; everything else lands in a review queue and stays out of every brief
until you accept it.

---

## Daily use

```bash
xscs review                    # triage what distillation proposed
xscs review --accept itm_abc --reject itm_def
xscs brief                     # exactly what the next cold session will receive
xscs search "how does auth work"
xscs remember --type constraint --title "Never run migrations against prod" --pin
xscs open                      # unfinished work
xscs conflicts                 # contradictory or duplicate memories
xscs stats                     # store health
xscs serve                     # curation dashboard on 127.0.0.1:4319
```

The dashboard is the fastest way to work through a review queue: bulk select,
accept/reject, resolve conflicts side by side, and preview the exact brief the
next session will get.

### Scopes

Items are born narrow and widen only by hand.

```
session    never leaves the session
branch     recalled on its own branch, excluded elsewhere
workspace  the default
global     every workspace on this machine   ← human-only promotion
```

```bash
xscs promote itm_abc --scope global
```

### Distillation

```bash
xscs distill --pending                 # heuristic; free, offline, deterministic
xscs distill --pending --mode agent    # uses claude/codex headlessly
xscs distill --session ses_x --dry-run # see what it would extract
```

Heuristic mode runs automatically in the background at session start and session
end. Agent mode is an upgrade, never a dependency — the store keeps working when
you are offline, rate-limited, or out of budget.

---

## MCP tools

Once registered, the agent can read and write memory deliberately:

`context_search` · `context_remember` · `context_supersede` · `context_forget` ·
`context_pin` · `context_brief` · `context_open_threads` · `context_conflicts`

Deliberate writes beat inferred ones — the agent knows what surprised it.

---

## Layout

```
packages/core        storage, distillation, recall, decay, drift, handoff
packages/cli         xscs binary: hook bridge, MCP server, curation commands
apps/dashboard       runtime-neutral loopback server + React 19 curation UI
internal/build-utils shared Bun build conventions
```

```bash
mise run lint
mise run build
mise run typecheck
mise run test
mise run prerelease-check
```

Architecture decisions live in [`docs/adr`](./docs/adr), the compatibility
contract in [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md), and the release
runbook in [`docs/RELEASING.md`](./docs/RELEASING.md).

---

## Where things live

| | |
|---|---|
| store | `~/.xscs/store.db` (`XSCS_HOME` / `XSCS_DB` to override) |
| log | `~/.xscs/xscs.log` |
| handoff | `<project>/.xscs/HANDOFF.md` — human-readable, committable |

Environment: `XSCS_HOME`, `XSCS_DB`, `XSCS_DISTILLER=claude|codex|none`,
`XSCS_INTERNAL=1` (disables all hooks — set automatically inside distiller
subprocesses).

---

## Safety properties

- A hook can never break the harness: every handler is wrapped, errors go to the
  log, and the process always exits `0`.
- `SessionEnd` writes one row and detaches — it stays inside Codex's three-second
  ceiling.
- The LLM distiller runs with all filesystem tools disabled. It reads transcripts,
  and transcripts are untrusted input.
- The dashboard binds to loopback only, with no auth and no network calls. The
  store holds verbatim excerpts of your sessions.
- A caller with no resolved workspace gets global-scope items only — never a
  cross-repository leak.

## Uninstall

```bash
xscs init --dry-run     # shows the files involved
```

Remove the `xscs` entries from `.claude/settings.json` and `.codex/hooks.json`
(originals are kept as `*.xscs-backup-*`), then delete `~/.xscs/`.
