import type { DistillerBackend } from '@xscs/core';
import type cac from 'cac';

import { cmdConflicts, cmdDistill, cmdPrune } from '../workflows/maintenance';
import {
    booleanOption,
    type CliOptions,
    contextInput,
    listOption,
    numberOption,
    stringOption,
} from './input';

export function registerMaintenanceCommands(cli: ReturnType<typeof cac>): void {
    cli.command('distill', 'Distill captured sessions into durable context')
        .option('--session <id>', 'Distill one session')
        .option('--pending', 'Distill pending sessions')
        .option('--mode <mode>', 'heuristic, agent, or both')
        .option('--backend <backend>', 'claude, codex, ollama, or none')
        .option('--limit <count>', 'Maximum sessions')
        .option('--dry-run', 'Return drafts without writing')
        .option('--handoff', 'Regenerate the workspace handoff')
        .option('--quiet', 'Suppress human output')
        .action(async (options: CliOptions) =>
            cmdDistill({
                ...contextInput(options),
                session: stringOption(options.session),
                mode: stringOption(options.mode),
                backend: stringOption(options.backend) as DistillerBackend | undefined,
                limit: numberOption(options.limit),
                dryRun: booleanOption(options.dryRun),
                handoff: booleanOption(options.handoff),
                quiet: booleanOption(options.quiet),
            }),
        );

    cli.command('conflicts', 'List contradictory or duplicate memories')
        .option('--dismiss <id>', 'Dismiss a pair; pass twice')
        .option('--limit <count>', 'Maximum pairs')
        .action((options: CliOptions) =>
            cmdConflicts({
                ...contextInput(options),
                dismiss: listOption(options.dismiss),
                limit: numberOption(options.limit),
            }),
        );

    cli.command('prune', 'Run decay and prune consumed history')
        .option('--events-days <days>', 'Consumed event retention')
        .option('--briefs-days <days>', 'Brief retention')
        .action((options: CliOptions) =>
            cmdPrune({
                ...contextInput(options),
                eventsDays: numberOption(options.eventsDays),
                briefsDays: numberOption(options.briefsDays),
            }),
        );

    cli.command('serve', 'Open the curation dashboard')
        .option('--port <port>', 'Loopback port', { default: 4319 })
        .option('--no-open', 'Do not open a browser')
        .action(async (options: CliOptions) => {
            const { serveDashboard } = await import('@xscs/dashboard');
            await serveDashboard({
                port: numberOption(options.port) ?? 4319,
                open: options.open !== false,
            });
        });
}
