import { existsSync, readFileSync } from 'node:fs';

import type { AgentKind } from './schema';

export interface TranscriptEntry {
    ts: number;
    role: 'user' | 'assistant' | 'tool' | 'tool_result' | 'system';
    text: string;
    /** Tool name for `tool` entries. */
    tool?: string;
}

export interface ParsedTranscript {
    agent: AgentKind;
    entries: TranscriptEntry[];
    cwd: string | null;
    model: string | null;
    compacted: boolean;
}

/**
 * Both harnesses persist a session as newline-delimited JSON, but with different
 * envelopes:
 *
 *   Claude Code  ~/.claude/projects/<slug>/<session-id>.jsonl
 *                {"type":"user"|"assistant", "message":{role, content}, "timestamp", ...}
 *
 *   Codex CLI    ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 *                {"type":"response_item","payload":{"type":"message"|"function_call", ...}}
 *
 * Reading them directly (rather than only trusting hook payloads) matters because
 * hooks give you the *edges* of a turn, while the transcript gives you what
 * actually happened in between — which is where the durable conclusions live.
 */
export function parseTranscript(path: string, hint?: AgentKind): ParsedTranscript | null {
    if (!path || !existsSync(path)) return null;
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return null;
    }
    return parseTranscriptText(raw, hint);
}

export function parseTranscriptText(raw: string, hint?: AgentKind): ParsedTranscript {
    const entries: TranscriptEntry[] = [];
    let cwd: string | null = null;
    let model: string | null = null;
    let compacted = false;
    let agent: AgentKind = hint ?? 'other';

    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
            obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }

        const type = str(obj.type);

        // ---- Codex rollout envelope -------------------------------------
        if (type === 'session_meta' || type === 'response_item' || type === 'compacted' || type === 'turn_context') {
            agent = hint ?? 'codex';
            const ts = parseTs(obj.timestamp);
            const payload = rec(obj.payload);
            if (type === 'session_meta' && payload) {
                cwd = str(payload.cwd) ?? cwd;
                model = str(payload.model) ?? model;
                continue;
            }
            if (type === 'turn_context' && payload) {
                model = str(payload.model) ?? model;
                continue;
            }
            if (type === 'compacted') {
                compacted = true;
                continue;
            }
            if (!payload) continue;
            const ptype = str(payload.type);
            if (ptype === 'message') {
                const role = str(payload.role);
                const text = flattenContent(payload.content);
                if (!text) continue;
                if (role === 'user') entries.push({ ts, role: 'user', text });
                else if (role === 'assistant') entries.push({ ts, role: 'assistant', text });
                else entries.push({ ts, role: 'system', text });
            } else if (ptype === 'function_call' || ptype === 'custom_tool_call') {
                entries.push({
                    ts,
                    role: 'tool',
                    tool: str(payload.name) ?? 'tool',
                    text: str(payload.arguments) ?? str(payload.input) ?? '',
                });
            } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
                entries.push({ ts, role: 'tool_result', text: truncate(stringify(payload.output), 2000) });
            }
            continue;
        }

        // ---- Claude Code transcript envelope ----------------------------
        if (type === 'user' || type === 'assistant') {
            agent = hint ?? 'claude';
            if (obj.isMeta === true) continue;
            const ts = parseTs(obj.timestamp);
            cwd = str(obj.cwd) ?? cwd;
            const message = rec(obj.message);
            if (!message) continue;
            const content = message.content;

            if (type === 'user') {
                // Claude threads tool results back through a `user` record. They
                // are machine output, not human intent — flattening them into the
                // user turn would let a file's contents or a command's stdout be
                // mined as a "user directive" by the distiller.
                const { text, toolResults } = splitUserContent(content);
                if (text) entries.push({ ts, role: 'user', text });
                for (const result of toolResults) entries.push({ ts, role: 'tool_result', text: result });
                continue;
            }

            model = str(message.model) ?? model;
            if (Array.isArray(content)) {
                for (const partRaw of content) {
                    const part = rec(partRaw);
                    if (!part) continue;
                    const pt = str(part.type);
                    if (pt === 'text' && str(part.text)) {
                        entries.push({ ts, role: 'assistant', text: str(part.text)! });
                    } else if (pt === 'tool_use') {
                        entries.push({
                            ts,
                            role: 'tool',
                            tool: str(part.name) ?? 'tool',
                            text: truncate(stringify(part.input), 2000),
                        });
                    }
                }
            } else {
                const text = flattenContent(content);
                if (text) entries.push({ ts, role: 'assistant', text });
            }
            continue;
        }

        if (type === 'compact-boundary' || type === 'summary') compacted = true;
    }

    return { agent, entries, cwd, model, compacted };
}

