import { describe, expect, test } from 'bun:test';

import { claudeHarness, codexHarness, recognizeHarness } from './harness';

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
            const hooks = adapter.buildHookMap('/usr/bin/bun', '/opt/xscs.js');
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
        const claude = claudeHarness.applyConfiguration({}, 'node', '/opt/xscs.js', true);
        const codex = codexHarness.applyConfiguration({}, 'node', '/opt/xscs.js', true);
        expect(claude.mcpServers).toEqual({ xscs: { command: 'node', args: ['/opt/xscs.js', 'mcp'] } });
        expect(codex.mcpServers).toBeUndefined();
    });
});
