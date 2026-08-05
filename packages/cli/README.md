# Cross-Session Summary

Cross-Session Summary persists curated coding-agent context across sessions and
across Claude Code and Codex. The installed command remains `xscs`.

```bash
npm install --global cross-session-summary
xscs init
xscs doctor
```

The npm package provides:

- `xscs` — Node 24 ESM runtime
- `xscs-bun` — Bun-native runtime

Both artifacts use the same `~/.xscs/store.db`.

Standalone executables for macOS, Linux, and Windows are distributed through
GitHub Releases with SHA-256 checksums. They include the dashboard and require no
adjacent assets.

See the repository README for architecture, commands, source-checkout setup, and
safety properties.
