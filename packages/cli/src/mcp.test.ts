import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

interface RpcResponse {
    error?: { code: number; message: string };
    id: number | string | null;
    jsonrpc: '2.0';
    result?: Record<string, unknown>;
}

interface Artifact {
    command: string;
    entry: string;
    name: string;
}

const ROOT = resolve(import.meta.dir, '../../..');
const artifacts: Artifact[] = [
    { name: 'Bun', command: process.execPath, entry: resolve(ROOT, 'packages/cli/dist/xscs.js') },
    { name: 'Node', command: 'node', entry: resolve(ROOT, 'packages/cli/dist/xscs.node.js') },
];
const temporaryDirectories: string[] = [];

function runMcp(artifact: Artifact, messages: unknown[], rawPrefix = ''): { responses: RpcResponse[]; stderr: string } {
    expect(existsSync(artifact.entry)).toBe(true);
    const home = mkdtempSync(resolve(tmpdir(), 'xscs-mcp-'));
    temporaryDirectories.push(home);
    const input = rawPrefix + messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    const result = Bun.spawnSync([artifact.command, artifact.entry, 'mcp'], {
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

for (const artifact of artifacts) describe(`${artifact.name} MCP JSON-RPC conformance characterization`, () => {
    test('initialize preserves protocol and server identity', () => {
        const { responses, stderr } = runMcp(artifact, [
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'xscs-conformance-test', version: '1.0.0' },
                },
            },
        ]);
        expect(stderr).toBe('');
        expect(responses).toEqual([
            {
                jsonrpc: '2.0',
                id: 1,
                result: {
                    protocolVersion: '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'xscs', version: '0.2.0-alpha.0' },
                },
            },
        ]);
    });

    test('tools/list exposes the complete stable tool set', () => {
        const { responses } = runMcp(artifact, [{ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }]);
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

    test('tools/call executes valid writes and ordered reads', () => {
        const { responses, stderr } = runMcp(artifact, [
            {
                jsonrpc: '2.0',
                id: 'remember',
                method: 'tools/call',
                params: {
                    name: 'context_remember',
                    arguments: {
                        type: 'fact',
                        title: 'MCP conformance memory',
                        body: 'A later request in this process must observe this write.',
                    },
                },
            },
            {
                jsonrpc: '2.0',
                id: 'search',
                method: 'tools/call',
                params: { name: 'context_search', arguments: { query: 'conformance memory' } },
            },
        ]);
        expect(stderr).toBe('');
        expect(responses.map((response) => response.id)).toEqual(['remember', 'search']);
        expect(responses[0]?.error).toBeUndefined();
        expect(responses[0]?.result?.content).toEqual([
            { type: 'text', text: expect.stringMatching(/^Stored as itm_/) },
        ]);
        expect(responses[1]?.error).toBeUndefined();
        expect(responses[1]?.result?.content).toEqual([
            { type: 'text', text: expect.stringContaining('MCP conformance memory') },
        ]);
    });

    test('notifications produce no response and request ids are preserved', () => {
        const { responses } = runMcp(artifact, [
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

    test('malformed JSON emits a framed parse error and processing continues', () => {
        const { responses, stderr } = runMcp(artifact, [{ jsonrpc: '2.0', id: 2, method: 'ping' }], '{not-json}\n');
        expect(stderr).toBe('');
        expect(responses).toEqual([
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            { jsonrpc: '2.0', id: 2, result: {} },
        ]);
    });

    test('invalid requests retain valid ids and use JSON-RPC errors', () => {
        const { responses } = runMcp(artifact, [
            { jsonrpc: '1.0', id: 10, method: 'ping' },
            { jsonrpc: '2.0', id: 11 },
            { jsonrpc: '2.0', id: 12, method: 'ping', params: [] },
            { jsonrpc: '2.0', id: 12.5, method: 'ping' },
        ]);
        expect(responses).toEqual([
            { jsonrpc: '2.0', id: 10, error: { code: -32600, message: 'Invalid Request' } },
            { jsonrpc: '2.0', id: 11, error: { code: -32600, message: 'Invalid Request' } },
            { jsonrpc: '2.0', id: 12, error: { code: -32600, message: 'Invalid Request' } },
            { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
        ]);
    });

    test('malformed tool arguments return invalid params without invoking the tool', () => {
        const { responses } = runMcp(artifact, [
            {
                jsonrpc: '2.0',
                id: 'bad-arguments',
                method: 'tools/call',
                params: { name: 'context_remember', arguments: { type: 'fact', title: 42 } },
            },
        ]);
        expect(responses).toEqual([
            {
                jsonrpc: '2.0',
                id: 'bad-arguments',
                error: { code: -32602, message: 'Invalid params: missing required property "body"' },
            },
        ]);
    });

    test('MCP rejects a null id while notifications remain silent', () => {
        const { responses } = runMcp(artifact, [
            { jsonrpc: '2.0', id: null, method: 'ping' },
            { jsonrpc: '2.0', method: 'ping' },
        ]);
        expect(responses).toEqual([
            { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
        ]);
    });

    test('unknown tools return a tool error without a JSON-RPC transport error', () => {
        const { responses } = runMcp(artifact, [
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
        const { responses } = runMcp(artifact, [
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { jsonrpc: '2.0', id: 3, method: 'ping' },
        ]);
        expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
    });
});
