/**
 * Normalized command input used while command workflows are extracted from the
 * original monolith. This module does not parse argv; CAC owns that boundary.
 */
export interface CommandInput {
    command: string;
    positionals: string[];
    flags: Record<string, string | boolean | string[]>;
}

export function flagString(args: CommandInput, name: string): string | undefined {
    const v = args.flags[name];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v[0];
    return undefined;
}

export function flagBool(args: CommandInput, name: string): boolean {
    const v = args.flags[name];
    return v === true || v === 'true';
}

export function flagNumber(args: CommandInput, name: string): number | undefined {
    const v = flagString(args, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function flagList(args: CommandInput, name: string): string[] {
    const v = args.flags[name];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
}
