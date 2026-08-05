import { afterEach, describe, expect, test } from 'bun:test';

import { bunProcessPlatform } from '../../bun';
import {
    configureProcessPlatform,
    type ProcessRunInput,
} from '../platform/process';
import { distillWithAgent } from './agent';

afterEach(() => configureProcessPlatform(bunProcessPlatform));

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
