import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface RpcResponse {
    error?: { code: number; message: string };
    id: number | string;
    jsonrpc: '2.0';
    result?: Record<string, unknown>;
}

const ROOT = resolve(import.meta.dir, '../../..');
const ENTRY = resolve(ROOT, 'packages/cli/dist/xscs.js');
const temporaryDirectories: string[] = [];

function runMcp(messages: unknown[], rawPrefix = ''): { responses: RpcResponse[]; stderr: string } {
    expect(existsSync(ENTRY)).toBe(true);
    const home = mkdtempSync(resolve(tmpdir(), 'xscs-mcp-'));
    temporaryDirectories.push(home);
    const input = rawPrefix + messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    const result = Bun.spawnSync([process.execPath, ENTRY, 'mcp'], {
        cwd: ROOT,
        env: { ...process.env, XSCS_HOME: home },
        stdin: new TextEncoder().encode(input),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RpcResponse);
    return { responses: lines, stderr: result.stderr.toString() };
}

afterEach(() => {
    while (temporaryDirectories.length) {
        rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
    }
});

describe('MCP JSON-RPC conformance characterization', () => {
    test('initialize preserves protocol and server identity', () => {
        const { responses, stderr } = runMcp([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
        expect(stderr).toBe('');
        expect(responses).toEqual([
            {
                jsonrpc: '2.0',
                id: 1,
                result: {
                    protocolVersion: '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'xscs', version: '0.1.0' },
                },
            },
        ]);
    });

    test('tools/list exposes the complete stable tool set', () => {
        const { responses } = runMcp([{ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }]);
        const tools = responses[0]!.result!.tools as Array<{ inputSchema: unknown; name: string }>;
        expect(tools.map((tool) => tool.name)).toEqual([
            'context_search',
            'context_remember',
            'context_supersede',
            'context_forget',
            'context_pin',
            'context_brief',
            'context_open_threads',
            'context_conflicts',
        ]);
        for (const tool of tools) expect(tool.inputSchema).toBeObject();
    });

    test('notifications produce no response and request ids are preserved', () => {
        const { responses } = runMcp([
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 'string-id', method: 'ping' },
            { jsonrpc: '2.0', id: 42, method: 'unknown/method' },
        ]);
        expect(responses).toHaveLength(2);
        expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 'string-id', result: {} });
        expect(responses[1]).toEqual({
            jsonrpc: '2.0',
            id: 42,
            error: { code: -32601, message: 'Method not found: unknown/method' },
        });
    });

    test('malformed JSON does not contaminate stdout framing', () => {
        const { responses, stderr } = runMcp([{ jsonrpc: '2.0', id: 2, method: 'ping' }], '{not-json}\n');
        expect(stderr).toBe('');
        expect(responses).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
    });

    test('unknown tools return a tool error without a JSON-RPC transport error', () => {
        const { responses } = runMcp([
            {
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'context_missing', arguments: {} },
            },
        ]);
        expect(responses).toEqual([
            {
                jsonrpc: '2.0',
                id: 7,
                result: {
                    content: [{ type: 'text', text: 'Unknown tool: context_missing' }],
                    isError: true,
                },
            },
        ]);
    });

    test('multiple requests are processed in order in one process', () => {
        const { responses } = runMcp([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { jsonrpc: '2.0', id: 3, method: 'ping' },
        ]);
        expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
    });
});
