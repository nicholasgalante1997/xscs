#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = resolve(import.meta.dir, '../packages/cli/dist/xscs.js');
const runs = Number(process.argv[2] ?? 30);

if (!existsSync(entry)) {
    console.error(`Missing built CLI at ${entry}. Run \`bun run build\` first.`);
    process.exit(1);
}

const events = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;

for (const event of events) {
    const timings: number[] = [];
    for (let run = 0; run < runs; run++) {
        const start = performance.now();
        const result = Bun.spawnSync([process.execPath, entry, 'hook', '--event', event, '--agent', 'codex'], {
            env: { ...process.env, XSCS_INTERNAL: '1' },
            stdin: new Uint8Array(),
            stdout: 'ignore',
            stderr: 'ignore',
        });
        if (result.exitCode !== 0) throw new Error(`${event} hook exited ${result.exitCode}`);
        timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)]!;
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!;
    const mean = timings.reduce((sum, timing) => sum + timing, 0) / timings.length;
    console.log(`${event.padEnd(16)} mean=${mean.toFixed(2)}ms median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms runs=${runs}`);
}
