# ADR 0004: One shared SQLite store

Status: accepted

## Context

Context is valuable only if every harness and runtime sees the same durable
history. Runtime-specific stores or migrations would silently fragment memory.

## Decision

Bun and Node open the exact same `~/.xscs/store.db`. One migration sequence owns
the schema. Both adapters apply WAL, a five-second busy timeout, foreign keys,
FTS5, and equivalent transaction/locking behavior. Existing migrations are
immutable and new migrations are append-only.

## Consequences

Users can alternate `xscs`, `xscs-bun`, and standalone executables safely.
Sequential and concurrent cross-runtime tests are mandatory. Runtime capability
checks fail early when SQLite or FTS5 is unavailable.

## Alternatives

Native third-party SQLite packages were rejected because Node 24 and Bun provide
the required capability. Per-runtime databases and migration branches were
rejected because they violate the product's cross-session premise.
