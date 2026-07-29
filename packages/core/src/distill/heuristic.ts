import type { ItemDraft, ItemType } from '../schema';
import { extractPaths, isEnvelopeNoise, type ParsedTranscript } from '../transcript';

export interface HeuristicInput {
    transcript: ParsedTranscript | null;
    /** Prompts captured by the UserPromptSubmit hook (available even without a transcript). */
    prompts: string[];
    /** Assistant turn-final messages captured by the Stop hook. */
    assistantMessages: string[];
    branch?: string | null;
}

/**
 * Deterministic, zero-cost, zero-network distillation.
 *
 * This exists because the LLM distiller is the part most likely to be unavailable
 * (offline, rate-limited, out of budget) and a memory system that only works when
 * a model call succeeds is a memory system that silently stops remembering. The
 * heuristics are tuned for precision, not coverage: a small number of confident
 * items beats a large number of plausible ones, because every wrong item costs
 * tokens in every future session until someone deletes it.
 */
export function distillHeuristically(input: HeuristicInput): ItemDraft[] {
    const drafts: ItemDraft[] = [];
    const seen = new Set<string>();

    const push = (draft: ItemDraft): void => {
        const key = `${draft.type}:${draft.title.toLowerCase().slice(0, 80)}`;
        if (seen.has(key)) return;
        seen.add(key);
        drafts.push(draft);
    };

    const userTexts = [
        ...input.prompts,
        ...(input.transcript?.entries.filter((e) => e.role === 'user').map((e) => e.text) ?? []),
    ].filter((t) => t && !isEnvelopeNoise(t));

    // ---- 1. Explicit user directives -----------------------------------
    // The highest-precision signal in any session. When a human writes "never
    // commit without running the tests", that is a durable rule, not chatter.
    for (const text of userTexts) {
        for (const sentence of sentences(text)) {
            const directive = classifyDirective(sentence);
            if (!directive) continue;
            push({
                type: directive.type,
                title: titleise(sentence),
                body: sentence,
                why: 'Stated directly by the user during a session.',
                scope: 'workspace',
                tags: ['user-directive', ...directive.tags],
                confidence: 0.65,
                status: 'active',
                source: 'distiller:heuristic',
            });
        }
    }

    // ---- 2. Unfinished work --------------------------------------------
    const tail = input.assistantMessages.slice(-3).join('\n');
    for (const sentence of sentences(tail)) {
        if (!OPEN_THREAD_RE.test(sentence)) continue;
        push({
            type: 'open_thread',
            title: titleise(sentence),
            body: sentence,
            why: 'Flagged as remaining work at the end of a previous session.',
            scope: input.branch ? 'branch' : 'workspace',
            scope_key: input.branch ?? null,
            tags: ['unfinished'],
            confidence: 0.45,
            status: 'proposed',
            source: 'distiller:heuristic',
        });
    }

    // ---- 3. Stated decisions -------------------------------------------
    for (const message of input.assistantMessages) {
        for (const sentence of sentences(message)) {
            if (!DECISION_RE.test(sentence)) continue;
            if (sentence.length < 30 || sentence.length > 400) continue;
            push({
                type: 'decision',
                title: titleise(sentence),
                body: sentence,
                why: 'Stated as a choice in a previous session; verify before relying on it.',
                scope: 'workspace',
                tags: ['agent-stated'],
                confidence: 0.35,
                status: 'proposed',
                source: 'distiller:heuristic',
            });
        }
    }

    // ---- 4. Working set --------------------------------------------------
    // One artifact item per session rather than one per file: the useful fact is
    // "this cluster of files moves together", not "file X exists".
    const paths = new Map<string, number>();
    for (const entry of input.transcript?.entries ?? []) {
        if (entry.role !== 'tool') continue;
        for (const p of extractPaths(entry.text)) paths.set(p, (paths.get(p) ?? 0) + 1);
    }
    const hot = [...paths.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([p]) => p);
    if (hot.length >= 3) {
        push({
            type: 'artifact',
            title: `Working set: ${hot[0]} and ${hot.length - 1} related files`,
            body: hot.map((p) => `- ${p}`).join('\n'),
            why: 'Files edited or read together in a previous session on this workspace.',
            scope: 'workspace',
            tags: ['working-set'],
            confidence: 0.4,
            status: 'proposed',
            source: 'distiller:heuristic',
        });
    }

    return drafts;
}

/* --------------------------------------------------------------- patterns */

interface Directive {
    type: ItemType;
    tags: string[];
}

const NEVER_RE = /\b(never|do ?n'?t|don't|avoid|stop|must not|should not|no longer)\b/i;
const ALWAYS_RE = /\b(always|make sure|be sure to|ensure that|you must|required to|from now on)\b/i;
const PREFER_RE = /\b(prefer|i like|i'd rather|use .{2,40} instead of|rather than|convention is)\b/i;
const REMEMBER_RE = /\b(remember that|note that|keep in mind|for future reference|fyi[,:])\b/i;
const OPEN_THREAD_RE =
    /\b(still (need|needs|have) to|next step|remaining work|not yet (done|implemented|wired)|left to do|todo:|follow[- ]up|i did not|i haven't|couldn't finish|blocked on)\b/i;
const DECISION_RE =
    /\b(i(?:'ll| will) use|we(?:'ll| will) use|chose|chosen|decided to|going with|settled on|switched to|opted for)\b/i;

export function classifyDirective(sentence: string): Directive | null {
    const s = sentence.trim();
    if (s.length < 12 || s.length > 400) return null;
    // Questions are requests, not rules.
    if (s.endsWith('?')) return null;
    if (NEVER_RE.test(s)) return { type: 'constraint', tags: ['prohibition'] };
    if (ALWAYS_RE.test(s)) return { type: 'constraint', tags: ['obligation'] };
    if (PREFER_RE.test(s)) return { type: 'preference', tags: [] };
    if (REMEMBER_RE.test(s)) return { type: 'fact', tags: ['stated'] };
    return null;
}

export function sentences(text: string): string[] {
    if (!text) return [];
    return text
        .replace(/```[\s\S]*?```/g, ' ') // code blocks are not prose
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
        .filter((s) => s.length > 0);
}

export function titleise(sentence: string): string {
    const clean = sentence.replace(/\s+/g, ' ').trim();
    if (clean.length <= 90) return clean;
    return clean.slice(0, 87).replace(/\s+\S*$/, '') + '…';
}
