# Refactor closeout guide

This guide defines how to close the intentional `cross-session-summary`
refactor and how to sequence the two follow-on goals: Kiro CLI support and an
initial npm release.

The approved architecture and compatibility requirements remain documented in
[`REFACTOR_PLAN.md`](../REFACTOR_PLAN.md). This document is the shorter,
operational checklist for deciding when that refactor is complete.

## Current implementation state

The architectural implementation is complete:

- CAC owns interactive CLI parsing behind a hook-first bootstrap;
- command workflows are split into focused, testable modules;
- Bun and Node 24 ESM artifacts provide full command parity;
- both runtimes use the same SQLite database, migrations, WAL configuration,
  locking policy, and FTS5 behavior;
- Claude Code and Codex are represented by explicit harness adapters;
- MCP remains a first-party newline-framed JSON-RPC 2.0 implementation with a
  conformance suite;
- the dashboard is loaded only by `serve` and can run through either runtime;
- the npm package exposes `xscs` for Node and `xscs-bun` for Bun;
- standalone executable build, checksum, and smoke tooling exists;
- Mise drives the Turborepo build, test, typecheck, and lint tasks;
- CI, GitHub Release assembly, ADRs, compatibility policy, and release
  documentation are present.

The remaining work is acceptance and closeout rather than another structural
refactor phase.

## Automated closeout gates

Start from a clean, reviewed worktree and run:

```bash
mise run lint
mise run build
mise run typecheck
mise run test
mise run prerelease-check
mise run npm-package-smoke
mise run benchmark-hooks
```

The npm package smoke installs the generated tarball into an isolated temporary
directory. It therefore needs registry access to install runtime dependencies.
A timeout or network failure is not a passing result; rerun it in an
unrestricted shell.

The ordinary local test command intentionally skips the Node dashboard network
test. Run the same network-enabled test configuration used by CI before
closeout:

```bash
XSCS_NETWORK_TESTS=1 bun test
```

Compare the hook benchmark with
[`benchmarks/hook-startup.md`](benchmarks/hook-startup.md). Hook performance
must not regress meaningfully, but no arbitrary percentage threshold is used.

## Standalone executable validation

Build the executable for the host platform, then run the complete standalone
smoke against the resulting artifact. For example, on Apple silicon:

```bash
bun scripts/build-standalone.ts --target bun-darwin-arm64
bun scripts/smoke-standalone.ts release/xscs-darwin-arm64
bun scripts/checksums.ts release
bun scripts/checksums.ts release --verify
```

Choose the appropriate target and artifact name for another platform. The
smoke validates version output, diagnostics, store writes and reads, hook
safety, MCP initialization, and dashboard serving without adjacent assets.

## Manual sanity and smoke block

Use a temporary store for isolated command checks, but also validate the
installed hooks against the real user store. Do not replace or delete the real
store as part of testing.

### 1. CLI compatibility

Run representative read, write, maintenance, and help commands with both built
artifacts:

```bash
packages/cli/dist/xscs.js --version
packages/cli/dist/xscs.js --help
packages/cli/dist/xscs.js doctor

node packages/cli/dist/xscs.node.js --version
node packages/cli/dist/xscs.node.js --help
node packages/cli/dist/xscs.node.js doctor
```

For commands used by scripts, verify the existing positional arguments, long
flags, JSON shapes, exit codes, and meaningful stdout/stderr behavior. The
complete command reference is [`USAGE.md`](../USAGE.md).

### 2. Shared Bun and Node store

Point both artifacts at one temporary `XSCS_HOME`. Write with one runtime and
read with the other, then reverse the direction. Confirm both processes see the
same item IDs and database contents and that neither creates a second store.

Also exercise concurrent activity through the normal hook or CLI paths and
confirm there are no lock errors, SQLite warnings, or FTS discrepancies.

### 3. Installed Claude Code integration

Start a genuinely new Claude Code session in this workspace and confirm:

