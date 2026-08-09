import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const artifact = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(artifact)) throw new Error('usage: bun scripts/smoke-standalone.ts <artifact>');
const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../packages/cli/package.json'), 'utf8'),
) as { version: string };

const home = mkdtempSync(resolve(tmpdir(), 'xscs-standalone-'));
const env = { ...process.env, XSCS_HOME: home, XSCS_DISTILLER: 'none' };

try {
    assertRun(['--version'], new RegExp(escapeRegExp(manifest.version)));
    assertRun(['doctor'], /store\s+/);
    const installed = run(['init', '--json'], { cwd: home });
    assertSuccess(installed, 'init');
    const claudeSettings = readFileSync(resolve(home, '.claude/settings.json'), 'utf8');
    const codexHooks = readFileSync(resolve(home, '.codex/hooks.json'), 'utf8');
    // These configurations are JSON, so a Windows artifact path appears with
    // its separators escaped (D:\\a\\... not D:\a\...). Compare against the
    // escaped spelling; on POSIX this is identical to the raw path.
    const embeddedArtifact = JSON.stringify(artifact).slice(1, -1);
    for (const configuration of [claudeSettings, codexHooks]) {
        // Bun's embedded filesystem is "/$bunfs/..." on POSIX but "B:\~BUN\..."
        // on Windows; checking only the former let a broken Windows hook
        // command ship for every standalone release.
        if (!configuration.includes(embeddedArtifact) || /\$bunfs|~BUN/i.test(configuration)) {
            throw new Error(`standalone hook configuration is not self-contained: ${configuration}`);
        }
    }
    assertRun(['remember', '--title', 'Standalone smoke memory', '--body', 'A durable standalone test item.', '--json'], /"created": true/);
    assertRun(['search', 'standalone', '--json'], /Standalone smoke memory/);

    const hook = run(['hook', '--event', 'SessionStart', '--agent', 'codex', '--no-background'], {
        stdin: JSON.stringify({ session_id: 'standalone-hook', cwd: home, hook_event_name: 'SessionStart' }),
    });
    assertSuccess(hook, 'hook');
    JSON.parse(hook.stdout);

    const mcp = run(['mcp'], {
        stdin: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    });
    assertSuccess(mcp, 'mcp');
    const response = JSON.parse(mcp.stdout.trim()) as { result?: { serverInfo?: { name?: string } } };
    if (response.result?.serverInfo?.name !== 'xscs') throw new Error(`unexpected MCP response: ${mcp.stdout}`);

    await smokeDashboard();
    console.log(`standalone smoke passed: ${artifact}`);
} finally {
    // Windows can hold handles to the store file for a moment after the
    // dashboard child exits. Removing a scratch directory is not what this
    // script verifies, so a stubborn temp directory must not fail a green run.
    try {
        rmSync(home, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
        console.warn(`could not remove ${home}: ${String(error)}`);
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertRun(args: string[], expected: RegExp): void {
    const result = run(args);
    assertSuccess(result, args.join(' '));
    if (!expected.test(result.stdout)) throw new Error(`${args.join(' ')} output did not match ${expected}: ${result.stdout}`);
}

function run(args: string[], options: { cwd?: string; stdin?: string } = {}): { exitCode: number; stderr: string; stdout: string } {
    const result = Bun.spawnSync([artifact, ...args], {
        env,
        cwd: options.cwd,
        stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
        stderr: 'pipe',
        stdout: 'pipe',
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() };
}

function assertSuccess(result: { exitCode: number; stderr: string }, label: string): void {
    if (result.exitCode !== 0) throw new Error(`${label} exited ${result.exitCode}: ${result.stderr}`);
}

async function smokeDashboard(): Promise<void> {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = Bun.spawn([artifact, 'serve', '--port', String(port), '--no-open'], {
        env,
        stderr: 'pipe',
        stdout: 'pipe',
    });
    try {
        let lastError: unknown;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                const shell = await fetch(`http://127.0.0.1:${port}/`);
                const client = await fetch(`http://127.0.0.1:${port}/app.js`);
                if (!shell.ok || !(await shell.text()).includes('/app.js')) throw new Error('dashboard shell is invalid');
                if (!client.ok || (await client.text()).length < 1_000) throw new Error('embedded dashboard client is invalid');
                return;
            } catch (error) {
                lastError = error;
                await Bun.sleep(50);
            }
        }
        throw new Error(`dashboard did not become ready: ${String(lastError)}`);
    } finally {
        child.kill();
        await child.exited;
    }
}
