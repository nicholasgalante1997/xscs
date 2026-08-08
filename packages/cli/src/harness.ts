import {
    type AgentKind,
    HookInput,
    type ParsedTranscript,
    parseTranscriptText,
} from '@xscs/core';

export interface HookCommand {
    type: 'command';
    command: string;
    timeout?: number;
    statusMessage?: string;
}

export interface HookMatcher {
    matcher?: string;
    hooks: HookCommand[];
}

export type HookMap = Record<string, HookMatcher[]>;

export interface HarnessEnvironment {
    CLAUDE_PROJECT_DIR?: string;
    CODEX_HOME?: string;
    KIRO_HOME?: string;
    KIRO_SESSION_ID?: string;
    USER_PROMPT?: string;
}

/**
 * The complete harness-specific boundary. Lifecycle workflows consume the
 * normalized HookInput and never need to know how a harness names its files,
 * identifies itself, or constrains hook execution.
 */
export interface HarnessAdapter {
    readonly kind: Extract<AgentKind, 'claude' | 'codex' | 'kiro'>;
    readonly label: string;
    readonly configDirectory: '.claude' | '.codex' | '.kiro';
    readonly configFile: string;
    normalizeHookPayload(value: unknown, env?: HarnessEnvironment): HookInput | null;
    recognizes(input: HookInput, env: HarnessEnvironment): boolean;
    parseTranscript(raw: string): ParsedTranscript;
    buildHookMap(command: string[]): HookMap;
    applyConfiguration(existing: Record<string, unknown>, command: string[], withMcp: boolean): Record<string, unknown>;
    renderHookOutput(output: Record<string, unknown>): string;
}

abstract class BaseHarnessAdapter implements HarnessAdapter {
    abstract readonly kind: Extract<AgentKind, 'claude' | 'codex' | 'kiro'>;
    abstract readonly label: string;
    abstract readonly configDirectory: '.claude' | '.codex' | '.kiro';
    abstract readonly configFile: string;

    normalizeHookPayload(value: unknown, _env?: HarnessEnvironment): HookInput | null {
        const parsed = HookInput.safeParse(value);
        return parsed.success ? parsed.data : null;
    }

    abstract recognizes(input: HookInput, env: HarnessEnvironment): boolean;

    parseTranscript(raw: string): ParsedTranscript {
        return parseTranscriptText(raw, this.kind);
    }

    renderHookOutput(output: Record<string, unknown>): string {
        return JSON.stringify(output);
    }

    buildHookMap(prefix: string[]): HookMap {
        const command = (event: string): string =>
            [...prefix, 'hook', '--agent', this.kind, '--event', event].map(quote).join(' ');
        return {
            SessionStart: [
                {
                    matcher: 'startup|resume|clear|compact|fork',
                    hooks: [
                        {
                            type: 'command',
                            command: command('SessionStart'),
                            timeout: 20,
                            statusMessage: 'Recalling stored context',
                        },
                    ],
                },
            ],
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit'), timeout: 15 }] }],
            Stop: [{ hooks: [{ type: 'command', command: command('Stop'), timeout: 10 }] }],
            PreCompact: [
                {
                    matcher: 'manual|auto',
                    hooks: [{ type: 'command', command: command('PreCompact'), timeout: 20 }],
                },
            ],
            SessionEnd: [{ hooks: [{ type: 'command', command: command('SessionEnd'), timeout: 3 }] }],
        };
    }

    applyConfiguration(
        existing: Record<string, unknown>,
        command: string[],
        _withMcp: boolean,
    ): Record<string, unknown> {
        return {
            ...existing,
            hooks: mergeHookMaps(asHookMap(existing.hooks), this.buildHookMap(command)),
        };
    }
}

class ClaudeHarnessAdapter extends BaseHarnessAdapter {
    readonly kind = 'claude';
    readonly label = 'Claude Code';
    readonly configDirectory = '.claude';
    readonly configFile = 'settings.json';

    recognizes(input: HookInput, env: HarnessEnvironment): boolean {
        return input.transcript_path?.includes('/.claude/') === true || Boolean(env.CLAUDE_PROJECT_DIR);
    }

}

class CodexHarnessAdapter extends BaseHarnessAdapter {
    readonly kind = 'codex';
    readonly label = 'Codex';
    readonly configDirectory = '.codex';
    readonly configFile = 'hooks.json';

    recognizes(input: HookInput, env: HarnessEnvironment): boolean {
        const transcript = input.transcript_path ?? '';
        return transcript.includes('/.codex/') || transcript.includes('rollout-') || Boolean(env.CODEX_HOME);
    }
}

class KiroHarnessAdapter extends BaseHarnessAdapter {
    readonly kind = 'kiro';
    readonly label = 'Kiro CLI';
    readonly configDirectory = '.kiro';
    readonly configFile = 'hooks/xscs.json';

    override normalizeHookPayload(value: unknown, env: HarnessEnvironment = {}): HookInput | null {
        if (!isRecord(value)) return null;
        const normalized = {
            ...value,
            session_id: typeof value.session_id === 'string' ? value.session_id : env.KIRO_SESSION_ID,
            prompt: typeof value.prompt === 'string' ? value.prompt : env.USER_PROMPT,
            last_assistant_message:
                typeof value.last_assistant_message === 'string'
                    ? value.last_assistant_message
                    : typeof value.assistant_response === 'string'
                      ? value.assistant_response
                      : undefined,
        };
        return super.normalizeHookPayload(normalized, env);
    }

