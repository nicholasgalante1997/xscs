# Release runbook

## Prerequisites

- The worktree starts from an intentional, reviewed commit.
- `packages/cli/package.json` contains the release version.
- Existing migrations remain immutable.
- Bun is the only package manager and `bun.lock` is current.

## Local validation

```bash
mise run lint
mise run build
mise run typecheck
mise run test
mise run prerelease-check
mise run npm-package-smoke
mise run benchmark-hooks
```

Compare hook startup with the recorded baseline in
[`benchmarks/hook-startup.md`](benchmarks/hook-startup.md). This is an
observational check; investigate meaningful movement rather than enforcing an
arbitrary percentage threshold.

Build and smoke the native executable:

```bash
bun scripts/build-standalone.ts --target bun-darwin-arm64 # choose native target
bun scripts/smoke-standalone.ts release/xscs-darwin-arm64
bun scripts/checksums.ts release
bun scripts/checksums.ts release --verify
```

The smoke covers version output, doctor, store write/search, hook safety, MCP
initialization, and dashboard serving from the single file.

## Publishing

1. Run `bun scripts/validate-release-tag.ts v<VERSION>`.
2. Create and push the reviewed `v<VERSION>` tag.
3. The Release workflow builds and executes all five native artifacts.
4. The assembly job verifies the tag/package version, generates `SHA256SUMS`,
   includes the MIT license, and creates a prerelease when the tag contains `-`.
5. Publish the npm package separately with the matching alpha/beta/stable tag
   only after the GitHub matrix is green.

Signing and macOS notarization are allowed to remain deferred during alpha but
must be resolved before stable `0.2.0`.
