import cac from 'cac';

import type { CommandInput } from './command-input';
import {
    cmdBrief,
    cmdConflicts,
    cmdDistill,
    cmdDoctor,
    cmdExport,
    cmdForget,
    cmdHandoff,
    cmdInit,
    cmdList,
    cmdPin,
    cmdPromote,
    cmdPrune,
    cmdRemember,
    cmdReview,
    cmdSearch,
    cmdStats,
    cmdWorkspaces,
} from './commands';

type CliOptions = Record<string, unknown>;

const VERSION = '0.1.0';
const HELP_FOOTER = `
Command groups:
  setup        init, doctor, mcp
  reading      brief, search, list, open, handoff, stats, workspaces, export
  writing      remember, review, pin, unpin, promote, forget
  maintenance  distill, conflicts, prune, serve
  internal     hook

global flags:
  --json  --cwd <path>

Environment:
  XSCS_HOME  XSCS_DB  XSCS_DISTILLER=claude|codex|none`;

export async function runInteractiveCli(argv: string[]): Promise<void> {
    const cli = cac('xscs');
    cli.usage('<command> [options]');
    cli.option('--json', 'Emit machine-readable JSON');
    cli.option('--cwd <path>', 'Resolve the workspace from this path');

    registerSetupCommands(cli);
    registerReadCommands(cli);
    registerWriteCommands(cli);
    registerMaintenanceCommands(cli);

    cli.command('mcp', 'Run the MCP server over stdio');
    cli.command('hook', 'Process a harness lifecycle event');
    cli.command('help', 'Display this message').action(() => {
        cli.unsetMatchedCommand();
        cli.outputHelp();
    });

    cli.help(() => console.log(HELP_FOOTER));
    cli.version(VERSION);
    cli.addEventListener('command:*', (event) => {
        const command = (event as CustomEvent<string>).detail;
        console.error(`unknown command: ${command}\n`);
        cli.outputHelp();
        process.exitCode = 1;
    });

    cli.parse(['bun', 'xscs', ...argv], { run: false });
    if (!cli.matchedCommand && argv.length === 0) {
        cli.outputHelp();
        return;
    }
    await cli.runMatchedCommand();
}

function registerSetupCommands(cli: ReturnType<typeof cac>): void {
    cli.command('init', 'Wire hooks into this project or the user home directory')
        .option('--user', 'Install user-level hooks')
        .option('--claude', 'Install Claude Code hooks only')
        .option('--codex', 'Install Codex hooks only')
        .option('--no-mcp', 'Do not register Claude Code MCP tools')
        .option('--dry-run', 'Show changes without writing')
        .action((options: CliOptions) => cmdInit(legacyArgs('init', [], options)));

    cli.command('doctor', 'Check store, hook wiring, and harness availability').action((options: CliOptions) =>
        cmdDoctor(legacyArgs('doctor', [], options)),
    );
}

function registerReadCommands(cli: ReturnType<typeof cac>): void {
    cli.command('brief [...query]', 'Render the context brief a fresh session would receive')
        .option('--budget <tokens>', 'Token budget')
        .action((query: string[], options: CliOptions) => cmdBrief(legacyArgs('brief', query, options)));

    cli.command('search [...query]', 'Keyword search over stored context')
        .option('--limit <count>', 'Maximum results')
        .action((query: string[], options: CliOptions) => cmdSearch(legacyArgs('search', query, options)));

    cli.command('list', 'List stored items')
        .option('--type <type>', 'Filter by type; repeat or use commas')
        .option('--status <status>', 'Filter by status; repeat or use commas')
        .option('--limit <count>', 'Maximum results')
        .action((options: CliOptions) => cmdList(legacyArgs('list', [], options)));

    cli.command('open', 'List unfinished open threads').action((options: CliOptions) =>
        cmdList(legacyArgs('open', [], { ...options, type: 'open_thread' })),
    );

    cli.command('handoff', 'Write .xscs/HANDOFF.md')
        .option('--stdout', 'Print without writing the handoff file')
        .option('--budget <tokens>', 'Token budget')
        .action((options: CliOptions) => cmdHandoff(legacyArgs('handoff', [], options)));

    cli.command('stats', 'Show store health')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdStats(legacyArgs('stats', [], options)));

    cli.command('workspaces', 'List every known workspace').action((options: CliOptions) =>
        cmdWorkspaces(legacyArgs('workspaces', [], options)),
    );

    cli.command('export', 'Dump stored items as JSON')
        .option('--all', 'Include every workspace')
        .action((options: CliOptions) => cmdExport(legacyArgs('export', [], options)));
}