/** Separates genuine user prose from tool results carried in the same record. */
function splitUserContent(content: unknown): { text: string; toolResults: string[] } {
    if (typeof content === 'string') return { text: content.trim(), toolResults: [] };
    if (!Array.isArray(content)) return { text: '', toolResults: [] };

    const prose: string[] = [];
    const toolResults: string[] = [];
    for (const partRaw of content) {
        if (typeof partRaw === 'string') {
            prose.push(partRaw);
            continue;
        }
        const part = rec(partRaw);
        if (!part) continue;
        const t = str(part.type);
        if (t === 'text' || t === 'input_text') {
            const text = str(part.text);
            if (text) prose.push(text);
        } else if (t === 'tool_result') {
            const text = typeof part.content === 'string' ? part.content : stringify(part.content);
            if (text) toolResults.push(truncate(text, 1500));
        }
    }
    return { text: prose.join('\n').trim(), toolResults };
}

/** Claude's `content` is string | array of blocks; Codex's is an array of typed parts. */
function flattenContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    const out: string[] = [];
    for (const partRaw of content) {
        const part = rec(partRaw);
        if (!part) {
            if (typeof partRaw === 'string') out.push(partRaw);
            continue;
        }
        const t = str(part.type);
        if (t === 'text' || t === 'input_text' || t === 'output_text') {
            const text = str(part.text);
            if (text) out.push(text);
        } else if (t === 'tool_result') {
            const text = typeof part.content === 'string' ? part.content : stringify(part.content);
            if (text) out.push(truncate(text, 1500));
        }
    }
    return out.join('\n').trim();
}

function parseTs(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Date.parse(v);
        if (!Number.isNaN(n)) return n;
    }
    return Date.now();
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringify(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v) ?? '';
    } catch {
        return '';
    }
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Compresses a transcript into the slice that is worth handing to a distiller.
 * User turns are kept whole (they carry intent and directives); assistant prose is
 * sampled from the head and tail of the run; tool calls are reduced to names and
 * target paths, which is enough to reconstruct "what was touched".
 */
export function summariseForDistill(t: ParsedTranscript, maxChars = 24_000): string {
    const userTurns = t.entries.filter((e) => e.role === 'user' && !isEnvelopeNoise(e.text));
    const assistantTurns = t.entries.filter((e) => e.role === 'assistant');
    const toolTurns = t.entries.filter((e) => e.role === 'tool');

    const toolSummary = new Map<string, number>();
    const touched = new Set<string>();
    for (const tool of toolTurns) {
        const name = tool.tool ?? 'tool';
        toolSummary.set(name, (toolSummary.get(name) ?? 0) + 1);
        for (const p of extractPaths(tool.text)) touched.add(p);
    }

    const parts: string[] = [];
    parts.push('## User turns');
    for (const u of userTurns.slice(0, 40)) parts.push(`- ${truncate(u.text.replace(/\s+/g, ' '), 600)}`);

    parts.push('\n## Assistant conclusions (head/tail sample)');
    const head = assistantTurns.slice(0, 6);
    const tail = assistantTurns.slice(-10);
    for (const a of dedupe([...head, ...tail])) parts.push(`- ${truncate(a.text.replace(/\s+/g, ' '), 800)}`);

    parts.push('\n## Tool usage');
    for (const [name, count] of [...toolSummary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        parts.push(`- ${name} ×${count}`);
    }

    if (touched.size) {
        parts.push('\n## Paths touched');
        for (const p of [...touched].slice(0, 60)) parts.push(`- ${p}`);
    }

    return truncate(parts.join('\n'), maxChars);
}

function dedupe(entries: TranscriptEntry[]): TranscriptEntry[] {
    const seen = new Set<string>();
    return entries.filter((e) => {
        const key = `${e.ts}:${e.text.slice(0, 80)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Harness-injected wrappers (environment blocks, command echoes, system reminders)
 * are not user intent and must never be mistaken for a durable directive.
 */
export function isEnvelopeNoise(text: string): boolean {
    const t = text.trimStart();
    return (
        t.startsWith('<environment_context') ||
        t.startsWith('<system-reminder') ||
        t.startsWith('<local-command') ||
        t.startsWith('<command-name') ||
        t.startsWith('<user-prompt-submit-hook') ||
        t.startsWith('Caveat: The messages below were generated') ||
        t.length < 2
    );
}

const PATH_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?(?:[\w.@-]+\/){1,}[\w.@-]+\.[a-zA-Z0-9]{1,6})/g;

export function extractPaths(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(PATH_RE)) {
        const p = m[1];
        if (!p) continue;
        if (p.includes('node_modules') || p.startsWith('http')) continue;
        out.add(p);
    }
    return [...out];
}
