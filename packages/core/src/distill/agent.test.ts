import { afterEach, describe, expect, test } from 'bun:test';

import { bunProcessPlatform } from '../../bun';
import {
    configureProcessPlatform,
    type ProcessRunInput,
} from '../platform/process';
import { distillWithAgent } from './agent';

const originalFetch = globalThis.fetch;

afterEach(() => {
    configureProcessPlatform(bunProcessPlatform);
    globalThis.fetch = originalFetch;
});

describe('agent distiller security boundary', () => {
    test('Claude cannot use filesystem, shell, network, or delegation tools', async () => {
        let invocation: ProcessRunInput | undefined;
        configureProcessPlatform(fakeProcess((input) => {
            invocation = input;
            return { exitCode: 0, stderr: '', stdout: '{"items":[]}' };
        }));

        await distillWithAgent({ backend: 'claude', material: 'untrusted transcript', workspaceName: 'demo' });
        expect(invocation?.command).toContain('--disallowed-tools');
        const tools = invocation?.command[invocation.command.indexOf('--disallowed-tools') + 1];
        for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task']) {
            expect(tools).toContain(tool);
        }
        expect(invocation?.env?.XSCS_INTERNAL).toBe('1');
    });

    test('Codex is read-only and model output cannot create global items', async () => {
        let invocation: ProcessRunInput | undefined;
        configureProcessPlatform(fakeProcess((input) => {
            invocation = input;
            return {
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    items: [
                        {
                            type: 'constraint',
                            title: 'Never expose the store',
                            body: 'Keep it local.',
                            scope: 'global',
                            confidence: 0.9,
                        },
                    ],
                }),
            };
        }));

        const result = await distillWithAgent({ backend: 'codex', material: 'untrusted transcript', workspaceName: 'demo' });
        expect(invocation?.command).toContain('read-only');
        expect(invocation?.env?.XSCS_INTERNAL).toBe('1');
        expect(result.drafts[0]).toMatchObject({ scope: 'workspace', status: 'proposed' });
    });

    test('Ollama uses the local structured-output API without agent tools', async () => {
        let request: RequestInit | undefined;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            request = init;
            return new Response(
                JSON.stringify({
                    response: JSON.stringify({
                        items: [{ type: 'fact', title: 'Local model', body: 'Ollama distilled this.', scope: 'global' }],
                    }),
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as typeof fetch;

        const result = await distillWithAgent({
            backend: 'ollama',
            model: 'qwen3:8b',
            material: 'untrusted transcript',
            workspaceName: 'demo',
        });
        const body = JSON.parse(String(request?.body)) as { format: string; model: string; stream: boolean };
        expect(body).toMatchObject({ format: 'json', model: 'qwen3:8b', stream: false });
        expect(result.drafts[0]).toMatchObject({ scope: 'workspace', source: 'distiller:ollama', status: 'proposed' });
    });
});

function fakeProcess(run: (input: ProcessRunInput) => { exitCode: number; stderr: string; stdout: string }) {
    return {
        mainEntry: '/tmp/xscs',
        selfCommand: (args: string[]) => ['/tmp/xscs', ...args],
        readStdin: async () => '',
        run: async (input: ProcessRunInput) => run(input),
        spawnDetached() {},
        async *stdinChunks() {},
        which: () => null,
    };
}
