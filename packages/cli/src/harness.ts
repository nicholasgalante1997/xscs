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
}

/**
 * The complete harness-specific boundary. Lifecycle workflows consume the
 * normalized HookInput and never need to know how a harness names its files,
 * identifies itself, or constrains hook execution.
 */
export interface HarnessAdapter {
    readonly kind: Extract<AgentKind, 'claude' | 'codex'>;
    readonly label: string;
    readonly configDirectory: '.claude' | '.codex';
    readonly configFile: string;
    normalizeHookPayload(value: unknown): HookInput | null;
    recognizes(input: HookInput, env: HarnessEnvironment): boolean;
    parseTranscript(raw: string): ParsedTranscript;
    buildHookMap(runtime: string, entry: string): HookMap;
    applyConfiguration(existing: Record<string, unknown>, runtime: string, entry: string, withMcp: boolean): Record<string, unknown>;
}

abstract class BaseHarnessAdapter implements HarnessAdapter {
    abstract readonly kind: Extract<AgentKind, 'claude' | 'codex'>;
    abstract readonly label: string;
    abstract readonly configDirectory: '.claude' | '.codex';
    abstract readonly configFile: string;

    normalizeHookPayload(value: unknown): HookInput | null {
        const parsed = HookInput.safeParse(value);
        return parsed.success ? parsed.data : null;
    }

    abstract recognizes(input: HookInput, env: HarnessEnvironment): boolean;

    parseTranscript(raw: string): ParsedTranscript {
        return parseTranscriptText(raw, this.kind);
    }

    buildHookMap(runtime: string, entry: string): HookMap {
        const command = (event: string): string =>
            `${quote(runtime)} ${quote(entry)} hook --agent ${this.kind} --event ${event}`;
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
        runtime: string,
        entry: string,
        _withMcp: boolean,
    ): Record<string, unknown> {
        return {
            ...existing,
            hooks: mergeHookMaps(asHookMap(existing.hooks), this.buildHookMap(runtime, entry)),
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

    override applyConfiguration(
        existing: Record<string, unknown>,
        runtime: string,
        entry: string,
        withMcp: boolean,
    ): Record<string, unknown> {
        const next = super.applyConfiguration(existing, runtime, entry, withMcp);
        if (!withMcp) return next;
        const servers = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
        servers.xscs = { command: runtime, args: [entry, 'mcp'] };
        return { ...next, mcpServers: servers };
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

export const claudeHarness: HarnessAdapter = new ClaudeHarnessAdapter();
export const codexHarness: HarnessAdapter = new CodexHarnessAdapter();
export const harnesses: readonly HarnessAdapter[] = [claudeHarness, codexHarness];

export function harnessFor(kind: AgentKind): HarnessAdapter | null {
    return harnesses.find((adapter) => adapter.kind === kind) ?? null;
}

export function recognizeHarness(
    input: HookInput,
    env: HarnessEnvironment = {
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
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
