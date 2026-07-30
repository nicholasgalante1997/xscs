import type { AgentKind } from '@xscs/core';

interface HookBootstrapOptions {
    agent?: AgentKind;
    budget?: number;
    event?: string;
    noBackground?: boolean;
    noTopup?: boolean;
}

/**
 * The hook path is deliberately selected before CAC or the interactive command
 * graph is evaluated. Hooks are the primary product path and run on every turn.
 */
export async function runBootstrap(argv: string[]): Promise<void> {
    const command = argv[0] ?? 'help';

    if (command === 'hook') {
        const { runHook } = await import('./hook');
        await runHook(readHookOptions(argv.slice(1)));
        return;
    }

    if (command === 'mcp') {
        const { runMcpServer } = await import('./mcp');
        await runMcpServer();
        return;
    }

    const { runInteractiveCli } = await import('./cli');
    await runInteractiveCli(argv);
}

function readHookOptions(argv: string[]): HookBootstrapOptions {
    const options: HookBootstrapOptions = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index]!;
        const [rawName, inlineValue] = token.split('=', 2);
        const name = rawName?.startsWith('--') ? rawName.slice(2) : '';
        const next = inlineValue ?? argv[index + 1];
        switch (name) {
            case 'agent':
                if (next === 'claude' || next === 'codex' || next === 'other') options.agent = next;
                if (inlineValue === undefined) index++;
                break;
            case 'event':
                if (next) options.event = next;
                if (inlineValue === undefined) index++;
                break;
            case 'budget': {
                const budget = Number(next);
                if (Number.isFinite(budget)) options.budget = budget;
                if (inlineValue === undefined) index++;
                break;
            }
            case 'no-topup':
                options.noTopup = true;
                break;
            case 'no-background':
                options.noBackground = true;
                break;
        }
    }
    return options;
}
