import type cac from 'cac';

import { cmdDoctor, cmdInit } from '../workflows/setup';
import {
    booleanOption,
    type CliOptions,
    contextInput,
} from './input';

export function registerSetupCommands(cli: ReturnType<typeof cac>): void {
    cli.command('init', 'Wire hooks into this project or the user home directory')
        .option('--user', 'Install user-level hooks')
        .option('--claude', 'Install Claude Code hooks only')
        .option('--codex', 'Install Codex hooks only')
        .option('--kiro', 'Install Kiro CLI hooks only')
        .option('--with-mcp', 'Register Claude Code MCP tools (default)')
        .option('--no-mcp', 'Do not register Claude Code MCP tools')
        .option('--dry-run', 'Show changes without writing')
        .action((options: CliOptions) =>
            cmdInit({
                ...contextInput(options),
                user: booleanOption(options.user),
                claude: booleanOption(options.claude),
                codex: booleanOption(options.codex),
                kiro: booleanOption(options.kiro),
                withMcp: options.withMcp === true || options.mcp !== false,
                dryRun: booleanOption(options.dryRun),
            }),
        );

    cli.command('doctor', 'Check store, hook wiring, and harness availability').action((options: CliOptions) =>
        cmdDoctor(contextInput(options)),
    );
}
