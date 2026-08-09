# Cross-Session Summary: Intentional Refactor Plan

**Baseline:** `54adb7e` (`feat: Initial unstructured vertical slice (0)`)  
**Target:** `cross-session-summary@0.2.0` through alpha and beta prereleases  
**Operational identity:** `xscs` remains unchanged  
**Implementation rule:** Codex must never create commits; the user owns all git history

## 1. Objective

Refactor the working cross-session context store into a maintainable, publishable,
cross-runtime product without losing or degrading existing functionality.

The refactor must preserve the architecture that already provides value:

- hook-based lifecycle integration;
- process-per-invocation operation rather than a daemon or server;
- fast append-only capture separated from out-of-band interpretation;
- SQLite as the local system of record, with WAL, FTS5, and shared concurrency;
- typed, scoped, curated memory rather than raw transcript injection;
- Claude Code and Codex interoperability;
- built JavaScript artifacts in `dist/`, never TypeScript package exports.

The refactor improves engineering structure, CLI behavior, portability,
distribution, testing, and release readiness. It does not redesign the memory
model during the first leg.

## 2. Binding Invariants

### Compatibility

- Preserve every valid existing command, positional argument, long flag, JSON
  shape, exit code, and important stdout/stderr behavior.
- Existing scripts and installed hooks must continue to work unchanged.
- Malformed or undocumented interactive invocations may receive earlier, clearer
  validation errors.
- Help layout may change to CAC-generated output, but it must retain complete
  informational parity and add command-specific help.
- Hooks are exceptional: malformed inputs and internal failures must continue to
  log safely, emit a harmless response, and exit successfully.
- The old hand-written CLI parser is removed only after black-box parity passes.

### Hook-first operation

- Hook processes are the primary use case and the highest-priority performance
  boundary.
- `packages/cli/dist/xscs.js` remains the source-checkout hook entrypoint.
- The bootstrap recognizes `hook` before loading CAC or any interactive command
  tree.
- Dashboard, React, presentation helpers, and unrelated commands must not load on
  the hook path.
- Hook performance is benchmarked and reported. There is no arbitrary hard 10%
  CI threshold, but unexplained meaningful regression blocks acceptance.
- `XSCS_INTERNAL=1` must short-circuit hooks before database or heavy module work.

### Persistence

- Bun and Node installations open the exact same `~/.xscs/store.db`
  interchangeably.
- They share one migration sequence, schema version, WAL configuration,
  busy-timeout policy, foreign-key policy, FTS5 behavior, and locking semantics.
- No runtime-specific database format, migration branch, or duplicate store.
- Existing migrations are immutable. New migrations are append-only.
- The schema, taxonomy, scope rules, recall scoring, decay policy, drift policy,
  distillation policy, and deduplication behavior are frozen during the first leg.

### Packaging

- Every package bundles JavaScript to `dist/`.
- Package exports must never reference TypeScript source.
- Hook commands invoke built JavaScript, never a `.ts` entrypoint.
- `xscs` remains the binary name, environment prefix, storage directory,
  internal namespace, hook identity, and operational shorthand.
- `cross-session-summary` is the public npm package name.
- The initial public compatibility surface is binary-only; internal libraries
  remain private until a genuine external API use case exists.
- Node support is ESM-only. CommonJS is explicitly out of scope.

### Git authority

- Codex and implementation agents must never create commits or tags.
- Work must be implemented and verified in phase-sized checkpoints.
- The user alone decides and writes repository history.

## 3. Approved Architecture

### 3.1 Runtime composition

Use explicit runtime composition roots and interface-driven composition.
Inheritance is reserved for meaningful shared implementation or lifecycle
invariants, not used as ceremony.

Conceptual capability shape:

```ts
interface RuntimePlatform {
    database: DatabasePlatform;
    processes: ProcessPlatform;
    server: ServerPlatform;
}
```

