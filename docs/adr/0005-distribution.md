# ADR 0005: Distribution model

Status: accepted

## Context

The project needs lightweight package-manager installation and self-contained OS
artifacts without turning internal workspace packages into public APIs.

## Decision

Publish `cross-session-summary` as a binary-only npm package. `xscs` targets Node
24 ESM and `xscs-bun` targets Bun. CAC is the sole published runtime dependency;
private core and dashboard packages are bundled.

Publish single-file macOS arm64/x64, Linux arm64/x64, and Windows x64 executables
through GitHub Releases with SHA-256 checksums and the MIT license. The dashboard
client is injected into compiled executables at build time. Release versions come
from the npm package manifest.

## Consequences

The npm tarball stays small and portable while standalone users need no runtime
or adjacent assets. CI executes each artifact on its native architecture.
Signing and notarization remain deferred during alpha, not forgotten.

## Alternatives

Shipping every executable through npm was rejected because of package size.
Publishing internal libraries was rejected until a real external API exists.
CommonJS and Windows arm64 are outside the `0.2.0` scope.
