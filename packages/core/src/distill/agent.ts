import { processPlatform } from '../platform/process';
import { DistillResult, type ItemDraft } from '../schema';

export type DistillerBackend = 'claude' | 'codex' | 'ollama' | 'none';

export interface AgentDistillInput {
    /** Compressed transcript produced by `summariseForDistill`. */
    material: string;
    workspaceName: string;
    branch?: string | null;
    backend?: DistillerBackend;
    model?: string | null;
    timeoutMs?: number;
    /** Existing item titles, so the model proposes deltas instead of restating. */
    known?: string[];
}

export interface AgentDistillOutput {
    drafts: ItemDraft[];
    backend: DistillerBackend;
    ok: boolean;
    error?: string;
}

/**
 * The prompt is the actual product here. Three things it does deliberately:
 *
 *  1. It states the cost of a wrong memory. Distillers left to their own devices
 *     produce enthusiastic summaries; what we want is a skeptical archivist.
 *  2. It forbids restating anything already known, which is what stops a store
 *     from growing linearly with session count.
 *  3. It demands `why`, because an item without a reason cannot be re-evaluated
 *     later and becomes permanent by default.
 */
export function buildDistillPrompt(input: AgentDistillInput): string {
    const known = input.known?.length
        ? `\nAlready stored (do NOT restate or paraphrase these):\n${input.known.slice(0, 60).map((k) => `- ${k}`).join('\n')}\n`
        : '';
    return `You are a memory archivist for a coding agent. You are reading a compressed record of one finished coding session in the workspace "${input.workspaceName}"${
        input.branch ? ` on branch "${input.branch}"` : ''
    }.

Extract ONLY durable context — things that would still be true and useful to an agent starting a fresh session next week with no memory of this one.

Keep:
- decisions that were actually made and their reasons
- constraints and rules the user imposed
- user preferences about how work should be done
- non-obvious facts about the codebase that took effort to discover
- pitfalls hit and how they were resolved
- work left unfinished, with a concrete next action

Discard:
- narration of what was done ("I read the file, then edited it")
- anything discoverable in 10 seconds by reading the code or running git log
- transient state, one-off answers, restatements of the task
- anything you are not confident about

Every wrong or redundant item costs tokens in every future session, so err heavily toward fewer items. Zero items is a valid and common answer. Never invent detail that is not in the record.
${known}
Return ONLY a JSON object, no prose, no code fence:
{"items":[{"type":"decision|constraint|preference|fact|artifact|open_thread|pitfall|glossary","title":"<= 90 chars","body":"1-3 sentences","why":"why this is worth remembering","scope":"workspace|global","tags":["..."],"confidence":0.0-1.0}]}

Session record:
${input.material}`;
}

