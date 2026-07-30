import type { CommandInput } from '../command-input';

export type CliOptions = Record<string, unknown>;

export function commandInput(command: string, positionals: string[], options: CliOptions): CommandInput {
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

export function numberOption(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function normalizeOption(value: unknown): string | boolean | string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'boolean') return value;
    return String(value);
}
