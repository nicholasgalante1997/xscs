# ADR 0002: Harness adapters

Status: accepted

## Context

Claude Code and Codex use similar lifecycle payloads and transcripts but differ
in configuration paths, envelopes, attribution signals, events, and timeouts.

## Decision

Each first-party harness implements `HarnessAdapter`: payload normalization,
recognition, transcript parsing entry, agent attribution, hook configuration,
event availability, and timeouts. Shared hook workflows consume normalized data.

## Consequences

Harness differences are explicit and contract-tested. Adding another harness is
additive rather than a new set of branches across install and hook code. Claude
and Codex remain the only supported implementations in this release.

## Alternatives

Scattered conditionals were rejected as difficult to extend and audit. A generic
configuration framework was rejected as unnecessary abstraction.
