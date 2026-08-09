export interface ProcessRunInput {
    command: string[];
    env?: Record<string, string | undefined>;
    stdin?: string;
    timeoutMs?: number;
}

export interface ProcessRunResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export interface DetachedProcessInput {
    command: string[];
    env?: Record<string, string | undefined>;
}

export interface ProcessPlatform {
    readonly mainEntry: string;
    selfCommand(args: string[]): string[];
    readStdin(): Promise<string>;
    run(input: ProcessRunInput): Promise<ProcessRunResult>;
    spawnDetached(input: DetachedProcessInput): void;
    stdinChunks(): AsyncIterable<Uint8Array>;
    which(command: string): string | null;
}

/**
 * True when the entrypoint lives inside a standalone executable's embedded
 * filesystem rather than on disk. Bun spells that path two different ways:
 * `/$bunfs/root/index.js` on POSIX, but `B:\~BUN\root\index.js` on Windows.
 * A standalone binary re-invokes itself with no entry argument, so missing the
 * Windows spelling writes an unusable embedded path into every hook command.
 */
export function isEmbeddedEntry(entry: string): boolean {
    return entry.includes('$bunfs') || /[\\/]~BUN[\\/]/i.test(entry);
}

let platform: ProcessPlatform | null = null;

export function configureProcessPlatform(next: ProcessPlatform): void {
    platform = next;
}

export function processPlatform(): ProcessPlatform {
    if (!platform) throw new Error('Process platform is not configured');
    return platform;
}
