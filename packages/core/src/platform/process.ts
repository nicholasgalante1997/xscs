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
    readStdin(): Promise<string>;
    run(input: ProcessRunInput): Promise<ProcessRunResult>;
    spawnDetached(input: DetachedProcessInput): void;
    stdinChunks(): AsyncIterable<Uint8Array>;
    which(command: string): string | null;
}

let platform: ProcessPlatform | null = null;

export function configureProcessPlatform(next: ProcessPlatform): void {
    platform = next;
}

export function processPlatform(): ProcessPlatform {
    if (!platform) throw new Error('Process platform is not configured');
    return platform;
}