Interfaces should be as narrow as the application requires. Do not construct a
generic operating-system framework. Bun and Node can continue sharing portable
`node:fs`, `node:path`, URL, and Web APIs where behavior is already compatible.

Composition roots:

- Bun entrypoint constructs Bun platform implementations.
- Node entrypoint constructs Node platform implementations.
- Standalone entrypoint constructs the Bun standalone platform.
- Shared application code never branches on the active runtime.
- Runtime detection is confined to launchers when unavoidable.

Runtime-controlled capabilities include:

- SQLite connections, statements, migrations, and transaction behavior;
- subprocess execution and stdio;
- detached background process execution;
- executable discovery;
- HTTP serving and browser opening;
- standalone asset access where it differs from package execution.

### 3.2 Harness composition

Introduce a focused `HarnessAdapter` contract for:

- hook configuration generation;
- raw hook payload normalization;
- transcript recognition and parsing;
- agent attribution;
- harness-specific event availability and timeout limits.

Claude Code and Codex are first-party implementations. Shared lifecycle handlers
consume normalized inputs. Adding another harness is explicitly out of scope for
this refactor, but must become additive rather than condition-heavy.

### 3.3 CLI composition

Use CAC for the interactive CLI.

- Keep a minimal hook-first bootstrap ahead of CAC.
- Use one command registration module per command or pragmatic command family.
- Keep registrations thin and lazy-load command implementations where useful.
- Convert CAC inputs into typed command inputs.
- Extract reusable workflow and domain logic into small testable modules.
- Do not impose a formal service/presenter class hierarchy.
- Extract pure formatting helpers only when testing or reuse justifies them.
- Centralize first-party typed errors: usage, configuration, storage, platform
  capability, and internal errors.
- The interactive boundary owns stdout/stderr and exit behavior.
- Hook and MCP boundaries retain their specialized error policies.

The following manual CLI machinery is removed after parity:

- `parseArgs`;
- `flagString`, `flagBool`, `flagNumber`, and `flagList`;
- the large command switch;
- the manually synchronized root help block.

This does not apply to transcript parsing, MCP JSON parsing, hook validation,
Zod schemas, SQLite processing, or FTS query sanitization.

### 3.4 MCP

The MCP server remains a first-party JSON-RPC 2.0 implementation.

- Do not add or use the official Model Context Protocol TypeScript SDK.
- Preserve all tool names, input schemas, result shapes, stdio behavior, and
  protocol version behavior.
- Keep MCP lazily loaded.
- Add protocol-level conformance coverage for initialization, notifications,
  malformed JSON, invalid requests, unknown methods, IDs, stdout purity, tool
  schemas, and sequential/concurrent message handling.

### 3.5 Dashboard

Freeze UI, routes, API payloads, and curation behavior.

Only change what is required for:

- runtime-neutral Bun and Node serving;
- lazy loading from the `serve` command;
- artifact-level tests;
- embedding the client bundle in a standalone executable.

Standalone embedding must use the simplest Bun-supported mechanism. Stop and
reassess if it requires a custom asset framework. npm builds may load the asset
from `dist/` when that is simpler.

## 4. Distribution Model

### npm

Publish `cross-session-summary` with:

- `xscs` -> Node 24 ESM artifact;
- `xscs-bun` -> Bun-native artifact.

The npm tarball must remain lightweight and must not include every OS
executable. It must contain only built artifacts and required package metadata.

### Node

- Minimum Node version: 24.
- Use `node:sqlite`; no native third-party SQLite dependency.
- Perform startup capability checks for SQLite and FTS5.
- Contain the `node:sqlite` experimental warning so it does not pollute normal
  stderr.
- Test the lowest supported Node 24 version and current Node 24.
- Provide full product parity: hooks, MCP, store, distillation, init, doctor,
  dashboard serving, and every interactive command.

### Standalone executables

Build and smoke-test:

- macOS arm64;
- macOS x64;
- Linux arm64;
- Linux x64;
- Windows x64.

