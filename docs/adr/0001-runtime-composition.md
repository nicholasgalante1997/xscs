# ADR 0001: Runtime composition

Status: accepted

## Context

The hook-first Bun implementation must also run under Node 24 and as standalone
executables without duplicating application logic or changing the store.

## Decision

Use narrow database, process, and server interfaces configured by explicit Bun
and Node composition roots. Prefer interface-driven composition; use inheritance
only when implementations genuinely share behavior. Portable filesystem, path,
URL, and Web APIs remain shared.

## Consequences

Shared workflows never detect the runtime. Runtime parity is testable with fake
capabilities and same-file interoperability tests. A new runtime must implement
the required capabilities rather than fork the product. The small amount of
composition setup is deliberate.

## Alternatives

Runtime checks throughout workflows were rejected because they compound. A Bun
daemon serving Node clients was rejected because xscs is intentionally a process,
not a service.
