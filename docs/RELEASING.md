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

### Local npm release

The first npm releases are operator-driven. Preparation and publication are
separate commands, and the exact tarball accepted locally is the artifact sent
to npm.

1. Set and commit the intended version in `packages/cli/package.json` and update
   the changelog. Start from a clean worktree.
2. Prepare the release candidate:

   ```bash
   mise run release-prepare -- 0.2.0-alpha.0
   ```

   This runs the frozen install, complete verification suite, package allowlist,
   hook benchmark, Node 24.0/current and Bun installed-package smoke, and an
   `npm publish --dry-run`. It writes the tarball, checksums, and a manifest to
   `release/npm/` but cannot publish.
3. Inspect the `.tgz`, its `.manifest.json`, `SHA256SUMS`, and `SHA512SUMS`.
4. Rehearse the guarded publish command if desired:

   ```bash
   mise run release-publish -- \
     release/npm/cross-session-summary-0.2.0-alpha.0.tgz \
     --dry-run
   ```
5. Publish the exact accepted artifact:

   ```bash
   mise run release-publish -- \
     release/npm/cross-session-summary-0.2.0-alpha.0.tgz \
     --confirm cross-session-summary@0.2.0-alpha.0
   ```

The publish stage refuses dirty or changed commits, changed package metadata,
checksum mismatches, already-published versions, dirty preparation manifests,
missing repository/homepage/bugs metadata, and missing explicit confirmation.
After publication it verifies dist-tags and installs the registry package into
a clean temporary environment. For a manual repeat of the post-publish check:

```bash
mise run release-verify -- cross-session-summary@0.2.0-alpha.0
```

Authenticate with `npm login` before publishing. Credentials remain in npm's
user configuration and must never be written to this repository.

### GitHub standalone release

1. Run `bun scripts/validate-release-tag.ts v<VERSION>`.
2. Create and push the reviewed `v<VERSION>` tag.
3. The Release workflow builds and executes all five native artifacts.
4. The assembly job verifies the tag/package version, generates `SHA256SUMS`,
   includes the MIT license, and creates a prerelease when the tag contains `-`.
5. Publish the npm package separately with the matching alpha/beta/stable tag
   only after the GitHub matrix is green.

Signing and macOS notarization are allowed to remain deferred during alpha but
must be resolved before stable `0.2.0`.
