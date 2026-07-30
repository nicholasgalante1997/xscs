import type cac from 'cac';

import { cmdDoctor, cmdInit } from '../workflows/setup';
import { type CliOptions,commandInput } from './input';

export function registerSetupCommands(cli: ReturnType<typeof cac>): void {
    cli.command('init', 'Wire hooks into this project or the user home directory')
        .option('--user', 'Install user-level hooks')
        .option('--claude', 'Install Claude Code hooks only')
        .option('--codex', 'Install Codex hooks only')
        .option('--no-mcp', 'Do not register Claude Code MCP tools')
        .option('--dry-run', 'Show changes without writing')
        .action((options: CliOptions) => cmdInit(commandInput('init', [], options)));

    cli.command('doctor', 'Check store, hook wiring, and harness availability').action((options: CliOptions) =>
        cmdDoctor(commandInput('doctor', [], options)),
    );
}
