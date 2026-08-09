import {
    buildBrief,
    type DB,
    deleteItem,
    ensureWorkspace,
    findDriftCandidates,
    getItem,
    type ItemDraft,
    listItems,
    openStore,
    processPlatform,
    putItem,
    searchItems,
    setItemPinned,
    supersede,
    touchItems,
    type Workspace,
} from '@xscs/core';

import { currentBranch } from './git';
import { logError } from './hook';
import { VERSION } from './version';

/**
 * Hooks give the store *ambient* recall: context arrives whether the agent asked
 * for it or not. That is the right default, but it is one-directional and always
 * a guess.
 *
 * MCP closes the loop. With these tools the agent can go looking for something
 * specific mid-task, and — more importantly — can *write back*: "I just learned
 * the deploy script needs AWS_PROFILE set; remember that." Deliberate writes are
 * far higher quality than anything a distiller infers after the fact, because the
 * agent knows what surprised it.
 */

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
}

interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>, ctx: Ctx) => string;
}

interface Ctx {
    db: DB;
    workspace: Workspace;
    branch: string | null;
}

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS: ToolDef[] = [
    {
        name: 'context_search',
        description:
            'Search durable context stored from previous sessions in this workspace (decisions, constraints, preferences, facts, pitfalls, open threads). Use before asking the user something they may have already told a previous session.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language or keywords.' },
                limit: { type: 'number', description: 'Max results (default 8).' },
            },
            required: ['query'],
        },
        handler: (args, ctx) => {
            const query = str(args.query);
            if (!query) return 'No query given.';
            const hits = searchItems(ctx.db, query, { workspace_id: ctx.workspace.id, limit: num(args.limit) ?? 8 });
            if (!hits.length) return 'No stored context matches that query.';
            touchItems(ctx.db, hits.map((h) => h.item.id));
            return hits
                .map(
                    (h) =>
                        `[${h.item.type}] ${h.item.title} (id: ${h.item.id}, confidence: ${h.item.confidence.toFixed(2)})\n${h.item.body}${
                            h.item.why ? `\nwhy: ${h.item.why}` : ''
                        }`,
                )
                .join('\n\n');
        },
    },
    {
        name: 'context_remember',
        description:
            'Store something durable for future sessions. Only record things that will still matter next week: decisions and their reasons, rules the user imposed, non-obvious facts that took effort to discover, pitfalls, and unfinished work. Do not record narration of what you just did.',
        inputSchema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['decision', 'constraint', 'preference', 'fact', 'artifact', 'open_thread', 'pitfall', 'glossary'],
                },
                title: { type: 'string', description: 'One line, under 90 characters.' },
                body: { type: 'string', description: '1-3 sentences of detail.' },
                why: { type: 'string', description: 'Why this is worth remembering.' },
                scope: { type: 'string', enum: ['workspace', 'branch'], description: 'Default workspace.' },
                tags: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number', description: '0-1, default 0.6.' },
            },
            required: ['type', 'title', 'body'],
        },
        handler: (args, ctx) => {
            const draft: ItemDraft = {
                type: (str(args.type) ?? 'fact') as ItemDraft['type'],
                title: str(args.title) ?? '',
                body: str(args.body) ?? '',
                why: str(args.why) ?? null,
                scope: str(args.scope) === 'branch' ? 'branch' : 'workspace',
                scope_key: str(args.scope) === 'branch' ? ctx.branch : null,
                tags: strArray(args.tags),
                confidence: num(args.confidence) ?? 0.6,
                status: 'active',
                source: 'mcp',
                workspace_id: ctx.workspace.id,
            };
            const res = putItem(ctx.db, draft);
            return res.created
                ? `Stored as ${res.item.id}.`
                : `Already known (${res.item.id}); reinforced to confidence ${res.item.confidence.toFixed(2)}.`;
        },
    },
    {
        name: 'context_supersede',
        description:
            'Replace a stored item that is now wrong or out of date. Pass the id of the stale item and the corrected content. Prefer this over storing a contradicting item.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Id of the item being replaced.' },
                title: { type: 'string' },
                body: { type: 'string' },
                why: { type: 'string', description: 'What changed and how you know.' },
            },
            required: ['id', 'title', 'body'],
        },
        handler: (args, ctx) => {
            const id = str(args.id);
            if (!id) return 'No id given.';
            const old = getItem(ctx.db, id);
            if (!old) return `No item with id ${id}.`;
            const res = putItem(ctx.db, {
                type: old.type,
                title: str(args.title) ?? old.title,
                body: str(args.body) ?? old.body,
                why: str(args.why) ?? 'Superseded a stale item.',
                scope: old.scope === 'global' ? 'workspace' : old.scope,
                scope_key: old.scope_key,
                tags: old.tags,
                confidence: Math.max(0.6, old.confidence),
                status: 'active',
                source: 'mcp',
                workspace_id: ctx.workspace.id,
            });
            if (res.item.id !== old.id) supersede(ctx.db, old.id, res.item.id);
            return `Replaced ${old.id} with ${res.item.id}.`;
        },
    },
    {
        name: 'context_forget',
        description: 'Delete a stored item that is wrong, duplicated, or was never worth keeping.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
        },
        handler: (args, ctx) => {
            const id = str(args.id);
            if (!id) return 'No id given.';
            if (!getItem(ctx.db, id)) return `No item with id ${id}.`;
            deleteItem(ctx.db, id);
            return `Deleted ${id}.`;
        },
    },
    {
        name: 'context_pin',
        description:
            'Pin an item so it is always recalled and never decays. Use sparingly — every pinned item costs tokens in every future session.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' }, pinned: { type: 'boolean', description: 'Default true.' } },
            required: ['id'],
        },
        handler: (args, ctx) => {
            const id = str(args.id);
            if (!id || !getItem(ctx.db, id)) return `No item with id ${id ?? '(none)'}.`;
            const pinned = args.pinned === undefined ? true : args.pinned === true;
            setItemPinned(ctx.db, id, pinned);
            return `${pinned ? 'Pinned' : 'Unpinned'} ${id}.`;
        },
    },
    {
        name: 'context_brief',
        description:
            'Get the full recalled-context brief for this workspace — everything a fresh session would be given. Useful after a context reset or when picking up unfamiliar work.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Optional focus for the brief.' },
                budget_tokens: { type: 'number' },
            },
        },
        handler: (args, ctx) => {
            const brief = buildBrief(ctx.db, {
                workspace_id: ctx.workspace.id,
                branch: ctx.branch,
                query: str(args.query),
                budgetTokens: num(args.budget_tokens) ?? 1600,
                reason: 'requested by the agent',
                workspaceName: ctx.workspace.name,
            });
            if (!brief.text) return 'No durable context stored for this workspace yet.';
            touchItems(ctx.db, brief.item_ids);
            return brief.text;
        },
    },
    {
        name: 'context_open_threads',
        description: 'List unfinished work recorded by previous sessions in this workspace.',
        inputSchema: { type: 'object', properties: {} },
        handler: (_args, ctx) => {
            const threads = listItems(ctx.db, {
                workspace_id: ctx.workspace.id,
                status: 'active',
                type: 'open_thread',
                limit: 25,
            });
            if (!threads.length) return 'No open threads recorded.';
            return threads.map((t) => `- ${t.title} (id: ${t.id})\n  ${t.body}`).join('\n');
        },
    },
    {
        name: 'context_conflicts',
        description:
            'List stored items that appear to contradict or duplicate each other. Resolve with context_supersede or context_forget.',
        inputSchema: { type: 'object', properties: {} },
        handler: (_args, ctx) => {
            const candidates = findDriftCandidates(ctx.db, ctx.workspace.id, 10);
            if (!candidates.length) return 'No conflicts detected.';
            return candidates
                .map((c) => `[${c.kind}] ${c.hint}\n  A ${c.a.id}: ${c.a.title}\n  B ${c.b.id}: ${c.b.title}`)
                .join('\n\n');
        },
    },
];

