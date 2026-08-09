# ADR 0003: CLI and protocol boundaries

Status: accepted

## Context

The original CLI manually parsed arguments and synchronized help text. Hook and
MCP paths have different latency and failure contracts from interactive commands.

## Decision

Use a minimal bootstrap to select `hook` and `mcp` before importing CAC. CAC owns
interactive parsing and help. Command-family registration modules translate raw
options into command-specific typed inputs; reusable workflow modules contain the
behavior. Expected interactive failures use typed first-party errors.

MCP remains a first-party JSON-RPC 2.0 implementation with protocol conformance
tests. The official MCP TypeScript SDK is prohibited.

## Consequences

Help and validation are generated, workflows are independently testable, and the
hook path does not evaluate CAC, React, or dashboard code. Hook failures still
fail open; MCP errors remain protocol-framed; interactive errors use stderr and
nonzero exit status.

## Alternatives

Commander was viable, but CAC matches the repository's Bun tooling patterns.
Presenter/service class hierarchies were rejected in favor of small functions.
