# ADR 0002: Harness adapters

Status: accepted

## Context

Claude Code, Codex, and Kiro CLI expose overlapping lifecycle payloads but differ
in configuration paths, output envelopes, attribution signals, events, and timeouts.

## Decision

Each first-party harness implements `HarnessAdapter`: payload normalization,
recognition, transcript parsing entry, agent attribution, hook configuration,
event availability, and timeouts. Shared hook workflows consume normalized data.

## Consequences

Harness differences are explicit and contract-tested. Adding another harness is
additive rather than a new set of branches across install and hook code. Kiro
maps only the lifecycle events its CLI exposes and uses plain stdout context
injection rather than Claude/Codex's structured output. Because Kiro 2.x embeds
camelCase hooks in agent configuration while Kiro 3.x discovers standalone
PascalCase hook files, installation emits both representations from the same
adapter-owned command contract.

## Alternatives

Scattered conditionals were rejected as difficult to extend and audit. A generic
configuration framework was rejected as unnecessary abstraction.