function registerWriteCommands(cli: ReturnType<typeof cac>): void {
    cli.command('remember [...title]', 'Store durable context explicitly')
        .option('--type <type>', 'Memory item type')
        .option('--title <title>', 'One-line title')
        .option('--body <body>', 'Detailed body')
        .option('--why <reason>', 'Why this is worth remembering')
        .option('--pin', 'Pin the item')
        .option('--scope <scope>', 'global, workspace, branch, or session')
        .option('--tag <tag>', 'Tag; repeat or use commas')
        .option('--confidence <number>', 'Confidence from 0 to 1')
        .action((title: string[], options: CliOptions) => cmdRemember(legacyArgs('remember', title, options)));

    cli.command('review', 'Triage items proposed by distillation')
        .option('--accept <id>', 'Accept an item; repeat or use commas')
        .option('--reject <id>', 'Reject an item; repeat or use commas')
        .option('--accept-all', 'Accept the complete review queue')
        .action((options: CliOptions) => cmdReview(legacyArgs('review', [], options)));

    cli.command('pin <...ids>', 'Pin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin(legacyArgs('pin', ids, options), true),
    );
    cli.command('unpin <...ids>', 'Unpin one or more items').action((ids: string[], options: CliOptions) =>
        cmdPin(legacyArgs('unpin', ids, options), false),
    );
    cli.command('promote <...ids>', 'Move items to a wider scope')
        .option('--scope <scope>', 'global, workspace, or branch', { default: 'global' })
        .action((ids: string[], options: CliOptions) => cmdPromote(legacyArgs('promote', ids, options)));
    cli.command('forget <...ids>', 'Delete stored items').action((ids: string[], options: CliOptions) =>
        cmdForget(legacyArgs('forget', ids, options)),
    );
}

function registerMaintenanceCommands(cli: ReturnType<typeof cac>): void {
    cli.command('distill', 'Distill captured sessions into durable context')
        .option('--session <id>', 'Distill one session')
        .option('--pending', 'Distill pending sessions')
        .option('--mode <mode>', 'heuristic, agent, or both')
        .option('--backend <backend>', 'claude, codex, or none')
        .option('--limit <count>', 'Maximum sessions')
        .option('--dry-run', 'Return drafts without writing')
        .option('--handoff', 'Regenerate the workspace handoff')
        .option('--quiet', 'Suppress human output')
        .action(async (options: CliOptions) => cmdDistill(legacyArgs('distill', [], options)));

    cli.command('conflicts', 'List contradictory or duplicate memories')
        .option('--dismiss <id>', 'Dismiss a pair; pass twice')
        .option('--limit <count>', 'Maximum pairs')
        .action((options: CliOptions) => cmdConflicts(legacyArgs('conflicts', [], options)));

    cli.command('prune', 'Run decay and prune consumed history')
        .option('--events-days <days>', 'Consumed event retention')
        .option('--briefs-days <days>', 'Brief retention')
        .action((options: CliOptions) => cmdPrune(legacyArgs('prune', [], options)));

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

/**
 * Temporary migration seam: CAC owns parsing while existing command behavior is
 * characterized. Command modules replace this generic shape incrementally.
 */
function legacyArgs(command: string, positionals: string[], options: CliOptions): CommandInput {
    const flags: CommandInput['flags'] = {};
    const names: Record<string, string> = {
        acceptAll: 'accept-all',
        briefsDays: 'briefs-days',
        dryRun: 'dry-run',
        eventsDays: 'events-days',
    };
    for (const [key, value] of Object.entries(options)) {
        if (key === '--') continue;
        const name = names[key] ?? key;
        if (key === 'mcp' && value === false) {
            flags['no-mcp'] = true;
            continue;
        }
        if (key === 'open' && value === false) {
            flags['no-open'] = true;
            continue;
        }
        if (value !== undefined) flags[name] = normalizeOption(value);
    }
    return { command, positionals, flags };
}

function normalizeOption(value: unknown): string | boolean | string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'boolean') return value;
    return String(value);
}

function numberOption(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
