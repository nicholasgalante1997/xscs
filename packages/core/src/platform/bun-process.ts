import type { ProcessPlatform, ProcessRunInput, ProcessRunResult } from './process';

async function run(input: ProcessRunInput): Promise<ProcessRunResult> {
    const process = Bun.spawn(input.command, {
        env: input.env,
        stdin: input.stdin === undefined ? 'ignore' : new TextEncoder().encode(input.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => process.kill(), input.timeoutMs);
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
        ]);
        return { exitCode, stderr, stdout };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function* stdinChunks(): AsyncIterable<Uint8Array> {
    const reader = Bun.stdin.stream().getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

export const bunProcessPlatform: ProcessPlatform = {
    mainEntry: Bun.main,
    async readStdin() {
        return Bun.stdin.text();
    },
    run,
    spawnDetached(input) {
        const child = Bun.spawn(input.command, {
            env: input.env,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
        });
        child.unref();
    },
    stdinChunks,
    which(command) {
        return Bun.which(command);
    },
};
