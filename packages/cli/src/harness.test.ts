import { describe, expect, test } from 'bun:test';

import { claudeHarness, codexHarness, kiroHarness, recognizeHarness } from './harness';

describe('HarnessAdapter contracts', () => {
    test('recognizes real-shaped hook payloads without global branching', () => {
        const claude = claudeHarness.normalizeHookPayload({
            hook_event_name: 'SessionStart',
            session_id: 'claude-session',
            transcript_path: '/tmp/.claude/projects/example/session.jsonl',
        });
        const codex = codexHarness.normalizeHookPayload({
            hook_event_name: 'SessionStart',
            session_id: 'codex-session',
            transcript_path: '/tmp/.codex/sessions/2026/07/rollout-session.jsonl',
        });

        expect(claude && recognizeHarness(claude, {})).toBe(claudeHarness);
        expect(codex && recognizeHarness(codex, {})).toBe(codexHarness);
    });

    test('normalizes Kiro lifecycle fields and emits plain context', () => {
        const input = kiroHarness.normalizeHookPayload(
            { hook_event_name: 'stop', session_id: 'kiro-session', assistant_response: 'Finished the adapter.' },
            { USER_PROMPT: 'Add Kiro support.' },
        );
        expect(input).toMatchObject({ prompt: 'Add Kiro support.', last_assistant_message: 'Finished the adapter.' });
        expect(input && recognizeHarness(input, {})).toBe(kiroHarness);
        expect(
            kiroHarness.renderHookOutput({
                hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'remember this' },
            }),
        ).toBe('remember this');
    });

    test('uses Kiro 2.x session identity from the hook environment', () => {
        const input = kiroHarness.normalizeHookPayload(
            { hook_event_name: 'agentSpawn', cwd: '/workspace' },
            { KIRO_SESSION_ID: 'kiro-env-session' },
        );
        expect(input?.session_id).toBe('kiro-env-session');
        expect(input && recognizeHarness(input, { KIRO_SESSION_ID: 'kiro-env-session' })).toBe(kiroHarness);
    });

    test('builds Kiro CLI 3 hook configuration', () => {
        const configuration = kiroHarness.applyConfiguration({}, ['xscs'], true) as {
            version: string;
            hooks: Array<{ trigger: string; action: { command: string } }>;
        };
        expect(configuration.version).toBe('v1');
        expect(configuration.hooks.map((hook) => hook.trigger)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
        expect(configuration.hooks[0]!.action.command).toContain('--agent kiro --event SessionStart');
    });

    test('owns transcript attribution and parsing', () => {
        const claude = claudeHarness.parseTranscript(
            JSON.stringify({
                type: 'user',
                timestamp: '2026-07-30T00:00:00Z',
                message: { role: 'user', content: 'Preserve this behavior.' },
            }),
        );
        const codex = codexHarness.parseTranscript(
            JSON.stringify({
                type: 'response_item',
                timestamp: '2026-07-30T00:00:00Z',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep parity.' }] },
            }),
        );

        expect(claude.agent).toBe('claude');
        expect(claude.entries[0]?.text).toBe('Preserve this behavior.');
        expect(codex.agent).toBe('codex');
        expect(codex.entries[0]?.text).toBe('Keep parity.');
    });

    test('encodes lifecycle availability and timeout policy', () => {
        for (const adapter of [claudeHarness, codexHarness]) {
            const hooks = adapter.buildHookMap(['/usr/bin/bun', '/opt/xscs.js']);
            expect(Object.keys(hooks)).toEqual([
                'SessionStart',
                'UserPromptSubmit',
                'Stop',
                'PreCompact',
                'SessionEnd',
            ]);
            expect(hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(3);
            expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toContain(`--agent ${adapter.kind}`);
        }
    });

    test('Claude alone adds MCP configuration', () => {
        const claude = claudeHarness.applyConfiguration({}, ['node', '/opt/xscs.js'], true);
        const codex = codexHarness.applyConfiguration({}, ['node', '/opt/xscs.js'], true);
        expect(claude.mcpServers).toBeUndefined();
        expect(codex.mcpServers).toBeUndefined();
    });
});