Windows arm64 is deferred until Bun compile support and CI coverage are
dependable.

Executables are attached to versioned GitHub Releases with SHA-256 checksums.
They must be single-file and dashboard-capable without adjacent assets. Signing
and macOS notarization may be deferred during alpha, but must be revisited
before stable `0.2.0`.

### Versioning

- Build-time version injection from one `package.json` source.
- `xscs --version` and `xscs-bun --version` report the same version.
- Release through `0.2.0-alpha.x`, then beta, then stable only after the complete
  parity matrix passes.
- Use the MIT license and include it in npm and release artifacts.

## 5. Tooling and Dependency Policy

- Bun remains the sole package manager, bundler, primary test runner, script
  runner, and lockfile owner.
- Do not add `package-lock.json` or a parallel npm development workflow.
- Turborepo remains the workspace task orchestrator.
- Add `mise.toml` as the thin human-facing task layer; Mise tasks invoke Turbo or
  focused package scripts and do not duplicate build logic.
- Add a private `internal/build-utils` workspace package modeled on Bundt’s
  strongest build patterns.
- Build utilities own shared Bun build configuration, concurrent execution,
  failure handling, artifact reporting, and target naming.
- Package-local build definitions retain entrypoints and genuine special cases.
- Add Bundt-aligned ESLint rules for type-only imports, no explicit `any`, unused
  values, and sorted imports.
- Preserve current formatting during the semantic refactor. Any mass formatting
  is a later formatting-only change.
- Keep runtime dependencies deliberately small:
  - CAC is the only new CLI infrastructure dependency.
  - Keep Zod and React where they already provide material value.
  - Use platform capabilities for SQLite, processes, HTTP, paths, JSON-RPC, and
    logging.
  - Do not add convenience libraries without explicit review.
- Keep output plain and deterministic. Colors, spinners, icons, and decorative
  polish are deferred.
- Release automation uses first-party Bun scripts, runnable locally through
  Mise and invoked by GitHub Actions. Do not add a release-management framework.

## 6. Mandatory Test and Acceptance Matrix

Do not use an arbitrary line-coverage target. Coverage is contract-driven.

### CLI characterization

Execute the built artifact and preserve:

- every valid command and documented flag;
- positional and variadic behavior;
- aliases;
- JSON shapes;
- meaningful human output;
- exit codes;
- stdout/stderr routing;
- hook responses;
- `--cwd` and environment behavior.

Help formatting is not byte-frozen, but informational parity is mandatory.
Malformed interactive input may improve.

### Runtime parity

Run the compatibility corpus against:

- Bun artifact;
- Node 24 artifact;
- standalone smoke artifacts where applicable.

### Database interoperability

- Alternate Bun and Node reads/writes/migrations against one database.
- Test FTS5 equivalence and hostile query sanitization.
- Run concurrent Bun and Node processes against one WAL database.
- Verify no corruption, duplicate sessions, duplicate items, or lost events.

### Harness contracts

Maintain sanitized, real-shaped Claude Code and Codex fixtures for:

- hook payloads;
- transcript envelopes;
- lifecycle normalization;
- attribution;
- configuration output;
- harness-specific timeout and event behavior.

Never commit personal transcript content.

### MCP conformance

Test:

- initialize and initialized flow;
- tools/list schema stability;
- tools/call success and failure;
- notifications with no response;
- request ID preservation;
- parse errors and invalid requests;
- unknown methods;
- malformed arguments;
- stdout protocol purity;
- multiple messages in one process;
- sequencing/concurrency expectations.

### Security properties

Turn every existing guarantee into an executable check:

- hooks cannot break either harness;
- `XSCS_INTERNAL=1` prevents recursive capture;
- transcript content is treated as untrusted;
- distiller subprocesses cannot use filesystem tools;
- model distillation cannot create global items;
- unresolved workspaces receive global items only;
- dashboard binds to loopback only;
- no hook path imports dashboard or React;
- user FTS input cannot become raw FTS syntax;
- install backs up and preserves foreign configuration.

