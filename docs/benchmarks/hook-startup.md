# Hook startup benchmark

Hook startup is tracked as an observational performance check, not as a brittle
CI threshold. Measurements should be compared on the same host while it is
otherwise idle.

## Refactor baseline comparison

Measured on 2026-08-02 using Bun 1.3.9 on macOS 26.5.2 (`arm64`). Each value is
based on 100 cold process launches. Both revisions were built and measured on
the same host. `XSCS_INTERNAL=1` is set by the benchmark so it measures the
hook-first bootstrap and safe internal short circuit without touching the
store.

| Event | Baseline median | Refactor median | Baseline p95 | Refactor p95 |
| --- | ---: | ---: | ---: | ---: |
| `SessionStart` | 33.05 ms | 27.03 ms | 35.10 ms | 29.32 ms |
| `UserPromptSubmit` | 33.53 ms | 27.05 ms | 36.47 ms | 28.07 ms |
| `SessionEnd` | 33.44 ms | 27.21 ms | 35.46 ms | 30.43 ms |

The baseline is immutable commit `54adb7e` (`Initial unstructured vertical
slice`). The refactor result is the working tree following Phase 6. No hook
event showed a regression.

## Reproducing a comparison

Build the revision being measured, then run:

```bash
bun scripts/benchmark-hooks.ts 100
```

The default entry is `packages/cli/dist/xscs.js`. To measure an artifact built
from another checkout without changing this worktree, provide its absolute
path:

```bash
XSCS_BENCHMARK_ENTRY=/path/to/baseline/packages/cli/dist/xscs.js \
  bun scripts/benchmark-hooks.ts 100
```

Record the host architecture, operating system, Bun version, revision, run
count, median, and p95 with the result. Do not compare measurements taken on
different hosts as if they were a regression test.