export async function runMcpServer(): Promise<void> {
    const db = openStore();
    const cwd = process.cwd();
    const workspace = ensureWorkspace(db, cwd);
    const ctx: Ctx = { db, workspace, branch: currentBranch(workspace.root) };

    // MCP's stdio transport is newline-delimited JSON-RPC, so messages are framed
    // by scanning for '\n' rather than by any length header.
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const value of processPlatform().stdinChunks()) {
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) handleLine(line, ctx);
            index = buffer.indexOf('\n');
        }
    }
}

function handleLine(line: string, ctx: Ctx): void {
    let decoded: unknown;
    try {
        decoded = JSON.parse(line);
    } catch {
        respondError(null, -32700, 'Parse error');
        return;
    }

    if (!isRequest(decoded)) {
        respondError(requestId(decoded), -32600, 'Invalid Request');
        return;
    }
    const req = decoded;
    // MCP notifications omit id entirely. Unlike base JSON-RPC, MCP forbids a
    // null request id; the validator rejects it as an invalid request.
    const isNotification = !Object.hasOwn(req, 'id');

    try {
        switch (req.method) {
            case 'initialize':
                if (!isNotification)
                    respond(req.id!, {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: 'xscs', version: VERSION },
                    });
                return;
            case 'tools/list':
                if (!isNotification)
                    respond(req.id!, {
                        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
                    });
                return;
            case 'tools/call': {
                if (isNotification) return;
                const name = str(req.params?.name);
                const tool = TOOLS.find((t) => t.name === name);
                if (!tool) {
                    respond(req.id!, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
                    return;
                }
                const args = req.params?.arguments ?? {};
                if (!isRecord(args)) {
                    respondError(req.id!, -32602, 'Invalid params: arguments must be an object');
                    return;
                }
                const validationError = validateToolArguments(tool.inputSchema, args);
                if (validationError) {
                    respondError(req.id!, -32602, `Invalid params: ${validationError}`);
                    return;
                }
                const text = tool.handler(args, ctx);
                respond(req.id!, { content: [{ type: 'text', text }] });
                return;
            }
            case 'ping':
                if (!isNotification) respond(req.id!, {});
                return;
            default:
                if (!isNotification) respondError(req.id!, -32601, `Method not found: ${req.method}`);
                return;
        }
    } catch (e) {
        logError('mcp handler failed', e);
        if (!isNotification) respondError(req.id!, -32603, e instanceof Error ? e.message : 'internal error');
    }
}

