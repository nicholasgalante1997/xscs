export interface Args {
    command: string;
    positionals: string[];
    flags: Record<string, string | boolean | string[]>;
}

/**
 * Hand-rolled instead of `commander` for one reason: this binary is invoked on
 * every hook of every turn, and every dependency loaded at startup is latency the
 * user feels as lag in their terminal.
 */
export function parseArgs(argv: string[]): Args {
    const [command = 'help', ...rest] = argv;
    const positionals: string[] = [];
    const flags: Record<string, string | boolean | string[]> = {};

    for (let i = 0; i < rest.length; i++) {
        const token = rest[i]!;
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        let key: string;
        let value: string | boolean;
        if (eq !== -1) {
            key = token.slice(2, eq);
            value = token.slice(eq + 1);
        } else {
            key = token.slice(2);
            const next = rest[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                value = next;
                i++;
            } else {
                value = true;
            }
        }
        const existing = flags[key];
        if (existing === undefined) flags[key] = value;
        else if (Array.isArray(existing)) existing.push(String(value));
        else flags[key] = [String(existing), String(value)];
    }

    return { command, positionals, flags };
}

export function flagString(args: Args, name: string): string | undefined {
    const v = args.flags[name];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v[0];
    return undefined;
}

export function flagBool(args: Args, name: string): boolean {
    const v = args.flags[name];
    return v === true || v === 'true';
}

export function flagNumber(args: Args, name: string): number | undefined {
    const v = flagString(args, name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function flagList(args: Args, name: string): string[] {
    const v = args.flags[name];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
}
