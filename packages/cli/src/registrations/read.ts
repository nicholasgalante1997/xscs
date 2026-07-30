import type cac from 'cac';

import { cmdBrief, cmdExport, cmdHandoff, cmdList, cmdSearch } from '../workflows/read';
import { cmdStats, cmdWorkspaces } from '../workflows/setup';
import { type CliOptions,commandInput } from './input';

export function registerReadCommands(cli: ReturnType<typeof cac>): void {
    cli.command('brief [...query]', 'Render the context brief a fresh session would receive')
        .option('--budget <tokens>', 'Token budget')
        .action((query: string[], options: CliOptions) => cmdBrief(commandInput('brief', query, options)));

    cli.command('search [...query]', 'Keyword search over stored context')
        .option('--limit <count>', 'Maximum results')
        .action((query: string[], options: CliOptions) => cmdSearch(commandInput('search', query, options)));

    cli.command('list', 'List stored items')
        .option('--type <type>', 'Filter by type; repeat or use commas')
        .option('--status <status>', 'Filter by status; repeat or use commas')
        .option('--limit <count>', 'Maximum results')
        .action((options: CliOptions) => cmdList(commandInput('list', [], options)));

    cli.command('open', 'List unfinished open threads').action((options: CliOptions) =>
        cmdList(commandInput('open', [], { ...options, type: 'open_thread' })),
    );

    cli.command('handoff', 'Write .xscs/HANDOFF.md')
        .option('--stdout', 'Print without writing the handoff file')
        .option('--budget <tokens>', 'Token budget')
        .action((options: CliOptions) => cmdHandoff(commandInput('handoff', [], options)));

    cli.command('stats', 'Show store health')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdStats(commandInput('stats', [], options)));

    cli.command('workspaces', 'List every known workspace').action((options: CliOptions) =>
        cmdWorkspaces(commandInput('workspaces', [], options)),
    );

    cli.command('export', 'Dump stored items as JSON')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdExport(commandInput('export', [], options)));
}
