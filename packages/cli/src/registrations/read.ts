import {
    ItemStatus,
    ItemType,
} from '@xscs/core';
import type cac from 'cac';

import { cmdBrief, cmdExport, cmdHandoff, cmdList, cmdSearch } from '../workflows/read';
import { cmdStats, cmdWorkspaces } from '../workflows/setup';
import {
    booleanOption,
    type CliOptions,
    contextInput,
    listOption,
    numberOption,
} from './input';

export function registerReadCommands(cli: ReturnType<typeof cac>): void {
    cli.command('brief [...query]', 'Render the context brief a fresh session would receive')
        .option('--budget <tokens>', 'Token budget')
        .action((query: string[], options: CliOptions) =>
            cmdBrief({ ...contextInput(options), query, budget: numberOption(options.budget) }),
        );

    cli.command('search [...query]', 'Keyword search over stored context')
        .option('--limit <count>', 'Maximum results')
        .action((query: string[], options: CliOptions) =>
            cmdSearch({ ...contextInput(options), query, limit: numberOption(options.limit) }),
        );

    cli.command('list', 'List stored items')
        .option('--type <type>', 'Filter by type; repeat or use commas')
        .option('--status <status>', 'Filter by status; repeat or use commas')
        .option('--limit <count>', 'Maximum results')
        .action((options: CliOptions) =>
            cmdList({
                ...contextInput(options),
                types: listOption(options.type).flatMap((value) => {
                    const parsed = ItemType.safeParse(value);
                    return parsed.success ? [parsed.data] : [];
                }),
                statuses: listOption(options.status).flatMap((value) => {
                    const parsed = ItemStatus.safeParse(value);
                    return parsed.success ? [parsed.data] : [];
                }),
                limit: numberOption(options.limit),
            }),
        );

    cli.command('open', 'List unfinished open threads').action((options: CliOptions) =>
        cmdList({ ...contextInput(options), types: ['open_thread'], statuses: [], limit: undefined }),
    );

    cli.command('handoff', 'Write .xscs/HANDOFF.md')
        .option('--stdout', 'Print without writing the handoff file')
        .option('--budget <tokens>', 'Token budget')
        .action((options: CliOptions) =>
            cmdHandoff({
                ...contextInput(options),
                stdout: booleanOption(options.stdout),
                budget: numberOption(options.budget),
            }),
        );

    cli.command('stats', 'Show store health')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdStats({ ...contextInput(options), all: booleanOption(options.all) }));

    cli.command('workspaces', 'List every known workspace').action((options: CliOptions) =>
        cmdWorkspaces(contextInput(options)),
    );

    cli.command('export', 'Dump stored items as JSON')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdExport({ ...contextInput(options), all: booleanOption(options.all) }));
}
