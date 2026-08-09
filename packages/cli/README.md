# cross-session-summary

`xscs` gives coding agents durable context across sessions, harnesses, and
runtime boundaries. It captures lifecycle events from Claude Code, Codex, and
Kiro CLI, distills durable decisions and constraints into a local SQLite store,
and recalls a token-budgeted brief when the next session starts.

It is a process, not a server. Hooks start quickly, write locally, return
context, and exit. The only long-running process is the optional loopback-only
curation dashboard.

## Why xscs

Chat transcripts are excessive and poor long-term context. They contain tool
noise, transient narration, stale plans, and unreviewed model claims. xscs keeps
the raw event stream separate from a curated memory layer built around durable
engineering information:

- decisions and their reasons;
- user constraints and working preferences;
- non-obvious repository facts and pitfalls;
- artifacts and unfinished work;
- provenance, confidence, scope, lifecycle status, and review state.

The same `~/.xscs/store.db` is shared by every supported harness and by both
distributed runtimes.

## Requirements

The npm package provides two commands:

- `xscs` — Node 24+ ESM runtime;
- `xscs-bun` — Bun 1.3+ runtime.

Either command operates on the same store. CommonJS is not supported.

## Install

```bash
npm install --global cross-session-summary@alpha
```

Wire Claude Code and Codex into the current project:

```bash
xscs init
xscs doctor
```

Install one harness explicitly:

```bash
xscs init --claude --with-mcp
xscs init --codex
xscs init --kiro --with-mcp
```

Use `--user` for user-wide configuration and `--dry-run` to preview writes.
Existing configuration is merged and backed up rather than replaced.

Claude Code MCP registration is written to `.mcp.json`. Kiro MCP registration
is written to `.kiro/settings/mcp.json`. Codex manages MCP servers in its TOML
configuration, so register it once with the command printed by `xscs init`.

Kiro 3.x discovers `.kiro/hooks/xscs.json` automatically. Kiro 2.x requires an
agent configuration for lifecycle hooks, so xscs also writes
`.kiro/agents/xscs.json`; launch it with `kiro-cli --agent xscs`.

Codex requires interactive trust approval for new or changed project hooks.
Start a fresh Codex session after installation and approve the xscs hooks when
prompted; unapproved hooks cannot inject SessionStart context.

## What happens during a session

1. A session-start hook ranks relevant active memories and injects a bounded
   brief into the harness context.
2. Prompt hooks capture user intent and may add a small query-specific recall
   top-up.
3. Stop hooks checkpoint assistant conclusions and tool summaries.
4. Compaction and session-end hooks capture final state where the harness makes
   those lifecycle events available.
5. Distillation runs outside the latency-sensitive hook path and proposes new
   durable memories for review.

Hook failures fail open: xscs logs the error and does not prevent the agent
harness from continuing.

## Everyday commands

```bash
# Inspect health and stored context
xscs doctor
xscs stats
xscs search "sqlite locking"
xscs list --type decision
xscs open

# Store an explicit memory
xscs remember \
  --type constraint \
  --title "Never publish TypeScript source" \
  --body "Package exports must resolve to bundled JavaScript in dist." \
  --pin

# Curate and maintain
xscs review
xscs conflicts
xscs prune
xscs serve
```

Add `--json` to scripting-oriented commands for stable machine-readable output.
Run `xscs <command> --help` for command-specific options.

## MCP tools

The built-in, first-party JSON-RPC 2.0 server exposes deliberate agent access to
the store:

- `context_search`
- `context_remember`
- `context_supersede`
- `context_forget`
- `context_pin`
- `context_brief`
- `context_open_threads`
- `context_conflicts`

The server uses newline-framed stdio and does not require an MCP SDK or network
listener.

## Distillation providers

Heuristic distillation is local and deterministic. Agent-assisted distillation
can use Claude Code, Codex, or Ollama:

```bash
XSCS_DISTILLER=claude xscs distill --pending --mode both
XSCS_DISTILLER=codex xscs distill --pending --mode both
XSCS_DISTILLER=ollama XSCS_OLLAMA_MODEL=qwen3:8b xscs distill --pending --mode both
```

Ollama is an inference provider, not a lifecycle harness. xscs calls its local
`/api/generate` endpoint with streaming disabled and JSON output requested. Set
`OLLAMA_HOST` to override the default `http://127.0.0.1:11434` endpoint.

When Codex itself runs with `--oss --local-provider ollama`, the harness remains
Codex and xscs records it as such.

## Data and privacy

By default, xscs stores data under `~/.xscs`:

```text
~/.xscs/store.db       SQLite database
~/.xscs/store.db-wal   SQLite write-ahead log while active
~/.xscs/xscs.log       fail-open hook diagnostics, when needed
```

Override the home or database path with `XSCS_HOME` or `XSCS_DB`. The dashboard
binds only to loopback and has no authentication; do not proxy or expose it.

Raw events are not injected into future sessions. Recall uses curated active
items, scope filtering, quotas, and a token budget. Model-inferred items are
proposed for review, while explicit user directives may become active
constraints immediately.

## Supported harness capabilities

| Capability | Claude Code | Codex | Kiro CLI |
| --- | --- | --- | --- |
| Session-start recall | Yes | Yes | Yes, through `SessionStart` (3.x) or `agentSpawn` (2.x) |
| Prompt capture/top-up | Yes | Yes | Yes |
| Turn checkpoint | Yes | Yes | Yes |
| Compaction capture | Yes | Yes | Not exposed by Kiro |
| Session-end capture | Yes | Yes | Not exposed by Kiro |
| MCP configuration | `.mcp.json` | `codex mcp add` | `.kiro/settings/mcp.json` |

This qualification is intentional: xscs models the lifecycle each harness
actually exposes instead of claiming false parity.

## Standalone executables

Self-contained macOS, Linux, and Windows executables are distributed separately
through GitHub Releases with SHA-256 checksums. They include the dashboard and
do not require adjacent assets. Standalone executables are not bundled into the
npm tarball.

## Stability

The `0.2.0-alpha` line preserves the existing `xscs` binary name, command and
flag behavior, JSON shapes, environment variables, SQLite location, and MCP
tool contracts. The initial public package surface is binary-only; internal
packages are not public library APIs.

## License

MIT
