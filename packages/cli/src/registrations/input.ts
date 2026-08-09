import type { ContextInput } from '../workflows/input';

export type CliOptions = Record<string, unknown>;

export function contextInput(options: CliOptions): ContextInput {
    return {
        cwd: stringOption(options.cwd),
        json: booleanOption(options.json),
    };
}

export function stringOption(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length) return String(value[0]);
    return undefined;
}

export function booleanOption(value: unknown): boolean {
    return value === true || value === 'true';
}

export function numberOption(value: unknown): number | undefined {
    const number = Number(value);
    return value !== undefined && Number.isFinite(number) ? number : undefined;
}

export function listOption(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return values.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
}
