import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

import type { ProcessPlatform, ProcessRunInput, ProcessRunResult } from './process';

async function run(input: ProcessRunInput): Promise<ProcessRunResult> {
    return new Promise((resolveResult, reject) => {
        const child = spawn(input.command[0]!, input.command.slice(1), {
            env: input.env as NodeJS.ProcessEnv | undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout: Uint8Array[] = [];
        const stderr: Uint8Array[] = [];
        child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (exitCode) => {
            resolveResult({
                exitCode: exitCode ?? 1,
                stdout: Buffer.concat(stdout).toString(),
                stderr: Buffer.concat(stderr).toString(),
            });
        });
        child.stdin.end(input.stdin);
        if (input.timeoutMs !== undefined) {
            const timer = setTimeout(() => child.kill(), input.timeoutMs);
            child.once('close', () => clearTimeout(timer));
        }
    });
}

async function* stdinChunks(): AsyncIterable<Uint8Array> {
    for await (const chunk of process.stdin) {
        yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    }
}

function executableExtensions(): string[] {
    if (process.platform !== 'win32') return [''];
    return (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
}

function which(command: string): string | null {
    if (command.includes('/') || command.includes('\\')) return existsSync(command) ? resolve(command) : null;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory) continue;
        for (const extension of executableExtensions()) {
            const candidate = resolve(directory, command + extension);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

export const nodeProcessPlatform: ProcessPlatform = {
    mainEntry: resolve(process.argv[1] ?? ''),
    selfCommand(args) {
        return [process.execPath, resolve(process.argv[1] ?? ''), ...args];
    },
    async readStdin() {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stdinChunks()) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
    },
    run,
    spawnDetached(input) {
        const child = spawn(input.command[0]!, input.command.slice(1), {
            detached: true,
            env: input.env as NodeJS.ProcessEnv | undefined,
            stdio: 'ignore',
        });
        child.unref();
    },
    stdinChunks,
    which,
};