    recognizes(input: HookInput, env: HarnessEnvironment): boolean {
        return (
            Boolean(env.KIRO_HOME || env.KIRO_SESSION_ID) ||
            ['agentSpawn', 'userPromptSubmit', 'stop', 'SessionStart', 'UserPromptSubmit', 'Stop'].includes(
                input.hook_event_name ?? '',
            )
        );
    }

    override applyConfiguration(
        existing: Record<string, unknown>,
        command: string[],
        _withMcp: boolean,
    ): Record<string, unknown> {
        const hooks: Array<[string, string, string]> = [
            ['xscs-session-start', 'SessionStart', 'SessionStart'],
            ['xscs-user-prompt', 'UserPromptSubmit', 'UserPromptSubmit'],
            ['xscs-stop', 'Stop', 'Stop'],
        ];
        const definitions = hooks.map(([name, event, trigger]) => ({
            name,
            trigger,
            action: { type: 'command', command: [...command, 'hook', '--agent', 'kiro', '--event', event].map(quote).join(' ') },
            timeout: event === 'Stop' ? 10 : 20,
        }));
        const foreign = Array.isArray(existing.hooks)
            ? existing.hooks.filter((hook) => !isRecord(hook) || !String(hook.name ?? '').startsWith('xscs-'))
            : [];
        return { ...existing, version: 'v1', hooks: [...foreign, ...definitions] };
    }

    override renderHookOutput(output: Record<string, unknown>): string {
        const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : null;
        return typeof specific?.additionalContext === 'string' ? specific.additionalContext : '';
    }
}

/**
 * Kiro 2.x discovers hooks inside a selected agent configuration. Kiro 3.x
 * moved them to standalone files, so xscs installs this companion agent rather
 * than trying to force one generation's schema through the other.
 */
export function applyKiro2AgentConfiguration(
    existing: Record<string, unknown>,
    command: string[],
    withMcp: boolean,
): Record<string, unknown> {
    const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
    const mcpServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
    const definitions: Array<[string, string, number]> = [
        ['agentSpawn', 'SessionStart', 20_000],
        ['userPromptSubmit', 'UserPromptSubmit', 20_000],
        ['stop', 'Stop', 10_000],
    ];
    for (const [trigger, event, timeoutMs] of definitions) {
        const current = Array.isArray(hooks[trigger]) ? hooks[trigger] : [];
        const foreign = current.filter((hook) => !isRecord(hook) || !isOurs(String(hook.command ?? '')));
        hooks[trigger] = [
            ...foreign,
            {
                command: [...command, 'hook', '--agent', 'kiro', '--event', event].map(quote).join(' '),
                timeout_ms: timeoutMs,
            },
        ];
    }
    if (withMcp) {
        mcpServers.xscs = { command: command[0], args: [...command.slice(1), 'mcp'] };
    }
    return {
        ...existing,
        name: typeof existing.name === 'string' ? existing.name : 'xscs',
        description:
            typeof existing.description === 'string'
                ? existing.description
                : 'Kiro CLI 2.x agent with cross-session context recall',
        prompt:
            typeof existing.prompt === 'string'
                ? existing.prompt
                : 'Use recalled xscs context as prior evidence, verifying anything load-bearing before relying on it.',
        ...(withMcp ? { includeMcpJson: true, mcpServers } : {}),
        hooks,
    };
}

export const claudeHarness: HarnessAdapter = new ClaudeHarnessAdapter();
export const codexHarness: HarnessAdapter = new CodexHarnessAdapter();
export const kiroHarness: HarnessAdapter = new KiroHarnessAdapter();
export const harnesses: readonly HarnessAdapter[] = [claudeHarness, codexHarness, kiroHarness];

export function harnessFor(kind: AgentKind): HarnessAdapter | null {
    return harnesses.find((adapter) => adapter.kind === kind) ?? null;
}

export function recognizeHarness(
    input: HookInput,
    env: HarnessEnvironment = {
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
        KIRO_HOME: process.env.KIRO_HOME,
        KIRO_SESSION_ID: process.env.KIRO_SESSION_ID,
        USER_PROMPT: process.env.USER_PROMPT,
    },
): HarnessAdapter | null {
    return harnesses.find((adapter) => adapter.recognizes(input, env)) ?? null;
}

export function mergeHookMaps(existing: HookMap, ours: HookMap): HookMap {
    const out: HookMap = { ...existing };
    for (const [event, matchers] of Object.entries(ours)) {
        const kept = (out[event] ?? []).filter((entry) => !entry.hooks?.some((hook) => isOurs(hook.command)));
        out[event] = [...kept, ...matchers];
    }
    return out;
}

export function asHookMap(value: unknown): HookMap {
    return isRecord(value) ? (value as HookMap) : {};
}

function isOurs(command: string | undefined): boolean {
    return typeof command === 'string' && / hook (--agent \w+ )?--event /.test(command) && command.includes('xscs');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function quote(value: string): string {
    return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