export async function distillWithAgent(input: AgentDistillInput): Promise<AgentDistillOutput> {
    const backend = input.backend ?? detectBackend();
    if (backend === 'none') {
        return { drafts: [], backend, ok: false, error: 'no distiller backend available' };
    }

    const prompt = buildDistillPrompt(input);
    const timeout = input.timeoutMs ?? 120_000;

    if (backend === 'ollama') return distillWithOllama(input, prompt, timeout);

    const cmd =
        backend === 'claude'
            ? [
                  'claude',
                  '-p',
                  '--output-format',
                  'text',
                  // A distiller that can touch the filesystem is a distiller that can
                  // be prompt-injected by the transcript it is reading.
                  '--disallowed-tools',
                  'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit',
                  ...(input.model ? ['--model', input.model] : []),
              ]
            : ['codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', ...(input.model ? ['-m', input.model] : []), '-'];

    try {
        const processResult = await processPlatform().run({
            command: cmd,
            stdin: prompt,
            timeoutMs: timeout,
            env: {
                ...process.env,
                // Prevents the child session from firing our own hooks and
                // recursively distilling itself.
                XSCS_INTERNAL: '1',
            },
        });
        const { stdout, stderr, exitCode } = processResult;

        if (exitCode !== 0 && !stdout.trim()) {
            return { drafts: [], backend, ok: false, error: `${backend} exited ${exitCode}: ${stderr.slice(0, 400)}` };
        }

        const parsed = extractJson(stdout);
        if (!parsed) return { drafts: [], backend, ok: false, error: 'no JSON object in distiller output' };

        const result = DistillResult.safeParse(parsed);
        if (!result.success) {
            return { drafts: [], backend, ok: false, error: `schema mismatch: ${result.error.message.slice(0, 300)}` };
        }

        const drafts: ItemDraft[] = result.data.items.map((item) => ({
            type: item.type,
            title: item.title.slice(0, 200),
            body: item.body.slice(0, 4000),
            why: item.why ?? null,
            // A distiller never gets to write global scope directly; promotion to
            // global is a human decision made in the dashboard.
            scope: item.scope === 'global' ? 'workspace' : (item.scope ?? 'workspace'),
            tags: item.tags ?? [],
            confidence: clamp(item.confidence ?? 0.5),
            status: 'proposed',
            source: `distiller:${backend}`,
        }));

        return { drafts, backend, ok: true };
    } catch (e) {
        return { drafts: [], backend, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function clamp(n: number): number {
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
}

export function detectBackend(): DistillerBackend {
    const configured = process.env.XSCS_DISTILLER;
    if (configured === 'claude' || configured === 'codex' || configured === 'ollama' || configured === 'none') return configured;
    if (processPlatform().which('claude')) return 'claude';
    if (processPlatform().which('codex')) return 'codex';
    if (processPlatform().which('ollama')) return 'ollama';
    return 'none';
}

async function distillWithOllama(
    input: AgentDistillInput,
    prompt: string,
    timeoutMs: number,
): Promise<AgentDistillOutput> {
    const backend = 'ollama' as const;
    const model = input.model ?? process.env.XSCS_OLLAMA_MODEL;
    if (!model) {
        return {
            drafts: [],
            backend,
            ok: false,
            error: 'Ollama requires --model <name> or XSCS_OLLAMA_MODEL',
        };
    }
    const configuredHost = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
    const host = /^https?:\/\//.test(configuredHost) ? configuredHost : `http://${configuredHost}`;
    try {
        const response = await fetch(`${host.replace(/\/$/, '')}/api/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await response.json()) as { error?: unknown; response?: unknown };
        if (!response.ok) {
            return {
                drafts: [],
                backend,
                ok: false,
                error: `ollama HTTP ${response.status}: ${String(body.error ?? response.statusText).slice(0, 400)}`,
            };
        }
        if (typeof body.response !== 'string') {
            return { drafts: [], backend, ok: false, error: 'ollama response did not contain generated text' };
        }
        const parsed = extractJson(body.response);
        if (!parsed) return { drafts: [], backend, ok: false, error: 'no JSON object in distiller output' };
        const result = DistillResult.safeParse(parsed);
        if (!result.success) {
            return { drafts: [], backend, ok: false, error: `schema mismatch: ${result.error.message.slice(0, 300)}` };
        }
        return {
            backend,
            ok: true,
            drafts: result.data.items.map((item) => ({
                type: item.type,
                title: item.title.slice(0, 200),
                body: item.body.slice(0, 4000),
                why: item.why ?? null,
                scope: item.scope === 'global' ? 'workspace' : (item.scope ?? 'workspace'),
                tags: item.tags ?? [],
                confidence: clamp(item.confidence ?? 0.5),
                status: 'proposed',
                source: 'distiller:ollama',
            })),
        };
    } catch (error) {
        return { drafts: [], backend, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Models wrap JSON in prose and fences no matter how firmly you ask them not to.
 * Scan for the first balanced object that parses, rather than trusting the shape
 * of the response.
 */
export function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates: string[] = [];
    if (fenced?.[1]) candidates.push(fenced[1]);
    candidates.push(text);

    for (const candidate of candidates) {
        const start = candidate.indexOf('{');
        if (start === -1) continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < candidate.length; i++) {
            const ch = candidate[i]!;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') inString = !inString;
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(candidate.slice(start, i + 1));
                    } catch {
                        break;
                    }
                }
            }
        }
    }
    return null;
}