- the session-start hook injects relevant recalled context;
- prompt, stop, compaction, and session-end events are captured;
- the configured MCP server starts successfully;
- explicit MCP search and write operations work;
- malformed or unavailable xscs state cannot break the harness session.

Inspect the generated configuration rather than assuming that a successful
`init` means every hook command points at the current built artifact.

### 4. Installed Codex integration

Start a genuinely new Codex session rather than resuming or compacting an old
one. MCP registrations are attached at harness startup and may not refresh in a
long-running session.

Confirm:

- recalled context appears at session start;
- prompt, stop, compaction, and session-end events reach the store;
- `codex mcp list` reports `xscs` as enabled;
- the xscs MCP tools are actually exposed inside the new session;
- an explicit context search succeeds;
- captured events and session attribution use the expected workspace and
  harness session ID.

Hook capture and MCP tool attachment are separate capabilities. Verify both.

### 5. Dashboard parity

Run `serve` through the Bun artifact and the Node artifact. For each runtime,
confirm:

- the server binds only to loopback;
- the shell and client bundle load;
- workspace selection and search work;
- curation actions persist correctly;
- stopping the process releases the port;
- running unrelated commands does not load dashboard or React modules.

Visual redesign and decorative terminal output remain fast-follow work and are
not closeout requirements.

### 6. Failure behavior

Exercise representative failures:

- unknown command;
- missing required argument;
- malformed hook JSON;
- malformed MCP JSON-RPC input;
- invalid or unwritable store location;
- conflicting foreign harness configuration during installation.

Confirm interactive commands retain their documented non-zero failures and
diagnostics, while hooks continue to fail open without breaking the harness.

## Refactor completion decision

The refactor can be declared complete when:

- all automated gates pass in an unrestricted environment;
- the native standalone smoke passes;
- the manual Claude Code and Codex checks pass in genuinely new sessions;
- Bun and Node operate interchangeably on one store;
- the dashboard works through both runtime artifacts;
- no backward-compatibility discrepancy or unexplained hook regression remains;
- the documentation accurately describes the artifacts that were tested.

Record defects found during smoke testing as refactor closeout work. Defer
polish and new product behavior unless a finding shows an actual compatibility,
correctness, security, or operability regression.

## Follow-on work

### Kiro CLI harness support

Treat Kiro as the first feature after refactor closeout and as a validation of
the `HarnessAdapter` design. Research its lifecycle hooks, payloads, transcript
format, configuration ownership, MCP registration, timeouts, and installation
behavior before implementation. Kiro-specific behavior belongs in its adapter,
not in shared hook branching.

The Kiro work must preserve Claude Code and Codex behavior and add adapter
contract fixtures based on real Kiro payloads.

### Initial npm release roadmap

Begin with a release audit of the existing package work:

1. Confirm ownership and availability of `cross-session-summary` on npm.
2. Select the exact prerelease version and dist-tag.
3. Run the prerelease and installed-tarball checks.
4. Inspect the tarball allowlist and both binary launchers.
5. Review package metadata, README, changelog, and license.
6. Run an authenticated local `npm publish --dry-run`.
7. Publish manually with the selected prerelease tag after approval.
8. Install from the public registry into a clean temporary environment and
   repeat the Node/Bun shared-store smoke.

Standalone executables remain GitHub Release artifacts and are not included in
the npm package. The detailed release procedure is
[`RELEASING.md`](RELEASING.md).

## Operational references

- [`USAGE.md`](../USAGE.md): complete CLI and operational behavior reference.
- [`RELEASING.md`](RELEASING.md): authoritative local validation and release
  runbook.
- [`COMPATIBILITY.md`](COMPATIBILITY.md): backward-compatibility contract.
- [`REFACTOR_PLAN.md`](../REFACTOR_PLAN.md): approved architecture, phases, and
  definition of done.
- [`DESIGN.md`](../DESIGN.md): product and persistence architecture rationale.