### Standard verification

At every green phase:

```bash
mise run lint
mise run typecheck
mise run test
mise run build
```

Before Mise exists, use the equivalent Bun/Turbo commands.

Release validation additionally includes:

- npm pack dry-run and tarball content checks;
- bin target existence and execution;
- version agreement;
- same-store parity;
- standalone smoke tests;
- SHA-256 manifest verification.

## 7. Delivery Phases

Every phase is independently green. One integration owner controls shared
entrypoints and abstractions. Parallel agents may work only on non-overlapping
packages or fixtures. Each work package includes objective, non-goals, ownership,
dependencies, tests, artifacts, risks, and rollback point.

### Phase 0 — Characterize the baseline

**Objective:** Make current external behavior executable before restructuring.

Work packages:

1. CLI subprocess harness and golden/structural expectations.
2. Hook fixtures and lifecycle contract coverage.
3. MCP stdio conformance harness.
4. Security invariant tests.
5. Repeatable hook-startup benchmark script and baseline record.

Non-goals:

- no parser replacement;
- no runtime abstraction;
- no behavior cleanup except test-enabling seams with identical output.

Acceptance:

- existing 75 tests remain green;
- new tests pass against `packages/cli/dist/xscs.js`;
- benchmark results are recorded without establishing a brittle CI threshold.

Rollback point: baseline implementation remains structurally intact.

### Phase 1 — Modular Bun CLI with CAC

**Objective:** Replace interactive manual CLI utilities without affecting hooks.

Work packages:

1. Minimal hook-first bootstrap.
2. CAC command composition root.
3. Command-focused registration modules and typed option boundaries.
4. Reusable workflow extraction from the monolithic command module.
5. Typed first-party errors and consistent boundary handling.
6. Remove `args.ts`, manual switch, and manual help after parity.

Non-goals:

- no Node runtime;
- no schema or memory changes;
- no output decoration;
- no dashboard redesign.

Acceptance:

- characterization corpus passes;
- all commands have command-specific help;
- hook bootstrap does not evaluate CAC or dashboard modules;
- hook benchmark shows no unexplained meaningful regression.

Rollback point: baseline artifact and characterization corpus identify divergence.

### Phase 2 — Shared build utilities and Bun composition

**Objective:** Establish the architecture needed for multiple artifacts without
changing the canonical Bun behavior.

Work packages:

1. Add `internal/build-utils`, bundled declarations, and private exports.
2. Extract runtime capability interfaces.
3. Implement Bun platform capabilities.
4. Add explicit Bun composition root.
5. Consolidate package build scripts around shared utilities.
6. Preserve `packages/cli/dist/xscs.js` exactly as the built hook target.

Acceptance:

- Bun artifact parity remains complete;
- no TypeScript source export exists;
- all packages produce `dist/` JavaScript and declarations;
- platform interfaces are narrow and fakeable.

Rollback point: Phase 1 remains a complete Bun-only implementation.

### Phase 3 — Node 24 parity

**Objective:** Add a genuine Node runtime with no Bun installation requirement.

Work packages:

1. `node:sqlite` adapter with FTS5/capability validation.
2. Node subprocess, executable lookup, detach, and stdio adapters.
3. Node HTTP/dashboard and browser-opening adapter.
4. Node composition root and ESM artifact.
5. Same-file sequential and concurrent interoperability tests.
6. Full CLI, hook, MCP, distillation, install, doctor, and serve parity.

Acceptance:

- full characterization corpus passes under Node 24;
- no Bun import is reachable in the Node artifact;
- normal stderr has no SQLite experimental warning;
- Bun and Node concurrently share one database without loss.

Rollback point: Bun artifacts remain complete and independently releasable.

### Phase 4 — npm packaging and development tooling

**Objective:** Prepare `cross-session-summary` for safe prerelease publication.

Work packages:

