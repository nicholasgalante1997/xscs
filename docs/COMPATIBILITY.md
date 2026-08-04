# Compatibility policy

## Stable operational surface

The `0.2.x` line preserves every valid existing command, positional argument,
long flag, JSON result shape, exit code, and meaningful stdout/stderr behavior.
Installed hooks and automation must continue to work unchanged. New short aliases,
generated help, and earlier validation of malformed interactive input may be added.

The operational identity remains `xscs`: binary names, `XSCS_*` environment
variables, `~/.xscs`, hook commands, MCP server identity, and database paths do
not follow the public npm package name.

Breaking cleanup requires a versioned release, an explicit migration path, and a
documented deprecation period.

## Runtime compatibility

- `xscs` is Node 24 ESM. CommonJS is not supported.
- `xscs-bun` and standalone executables use Bun 1.3 or its embedded runtime.
- All artifacts open the exact same SQLite store and share migrations, schema
  versioning, WAL, busy timeout, foreign keys, FTS5 behavior, and locking.
- Internal packages are not a public compatibility surface; the initial npm
  contract is binary-only.

## Hook and MCP compatibility

Hooks always fail open: malformed input and internal errors are logged, `{}` is
safe output, and the process exits successfully. Hook latency is a release
boundary and must not regress without explanation.

MCP is a first-party newline-framed JSON-RPC 2.0 implementation. Tool names,
schemas, protocol framing, result shapes, request IDs, and notification silence
are compatibility surfaces. The official MCP TypeScript SDK is intentionally not
used.
