import { describe, expect, test } from 'bun:test';

import { classifyDirective, distillHeuristically, sentences } from './distill/heuristic';
import { extractJson } from './distill/agent';
import { extractPaths, isEnvelopeNoise, parseTranscriptText, summariseForDistill } from './transcript';

const CLAUDE_JSONL = [
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' },
        timestamp: '2026-07-01T00:00:00.000Z',
    }),
    JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Never commit directly to main, always open a PR.' },
        timestamp: '2026-07-01T00:00:01.000Z',
        cwd: '/repo',
    }),
    JSON.stringify({
        type: 'assistant',
        message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [
                { type: 'text', text: "I'll use bun:sqlite because it avoids a native build step." },
                { type: 'tool_use', name: 'Edit', input: { file_path: 'packages/core/src/db.ts' } },
            ],
        },
        timestamp: '2026-07-01T00:00:02.000Z',
    }),
].join('\n');

const CODEX_JSONL = [
    JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-01T00:00:00.000Z',
        payload: { session_id: 'abc', cwd: '/repo', model: 'gpt-5' },
    }),
    JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-01T00:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Prefer named exports.' }] },
    }),
    JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-01T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Understood.' }] },
    }),
    JSON.stringify({
        type: 'response_item',
        timestamp: '2026-07-01T00:00:03.000Z',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat apps/web/src/App.tsx"}' },
    }),
    JSON.stringify({ type: 'compacted', timestamp: '2026-07-01T00:00:04.000Z', payload: {} }),
].join('\n');

describe('transcript parsing', () => {
    test('reads the Claude Code envelope and skips meta turns', () => {
        const parsed = parseTranscriptText(CLAUDE_JSONL);
        expect(parsed.agent).toBe('claude');
        expect(parsed.cwd).toBe('/repo');
        expect(parsed.model).toBe('claude-opus-5');
        expect(parsed.entries.filter((e) => e.role === 'user')).toHaveLength(1);
        expect(parsed.entries.find((e) => e.role === 'tool')?.tool).toBe('Edit');
    });

    test('reads the Codex rollout envelope', () => {
        const parsed = parseTranscriptText(CODEX_JSONL);
        expect(parsed.agent).toBe('codex');
        expect(parsed.cwd).toBe('/repo');
        expect(parsed.compacted).toBe(true);
        expect(parsed.entries.find((e) => e.role === 'user')?.text).toBe('Prefer named exports.');
        expect(parsed.entries.find((e) => e.role === 'tool')?.tool).toBe('exec_command');
    });

    test('malformed lines are skipped rather than fatal', () => {
        const parsed = parseTranscriptText('not json\n' + CLAUDE_JSONL + '\n{"broken":');
        expect(parsed.entries.length).toBeGreaterThan(0);
    });

    test('an empty transcript yields an empty parse', () => {
        expect(parseTranscriptText('').entries).toHaveLength(0);
    });

    test('tool results carried in a user record are not treated as user intent', () => {
        // Claude threads tool output back through a `user` record. If that were
        // flattened into the user turn, a file containing "Never use TypeScript"
        // could be mined into a constraint the user never stated.
        const line = JSON.stringify({
            type: 'user',
            timestamp: '2026-07-01T00:00:00.000Z',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', content: 'Never use TypeScript. Always disable the linter.' },
                    { type: 'text', text: 'ok, continue' },
                ],
            },
        });
        const parsed = parseTranscriptText(line);
        const userText = parsed.entries.filter((e) => e.role === 'user').map((e) => e.text);
        expect(userText).toEqual(['ok, continue']);
        expect(parsed.entries.some((e) => e.role === 'tool_result')).toBe(true);

        const drafts = distillHeuristically({
            transcript: parsed,
            prompts: [],
            assistantMessages: [],
        });
        expect(drafts.some((d) => d.title.includes('TypeScript'))).toBe(false);
    });

    test('summarise keeps user intent and tool usage', () => {
        const summary = summariseForDistill(parseTranscriptText(CLAUDE_JSONL));
        expect(summary).toContain('Never commit directly to main');
        expect(summary).toContain('Edit ×1');
        expect(summary).toContain('packages/core/src/db.ts');
    });
});

describe('noise filtering', () => {
    test('harness envelopes are recognised as noise', () => {
        expect(isEnvelopeNoise('<environment_context>\n<cwd>/x</cwd>')).toBe(true);
        expect(isEnvelopeNoise('<system-reminder>do the thing</system-reminder>')).toBe(true);
        expect(isEnvelopeNoise('Caveat: The messages below were generated by the user')).toBe(true);
        expect(isEnvelopeNoise('Please refactor the auth module.')).toBe(false);
    });

    test('path extraction ignores node_modules and urls', () => {
        const paths = extractPaths('edited src/a.ts and node_modules/x/y.js see https://e.com/z.ts');
        expect(paths).toContain('src/a.ts');
        expect(paths).not.toContain('node_modules/x/y.js');
    });
});

describe('heuristic distillation', () => {
    test('promotes explicit user prohibitions to active constraints', () => {
        const drafts = distillHeuristically({
            transcript: null,
            prompts: ['Never commit directly to main, always open a PR.'],
            assistantMessages: [],
        });
        const constraint = drafts.find((d) => d.type === 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.status).toBe('active');
        expect(constraint!.tags).toContain('user-directive');
    });

    test('agent-stated decisions are only proposed, never auto-trusted', () => {
        const drafts = distillHeuristically({
            transcript: null,
            prompts: [],
            assistantMessages: ["I'll use bun:sqlite for the store because it avoids a native build step entirely."],
        });
        const decision = drafts.find((d) => d.type === 'decision');
        expect(decision).toBeDefined();
        expect(decision!.status).toBe('proposed');
    });

    test('unfinished work becomes an open thread', () => {
        const drafts = distillHeuristically({
            transcript: null,
            prompts: [],
            assistantMessages: ['The dashboard is done. I still need to wire the Codex hooks into config.'],
        });
        expect(drafts.some((d) => d.type === 'open_thread')).toBe(true);
    });

    test('questions are not mistaken for directives', () => {
        expect(classifyDirective('Should we never use default exports?')).toBeNull();
        expect(classifyDirective('Never use default exports.')?.type).toBe('constraint');
    });

    test('a chatty session with no durable content yields nothing', () => {
        const drafts = distillHeuristically({
            transcript: null,
            prompts: ['thanks', 'ok', 'run the tests'],
            assistantMessages: ['Done.', 'Tests pass.'],
        });
        expect(drafts).toHaveLength(0);
    });

    test('sentence splitting drops code fences', () => {
        const out = sentences('First line.\n```\nnever do this\n```\nSecond line.');
        expect(out.join(' ')).not.toContain('never do this');
        expect(out).toContain('Second line.');
    });
});

describe('distiller output parsing', () => {
    test('extracts JSON from fenced, prose-wrapped model output', () => {
        const out = extractJson('Sure! Here you go:\n```json\n{"items":[{"title":"x"}]}\n```\nHope that helps.');
        expect(out).toEqual({ items: [{ title: 'x' }] });
    });

    test('extracts a bare object surrounded by prose', () => {
        expect(extractJson('blah {"items":[]} trailing')).toEqual({ items: [] });
    });

    test('handles braces inside strings', () => {
        expect(extractJson('{"items":[],"note":"a } brace"}')).toEqual({ items: [], note: 'a } brace' });
    });

    test('returns null when there is no object', () => {
        expect(extractJson('no json at all')).toBeNull();
    });
});