1. Public package metadata, MIT license, README, and changelog.
2. `xscs` Node launcher and `xscs-bun` Bun launcher.
3. Build-time version injection.
4. npm pack validation and tarball allowlist.
5. `mise.toml` thin tasks over Turbo.
6. ESLint integration without mass formatting.
7. First-party prerelease validation scripts.

Acceptance:

- `npm pack --dry-run` contains only intended built assets;
- both binaries execute and agree on version;
- no source `.ts` file is an exported or published runtime entrypoint;
- Bun remains the only lockfile owner.

Rollback point: local Bun/Node artifacts remain usable before publication.

### Phase 5 — Standalone executables and CI

**Objective:** Produce verified, downloadable OS artifacts.

Work packages:

1. Bun compile definitions for the approved platform matrix.
2. Simplest viable embedded dashboard client asset.
3. Cross-platform smoke-test harness.
4. GitHub Actions runtime and OS matrix.
5. SHA-256 checksum generation and verification.
6. GitHub Release assembly for prereleases.

Acceptance:

- every artifact runs `--version`, `doctor`, core store operations, MCP smoke,
  hook smoke, and `serve`;
- standalone `serve` requires no adjacent assets;
- release artifacts are not included in the npm tarball;
- checksums verify.

Rollback point: npm artifacts remain independently releasable.

### Phase 6 — Documentation and release readiness

**Objective:** Make the architecture operable by maintainers and understandable
by users.

Work packages:

1. Update README installation and usage paths.
2. Preserve product rationale in `DESIGN.md`.
3. Add ADRs for runtime, harness, CLI, database, and distribution decisions.
4. Document compatibility policy and deferred breaking changes.
5. Run the complete release matrix and prepare `0.2.0-alpha`.

Acceptance:

- docs match actual artifact names and commands;
- every ADR records context, decision, consequences, and alternatives;
- no unresolved release-blocking test or compatibility discrepancy remains.

## 8. Explicit Non-goals and Fast Follows

Not part of this refactor:

- memory schema or taxonomy redesign;
- recall-score or token-budget tuning;
- new harness support;
- embeddings or vector storage;
- daemonization;
- MCP SDK adoption;
- CommonJS;
- dashboard visual redesign;
- colors, spinners, and terminal decoration;
- arbitrary config-file framework;
- public core/dashboard library APIs;
- Windows arm64 executables;
- team synchronization or hosted service;
- automatic conflict resolution.

Fast follows after value validation:

- dashboard product/design work;
- terminal polish;
- executable signing and notarization before stable;
- measurement-driven recall and budget tuning;
- additional harness adapters;
- intentionally versioned CLI breaking changes, if justified.

## 9. Agent Orchestration Rules

- One integration owner per phase.
- Delegate only bounded, non-overlapping work.
- Do not let multiple agents rewrite shared CLI entrypoints, runtime contracts,
  migrations, or package metadata concurrently.
- Every delegated result must include tests run, files changed, known risks, and
  assumptions.
- The integration owner re-reads and verifies all changes.
- Stop for user input only when implementation evidence requires:
  - changing an agreed invariant;
  - adding a runtime dependency;
  - altering public behavior;
  - changing schema semantics;
  - expanding scope materially.
- Never create commits. Report phase boundaries and suggested commit messages to
  the user instead.

## 10. Definition of Done

The refactor is complete when:

- all approved compatibility behavior is preserved;
- hook operation remains isolated, safe, and fast;
- CAC fully owns interactive CLI parsing;
- Bun and Node have full parity through shared application code;
- both runtimes safely share one SQLite store concurrently;
- Claude and Codex use explicit harness adapters;
- MCP remains first-party and passes conformance coverage;
- npm installs expose `xscs` and `xscs-bun`;
- approved standalone executables are downloadable and self-contained;
- the entire OS/runtime/release matrix is green;
- all packages export built `dist/` JavaScript rather than TypeScript;
- architecture and installation documentation match reality;
- no commits were created by Codex or implementation agents.