function respond(id: string | number | null, result: unknown): void {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: string | number | null, code: number, message: string): void {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function isRequest(value: unknown): value is JsonRpcRequest {
    if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return false;
    if (Object.hasOwn(value, 'id')) {
        if (typeof value.id !== 'string' && typeof value.id !== 'number') return false;
        if (typeof value.id === 'number' && !Number.isInteger(value.id)) return false;
    }
    return value.params === undefined || isRecord(value.params);
}

function requestId(value: unknown): string | number | null {
    if (!isRecord(value)) return null;
    if (typeof value.id === 'string') return value.id;
    return typeof value.id === 'number' && Number.isInteger(value.id) ? value.id : null;
}

function validateToolArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
    for (const name of required) if (!Object.hasOwn(args, name)) return `missing required property "${name}"`;

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, value] of Object.entries(args)) {
        const property = properties[name];
        if (!isRecord(property)) continue;
        const type = property.type;
        if (type === 'string' && typeof value !== 'string') return `"${name}" must be a string`;
        if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `"${name}" must be a number`;
        if (type === 'boolean' && typeof value !== 'boolean') return `"${name}" must be a boolean`;
        if (type === 'array' && !Array.isArray(value)) return `"${name}" must be an array`;
        if (Array.isArray(property.enum) && !property.enum.includes(value)) return `"${name}" is not an allowed value`;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
